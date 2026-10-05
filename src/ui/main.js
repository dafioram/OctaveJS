// main.js — App entry point. Wires the interpreter session (running in a
// Web Worker — see backend.js / src/worker/session.js) up to the DOM: the
// Command Window REPL, the multi-file CodeMirror script editor, the
// Workspace / History / Files sidebar, the Plotly figures panel, and the
// File/Edit/View/Help menus. No framework — plain DOM, since the surface
// area here is small enough that a framework would add more ceremony than
// it would save.

import Plotly from 'plotly.js-dist-min';
import Papa from 'papaparse';

import { createBackend } from './backend.js';
import { openVfs, kindFor, isTextKind } from './vfs.js';
import { Mat, serializeValue } from '../core/values.js';

import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completeFromList, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { matlabLanguageSupport, matlabHighlighting, matlabCompletionWords } from './matlab-lang.js';
import { figureToPlotly } from '../plot/toPlotly.js';

const consoleOutputEl = document.getElementById('console-output');
const consoleInputEl = document.getElementById('console-input');
const stopBtn = document.getElementById('stop-button');
const busyEl = document.getElementById('busy-indicator');
const workspaceListEl = document.getElementById('workspace-list');
const filesListEl = document.getElementById('files-list');
const figureMountEl = document.getElementById('figure-mount');
const figureTabStripEl = document.getElementById('figure-tab-strip');
const editorTabsEl = document.getElementById('editor-tabs');

const EXAMPLE_SCRIPT = `% New script\nx = linspace(0, 2*pi, 100);\ny = sin(x);\nplot(x, y, 'b-');\nxlabel('x'); ylabel('sin(x)'); title('Example');\n`;

// ---------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------

