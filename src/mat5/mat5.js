// mat5.js — A rudimentary writer/reader for the MATLAB Level-5 MAT-file
// format (the format `save('x.mat')` actually produces by default in real
// MATLAB — this is NOT HDF5; HDF5 only shows up if MATLAB is told to use
// `-v7.3`). See README for exactly what this does and doesn't support.
//
// Supported: real and complex double-precision 2-D numeric arrays, and
// (best-effort) char arrays, uncompressed. One variable per top-level
// name, no structs/cells/sparse/int-classes/compression.
//
// Implemented with plain Uint8Array/DataView (no Node `Buffer`) so the
// exact same code runs in the browser bundle and in Node-based tests.
//
// Layout (see MathWorks "MAT-File Format" spec):
//   128-byte header: 116-byte text, 8-byte subsystem offset (blank),
//     2-byte version (0x0100), 2-byte endian indicator ('M','I').
//   Then a sequence of data elements, each: 4-byte type, 4-byte byte
//   count, payload padded to a multiple of 8 bytes.
//   A numeric array is a miMATRIX element containing, in order: array
//   flags (8 bytes), dimensions array, array name, real part, and
//   (if complex) imaginary part — each itself a tagged sub-element.

import { Mat } from '../core/values.js';

const miINT8 = 1, miUINT16 = 4, miINT32 = 5, miUINT32 = 6, miDOUBLE = 9, miMATRIX = 14;
const mxDOUBLE_CLASS = 6, mxCHAR_CLASS = 4;

function pad8(n) { return (8 - (n % 8)) % 8; }

class ByteWriter {
  constructor() { this.parts = []; this.length = 0; }
  pushBytes(u8) { this.parts.push(u8); this.length += u8.length; }
  pushU32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.pushBytes(b); }
  pushU16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.pushBytes(b); }
  pushAscii(str) { const b = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff; this.pushBytes(b); }
  pushZeros(n) { this.pushBytes(new Uint8Array(n)); }
  finish() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

function writeTaggedElement(w, type, payload) {
  w.pushU32(type);
  w.pushU32(payload.length);
  w.pushBytes(payload);
  const padding = pad8(payload.length);
  if (padding) w.pushZeros(padding);
}

function encodeVariable(name, mat) {
  const inner = new ByteWriter();

  // Array flags (8 bytes): byte0 = class, byte1 = flags (bit3 = complex, bit1 = logical)
  const flags = new Uint8Array(8);
  const complexFlag = mat.isComplex ? 0x08 : 0x00;
  const logicalFlag = mat.isLogical ? 0x02 : 0x00;
  flags[0] = mat.isChar ? mxCHAR_CLASS : mxDOUBLE_CLASS;
  flags[1] = complexFlag | logicalFlag;
  writeTaggedElement(inner, miUINT32, flags);

  // Dimensions
  const dims = new Uint8Array(8);
  const dv = new DataView(dims.buffer);
  dv.setInt32(0, mat.rows, true);
  dv.setInt32(4, mat.cols, true);
  writeTaggedElement(inner, miINT32, dims);

  // Name
  const nameBytes = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) nameBytes[i] = name.charCodeAt(i) & 0xff;
  writeTaggedElement(inner, miINT8, nameBytes);

  if (mat.isChar) {
    const buf = new Uint8Array(mat.numel * 2);
    const bdv = new DataView(buf.buffer);
    for (let k = 0; k < mat.numel; k++) bdv.setUint16(k * 2, Math.round(mat.re[k]) & 0xffff, true);
    writeTaggedElement(inner, miUINT16, buf);
  } else {
    const reBuf = new Uint8Array(mat.numel * 8);
    const rdv = new DataView(reBuf.buffer);
    for (let k = 0; k < mat.numel; k++) rdv.setFloat64(k * 8, mat.re[k], true);
    writeTaggedElement(inner, miDOUBLE, reBuf);
    if (mat.isComplex) {
      const imBuf = new Uint8Array(mat.numel * 8);
      const idv = new DataView(imBuf.buffer);
      for (let k = 0; k < mat.numel; k++) idv.setFloat64(k * 8, mat.im[k], true);
      writeTaggedElement(inner, miDOUBLE, imBuf);
    }
  }

  const payload = inner.finish();
  const outer = new ByteWriter();
  writeTaggedElement(outer, miMATRIX, payload);
  return outer.finish();
}

