// worker.js — Web Worker entry point: hosts the interpreter session off
// the page's main thread (see session.js for the message protocol).
import { createSession } from './session.js';

const session = createSession((msg) => self.postMessage(msg));

self.onmessage = (ev) => {
  try {
    session.handle(ev.data);
  } catch (e) {
    // Protocol/internal failures (MATLAB errors are reported via 'done').
    self.postMessage({ type: 'print', text: `Internal error: ${e && e.message ? e.message : e}\n` });
  }
};