function appendConsoleLine(text, cls = '') {
  const div = document.createElement('div');
  div.className = 'console-line' + (cls ? ' ' + cls : '');
  div.textContent = text.replace(/\n+$/, '');
  consoleOutputEl.appendChild(div);
  consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------------
// Session state mirror (used to restore the workspace after Stop)
// ---------------------------------------------------------------------
//
// The worker reports what changed after every command (`delta`). We keep
// the accumulated state here; Stop terminates the worker and starts a new
// one initialized from this mirror, i.e. from just before the command.

const mirror = {
  vars: new Map(), globalNames: [], globals: [], persistents: [], funcTable: [],
  figureState: { current: 1, hold: false }, figures: new Map(), settings: null,
};

function applyDelta(d) {
  if (!d) return;
  for (const [name, value] of d.vars) mirror.vars.set(name, value);
  for (const name of d.deleted) mirror.vars.delete(name);
  mirror.globalNames = d.globalNames;
  if (d.globals) mirror.globals = d.globals;
  if (d.persistents) mirror.persistents = d.persistents;
  if (d.funcTable) mirror.funcTable = d.funcTable;
  if (d.figureState) mirror.figureState = d.figureState;
  if (d.settings) mirror.settings = d.settings;
}

function initMessage() {
  return {
    type: 'init',
    files: [...vfs.files.entries()],
    snapshot: {
      vars: [...mirror.vars.entries()], globalNames: mirror.globalNames, globals: mirror.globals,
      persistents: mirror.persistents, funcTable: mirror.funcTable, figureState: mirror.figureState,
      figures: [...mirror.figures.entries()], settings: mirror.settings,
    },
  };
}

// ---------------------------------------------------------------------
// Running commands (one at a time; later ones queue)
// ---------------------------------------------------------------------

let backend = null;
let busy = false;
let nextRunId = 1;
const runQueue = [];
const varRequests = new Map(); // id -> callback
let pendingDownload = null;    // file to download once the session writes it

function setBusy(b) {
  busy = b;
  busyEl.classList.toggle('active', b);
  stopBtn.disabled = !b || !backend.canStop;
  stopBtn.title = backend && !backend.canStop ? 'Stop is unavailable here: this browser could not start a Web Worker, so commands run on the page itself' : 'Stop the running command (Ctrl+C)';
}

function enqueueRun(src) {
  runQueue.push(src);
  if (!busy) runNext();
}

function runNext() {
  if (runQueue.length === 0) { setBusy(false); return; }
  setBusy(true);
  backend.send({ type: 'run', id: nextRunId++, src: runQueue.shift() });
}

function stopRunning() {
  if (!busy || !backend.canStop) return;
  runQueue.length = 0;
  backend.restart(initMessage());
  appendConsoleLine('Operation terminated by user. The workspace was restored to its state before the command.', 'error');
  setBusy(false);
  // Figures go back to their pre-command state too (drawnow may have shown later frames).
  pendingFrames.clear();
  framesShown = false;
  for (const num of [...figurePlotDivs.keys()]) if (!mirror.figures.has(num)) closeFigure(num, { notifySession: false });
  for (const [num, fig] of mirror.figures) renderFigure(num, fig);
}
stopBtn.addEventListener('click', stopRunning);

function handleMessage(msg) {
  switch (msg.type) {
    case 'ready':
      renderWorkspace(msg.workspace);
      return;
    case 'print':
      if (msg.text) appendConsoleLine(msg.text);
      return;
    case 'clc':
      consoleOutputEl.innerHTML = '';
      return;
    case 'fileWritten':
      saveFile(msg.name, msg.entry, { sync: false });
      if (pendingDownload === msg.name) { pendingDownload = null; downloadFile(msg.name); }
      return;
    case 'done':
      if (msg.error) appendConsoleLine(msg.error, 'error');
      applyDelta(msg.delta);
      renderWorkspace(msg.workspace);
      for (const { num, fig } of msg.figures) {
        if (fig) mirror.figures.set(num, fig); else mirror.figures.delete(num);
      }
      pendingFrames.clear(); // the final state supersedes any undrawn frame
      framesShown = false;
      showFigures(msg.figures);
      runNext();
      return;
    case 'figures':
      showFrame(msg.figures);
      return;
    case 'exportFigure':
      exportFigureToFile(msg.fig, msg.request);
      return;
    case 'workspace':
      applyDelta(msg.delta);
      renderWorkspace(msg.workspace);
      return;
    case 'var': {
      const cb = varRequests.get(msg.id);
      varRequests.delete(msg.id);
      if (cb) cb(msg.value);
      return;
    }
  }
}

// ---------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------

const figurePlotDivs = new Map(); // figNum -> div element
let activeFigureNum = null;

// After a command finishes, draw each figure it touched once (with its
// final state), then bring it into view — straight to it if there's one,
// or a ~1s-paced flip through all of them in order if there are several.
function showFigures(entries) {
  const drawn = [];
  for (const { num, fig } of entries) {
    // A figure the session reports as gone was closed by code (close, close all).
    if (!fig) { if (figurePlotDivs.has(num)) closeFigure(num, { notifySession: false }); continue; }
    renderFigure(num, fig);
    drawn.push(num);
  }
  if (drawn.length === 0) return;
  switchTab('figures');
  let i = 0;
  const showNext = () => {
    if (i >= drawn.length) return;
    switchFigureTab(drawn[i]);
    i++;
    if (i < drawn.length) setTimeout(showNext, 1000);
  };
  showNext();
}

const figureNames = new Map(); // figNum -> figure('Name', ...) title, if any

// A mid-command update (drawnow / pause): draw the changed figures without
// the end-of-command tab tour. Only the newest state of each figure is
// kept and drawn once per animation frame, so a fast loop can't queue up
// more renders than Plotly can keep up with.
const pendingFrames = new Map();
let frameScheduled = false;
let framesShown = false; // only a command's first frame switches to the Figures tab, so Stop stays reachable

function showFrame(entries) {
  for (const { num, fig } of entries) { pendingFrames.delete(num); pendingFrames.set(num, fig); }
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(drawPendingFrames);
}

function drawPendingFrames() {
  frameScheduled = false;
  const entries = [...pendingFrames].map(([num, fig]) => ({ num, fig }));
  pendingFrames.clear();
  let last = null;
  for (const { num, fig } of entries) {
    if (!fig) { if (figurePlotDivs.has(num)) closeFigure(num, { notifySession: false }); continue; }
    renderFigure(num, fig);
    last = num;
  }
  if (last === null || framesShown) return;
  framesShown = true;
  switchTab('figures');
  if (activeFigureNum !== last) switchFigureTab(last);
}

function dataUrlToBytes(url) {
  const comma = url.indexOf(',');
  const meta = url.slice(0, comma), body = url.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bin = atob(body);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

// saveas / exportgraphics / print: render the figure off-screen with
// Plotly and save the image into Files (white background, like MATLAB).
async function exportFigureToFile(fig, request) {
  try {
    const { data, layout } = figureToPlotly(fig);
    const fullLayout = Object.assign({
      paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
      font: { family: 'Helvetica, Arial, sans-serif', size: 12, color: '#262626' },
    }, layout, { width: request.width, height: request.height });
    const url = await Plotly.toImage({ data, layout: fullLayout }, { format: request.format, width: request.width, height: request.height, scale: request.scale });
    saveFile(request.name, { kind: 'binary', bytes: dataUrlToBytes(url) });
  } catch (e) {
    appendConsoleLine(`Could not save ${request.name}: ${e && e.message ? e.message : e}`, 'error');
  }
}

function renderFigure(figNum, fig) {
  const { data, layout } = figureToPlotly(fig);
  figureNames.set(figNum, fig.name || '');
  if (!figurePlotDivs.has(figNum)) {
    const div = document.createElement('div');
    div.className = 'figure-plot';
    div.style.display = 'none';
    figureMountEl.appendChild(div);
    figurePlotDivs.set(figNum, div);
    const emptyMsg = figureMountEl.querySelector('.figure-empty');
    if (emptyMsg) emptyMsg.remove();
  }
  const div = figurePlotDivs.get(figNum);
  const plotlyLayout = Object.assign({
    paper_bgcolor: '#fffdf9', plot_bgcolor: '#ffffff',
    font: { family: 'ui-monospace, SFMono-Regular, Menlo, monospace', size: 12, color: '#2b2822' },
  }, layout);
  Plotly.react(div, data, plotlyLayout, { responsive: true, displaylogo: false });
  if (activeFigureNum === null) switchFigureTab(figNum);
  else rebuildFigureTabStrip();
}

function rebuildFigureTabStrip() {
  figureTabStripEl.innerHTML = '';
  for (const figNum of [...figurePlotDivs.keys()].sort((a, b) => a - b)) {
    const tab = document.createElement('div');
    tab.className = 'figure-tab' + (figNum === activeFigureNum ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'figure-tab-label';
    label.textContent = figureNames.get(figNum) ? `Figure ${figNum}: ${figureNames.get(figNum)}` : `Figure ${figNum}`;
    label.onclick = () => switchFigureTab(figNum);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'figure-tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close figure';
    closeBtn.setAttribute('aria-label', `Close Figure ${figNum}`);
    closeBtn.onclick = (ev) => { ev.stopPropagation(); closeFigure(figNum); };
    tab.appendChild(label);
    tab.appendChild(closeBtn);
    figureTabStripEl.appendChild(tab);
  }
}

function switchFigureTab(figNum) {
  if (!figurePlotDivs.has(figNum)) return;
  activeFigureNum = figNum;
  for (const [n, div] of figurePlotDivs.entries()) div.style.display = (n === figNum) ? 'block' : 'none';
  rebuildFigureTabStrip();
  // A figure drawn while its div was display:none gets laid out against a
  // zero-size container, which makes Plotly silently skip title/axis-label
  // positioning. Recompute a frame later, once it has real dimensions.
  const activeDiv = figurePlotDivs.get(figNum);
  requestAnimationFrame(() => {
    try { Plotly.Plots.resize(activeDiv); } catch (e) { /* figure may have been closed by the time this fires */ }
  });
}

function closeFigure(figNum, { notifySession = true } = {}) {
  const div = figurePlotDivs.get(figNum);
  if (div) {
    try { Plotly.purge(div); } catch (e) { /* ignore */ }
    div.remove();
    figurePlotDivs.delete(figNum);
  }
  figureNames.delete(figNum);
  mirror.figures.delete(figNum);
  if (notifySession) backend.send({ type: 'closeFigure', num: figNum });
  if (figurePlotDivs.size === 0) {
    activeFigureNum = null;
    figureMountEl.innerHTML = '<div class="figure-empty">No figures yet — try <code>plot(1:10, sin(1:10))</code> in the Command Window.</div>';
    rebuildFigureTabStrip();
    return;
  }
  if (activeFigureNum === figNum) {
    const remaining = [...figurePlotDivs.keys()].sort((a, b) => a - b);
    switchFigureTab(remaining[remaining.length - 1]);
  } else {
    rebuildFigureTabStrip();
  }
}

// ---------------------------------------------------------------------
// Workspace panel
// ---------------------------------------------------------------------

function renderWorkspace(vars) {
  workspaceListEl.innerHTML = '';
  if (!vars || vars.length === 0) {
    workspaceListEl.innerHTML = '<div class="workspace-empty">No variables yet</div>';
    return;
  }
  for (const { name, size, cls } of vars) {
    const row = document.createElement('div');
    row.className = 'workspace-row';
    const main = document.createElement('div');
    main.className = 'workspace-row-main';
    const nameEl = document.createElement('span');
    nameEl.className = 'var-name';
    nameEl.textContent = name;
    const delBtn = document.createElement('button');
    delBtn.className = 'var-delete';
    delBtn.textContent = '×';
    delBtn.title = `Delete ${name}`;
    delBtn.setAttribute('aria-label', `Delete variable ${name}`);
    delBtn.onclick = (ev) => { ev.stopPropagation(); backend.send({ type: 'deleteVar', name }); };
    main.appendChild(nameEl);
    main.appendChild(delBtn);
    const meta = document.createElement('div');
    meta.className = 'var-meta';
    meta.textContent = `${size}  ${cls}`;
    row.appendChild(main);
    row.appendChild(meta);
    row.onclick = () => showVariable(name);
    workspaceListEl.appendChild(row);
  }
}

function showVariable(name) {
  if (busy) { appendConsoleLine('The variable viewer is unavailable while a command is running.', 'error'); return; }
  const id = nextRunId++;
  varRequests.set(id, (value) => { if (value) showVariableModal(name, value); });
  backend.send({ type: 'getVar', id, name });
}

function fmtNum(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Inf' : '-Inf';
  return Number.isInteger(x) ? String(x) : Number(x.toPrecision(5)).toString();
}

function showVariableModal(name, v) {
  let body;
  if (v.kind === 'matrix') {
    let html = '<table><tbody>';
    for (let r = 0; r < v.rows; r++) {
      html += '<tr>';
      for (let c = 0; c < v.cols; c++) {
        const re = v.re[c * v.rows + r];
        const im = v.im ? v.im[c * v.rows + r] : 0;
        html += `<td>${im !== 0 ? `${fmtNum(re)}${im < 0 ? '-' : '+'}${fmtNum(Math.abs(im))}i` : fmtNum(re)}</td>`;
      }
      html += '</tr>';
    }
    body = html + '</tbody></table>';
  } else {
    body = `<pre class="modal-pre">${escapeHtml(v.text)}</pre>`;
  }
  const box = document.getElementById('modal-box');
  box.innerHTML = `<button class="modal-close" data-action="close-modal">&times;</button><h2>${escapeHtml(name)} <small style="color:var(--ink-faint);font-weight:normal;">(${escapeHtml(v.size)} ${escapeHtml(v.cls)})</small></h2>${body}`;
  openModal();
}

// ---------------------------------------------------------------------
// Sidebar: Workspace / History / Files sub-tabs
// ---------------------------------------------------------------------

function switchSidebar(name) {
  document.querySelectorAll('.sidebar-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === name));
  document.querySelectorAll('.sidebar-view').forEach(v => v.classList.toggle('active', v.dataset.subview === name));
}
document.getElementById('sidebar-subtabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.sidebar-subtab');
  if (btn) switchSidebar(btn.dataset.subtab);
});

const HISTORY_KEY = 'matweb_history';
let history_ = [];
try { history_ = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { history_ = []; }
let historyPos = history_.length;

function pushHistory(cmd) {
  history_.push(cmd);
  historyPos = history_.length;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history_.slice(-500))); } catch (e) { /* storage may be unavailable; history just won't persist */ }
  renderHistoryList();
}

