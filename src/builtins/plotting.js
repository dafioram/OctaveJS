// plotting.js — MATLAB plotting commands. These build a plain-data model
// of each figure:
//
//   figure { num, name, axes: [axes...], current: axes handle, sgtitle }
//   axes   { h, kind: 'cartesian'|'polar'|'pie', cell (subplot position or
//            null for the whole figure), hold, objects: [...], texts: [...],
//            title, xlabel, ylabel, xlim, ylim, xscale, yscale, grid, box,
//            legend, ticks, ... }
//   object { h, type: 'line'|'scatter'|'bar'|'histogram'|'stem'|'area'|
//            'errorbar'|'fill'|'pie', data and style properties }
//
// and tell the host which figures changed (host.figures.render). The page
// turns the model into Plotly charts (src/plot/toPlotly.js), so everything
// here stays DOM-free and testable. Graphics handles are plain numbers:
// figures use their figure number, axes and plotted objects get numbers
// from 1001 up.

import { Mat, Cell, StructArray, MatlabError } from '../core/values.js';
import { COLOR_ORDER, LINE_STYLES, colorFromText, markerFromText, parseLinespec } from '../plot/style.js';
import { colormapByName, colorDataRange, DEFAULT_COLORMAP_SIZE } from '../plot/colormaps.js';
import { contourLevelValues } from '../plot/contours.js';

const FIRST_OBJECT_HANDLE = 1001;

const isText = (v) => v instanceof Mat && v.isChar;
function textOf(v, what) {
  if (isText(v)) return v.toJSString();
  if (v instanceof Cell && v.isCellstr()) return v.data.map(x => x.toJSString()).join('\n');
  throw new MatlabError(`${what} must be text`);
}
const values = (m) => Array.from(m.re);
const handlesMat = (hs) => new Mat(hs.length, 1, Float64Array.from(hs));

// ---------------- figures, axes and handles ----------------

function figureMap(interp) {
  if (!interp.figures) interp.figures = new Map();
  return interp.figures;
}

function lowestUnusedFigure(interp) {
  const figs = figureMap(interp);
  let n = 1;
  while (figs.has(n)) n++;
  return n;
}

function nextHandle(interp) {
  if (interp.graphicsNext === undefined) {
    // First use (or after a restart): continue above every existing handle.
    let max = FIRST_OBJECT_HANDLE - 1;
    for (const fig of figureMap(interp).values()) {
      for (const ax of fig.axes) {
        max = Math.max(max, ax.h);
        for (const o of [...ax.objects, ...ax.texts]) max = Math.max(max, o.h);
      }
    }
    interp.graphicsNext = max + 1;
  }
  return interp.graphicsNext++;
}

function newFigure(num, name = '') {
  return { num, name, axes: [], current: null, sgtitle: null, colormap: null };
}

// A colormap from a name ('jet') or an N-by-3 matrix of RGB rows in [0, 1].
function colormapValue(v) {
  if (isText(v)) {
    const map = colormapByName(v.toJSString().toLowerCase());
    if (!map) throw new MatlabError(`Unknown colormap '${v.toJSString()}'`);
    return map;
  }
  if (v instanceof Mat && v.cols === 3 && v.rows >= 1 && !v.isComplex) {
    const rows = rowsOf(v);
    if (rows.flat().some(x => !(x >= 0 && x <= 1))) throw new MatlabError('Colormap values must be between 0 and 1');
    return rows;
  }
  throw new MatlabError('A colormap must be a name or an N-by-3 matrix of RGB values');
}
const defaultColormap = () => colormapByName('parula', DEFAULT_COLORMAP_SIZE);

function axesDefaults() {
  return {
    kind: 'cartesian', objects: [], texts: [], colorIndex: 0,
    title: null, xlabel: null, ylabel: null, xlim: null, ylim: null,
    xscale: 'linear', yscale: 'linear', grid: false, minorGrid: false, box: true, visible: true,
    equal: false, ydir: 'normal', xticks: null, yticks: null, xticklabels: null, yticklabels: null,
    legend: { show: false, location: 'northeast', boxOff: false },
    // 3-D and color: z axis, camera angles (MATLAB's default view), and
    // color limits (null = the range of the plotted color data).
    zlabel: null, zlim: null, view: [-37.5, 30], clim: null,
  };
}

function newAxes(interp, cell = null) {
  return { h: nextHandle(interp), cell, hold: false, colorbar: false, colormap: null, ...axesDefaults() };
}

// The current figure, created (as the lowest unused number) if none exists.
function currentFigure(ctx) {
  const interp = ctx.interp;
  const figs = figureMap(interp);
  let num = interp.figureState.current;
  if (num === undefined || !figs.has(num)) {
    num = num !== undefined && !figs.has(num) ? num : lowestUnusedFigure(interp);
    figs.set(num, newFigure(num));
    interp.figureState.current = num;
  }
  return figs.get(num);
}

// The current axes of the current figure, created if none exists.
function currentAxes(ctx) {
  const fig = currentFigure(ctx);
  let ax = fig.axes.find(a => a.h === fig.current);
  if (!ax) {
    ax = newAxes(ctx.interp);
    fig.axes.push(ax);
    fig.current = ax.h;
  }
  return ax;
}

function touch(ctx, num = ctx.interp.figureState.current) {
  if (ctx.host.figures && ctx.host.figures.render) ctx.host.figures.render(num);
}

// Ready the current axes for a new plot: unless hold is on, clear it and
// reset its properties (MATLAB's NextPlot 'replace').
function prepareAxes(ctx, kind) {
  const ax = currentAxes(ctx);
  // The colorbar and an axes-specific colormap survive a replot.
  if (!ax.hold) Object.assign(ax, axesDefaults(), { kind });
  else if (ax.kind !== kind) {
    if (ax.objects.length === 0) ax.kind = kind;
    else throw new MatlabError(`Cannot add ${kind} data to ${ax.kind} axes while hold is on`);
  }
  return ax;
}

function nextColor(ax) {
  const c = COLOR_ORDER[ax.colorIndex % COLOR_ORDER.length];
  ax.colorIndex++;
  return c;
}

// Every graphics object with handle h, as { kind, fig, ax, obj }.
function findHandle(interp, h) {
  const figs = figureMap(interp);
  if (Number.isInteger(h) && h < FIRST_OBJECT_HANDLE && figs.has(h)) return { kind: 'figure', fig: figs.get(h) };
  for (const fig of figs.values()) {
    for (const ax of fig.axes) {
      if (ax.h === h) return { kind: 'axes', fig, ax };
      const obj = ax.objects.find(o => o.h === h);
      if (obj) return { kind: 'object', fig, ax, obj };
      const text = ax.texts.find(t => t.h === h);
      if (text) return { kind: 'text', fig, ax, obj: text };
    }
  }
  return null;
}

// ---------------- property (Name, Value) parsing ----------------

function colorValue(v, name) {
  if (isText(v)) {
    const t = v.toJSString().trim().toLowerCase();
    if (t === 'none' || t === 'auto' || t === 'flat' || t === 'interp') return t;
    const c = colorFromText(t);
    if (c) return c;
    throw new MatlabError(`Invalid color '${v.toJSString()}' for ${name}`);
  }
  if (v instanceof Mat && v.numel === 3 && !v.isComplex) {
    const c = values(v);
    if (c.some(x => !(x >= 0 && x <= 1))) throw new MatlabError(`${name}: RGB values must be between 0 and 1`);
    return c;
  }
  throw new MatlabError(`Invalid color value for ${name}`);
}
function scalarValue(v, name) {
  if (!(v instanceof Mat) || v.numel !== 1) throw new MatlabError(`${name} must be a scalar`);
  return v.re[0];
}

