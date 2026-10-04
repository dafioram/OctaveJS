// backend.js — Runs the interpreter session (src/worker/session.js) in a
// Web Worker when possible, so long computations don't freeze the page and
// can be stopped. Falls back to running it on the page itself when a
// worker can't be created (typically when index.html is opened from
// file://); in that mode Stop is unavailable.

import { createSession } from '../worker/session.js';

export function createBackend(onMessage) {
  let worker = null;
  let inPage = null;
  let ready = false;
  let lastInit = null;

  function startInPage() {
    worker = null;
    // No snapshots in-page: they'd share live arrays, and there's no Stop.
    inPage = createSession((msg) => onMessage(msg), { snapshots: false });
    inPage.handle(lastInit);
  }

  function start(initMsg) {
    lastInit = initMsg;
    ready = false;
    try {
      worker = new Worker('./worker.js');
    } catch (e) {
      startInPage();
      return;
    }
    worker.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'ready') ready = true;
      onMessage(ev.data);
    };
    worker.onerror = (ev) => {
      // A worker that fails before it's ready (e.g. blocked script load)
      // means workers aren't usable here: switch to in-page mode.
      if (!ready) { ev.preventDefault(); worker.terminate(); startInPage(); }
    };
    worker.postMessage(initMsg);
  }

  return {
    start,
    send(msg) {
      if (worker) { worker.postMessage(msg); return; }
      // Defer so the page can paint (e.g. the echoed command) before running.
      setTimeout(() => {
        try { inPage.handle(msg); } catch (e) { onMessage({ type: 'print', text: `Internal error: ${e.message}\n` }); }
      }, 0);
    },
    get canStop() { return !!worker; },
    // Stop: kill the worker mid-command and start a fresh one from `initMsg`.
    restart(initMsg) {
      if (worker) worker.terminate();
      start(initMsg);
    },
  };
}