function renderHistoryList() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '';
  if (history_.length === 0) {
    listEl.innerHTML = '<div class="workspace-empty">No commands yet</div>';
    return;
  }
  // Most recent first — quickest to find and re-run something you just typed.
  for (let i = history_.length - 1; i >= 0; i--) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.textContent = history_[i];
    row.title = 'Click to run again';
    row.onclick = () => runCommand(history_[i]);
    listEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------
// Files (saved in IndexedDB, mirrored into the session)
// ---------------------------------------------------------------------

let vfs = null;

function fileSizeStr(entry) {
  const n = entry.text !== undefined ? entry.text.length : (entry.bytes ? entry.bytes.length : 0);
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Saves a file to IndexedDB and (unless it came from the session itself)
// to the session's file store.
function saveFile(name, entry, { sync = true } = {}) {
  const rec = vfs.put(name, entry);
  if (sync) backend.send({ type: 'putFile', name, entry: rec });
  renderFilesList();
}

function deleteFile(name) {
  vfs.remove(name);
  backend.send({ type: 'deleteFile', name });
  if (openTabs.includes(name)) closeTab(name, { force: true });
  renderFilesList();
}

function downloadFile(name) {
  const entry = vfs.files.get(name);
  if (!entry) return;
  const blob = entry.text !== undefined
    ? new Blob([entry.text], { type: 'text/plain' })
    : new Blob([entry.bytes], { type: 'application/octet-stream' });
  downloadBlob(name, blob);
}

function renderFilesList() {
  filesListEl.innerHTML = '';
  const names = [...vfs.files.keys()].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    filesListEl.innerHTML = '<div class="workspace-empty">No files yet</div>';
    return;
  }
  for (const name of names) {
    const entry = vfs.files.get(name);
    const row = document.createElement('div');
    row.className = 'workspace-row file-row';
    const main = document.createElement('div');
    main.className = 'workspace-row-main';
    const nameEl = document.createElement('span');
    nameEl.className = 'var-name';
    nameEl.textContent = name;
    const actions = document.createElement('span');
    actions.className = 'file-actions';
    const dl = document.createElement('button');
    dl.className = 'var-delete';
    dl.textContent = '⤓';
    dl.title = `Download ${name}`;
    dl.setAttribute('aria-label', `Download ${name}`);
    dl.onclick = (ev) => { ev.stopPropagation(); downloadFile(name); };
    const del = document.createElement('button');
    del.className = 'var-delete';
    del.textContent = '×';
    del.title = `Delete ${name}`;
    del.setAttribute('aria-label', `Delete ${name}`);
    del.onclick = (ev) => { ev.stopPropagation(); if (confirm(`Delete ${name}?`)) deleteFile(name); };
    actions.appendChild(dl);
    actions.appendChild(del);
    main.appendChild(nameEl);
    main.appendChild(actions);
    const meta = document.createElement('div');
    meta.className = 'var-meta';
    meta.textContent = fileSizeStr(entry);
    row.appendChild(main);
    row.appendChild(meta);
    if (entry.kind === 'm') { row.title = 'Open in the Script Editor'; row.onclick = () => openTab(name); }
    filesListEl.appendChild(row);
  }
  if (!vfs.persistent) {
    const note = document.createElement('div');
    note.className = 'workspace-empty';
    note.textContent = 'Browser storage is unavailable, so files will be lost when the page closes.';
    filesListEl.appendChild(note);
  }
}