const PROPS = {
  color: ['color', colorValue],
  linewidth: ['lineWidth', scalarValue],
  linestyle: ['lineStyle', (v, n) => {
    const s = textOf(v, n);
    if (!LINE_STYLES.includes(s)) throw new MatlabError(`Invalid LineStyle '${s}'`);
    return s;
  }],
  marker: ['marker', (v, n) => {
    const m = markerFromText(textOf(v, n));
    if (!m) throw new MatlabError(`Invalid Marker '${textOf(v, n)}'`);
    return m;
  }],
  markersize: ['markerSize', scalarValue],
  markerfacecolor: ['markerFaceColor', colorValue],
  markeredgecolor: ['markerEdgeColor', colorValue],
  displayname: ['displayName', (v, n) => textOf(v, n)],
  facecolor: ['faceColor', colorValue],
  edgecolor: ['edgeColor', colorValue],
  facealpha: ['faceAlpha', scalarValue],
  barwidth: ['barWidth', scalarValue],
  numbins: ['numBins', scalarValue],
  binwidth: ['binWidth', scalarValue],
  binedges: ['binEdges', (v) => values(v)],
  normalization: ['normalization', (v, n) => {
    const s = textOf(v, n).toLowerCase();
    if (!['count', 'probability', 'pdf', 'countdensity', 'cumcount', 'cdf'].includes(s)) throw new MatlabError(`Invalid Normalization '${s}'`);
    return s;
  }],
  fontsize: ['fontSize', scalarValue],
  horizontalalignment: ['hAlign', (v, n) => textOf(v, n).toLowerCase()],
  verticalalignment: ['vAlign', (v, n) => textOf(v, n).toLowerCase()],
  capsize: ['capSize', scalarValue],
  linecolor: ['lineColor', colorValue],
  showtext: ['showText', (v, n) => {
    const s = textOf(v, n).toLowerCase();
    if (s !== 'on' && s !== 'off') throw new MatlabError(`${n} must be 'on' or 'off'`);
    return s === 'on';
  }],
  levellist: ['levelList', (v) => values(v)],
  resolution: ['resolution', scalarValue],
};
const LINE_PROPS = ['color', 'linewidth', 'linestyle', 'marker', 'markersize', 'markerfacecolor', 'markeredgecolor', 'displayname'];
// Accepted for compatibility but with no visual effect here.
const IGNORED_PROPS = new Set(['interpreter', 'fontweight', 'fontname', 'fontangle', 'linejoin', 'clipping', 'tag', 'visible', 'hittest', 'pickableparts']);

function parseProps(pairs, allowed, fname) {
  if (pairs.length % 2 !== 0) throw new MatlabError(`${fname}: property names and values must come in pairs (or an invalid line spec was given)`);
  const out = {};
  for (let i = 0; i < pairs.length; i += 2) {
    if (!isText(pairs[i])) throw new MatlabError(`${fname}: expected a property name`);
    const raw = pairs[i].toJSString();
    const key = raw.toLowerCase();
    if (IGNORED_PROPS.has(key)) continue;
    if (!allowed.includes(key) || !PROPS[key]) throw new MatlabError(`${fname}: unsupported property '${raw}'`);
    const [field, convert] = PROPS[key];
    out[field] = convert(pairs[i + 1], raw);
  }
  return out;
}

// ---------------- data arguments ----------------

// Splits plot-style arguments into data groups (X, Y, optional line
// spec), followed by Name,Value pairs: plot(Y), plot(X,Y,'r--'),
// plot(X1,Y1,X2,Y2,...), plot(..., 'LineWidth', 2).
function splitPlotArgs(args, fname) {
  const groups = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (isText(a)) {
      const spec = parseLinespec(a.toJSString());
      const last = groups[groups.length - 1];
      if (spec && last && !last.spec) { last.spec = spec; i++; continue; }
      break;
    }
    if (!(a instanceof Mat)) throw new MatlabError(`${fname}: data must be numeric`);
    const b = args[i + 1];
    if (b !== undefined && b instanceof Mat && !b.isChar) { groups.push({ x: a, y: b }); i += 2; }
    else { groups.push({ x: null, y: a }); i += 1; }
  }
  if (groups.length === 0) throw new MatlabError(`${fname}: not enough input arguments`);
  return { groups, pairs: args.slice(i) };
}

function columns(m) {
  const out = [];
  for (let c = 0; c < m.cols; c++) out.push(Array.from(m.re.subarray(c * m.rows, (c + 1) * m.rows)));
  return out;
}
function rowsOf(m) {
  const out = [];
  for (let r = 0; r < m.rows; r++) { const row = []; for (let c = 0; c < m.cols; c++) row.push(m.re[c * m.rows + r]); out.push(row); }
  return out;
}
const indexVector = (n) => Array.from({ length: n }, (_, k) => k + 1);

// The individual lines a data group describes, MATLAB-style: a matrix Y
// gives one line per column (or per row, when that's what matches X).
function groupLines(g, fname) {
  const { x, y } = g;
  if (!x) {
    if (y.isComplex) return [{ x: values(y), y: Array.from(y.im) }];
    if (y.isVector || y.isEmpty) return y.isEmpty ? [] : [{ x: indexVector(y.numel), y: values(y) }];
    return columns(y).map(col => ({ x: indexVector(y.rows), y: col }));
  }
  if (x.isVector && y.isVector) {
    if (x.numel !== y.numel) throw new MatlabError('Vectors must be the same length.');
    return [{ x: values(x), y: values(y) }];
  }
  if (x.isVector) {
    if (y.rows === x.numel) return columns(y).map(col => ({ x: values(x), y: col }));
    if (y.cols === x.numel) return rowsOf(y).map(r => ({ x: values(x), y: r }));
    throw new MatlabError('Vectors must be the same length.');
  }
  if (y.isVector) {
    if (x.rows === y.numel) return columns(x).map(col => ({ x: col, y: values(y) }));
    if (x.cols === y.numel) return rowsOf(x).map(r => ({ x: r, y: values(y) }));
    throw new MatlabError('Vectors must be the same length.');
  }
  if (x.rows !== y.rows || x.cols !== y.cols) throw new MatlabError(`${fname}: X and Y matrices must be the same size`);
  const xc = columns(x);
  return columns(y).map((col, k) => ({ x: xc[k], y: col }));
}

function makeLine(ctx, ax, xy, spec, props, type = 'line') {
  const auto = props.color === undefined && (!spec || spec.color === undefined);
  const marker = props.marker ?? spec?.marker ?? 'none';
  const lineStyle = props.lineStyle ?? spec?.lineStyle ?? (spec?.marker && props.marker === undefined ? 'none' : '-');
  return {
    h: nextHandle(ctx.interp), type, x: xy.x, y: xy.y,
    color: auto ? nextColor(ax) : (props.color ?? spec.color),
    lineWidth: props.lineWidth ?? 0.5, lineStyle, marker,
    markerSize: props.markerSize ?? 6,
    markerFaceColor: props.markerFaceColor ?? 'none',
    markerEdgeColor: props.markerEdgeColor ?? 'auto',
    displayName: props.displayName ?? null,
  };
}

// plot, semilogx/semilogy/loglog, stairs, polarplot.
function linePlot(fname, { kind = 'cartesian', xscale = null, yscale = null, shape = null } = {}) {
  return (args, nargout, ctx) => {
    const { groups, pairs } = splitPlotArgs(args, fname);
    const props = parseProps(pairs, LINE_PROPS, fname);
    const ax = prepareAxes(ctx, kind);
    if (xscale) ax.xscale = xscale;
    if (yscale) ax.yscale = yscale;
    const hs = [];
    for (const g of groups) {
      for (const xy of groupLines(g, fname)) {
        const obj = makeLine(ctx, ax, xy, g.spec, props);
        if (shape) obj.shape = shape;
        ax.objects.push(obj);
        hs.push(obj.h);
      }
    }
    touch(ctx);
    return nargout >= 1 ? [handlesMat(hs)] : [];
  };
}