export function encodeMat5(vars) {
  // vars: { [name]: Mat }
  const header = new Uint8Array(128);
  const text = `MATLAB 5.0 MAT-file, Platform: Web, Created by: matweb ${new Date().toISOString()}`.slice(0, 116).padEnd(116, ' ');
  for (let i = 0; i < 116; i++) header[i] = text.charCodeAt(i) & 0xff;
  for (let i = 116; i < 124; i++) header[i] = 0x20; // subsystem data offset, left blank
  new DataView(header.buffer).setUint16(124, 0x0100, true); // version
  header[126] = 'I'.charCodeAt(0); header[127] = 'M'.charCodeAt(0); // endian indicator (verified vs scipy.io.savemat output)

  const parts = [header];
  let total = header.length;
  for (const [name, mat] of Object.entries(vars)) {
    if (!(mat instanceof Mat)) continue; // function handles etc. are skipped
    const enc = encodeVariable(name, mat);
    parts.push(enc);
    total += enc.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function decodeMat5(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const endianTag = String.fromCharCode(u8[126], u8[127]);
  if (endianTag !== 'MI' && endianTag !== 'IM') {
    throw new Error('Not a recognized MAT5 file (bad endian indicator)');
  }
  let pos = 128;
  const vars = {};
  while (pos < u8.length) {
    const type = dv.getUint32(pos, true);
    const size = dv.getUint32(pos + 4, true);
    const dataStart = pos + 8;
    if (type === miMATRIX) {
      const { name, mat } = decodeMatrixElement(u8, dv, dataStart, size);
      vars[name] = mat;
    }
    pos = dataStart + size + pad8(size);
  }
  return vars;
}

function readTag(dv, pos) {
  const firstWord = dv.getUint32(pos, true);
  const compactSize = (firstWord >>> 16) & 0xffff;
  if (compactSize !== 0) {
    // MAT5 "compact" small-element form: for payloads <=4 bytes, real
    // writers (MATLAB, scipy) pack [type:u16][size:u16] into one 4-byte
    // word followed immediately by the (padded) data, 8 bytes total,
    // instead of the general 8-byte-tag-plus-padded-payload form we
    // always use when *writing*. We still need to read it, since files
    // from real tools use it constantly (e.g. short variable names).
    const type = firstWord & 0xffff;
    return { type, size: compactSize, dataStart: pos + 4, next: pos + 8 };
  }
  const type = firstWord;
  const size = dv.getUint32(pos + 4, true);
  return { type, size, dataStart: pos + 8, next: pos + 8 + size + pad8(size) };
}

function decodeMatrixElement(u8, dv, start, totalSize) {
  let pos = start;
  const end = start + totalSize;

  const flagsTag = readTag(dv, pos);
  const clsByte = u8[flagsTag.dataStart];
  const flagsByte = u8[flagsTag.dataStart + 1];
  const isComplex = !!(flagsByte & 0x08);
  const isLogical = !!(flagsByte & 0x02);
  pos = flagsTag.next;

  const dimsTag = readTag(dv, pos);
  const rows = dv.getInt32(dimsTag.dataStart, true);
  const cols = dv.getInt32(dimsTag.dataStart + 4, true);
  pos = dimsTag.next;

  const nameTag = readTag(dv, pos);
  let name = '';
  for (let i = 0; i < nameTag.size; i++) name += String.fromCharCode(u8[nameTag.dataStart + i]);
  pos = nameTag.next;

  const numel = rows * cols;
  const isChar = clsByte === mxCHAR_CLASS;

  const realTag = readTag(dv, pos);
  let re = new Float64Array(numel);
  if (isChar) {
    for (let k = 0; k < numel; k++) re[k] = dv.getUint16(realTag.dataStart + k * 2, true);
  } else {
    for (let k = 0; k < numel; k++) re[k] = dv.getFloat64(realTag.dataStart + k * 8, true);
  }
  pos = realTag.next;

  let im = null;
  if (isComplex && pos < end) {
    const imTag = readTag(dv, pos);
    im = new Float64Array(numel);
    for (let k = 0; k < numel; k++) im[k] = dv.getFloat64(imTag.dataStart + k * 8, true);
    pos = imTag.next;
  }

  const mat = new Mat(rows, cols, re, im, { isChar, isLogical });
  return { name, mat };
}