async function uploadFiles(fileList, { open = false } = {}) {
  for (const file of fileList) {
    const kind = kindFor(file.name);
    const entry = isTextKind(kind) ? { kind, text: await file.text() } : { kind, bytes: new Uint8Array(await file.arrayBuffer()) };
    saveFile(file.name, entry);
    if (open && kind === 'm') openTab(file.name);
  }
}

function uniqueName(base, ext) {
  let name = `${base}${ext}`;
  for (let k = 2; vfs.files.has(name); k++) name = `${base}${k}${ext}`;
  return name;
}

// ---------------------------------------------------------------------
// Script editor (CodeMirror 6), one tab per open .m file
// ---------------------------------------------------------------------

const TABS_KEY = 'matweb_open_tabs';
let openTabs = [];
let activeFile = null;
const editorStates = new Map(); // file name -> EditorState
let saveTimer = null;

const matlabSupport = matlabLanguageSupport();
const editorExtensions = [
  lineNumbers(), history(), drawSelection(), dropCursor(), rectangularSelection(), crosshairCursor(),
  highlightActiveLine(), highlightSelectionMatches(), indentOnInput(), bracketMatching(), closeBrackets(),
  matlabSupport, ...matlabHighlighting,
  matlabSupport.language.data.of({ autocomplete: completeFromList(matlabCompletionWords.map(label => ({ label, type: 'keyword' }))) }),
  autocompletion(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
  EditorView.theme({ '&': { height: '100%' } }),
  // Edits are saved automatically, shortly after typing stops.
  EditorView.updateListener.of((u) => { if (u.docChanged) scheduleSave(); }),
];

const editorView = new EditorView({ parent: document.getElementById('editor-mount'), state: EditorState.create({ doc: '', extensions: editorExtensions }) });

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!activeFile) return;
  const text = editorView.state.doc.toString();
  const cur = vfs.files.get(activeFile);
  if (!cur || cur.text !== text) saveFile(activeFile, { kind: 'm', text });
}