// Pulls bare flags (e.g. 'filled', 'stacked') out of an argument list.
function takeFlags(args, flags) {
  const found = new Set();
  const rest = args.filter(a => {
    if (isText(a) && flags.includes(a.toJSString().toLowerCase())) { found.add(a.toJSString().toLowerCase()); return false; }
    return true;
  });
  return { rest, found };
}

// ---------------- histogram binning ----------------

function niceWidth(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

// Bin edges for histogram: explicit edges, a bin count, a bin width, or
// automatic (Scott's rule rounded to a "nice" width, like MATLAB's 'auto').
export function histogramEdges(data, { binEdges, numBins, binWidth } = {}) {
  if (binEdges) return binEdges;
  if (data.length === 0) return [0, 1];
  let mn = Math.min(...data), mx = Math.max(...data);
  if (numBins) {
    if (mn === mx) { mn -= 0.5; mx += 0.5; }
    return Array.from({ length: numBins + 1 }, (_, k) => mn + (mx - mn) * k / numBins);
  }
  let w = binWidth;
  if (!w) {
    const n = data.length;
    const mean = data.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(data.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1));
    w = niceWidth(sd > 0 ? 3.5 * sd / Math.cbrt(n) : 1);
  }
  const start = Math.floor(mn / w) * w;
  let end = Math.ceil(mx / w) * w;
  if (end <= start) end = start + w;
  const nb = Math.max(1, Math.round((end - start) / w));
  return Array.from({ length: nb + 1 }, (_, k) => start + k * w);
}

export function histogramCounts(data, edges) {
  const counts = new Array(edges.length - 1).fill(0);
  for (const v of data) {
    if (v < edges[0] || v > edges[edges.length - 1]) continue;
    let k = edges.length - 2;
    for (let i = 0; i < edges.length - 1; i++) if (v < edges[i + 1]) { k = i; break; }
    counts[k]++;
  }
  return counts;
}

function normalizeCounts(counts, edges, mode) {
  const n = counts.reduce((s, c) => s + c, 0) || 1;
  const width = (k) => edges[k + 1] - edges[k];
  let acc = 0;
  switch (mode) {
    case 'probability': return counts.map(c => c / n);
    case 'pdf': return counts.map((c, k) => c / (n * width(k)));
    case 'countdensity': return counts.map((c, k) => c / width(k));
    case 'cumcount': return counts.map(c => (acc += c));
    case 'cdf': return counts.map(c => (acc += c) / n);
    default: return counts;
  }
}

// ---------------- text (title/label strings) ----------------

function labelArgs(args, fname) {
  if (args.length === 0) throw new MatlabError(`${fname} requires a text argument`);
  const label = { text: textOf(args[0], fname) };
  const rest = args.slice(1);
  // title(str, subtitle) form.
  if (fname === 'title' && rest.length % 2 === 1 && (isText(rest[0]) || rest[0] instanceof Cell)) label.subtitle = textOf(rest.shift(), fname);
  const props = parseProps(rest, ['fontsize', 'color'], fname);
  if (props.fontSize) label.fontSize = props.fontSize;
  if (props.color && Array.isArray(props.color)) label.color = props.color;
  return label;
}

function onOff(args, current, fname) {
  if (args.length === 0) return !current;
  const s = textOf(args[0], fname).toLowerCase();
  if (s === 'on') return true;
  if (s === 'off') return false;
  throw new MatlabError(`${fname}: expected 'on' or 'off'`);
}

// Data range of an axes along x or y (used when limits are 'auto').
function dataRange(ax, dim) {
  let mn = Infinity, mx = -Infinity;
  const scan = (arr) => { for (const v of arr.flat()) if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); } };
  for (const o of ax.objects) {
    if (dim === 'z') { if (o.z) scan(o.z); continue; }
    if (o.type === 'histogram') { if (dim === 'x') scan(o.edges); else scan([0, ...o.values]); continue; }
    if (o.type === 'pie') continue;
    const horizontal = o.type === 'bar' && o.horizontal;
    const key = (dim === 'x') !== horizontal ? 'x' : 'y';
    if (o[key]) scan(o[key]);
    if (o.type === 'bar' && key === 'y') scan([0]);
  }
  if (mn === Infinity) return [0, 1];
  if (mn === mx) return [mn - 1, mx + 1];
  return [mn, mx];
}

// xlim/ylim: no argument returns the limits (set, or the data range when
// automatic); a vector sets them; 'auto' clears them.
function limitsArg(args, ax, key, fname, ctx) {
  if (args.length === 0) return [Mat.fromRows([ax[key] || dataRange(ax, key[0])])];
  const a = args[0];
  if (isText(a)) {
    const mode = a.toJSString().toLowerCase();
    if (mode === 'auto') ax[key] = null;
    else if (mode !== 'manual') throw new MatlabError(`${fname}: unsupported mode '${mode}'`);
  } else {
    const v = values(a);
    if (v.length !== 2 || !(v[0] < v[1])) throw new MatlabError(`${fname}: limits must be a 2-element vector of increasing values`);
    ax[key] = v;
  }
  touch(ctx);
  return [];
}

// ---------------- get / set ----------------

const toMat = (v) => {
  if (v instanceof Mat) return v;
  if (typeof v === 'string') return Mat.fromString(v);
  if (Array.isArray(v)) return Mat.fromRows([v]);
  if (typeof v === 'number') return Mat.scalar(v);
  if (v === null || v === undefined) return Mat.empty();
  return Mat.fromString(String(v));
};
const colorOut = (c) => (Array.isArray(c) ? Mat.fromRows([c]) : Mat.fromString(c));