function persistTabs() {
  try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: openTabs, active: activeFile })); } catch (e) { /* not critical */ }
}

function openTab(name) {
  if (!vfs.files.has(name)) return;
  flushSave();
  if (activeFile) editorStates.set(activeFile, editorView.state);
  if (!openTabs.includes(name)) openTabs.push(name);
  if (!editorStates.has(name)) editorStates.set(name, EditorState.create({ doc: vfs.files.get(name).text || '', extensions: editorExtensions }));
  activeFile = name;
  editorView.setState(editorStates.get(name));
  document.getElementById('editor-filename').textContent = name;
  renderEditorTabs();
  persistTabs();
  switchTab('editor');
}

function closeTab(name, { force = false } = {}) {
  if (!force && name === activeFile) flushSave();
  openTabs = openTabs.filter(n => n !== name);
  editorStates.delete(name);
  if (activeFile === name) {
    activeFile = null;
    if (openTabs.length) openTab(openTabs[openTabs.length - 1]);
    else {
      editorView.setState(EditorState.create({ doc: '', extensions: editorExtensions }));
      document.getElementById('editor-filename').textContent = '(no file open)';
    }
  }
  renderEditorTabs();
  persistTabs();
}

function renderEditorTabs() {
  editorTabsEl.innerHTML = '';
  for (const name of openTabs) {
    const tab = document.createElement('div');
    tab.className = 'figure-tab editor-tab' + (name === activeFile ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'figure-tab-label';
    label.textContent = name;
    label.onclick = () => openTab(name);
    const close = document.createElement('button');
    close.className = 'figure-tab-close';
    close.textContent = '×';
    close.title = `Close ${name}`;
    close.setAttribute('aria-label', `Close ${name}`);
    close.onclick = (ev) => { ev.stopPropagation(); closeTab(name); };
    tab.appendChild(label);
    tab.appendChild(close);
    editorTabsEl.appendChild(tab);
  }
}

function newScript() {
  const name = uniqueName('untitled', '.m');
  saveFile(name, { kind: 'm', text: '' });
  openTab(name);
}

function renameActiveFile() {
  if (!activeFile) return;
  flushSave();
  let name = prompt('Rename script:', activeFile);
  if (name === null) return;
  name = name.trim();
  if (!name || name === activeFile) return;
  if (!/\.m$/i.test(name)) name += '.m';
  if (!/^[A-Za-z][A-Za-z0-9_]*\.m$/.test(name)) { alert('Script names must start with a letter and contain only letters, digits and underscores.'); return; }
  if (vfs.files.has(name) && !confirm(`${name} already exists. Replace it?`)) return;
  const old = activeFile;
  const state = editorView.state;
  saveFile(name, { kind: 'm', text: state.doc.toString() });
  vfs.remove(old);
  backend.send({ type: 'deleteFile', name: old });
  openTabs = openTabs.map(n => (n === old ? name : n)).filter((n, i, all) => all.indexOf(n) === i);
  editorStates.delete(old);
  editorStates.set(name, state);
  activeFile = name;
  document.getElementById('editor-filename').textContent = name;
  renderEditorTabs();
  renderFilesList();
  persistTabs();
}
document.getElementById('editor-filename').addEventListener('click', renameActiveFile);

function runFullScript() {
  if (!activeFile) return;
  flushSave();
  const cmd = `run('${activeFile.replace(/'/g, "''")}')`;
  switchTab('command');
  appendConsoleLine(cmd, 'echo');
  pushHistory(cmd);
  enqueueRun(cmd);
}

function runSelectionOrAll() {
  const sel = editorView.state.selection.main;
  if (sel.from === sel.to) { runFullScript(); return; } // no selection -> same as Run
  const text = editorView.state.sliceDoc(sel.from, sel.to);
  switchTab('command');
  // Not pushed to history: a selection snippet isn't reliably re-runnable
  // later the way a named script or typed command is.
  appendConsoleLine(`% running ${text.split('\n').length} selected line(s) from ${activeFile}`, 'echo');
  enqueueRun(text);
}

document.querySelector('[data-action="run-script"]').addEventListener('click', runFullScript);
document.querySelector('[data-action="run-selection"]').addEventListener('click', runSelectionOrAll);

// ---------------------------------------------------------------------
// Command window (REPL)
// ---------------------------------------------------------------------

function runCommand(cmd) {
  if (!cmd.trim()) return;
  switchTab('command');
  appendConsoleLine(cmd, 'echo');
  pushHistory(cmd);
  enqueueRun(cmd);
}

consoleInputEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    const cmd = consoleInputEl.value;
    consoleInputEl.value = '';
    runCommand(cmd);
  } else if (ev.key === 'ArrowUp') {
    if (historyPos > 0) { historyPos--; consoleInputEl.value = history_[historyPos] || ''; }
    ev.preventDefault();
  } else if (ev.key === 'ArrowDown') {
    if (historyPos < history_.length) { historyPos++; consoleInputEl.value = history_[historyPos] || ''; }
    ev.preventDefault();
  } else if (ev.key === 'c' && ev.ctrlKey && busy && consoleInputEl.selectionStart === consoleInputEl.selectionEnd) {
    // Ctrl+C with nothing selected stops the running command, like MATLAB.
    ev.preventDefault();
    stopRunning();
  }
});

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll('.tab-button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'command') setTimeout(() => consoleInputEl.focus(), 0);
  if (name === 'editor') editorView.focus();
}
document.getElementById('tab-bar').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.tab-button');
  if (btn) switchTab(btn.dataset.tab);
});