// Supported properties per kind: name -> [getter, setter].
function propertyTable(found) {
  const { kind, obj, ax, fig } = found;
  if (kind === 'figure') {
    return {
      Name: [() => toMat(fig.name), (v) => { fig.name = textOf(v, 'Name'); }],
      Number: [() => Mat.scalar(fig.num), null],
      Colormap: [() => Mat.fromRows(fig.colormap || defaultColormap()), (v) => { fig.colormap = colormapValue(v); }],
    };
  }
  if (kind === 'axes') {
    const lim = (k) => [() => Mat.fromRows([ax[k] || dataRange(ax, k[0])]), (v) => {
      const a = values(v);
      if (a.length !== 2 || !(a[0] < a[1])) throw new MatlabError('Limits must be a 2-element vector of increasing values');
      ax[k] = a;
    }];
    const scale = (k) => [() => toMat(ax[k]), (v) => {
      const s = textOf(v, 'scale').toLowerCase();
      if (s !== 'linear' && s !== 'log') throw new MatlabError("Scale must be 'linear' or 'log'");
      ax[k] = s;
    }];
    return {
      XLim: lim('xlim'), YLim: lim('ylim'), ZLim: lim('zlim'), XScale: scale('xscale'), YScale: scale('yscale'),
      CLim: [() => Mat.fromRows([ax.clim || colorDataRange(ax)]), (v) => {
        const a = values(v);
        if (a.length !== 2 || !(a[0] < a[1])) throw new MatlabError('CLim must be a 2-element vector of increasing values');
        ax.clim = a;
      }],
      View: [() => Mat.fromRows([ax.view]), (v) => { const a = values(v); if (a.length !== 2) throw new MatlabError('View must be [azimuth elevation]'); ax.view = a; }],
      XGrid: [() => toMat(ax.grid ? 'on' : 'off'), (v) => { ax.grid = textOf(v, 'XGrid').toLowerCase() === 'on'; }],
      YGrid: [() => toMat(ax.grid ? 'on' : 'off'), (v) => { ax.grid = textOf(v, 'YGrid').toLowerCase() === 'on'; }],
      Box: [() => toMat(ax.box ? 'on' : 'off'), (v) => { ax.box = textOf(v, 'Box').toLowerCase() === 'on'; }],
    };
  }
  if (kind === 'text') {
    return {
      String: [() => toMat(obj.str), (v) => { obj.str = textOf(v, 'String'); }],
      Position: [() => Mat.fromRows([[obj.x, obj.y]]), (v) => { const a = values(v); obj.x = a[0]; obj.y = a[1]; }],
      FontSize: [() => Mat.scalar(obj.fontSize), (v) => { obj.fontSize = scalarValue(v, 'FontSize'); }],
      Color: [() => colorOut(obj.color), (v) => { obj.color = colorValue(v, 'Color'); }],
    };
  }
  const t = {
    DisplayName: [() => toMat(obj.displayName || ''), (v) => { obj.displayName = textOf(v, 'DisplayName'); }],
  };
  const data = (k) => [() => Mat.fromRows([obj[k]]), (v) => { obj[k] = values(v); }];
  const grid = (k) => [() => Mat.fromRows(obj[k]), (v) => { obj[k] = rowsOf(v); }];
  if (['line', 'stem', 'errorbar', 'scatter', 'bar', 'area', 'fill', 'line3', 'scatter3'].includes(obj.type)) { t.XData = data('x'); t.YData = data('y'); }
  if (['line3', 'scatter3'].includes(obj.type)) t.ZData = data('z');
  if (obj.type === 'surface') {
    Object.assign(t, {
      XData: grid('x'), YData: grid('y'), ZData: grid('z'), CData: grid('c'),
      FaceColor: [() => colorOut(obj.faceColor), (v) => { obj.faceColor = colorValue(v, 'FaceColor'); }],
      EdgeColor: [() => colorOut(obj.edgeColor), (v) => { obj.edgeColor = colorValue(v, 'EdgeColor'); }],
      FaceAlpha: [() => Mat.scalar(obj.faceAlpha), (v) => { obj.faceAlpha = scalarValue(v, 'FaceAlpha'); }],
    });
  }
  if (obj.type === 'image') t.CData = grid('c');
  if (obj.type === 'contour') {
    Object.assign(t, {
      ZData: grid('z'),
      LevelList: [() => Mat.fromRows([contourLevelValues(obj.z, obj.levels)]), (v) => { obj.levels = values(v); }],
      LineColor: [() => colorOut(obj.lineColor), (v) => { obj.lineColor = colorValue(v, 'LineColor'); }],
      LineWidth: [() => Mat.scalar(obj.lineWidth), (v) => { obj.lineWidth = scalarValue(v, 'LineWidth'); }],
      ShowText: [() => toMat(obj.showText ? 'on' : 'off'), (v) => { obj.showText = PROPS.showtext[1](v, 'ShowText'); }],
    });
  }
  if (['line', 'stem', 'errorbar', 'scatter', 'line3'].includes(obj.type)) {
    const prop = (k, conv, out = toMat) => [() => out(obj[k]), (v) => { obj[k] = conv(v, k); }];
    Object.assign(t, {
      Color: prop('color', colorValue, colorOut),
      LineWidth: prop('lineWidth', scalarValue),
      LineStyle: prop('lineStyle', PROPS.linestyle[1]),
      Marker: prop('marker', PROPS.marker[1]),
      MarkerSize: prop('markerSize', scalarValue),
      MarkerFaceColor: prop('markerFaceColor', colorValue, colorOut),
      MarkerEdgeColor: prop('markerEdgeColor', colorValue, colorOut),
    });
  }
  if (['bar', 'area', 'histogram', 'fill'].includes(obj.type)) {
    t.FaceColor = [() => colorOut(obj.faceColor), (v) => { obj.faceColor = colorValue(v, 'FaceColor'); }];
    t.EdgeColor = [() => colorOut(obj.edgeColor), (v) => { obj.edgeColor = colorValue(v, 'EdgeColor'); }];
  }
  return t;
}

function lookupProp(table, name, found) {
  const key = Object.keys(table).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key) {
    const what = found.kind === 'object' ? `${found.obj.type} objects` : `${found.kind} objects`;
    throw new MatlabError(`Property '${name}' is not supported for ${what} (supported: ${Object.keys(table).join(', ')})`);
  }
  return table[key];
}

function requireHandles(ctx, hv, fname) {
  if (!(hv instanceof Mat)) throw new MatlabError(`${fname}: first argument must be a graphics handle`);
  return values(hv).map(h => {
    const f = findHandle(ctx.interp, h);
    if (!f) throw new MatlabError(`${fname}: invalid or deleted graphics handle (${h})`);
    return f;
  });
}

// ---------------- subplot geometry ----------------

function cellRect(cell) {
  if (!cell) return { x0: 0, x1: 1, y0: 0, y1: 1 };
  return { x0: cell.c0 / cell.cols, x1: (cell.c1 + 1) / cell.cols, y0: cell.r0 / cell.rows, y1: (cell.r1 + 1) / cell.rows };
}
function sameCell(a, b) {
  if (!a || !b) return a === b;
  const ra = cellRect(a), rb = cellRect(b);
  return ['x0', 'x1', 'y0', 'y1'].every(k => Math.abs(ra[k] - rb[k]) < 1e-9);
}
function cellsOverlap(a, b) {
  const ra = cellRect(a), rb = cellRect(b), eps = 1e-9;
  return ra.x0 < rb.x1 - eps && rb.x0 < ra.x1 - eps && ra.y0 < rb.y1 - eps && rb.y0 < ra.y1 - eps;
}

// ---------------- registration ----------------

// Helpers shared with plotting3d.js.
export const plotKit = {
  isText, textOf, values, handlesMat, figureMap, currentFigure, currentAxes, prepareAxes,
  nextHandle, touch, parseProps, colorValue, scalarValue, colormapValue, defaultColormap,
  findHandle, requireHandles, onOff, columns, rowsOf, splitPlotArgs, makeLine, takeFlags,
  LINE_PROPS, labelArgs, limitsArg, nextColor,
};

const IMAGE_FORMATS = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', svg: 'svg' };

// Asks the host (the page) to render figure `num` to an image file in the
// Files panel. The worker can't draw, so this is a request; the file
// appears once the page has rendered it.
function exportFigure(ctx, num, name, format, dpi, fname) {
  const fig = figureMap(ctx.interp).get(num);
  if (!fig) throw new MatlabError(`${fname}: figure ${num} does not exist`);
  let fmt = format;
  if (!fmt) {
    const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1];
    if (!ext) throw new MatlabError(`${fname}: give the file an extension (.png, .jpg or .svg)`);
    fmt = ext.toLowerCase();
  }
  const f = IMAGE_FORMATS[fmt.toLowerCase()];
  if (!f) throw new MatlabError(`${fname}: unsupported format '${fmt}' (use png, jpg or svg)`);
  if (!/\.[A-Za-z0-9]+$/.test(name)) name += f === 'jpeg' ? '.jpg' : `.${f}`;
  if (!ctx.host.figures || !ctx.host.figures.export) throw new MatlabError(`${fname}: saving figures is only available in the browser app`);
  ctx.host.figures.export(num, fig, { name, format: f, width: 800, height: 600, scale: (dpi || 96) / 96 });
}

// The figure a handle refers to (a figure number, or an axes/object handle).
function figureOfHandle(ctx, h, fname) {
  const found = findHandle(ctx.interp, h);
  if (!found) throw new MatlabError(`${fname}: invalid graphics handle (${h})`);
  return found.fig.num;
}

// Busy-waits `seconds`: pause runs in the worker (or, without one, on the
// page), and plain synchronous code has no way to sleep there.
function sleepSync(seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { /* waiting */ }
}