// ---------------------------------------------------------------------
// Menu bar
// ---------------------------------------------------------------------

const menubar = document.getElementById('menubar');
menubar.addEventListener('click', (ev) => {
  const menuItem = ev.target.closest('.menu-item');
  const actionBtn = ev.target.closest('[data-action]');
  if (actionBtn) {
    handleMenuAction(actionBtn.dataset.action);
    closeAllMenus();
    return;
  }
  if (menuItem) {
    const wasOpen = menuItem.classList.contains('open');
    closeAllMenus();
    if (!wasOpen) menuItem.classList.add('open');
  }
});
document.addEventListener('click', (ev) => { if (!ev.target.closest('.menu-item')) closeAllMenus(); });
function closeAllMenus() { document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open')); }

function handleMenuAction(action) {
  switch (action) {
    case 'new-script': newScript(); break;
    case 'open-m': document.getElementById('file-input-m').click(); break;
    case 'save-m': if (activeFile) { flushSave(); downloadFile(activeFile); } break;
    case 'upload-files': document.getElementById('file-input-any').click(); break;
    case 'import-csv': document.getElementById('file-input-csv').click(); break;
    case 'open-mat': document.getElementById('file-input-mat').click(); break;
    case 'save-mat':
      pendingDownload = 'workspace.mat';
      runCommand("save('workspace.mat')");
      break;
    case 'clear-workspace':
      if (confirm('Clear all variables from the workspace?')) backend.send({ type: 'clearVars' });
      break;
    case 'clear-console': consoleOutputEl.innerHTML = ''; break;
    case 'clear-history':
      if (confirm('Clear command history?')) {
        history_ = []; historyPos = 0;
        try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* ignore */ }
        renderHistoryList();
      }
      break;
    case 'focus-command': switchTab('command'); break;
    case 'focus-editor': switchTab('editor'); break;
    case 'focus-figures': switchTab('figures'); break;
    case 'focus-files': switchSidebar('files'); break;
    case 'show-help': showHelpModal(); break;
    case 'show-about': showAboutModal(); break;
    case 'close-modal': closeModal(); break;
  }
}

document.getElementById('file-input-m').addEventListener('change', async (ev) => {
  await uploadFiles(ev.target.files, { open: true });
  ev.target.value = '';
});

document.getElementById('file-input-any').addEventListener('change', async (ev) => {
  await uploadFiles(ev.target.files);
  switchSidebar('files');
  ev.target.value = '';
});

document.getElementById('file-input-csv').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const text = await file.text();
  saveFile(file.name, { kind: 'text', text });
  const results = Papa.parse(text);
  const rows = results.data
    .filter(row => row.some(cell => String(cell).trim() !== ''))
    .map(row => row.map(cell => parseFloat(cell)));
  const varName = prompt(`Import "${file.name}" as which variable name?`, 'data') || 'data';
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(varName)) { appendConsoleLine(`'${varName}' is not a valid variable name.`, 'error'); return; }
  backend.send({ type: 'setVar', name: varName, value: serializeValue(Mat.fromRows(rows)) });
  appendConsoleLine(`Imported ${file.name} as ${varName} (${rows.length}x${rows[0]?.length || 0})`, 'echo');
  switchTab('command');
});

document.getElementById('file-input-mat').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  saveFile(file.name, { kind: 'mat', bytes: new Uint8Array(await file.arrayBuffer()) });
  runCommand(`load('${file.name.replace(/'/g, "''")}')`);
});

// Drag and drop files anywhere onto the app to add them to Files.
document.addEventListener('dragover', (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) ev.preventDefault(); });
document.addEventListener('drop', async (ev) => {
  if (!ev.dataTransfer || ev.dataTransfer.files.length === 0) return;
  ev.preventDefault();
  await uploadFiles(ev.dataTransfer.files, { open: ev.dataTransfer.files.length === 1 });
  switchSidebar('files');
});

document.getElementById('files-new').addEventListener('click', newScript);
document.getElementById('files-upload').addEventListener('click', () => document.getElementById('file-input-any').click());

// ---------------------------------------------------------------------
// Modal (help / about / variable viewer share this overlay)
// ---------------------------------------------------------------------

const modalOverlay = document.getElementById('modal-overlay');
function openModal() { modalOverlay.classList.add('open'); }
function closeModal() { modalOverlay.classList.remove('open'); }
modalOverlay.addEventListener('click', (ev) => { if (ev.target === modalOverlay) closeModal(); });
document.getElementById('modal-box').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-action="close-modal"]')) closeModal();
});

function showAboutModal() {
  document.getElementById('modal-box').innerHTML = `
    <button class="modal-close" data-action="close-modal">&times;</button>
    <h2>MatWeb</h2>
    <p>A lightweight, offline-capable, MATLAB-compatible console that runs entirely in your browser — a real lexer/parser/interpreter, not a wrapper around a remote service. Nothing you type ever leaves this page; your scripts and data files are stored in this browser.</p>
    <p>See the bundled README for exactly what MATLAB syntax is and isn't supported.</p>
  `;
  openModal();
}