export function registerPlotting(reg) {
  // ---- figures ----
  reg.set('figure', {
    fn: (args, nargout, ctx) => {
      const interp = ctx.interp;
      const figs = figureMap(interp);
      let rest = args;
      let num;
      if (rest.length && !isText(rest[0])) { num = Math.round(rest[0].toScalarNumber()); rest = rest.slice(1); }
      if (rest.length % 2 !== 0) throw new MatlabError('figure: property names and values must come in pairs');
      if (num === undefined) num = lowestUnusedFigure(interp);
      if (!(num >= 1)) throw new MatlabError('figure: figure number must be a positive integer');
      if (!figs.has(num)) figs.set(num, newFigure(num));
      const fig = figs.get(num);
      for (let i = 0; i < rest.length; i += 2) {
        // Only Name changes anything; layout properties (Position, Color, ...) are accepted and ignored.
        if (textOf(rest[i], 'figure property').toLowerCase() === 'name') fig.name = textOf(rest[i + 1], 'Name');
      }
      interp.figureState.current = num;
      touch(ctx, num);
      return nargout >= 1 ? [Mat.scalar(num)] : [];
    },
  });
  reg.set('gcf', { fn: (_a, _n, ctx) => [Mat.scalar(currentFigure(ctx).num)] });
  reg.set('gca', { fn: (_a, _n, ctx) => [Mat.scalar(currentAxes(ctx).h)] });
  reg.set('clf', {
    fn: (_a, _n, ctx) => {
      const fig = currentFigure(ctx);
      fig.axes = []; fig.current = null; fig.sgtitle = null;
      touch(ctx, fig.num);
      return [];
    },
  });
  reg.set('close', {
    fn: (args, _n, ctx) => {
      const interp = ctx.interp;
      const figs = figureMap(interp);
      let nums;
      if (args.length === 0) nums = interp.figureState.current !== undefined && figs.has(interp.figureState.current) ? [interp.figureState.current] : [];
      else if (isText(args[0]) && args[0].toJSString().toLowerCase() === 'all') nums = [...figs.keys()];
      else nums = values(args[0]).map(Math.round);
      for (const n of nums) {
        if (!figs.has(n)) continue;
        figs.delete(n);
        touch(ctx, n);
      }
      if (!figs.has(interp.figureState.current)) {
        const remaining = [...figs.keys()];
        interp.figureState.current = remaining.length ? Math.max(...remaining) : undefined;
      }
      return [];
    },
  });

  // subplot(m, n, p), subplot(mnp), p may list several cells to span.
  reg.set('subplot', {
    fn: (args, nargout, ctx) => {
      let m, n, p;
      if (args.length === 1) {
        const d = Math.round(args[0].toScalarNumber());
        if (d < 111 || d > 999) throw new MatlabError('subplot: expected subplot(m, n, p) or a three-digit subplot(mnp)');
        m = Math.floor(d / 100); n = Math.floor(d / 10) % 10; p = [d % 10];
      } else if (args.length >= 3) {
        m = Math.round(args[0].toScalarNumber()); n = Math.round(args[1].toScalarNumber()); p = values(args[2]).map(Math.round);
      } else throw new MatlabError('subplot: expected subplot(m, n, p)');
      if (!(m >= 1 && n >= 1) || p.length === 0 || p.some(k => !(k >= 1 && k <= m * n))) {
        throw new MatlabError(`subplot: index must be between 1 and ${m * n}`);
      }
      const rs = p.map(k => Math.floor((k - 1) / n)), cs = p.map(k => (k - 1) % n);
      const cell = { rows: m, cols: n, r0: Math.min(...rs), r1: Math.max(...rs), c0: Math.min(...cs), c1: Math.max(...cs) };
      const fig = currentFigure(ctx);
      let ax = fig.axes.find(a => sameCell(a.cell, cell));
      if (!ax) {
        // A new subplot replaces any axes it overlaps (as in MATLAB).
        fig.axes = fig.axes.filter(a => !cellsOverlap(a.cell, cell));
        ax = newAxes(ctx.interp, cell);
        fig.axes.push(ax);
      }
      fig.current = ax.h;
      touch(ctx, fig.num);
      return nargout >= 1 ? [Mat.scalar(ax.h)] : [];
    },
  });

  reg.set('sgtitle', {
    fn: (args, _n, ctx) => {
      const fig = currentFigure(ctx);
      fig.sgtitle = labelArgs(args, 'sgtitle');
      touch(ctx, fig.num);
      return [];
    },
  });

  reg.set('hold', {
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      if (args.length === 0) ax.hold = !ax.hold;
      else {
        const s = textOf(args[0], 'hold').toLowerCase();
        if (s === 'on' || s === 'all') ax.hold = true;
        else if (s === 'off') ax.hold = false;
        else throw new MatlabError("hold: expected 'on' or 'off'");
      }
      return [];
    },
  });
  reg.set('ishold', { fn: (_a, _n, ctx) => [Mat.logicalScalar(currentAxes(ctx).hold)] });

  // ---- line plots ----
  reg.set('plot', { fn: linePlot('plot') });
  reg.set('semilogx', { fn: linePlot('semilogx', { xscale: 'log' }) });
  reg.set('semilogy', { fn: linePlot('semilogy', { yscale: 'log' }) });
  reg.set('loglog', { fn: linePlot('loglog', { xscale: 'log', yscale: 'log' }) });
  reg.set('stairs', { fn: linePlot('stairs', { shape: 'hv' }) });
  reg.set('polarplot', { fn: linePlot('polarplot', { kind: 'polar' }) });

  reg.set('stem', {
    fn: (args, nargout, ctx) => {
      const { rest, found } = takeFlags(args, ['filled']);
      const { groups, pairs } = splitPlotArgs(rest, 'stem');
      const props = parseProps(pairs, LINE_PROPS, 'stem');
      const ax = prepareAxes(ctx, 'cartesian');
      const hs = [];
      for (const g of groups) {
        for (const xy of groupLines(g, 'stem')) {
          const obj = makeLine(ctx, ax, xy, g.spec, { marker: 'o', ...props }, 'stem');
          if (obj.lineStyle === 'none') obj.lineStyle = '-';
          if (found.has('filled') && props.markerFaceColor === undefined) obj.markerFaceColor = obj.color;
          ax.objects.push(obj);
          hs.push(obj.h);
        }
      }
      touch(ctx);
      return nargout >= 1 ? [handlesMat(hs)] : [];
    },
  });

  // errorbar(y, err), errorbar(x, y, err), errorbar(x, y, neg, pos), + line spec / Name,Value.
  reg.set('errorbar', {
    fn: (args, nargout, ctx) => {
      let i = 0;
      const nums = [];
      while (i < args.length && !isText(args[i])) nums.push(args[i++]);
      let spec;
      if (i < args.length && parseLinespec(args[i].toJSString())) spec = parseLinespec(args[i++].toJSString());
      const props = parseProps(args.slice(i), [...LINE_PROPS, 'capsize'], 'errorbar');
      let x, y, neg, pos;
      if (nums.length === 2) { [y, neg] = nums; pos = neg; }
      else if (nums.length === 3) { [x, y, neg] = nums; pos = neg; }
      else if (nums.length === 4) { [x, y, neg, pos] = nums; }
      else throw new MatlabError('errorbar: expected errorbar(y, err), errorbar(x, y, err) or errorbar(x, y, neg, pos)');
      const yv = values(y);
      const xv = x ? values(x) : indexVector(yv.length);
      const expand = (m) => (m.numel === 1 ? yv.map(() => m.re[0]) : values(m));
      const nv = expand(neg), pv = expand(pos);
      if (xv.length !== yv.length || nv.length !== yv.length || pv.length !== yv.length) throw new MatlabError('errorbar: inputs must be the same length');
      const ax = prepareAxes(ctx, 'cartesian');
      const obj = makeLine(ctx, ax, { x: xv, y: yv }, spec, props, 'errorbar');
      obj.neg = nv; obj.pos = pv; obj.capSize = props.capSize ?? 6;
      ax.objects.push(obj);
      touch(ctx);
      return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
    },
  });

  // scatter(x, y), scatter(x, y, sz), scatter(x, y, sz, c), 'filled', marker, Name,Value.
  reg.set('scatter', {
    fn: (args, nargout, ctx) => {
      if (args.length < 2) throw new MatlabError('scatter requires x and y');
      const x = values(args[0]), y = values(args[1]);
      if (x.length !== y.length) throw new MatlabError('scatter: X and Y must be the same length');
      let i = 2;
      let sizes = 36, color = null, colorValues = null;
      if (i < args.length && !isText(args[i])) {
        const s = args[i++];
        if (!s.isEmpty) sizes = s.numel === 1 ? s.re[0] : values(s);
      }
      if (i < args.length) {
        const c = args[i];
        if (!isText(c)) {
          i++;
          if (c.numel === 3 && x.length !== 3) color = values(c);
          else if (!c.isEmpty) colorValues = values(c);
        } else if (colorFromText(c.toJSString()) && !markerFromText(c.toJSString())) { color = colorFromText(c.toJSString()); i++; }
      }
      let filled = false, marker = 'o';
      while (i < args.length && isText(args[i])) {
        const t = args[i].toJSString();
        if (t.toLowerCase() === 'filled') { filled = true; i++; }
        else if (markerFromText(t) && markerFromText(t) !== 'none' && t.length === 1) { marker = markerFromText(t); i++; }
        else break;
      }
      const props = parseProps(args.slice(i), ['marker', 'markerfacecolor', 'markeredgecolor', 'linewidth', 'displayname', 'color'], 'scatter');
      const ax = prepareAxes(ctx, 'cartesian');
      const obj = {
        h: nextHandle(ctx.interp), type: 'scatter', x, y, sizes,
        color: props.color ?? color ?? (colorValues ? null : nextColor(ax)), colorValues,
        marker: props.marker ?? marker, filled,
        markerFaceColor: props.markerFaceColor ?? (filled ? 'flat' : 'none'),
        markerEdgeColor: props.markerEdgeColor ?? 'flat',
        lineWidth: props.lineWidth ?? 0.5, displayName: props.displayName ?? null,
      };
      ax.objects.push(obj);
      touch(ctx);
      return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
    },
  });

  // bar/barh(y), (x, y), (..., width), (..., 'grouped'|'stacked'), (..., color), Name,Value.
  const barFn = (fname, horizontal) => ({
    fn: (args, nargout, ctx) => {
      const { rest, found } = takeFlags(args, ['grouped', 'stacked']);
      const nums = [];
      let i = 0;
      while (i < rest.length && !isText(rest[i])) nums.push(rest[i++]);
      let color = null;
      if (i < rest.length && colorFromText(rest[i].toJSString()) && rest[i].toJSString().length === 1) color = colorFromText(rest[i++].toJSString());
      const props = parseProps(rest.slice(i), ['facecolor', 'edgecolor', 'barwidth', 'displayname'], fname);
      let x = null, y, width = 0.8;
      if (nums.length === 1) y = nums[0];
      else if (nums.length === 2 && nums[1].isScalar && !nums[0].isScalar) { y = nums[0]; width = nums[1].re[0]; }
      else if (nums.length >= 2) { x = nums[0]; y = nums[1]; if (nums.length >= 3) width = nums[2].toScalarNumber(); }
      else throw new MatlabError(`${fname}: not enough input arguments`);
      const series = y.isVector ? [values(y)] : columns(y);
      const n = series[0].length;
      const xv = x ? values(x) : indexVector(n);
      if (xv.length !== n) throw new MatlabError(`${fname}: X must have one value per bar`);
      const ax = prepareAxes(ctx, 'cartesian');
      const hs = series.map(yv => {
        const obj = {
          h: nextHandle(ctx.interp), type: 'bar', x: xv, y: yv, horizontal,
          layout: found.has('stacked') ? 'stacked' : 'grouped',
          barWidth: props.barWidth ?? width,
          faceColor: props.faceColor ?? color ?? nextColor(ax),
          edgeColor: props.edgeColor ?? [0, 0, 0],
          displayName: props.displayName ?? null,
        };
        ax.objects.push(obj);
        return obj.h;
      });
      touch(ctx);
      return nargout >= 1 ? [handlesMat(hs)] : [];
    },
  });
  reg.set('bar', barFn('bar', false));
  reg.set('barh', barFn('barh', true));

  reg.set('histogram', {
    fn: (args, nargout, ctx) => {
      if (args.length === 0) throw new MatlabError('histogram requires data');
      const data = values(args[0]).filter(Number.isFinite);
      let rest = args.slice(1);
      const opts = {};
      if (rest.length && !isText(rest[0])) {
        const b = rest.shift();
        if (b.numel === 1) opts.numBins = Math.round(b.re[0]); else opts.binEdges = values(b);
      }
      const props = parseProps(rest, ['numbins', 'binedges', 'binwidth', 'normalization', 'facecolor', 'facealpha', 'edgecolor', 'displayname'], 'histogram');
      Object.assign(opts, props.numBins ? { numBins: Math.round(props.numBins) } : {}, props.binEdges ? { binEdges: props.binEdges } : {}, props.binWidth ? { binWidth: props.binWidth } : {});
      const edges = histogramEdges(data, opts);
      const counts = histogramCounts(data, edges);
      const ax = prepareAxes(ctx, 'cartesian');
      const obj = {
        h: nextHandle(ctx.interp), type: 'histogram', edges,
        values: normalizeCounts(counts, edges, props.normalization || 'count'),
        faceColor: props.faceColor ?? nextColor(ax), faceAlpha: props.faceAlpha ?? 0.6,
        edgeColor: props.edgeColor ?? [0, 0, 0], displayName: props.displayName ?? null,
      };
      ax.objects.push(obj);
      touch(ctx);
      return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
    },
  });

  // Classic MATLAB `hist`: with no output args it plots a bar chart of
  // bin counts; with output args it returns [counts, centers] instead of
  // plotting (matching real hist's dual behavior).
  reg.set('hist', {
    fn: (args, nargout, ctx) => {
      const vals = values(args[0]);
      let centers;
      if (args.length >= 2 && args[1].numel > 1) {
        centers = values(args[1]);
      } else {
        const nbins = args.length >= 2 ? Math.round(args[1].toScalarNumber()) : 10;
        const mn = Math.min(...vals), mx = Math.max(...vals);
        const width = (mx - mn) / nbins || 1;
        centers = Array.from({ length: nbins }, (_, k) => mn + width * (k + 0.5));
      }
      const edges = centers.map((c, k) => (k === 0 ? -Infinity : (centers[k - 1] + c) / 2)).concat([Infinity]);
      const counts = new Array(centers.length).fill(0);
      for (const v of vals) {
        for (let k = 0; k < centers.length; k++) {
          if (v >= edges[k] && v < edges[k + 1]) { counts[k]++; break; }
          if (k === centers.length - 1 && v === edges[k + 1]) counts[k]++;
        }
      }
      if (nargout >= 1) {
        return nargout >= 2 ? [Mat.fromRows([counts]), Mat.fromRows([centers])] : [Mat.fromRows([counts])];
      }
      const ax = prepareAxes(ctx, 'cartesian');
      ax.objects.push({
        h: nextHandle(ctx.interp), type: 'bar', x: centers, y: counts, horizontal: false, layout: 'grouped',
        barWidth: 1, faceColor: nextColor(ax), edgeColor: [0, 0, 0], displayName: null,
      });
      touch(ctx);
      return [];
    },
  });

  // area(Y), area(X, Y): a matrix Y stacks one filled area per column.
  reg.set('area', {
    fn: (args, nargout, ctx) => {
      const nums = [];
      let i = 0;
      while (i < args.length && !isText(args[i])) nums.push(args[i++]);
      const props = parseProps(args.slice(i), ['facecolor', 'edgecolor', 'facealpha', 'displayname'], 'area');
      let x = null, y;
      if (nums.length === 1) y = nums[0];
      else if (nums.length === 2) [x, y] = nums;
      else throw new MatlabError('area: expected area(Y) or area(X, Y)');
      const series = y.isVector ? [values(y)] : columns(y);
      const xv = x ? values(x) : indexVector(series[0].length);
      const ax = prepareAxes(ctx, 'cartesian');
      const group = nextHandle(ctx.interp);
      const hs = series.map(yv => {
        if (yv.length !== xv.length) throw new MatlabError('area: X and Y must be the same length');
        const obj = {
          h: nextHandle(ctx.interp), type: 'area', x: xv, y: yv, group,
          faceColor: props.faceColor ?? nextColor(ax), faceAlpha: props.faceAlpha ?? 1,
          edgeColor: props.edgeColor ?? [0, 0, 0], displayName: props.displayName ?? null,
        };
        ax.objects.push(obj);
        return obj.h;
      });
      touch(ctx);
      return nargout >= 1 ? [handlesMat(hs)] : [];
    },
  });

  // fill(x, y, c): a filled polygon.
  reg.set('fill', {
    fn: (args, nargout, ctx) => {
      if (args.length < 3) throw new MatlabError('fill requires x, y and a color');
      const x = values(args[0]), y = values(args[1]);
      if (x.length !== y.length) throw new MatlabError('fill: X and Y must be the same length');
      const ax = prepareAxes(ctx, 'cartesian');
      const props = parseProps(args.slice(3), ['facecolor', 'edgecolor', 'facealpha', 'displayname'], 'fill');
      const obj = {
        h: nextHandle(ctx.interp), type: 'fill', x, y,
        faceColor: props.faceColor ?? colorValue(args[2], 'fill color'), faceAlpha: props.faceAlpha ?? 1,
        edgeColor: props.edgeColor ?? [0, 0, 0], displayName: props.displayName ?? null,
      };
      ax.objects.push(obj);
      touch(ctx);
      return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
    },
  });

  // pie(X), pie(X, labels)
  reg.set('pie', {
    fn: (args, nargout, ctx) => {
      if (args.length === 0) throw new MatlabError('pie requires data');
      const vals = values(args[0]);
      let labels = null;
      if (args.length >= 2) {
        const l = args[args.length - 1];
        if (l instanceof Cell && l.isCellstr()) labels = l.data.map(v => v.toJSString());
        if (labels && labels.length !== vals.length) throw new MatlabError('pie: there must be one label per slice');
      }
      const ax = prepareAxes(ctx, 'pie');
      const obj = { h: nextHandle(ctx.interp), type: 'pie', values: vals, labels, colors: vals.map(() => nextColor(ax)) };
      ax.objects.push(obj);
      touch(ctx);
      return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
    },
  });

  // text(x, y, str, Name, Value)
  reg.set('text', {
    fn: (args, nargout, ctx) => {
      if (args.length < 3) throw new MatlabError('text requires x, y and a string');
      const xs = values(args[0]), ys = values(args[1]);
      const strs = args[2] instanceof Cell && xs.length > 1 ? args[2].data.map(v => textOf(v, 'text')) : [textOf(args[2], 'text')];
      const props = parseProps(args.slice(3), ['fontsize', 'color', 'horizontalalignment', 'verticalalignment'], 'text');
      const ax = currentAxes(ctx);
      const hs = xs.map((x, k) => {
        const t = {
          h: nextHandle(ctx.interp), x, y: ys[k], str: strs[Math.min(k, strs.length - 1)],
          fontSize: props.fontSize ?? 10, color: Array.isArray(props.color) ? props.color : [0, 0, 0],
          hAlign: props.hAlign ?? 'left', vAlign: props.vAlign ?? 'middle',
        };
        ax.texts.push(t);
        return t.h;
      });
      touch(ctx);
      return nargout >= 1 ? [handlesMat(hs)] : [];
    },
  });

  // ---- axes decorations ----
  const labelFn = (key) => ({
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      ax[key] = labelArgs(args, key);
      touch(ctx);
      return [];
    },
  });
  reg.set('title', labelFn('title'));
  reg.set('xlabel', labelFn('xlabel'));
  reg.set('ylabel', labelFn('ylabel'));

  // legend(labels...), legend({labels}), legend('show'|'off'|'hide'|'toggle'|'boxoff'|'boxon'), 'Location', loc.
  reg.set('legend', {
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      let rest = args.slice();
      const locIdx = rest.findIndex(a => isText(a) && a.toJSString().toLowerCase() === 'location');
      if (locIdx >= 0) {
        if (locIdx + 1 >= rest.length) throw new MatlabError("legend: 'Location' needs a value");
        ax.legend.location = textOf(rest[locIdx + 1], 'Location').toLowerCase();
        rest.splice(locIdx, 2);
      }
      const cmd = rest.length === 1 && isText(rest[0]) ? rest[0].toJSString().toLowerCase() : null;
      if (cmd === 'off' || cmd === 'hide') ax.legend.show = false;
      else if (cmd === 'show') ax.legend.show = true;
      else if (cmd === 'toggle') ax.legend.show = !ax.legend.show;
      else if (cmd === 'boxoff' || cmd === 'boxon') ax.legend.boxOff = cmd === 'boxoff';
      else {
        const labels = rest.length === 1 && rest[0] instanceof Cell ? rest[0].data.map(v => textOf(v, 'legend label')) : rest.map(v => textOf(v, 'legend label'));
        labels.forEach((l, k) => { if (ax.objects[k]) ax.objects[k].displayName = l; });
        ax.legend.show = true;
      }
      touch(ctx);
      return [];
    },
  });

  reg.set('grid', {
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      if (args.length && textOf(args[0], 'grid').toLowerCase() === 'minor') { ax.minorGrid = !ax.minorGrid; ax.grid = ax.grid || ax.minorGrid; }
      else { ax.grid = onOff(args, ax.grid, 'grid'); if (!ax.grid) ax.minorGrid = false; }
      touch(ctx);
      return [];
    },
  });
  reg.set('box', {
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      ax.box = onOff(args, ax.box, 'box');
      touch(ctx);
      return [];
    },
  });

  reg.set('xlim', { fn: (args, _n, ctx) => limitsArg(args, currentAxes(ctx), 'xlim', 'xlim', ctx) });
  reg.set('ylim', { fn: (args, _n, ctx) => limitsArg(args, currentAxes(ctx), 'ylim', 'ylim', ctx) });

  // axis([xmin xmax ymin ymax (zmin zmax)]) | axis equal|image|square|tight|auto|normal|off|on|ij|xy
  reg.set('axis', {
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      if (args.length === 0) {
        const lims = [...(ax.xlim || dataRange(ax, 'x')), ...(ax.ylim || dataRange(ax, 'y'))];
        if (ax.kind === '3d') lims.push(...(ax.zlim || dataRange(ax, 'z')));
        return [Mat.fromRows([lims])];
      }
      for (const a of args) {
        if (isText(a)) {
          const mode = a.toJSString().toLowerCase();
          switch (mode) {
            case 'equal': ax.equal = true; break;
            case 'image': ax.equal = true; ax.xlim = null; ax.ylim = null; ax.zlim = null; break;
            case 'square': break; // aspect ratio of the box itself isn't controllable here; accepted and ignored
            case 'tight': case 'auto': ax.xlim = null; ax.ylim = null; ax.zlim = null; break;
            case 'normal': ax.equal = false; ax.ydir = 'normal'; break;
            case 'off': ax.visible = false; break;
            case 'on': ax.visible = true; break;
            case 'ij': ax.ydir = 'reverse'; break;
            case 'xy': ax.ydir = 'normal'; break;
            default: throw new MatlabError(`axis: unsupported mode '${mode}'`);
          }
        } else {
          const v = values(a);
          if ((v.length !== 4 && v.length !== 6) || !(v[0] < v[1]) || !(v[2] < v[3]) || (v.length === 6 && !(v[4] < v[5]))) {
            throw new MatlabError('axis: limits must be [xmin xmax ymin ymax] or [xmin xmax ymin ymax zmin zmax] with increasing pairs');
          }
          ax.xlim = [v[0], v[1]]; ax.ylim = [v[2], v[3]];
          if (v.length === 6) ax.zlim = [v[4], v[5]];
        }
      }
      touch(ctx);
      return [];
    },
  });

  const ticksFn = (key) => ({
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      if (args.length === 0) return [ax[key] ? Mat.fromRows([ax[key]]) : Mat.zeros(1, 0)];
      const a = args[0];
      if (isText(a) && a.toJSString().toLowerCase() === 'auto') ax[key] = null;
      else ax[key] = values(a);
      touch(ctx);
      return [];
    },
  });
  reg.set('xticks', ticksFn('xticks'));
  reg.set('yticks', ticksFn('yticks'));
  const tickLabelsFn = (key) => ({
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      const a = args[0];
      if (a === undefined) {
        const l = ax[key] || [];
        return [new Cell(l.length, 1, l.map(s => Mat.fromString(s)))];
      }
      if (isText(a) && a.toJSString().toLowerCase() === 'auto') ax[key] = null;
      else if (a instanceof Cell) ax[key] = a.data.map(v => textOf(v, key));
      else if (a instanceof Mat && !a.isChar) ax[key] = values(a).map(String);
      else ax[key] = [textOf(a, key)];
      touch(ctx);
      return [];
    },
  });
  reg.set('xticklabels', tickLabelsFn('xticklabels'));
  reg.set('yticklabels', tickLabelsFn('yticklabels'));

  // ---- saving figures ----
  // saveas(h, filename) | saveas(h, filename, format)
  reg.set('saveas', {
    fn: (args, _n, ctx) => {
      if (args.length < 2) throw new MatlabError('saveas: expected saveas(h, filename)');
      const num = figureOfHandle(ctx, args[0].toScalarNumber(), 'saveas');
      exportFigure(ctx, num, textOf(args[1], 'saveas: filename'), args[2] ? textOf(args[2], 'saveas: format') : null, null, 'saveas');
      return [];
    },
  });
  // exportgraphics(h, filename, 'Resolution', dpi)
  reg.set('exportgraphics', {
    fn: (args, _n, ctx) => {
      if (args.length < 2) throw new MatlabError('exportgraphics: expected exportgraphics(h, filename)');
      const num = figureOfHandle(ctx, args[0].toScalarNumber(), 'exportgraphics');
      let dpi = null;
      const rest = args.slice(2);
      for (let i = 0; i + 1 < rest.length; i += 2) {
        const key = textOf(rest[i], 'exportgraphics option').toLowerCase();
        if (key === 'resolution') dpi = scalarValue(rest[i + 1], 'Resolution');
        // ContentType, BackgroundColor, ... are accepted and ignored.
      }
      exportFigure(ctx, num, textOf(args[1], 'exportgraphics: filename'), null, dpi, 'exportgraphics');
      return [];
    },
  });
  // print(filename, '-dpng') | print(fig, filename, '-dsvg', '-r300') | print('-f2', ...)
  reg.set('print', {
    fn: (args, _n, ctx) => {
      let num = null, name = null, format = null, dpi = null;
      for (const a of args) {
        if (!isText(a)) { num = figureOfHandle(ctx, a.toScalarNumber(), 'print'); continue; }
        const t = a.toJSString();
        if (/^-d/i.test(t)) format = t.slice(2).toLowerCase();
        else if (/^-r\d+$/i.test(t)) dpi = Number(t.slice(2));
        else if (/^-f\d+$/i.test(t)) num = Number(t.slice(2));
        else if (t.startsWith('-')) { /* other print options are ignored */ }
        else name = t;
      }
      if (!name) throw new MatlabError('print: give a file name (printing to a printer is not supported)');
      if (num === null) num = currentFigure(ctx).num;
      exportFigure(ctx, num, name, format, dpi, 'print');
      return [];
    },
  });

  // ---- animation ----
  // drawnow: show the figures' current state now, mid-command.
  reg.set('drawnow', {
    fn: (_args, _n, ctx) => {
      if (ctx.host.figures && ctx.host.figures.flush) ctx.host.figures.flush();
      return [];
    },
  });
  // pause(seconds) also updates figures first; pause('off') turns pauses off.
  reg.set('pause', {
    fn: (args, _n, ctx) => {
      const interp = ctx.interp;
      let t = args.length && !isText(args[0]) ? args[0].toScalarNumber() : null;
      if (args.length && isText(args[0])) {
        const s = args[0].toJSString().toLowerCase();
        if (s.trim() !== '' && !Number.isNaN(Number(s))) t = Number(s); // command syntax: pause 2
        else if (s === 'on' || s === 'off') { interp.pauseEnabled = s === 'on'; return []; }
        else if (s === 'query') return [Mat.fromString(interp.pauseEnabled === false ? 'off' : 'on')];
        else throw new MatlabError(`pause: unknown option '${s}'`);
      }
      // A pause long enough to look at always shows the latest frame; short
      // ones in a tight loop are throttled like drawnow.
      const shows = args.length > 0 && interp.pauseEnabled !== false && t >= 0.03;
      if (ctx.host.figures && ctx.host.figures.flush) ctx.host.figures.flush(shows);
      if (args.length === 0) {
        if (!interp.warnedPauseKey) { interp.print('Warning: pause with no duration (wait for a key press) is not supported; continuing.\n'); interp.warnedPauseKey = true; }
        return [];
      }
      if (!(t >= 0)) throw new MatlabError('pause: the duration must be a non-negative number');
      if (interp.pauseEnabled !== false && Number.isFinite(t)) sleepSync(t);
      return [];
    },
  });

  // ---- handles: get / set / isgraphics ----
  reg.set('set', {
    fn: (args, _n, ctx) => {
      if (args.length < 3 || (args.length - 1) % 2 !== 0) throw new MatlabError('set: expected set(h, Name, Value, ...)');
      const targets = requireHandles(ctx, args[0], 'set');
      for (const found of targets) {
        const table = propertyTable(found);
        for (let i = 1; i < args.length; i += 2) {
          const name = textOf(args[i], 'property name');
          const [, setter] = lookupProp(table, name, found);
          if (!setter) throw new MatlabError(`Property '${name}' is read-only`);
          setter(args[i + 1]);
        }
        touch(ctx, found.fig.num);
      }
      return [];
    },
  });
  reg.set('get', {
    fn: (args, _n, ctx) => {
      if (args.length === 0) throw new MatlabError('get: expected get(h) or get(h, Name)');
      const targets = requireHandles(ctx, args[0], 'get');
      if (targets.length !== 1) throw new MatlabError('get: only one handle at a time is supported');
      const found = targets[0];
      const table = propertyTable(found);
      if (args.length === 1) {
        const names = Object.keys(table);
        return [StructArray.scalar(Object.fromEntries(names.map(n => [n, table[n][0]()])))];
      }
      const [getter] = lookupProp(table, textOf(args[1], 'property name'), found);
      return [getter()];
    },
  });
  reg.set('isgraphics', {
    fn: (args, _n, ctx) => {
      const h = args[0];
      const out = Mat.zeros(h.rows, h.cols);
      for (let k = 0; k < h.numel; k++) out.re[k] = findHandle(ctx.interp, h.re[k]) ? 1 : 0;
      out.isLogical = true;
      return [out];
    },
  });
}