function showHelpModal() {
  document.getElementById('modal-box').innerHTML = `
    <button class="modal-close" data-action="close-modal">&times;</button>
    <h2>Supported functions &amp; key limitations</h2>
    <p><strong>Language:</strong> variables, matrices/vectors, complex numbers, cell arrays (<code>{...}</code>, <code>c{i}</code>, <code>c{:}</code>), structs (<code>s.a.b = 1</code>, struct arrays, <code>s.(name)</code>), if/for/while/switch, try/catch, functions (multiple outputs, <code>varargin</code>/<code>varargout</code>, anonymous functions, recursion), function files, global/persistent, logical &amp; numeric indexing, auto-growing arrays, deletion via <code>[]</code>.</p>
    <p><strong>Math:</strong> operators expand implicitly (<code>A - mean(A)</code>); trig/exp/log family, sum/mean/std/var/min/max/median/mode (with <code>'all'</code>, <code>'omitnan'</code>), sort/unique/find/any/all, isnan/isinf/isfinite, fliplr/flipud/flip/repmat/cat/circshift, size/reshape/diag/triu/tril, det/trace/rank/norm/dot/cross/inv/pinv/eig/svd/lu/qr/kron, fft/ifft, polyfit/polyval/roots/conv/deconv/filter/interp1, magic/meshgrid/diff/trapz/cumtrapz, factorial/nchoosek/primes/isprime/gcd/lcm, isequal/ismember, operator functions (plus, times, …).</p>
    <p><strong>Cells &amp; structs:</strong> cell, cellfun, arrayfun, num2cell, cell2mat, cellstr, iscell, iscellstr, struct, fieldnames, isfield, rmfield, isstruct, getfield, setfield, struct2cell.</p>
    <p><strong>Errors:</strong> error, warning, assert, MException, throw/rethrow, getReport.</p>
    <p><strong>Strings:</strong> strcmp/strcmpi, upper/lower, strtrim, strrep, strsplit, strjoin, strcat, strfind, contains/startsWith/endsWith, regexp/regexpi/regexprep, str2double, str2num, sprintf, num2str, int2str.</p>
    <p><strong>Timing &amp; display:</strong> tic/toc, <code>format long</code> / <code>format short</code>.</p>
    <p><strong>Plotting:</strong> plot (line specs and Name,Value options), semilogx/semilogy/loglog, stairs, stem, errorbar, scatter, bar/barh, histogram, hist, area, fill, pie, polarplot, text; figure, subplot, sgtitle, hold, gcf/gca, clf, close; title/xlabel/ylabel, legend, grid, box, xlim/ylim, axis, xticks/xticklabels; set/get on handles.</p>
    <p><strong>3-D, images &amp; color:</strong> plot3, scatter3, surf, mesh, contour/contourf, imagesc, image, peaks, sphere; view, zlabel, zlim, shading; colormap (parula, jet, hot, gray, turbo, … or an N-by-3 matrix), colorbar, clim/caxis.</p>
    <p><strong>Saving &amp; animation:</strong> <code>saveas(gcf, 'plot.png')</code>, exportgraphics and print write PNG, JPEG or SVG files to the <em>Files</em> tab. <code>drawnow</code> and <code>pause(t)</code> show figures while a loop runs; Stop still interrupts.</p>
    <p><strong>Files:</strong> scripts and data live in the <em>Files</em> sidebar tab and are saved in this browser. Drag files onto the page to add them. <code>save</code>/<code>writematrix</code> write there too; use the &#x2913; button to download a file.</p>
    <p><strong>Console:</strong> commands run in the background — press <em>Stop</em> (or Ctrl+C in the command line) to interrupt one; the workspace returns to its state before that command. <code>clc</code> clears the window, <code>help('name')</code> shows syntax.</p>
    <p><strong>Not supported:</strong> string arrays (double-quoted), N-D arrays, integer classes, classdef. Command syntax (bareword args) works for <code>clear</code>, <code>hold</code>, <code>grid</code>, <code>axis</code>, <code>disp</code>, <code>format</code>, <code>box</code>, <code>legend</code>, <code>close</code>, <code>warning</code>, <code>xlim</code>, <code>ylim</code>, <code>zlim</code>, <code>colormap</code>, <code>colorbar</code>, <code>shading</code>, <code>clim</code>, <code>caxis</code>, <code>drawnow</code>, <code>pause</code> only. Full list in the README.</p>
  `;
  openModal();
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

async function boot() {
  appendConsoleLine('MatWeb — a lightweight MATLAB-compatible console. Type a command below, or open the Script Editor tab.', 'echo');
  renderHistoryList();

  vfs = await openVfs();
  if (vfs.files.size === 0) vfs.put('untitled.m', { kind: 'm', text: EXAMPLE_SCRIPT });
  backend = createBackend(handleMessage);
  backend.start(initMessage());
  setBusy(false);
  renderFilesList();

  // Reopen the editor tabs from last time.
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TABS_KEY) || 'null'); } catch (e) { saved = null; }
  const restoreTabs = (saved && Array.isArray(saved.tabs) ? saved.tabs : ['untitled.m']).filter(n => vfs.files.has(n));
  for (const name of restoreTabs) if (!openTabs.includes(name)) openTabs.push(name);
  const firstTab = saved && vfs.files.has(saved.active) ? saved.active : (openTabs[0] || [...vfs.files.keys()].find(n => n.endsWith('.m')));
  if (firstTab) openTab(firstTab);
  switchTab('command');
}

boot();
