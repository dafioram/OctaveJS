// main.js — App entry point. Wires the Interpreter core up to the DOM:
// the Command Window REPL, the CodeMirror script editor, the workspace
// browser, the Plotly figures panel, and the File/Edit/View/Help menus.
// No framework — plain DOM, since the surface area here is small enough
// that a framework would add more ceremony than it would save.

import Plotly from 'plotly.js-dist-min';
import Papa from 'papaparse';

import { Interpreter } from '../core/interpreter.js';
import { buildBuiltinsRegistry } from '../builtins/index.js';
import { Mat, FunctionHandle } from '../core/values.js';

import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completeFromList, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { matlabLanguageSupport, matlabHighlighting, matlabCompletionWords } from './matlab-lang.js';

// ---------------------------------------------------------------------
// Interpreter + host wiring
// ---------------------------------------------------------------------

const consoleOutputEl = document.getElementById('console-output');
const consoleInputEl = document.getElementById('console-input');
const workspaceListEl = document.getElementById('workspace-list');
const figureMountEl = document.getElementById('figure-mount');
const figureTabStripEl = document.getElementById('figure-tab-strip');

const figurePlotDivs = new Map(); // figNum -> div element
let activeFigureNum = null;
let figuresTouchedThisRun = []; // figure numbers touched during the run in progress, in first-touch order

function trackFigureTouch(figNum) {
  if (!figuresTouchedThisRun.includes(figNum)) figuresTouchedThisRun.push(figNum);
}

// After a command or script finishes, bring whatever figure(s) it touched
// into view: straight to it if there's one, or a ~1s-paced flip through
// all of them in the order they were created if there are several.
function revealTouchedFigures() {
  const touched = figuresTouchedThisRun;
  figuresTouchedThisRun = [];
  const stillOpen = touched.filter(n => figurePlotDivs.has(n));
  if (stillOpen.length === 0) return;
  switchTab('figures');
  if (stillOpen.length === 1) { switchFigureTab(stillOpen[0]); return; }
  let i = 0;
  const showNext = () => {
    if (i >= stillOpen.length) return;
    switchFigureTab(stillOpen[i]);
    i++;
    if (i < stillOpen.length) setTimeout(showNext, 1000);
  };
  showNext();
}

function appendConsoleLine(text, cls = '') {
  const div = document.createElement('div');
  div.className = 'console-line' + (cls ? ' ' + cls : '');
  div.textContent = text.replace(/\n+$/, '');
  consoleOutputEl.appendChild(div);
  consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
}

const host = {
  print(text) {
    if (!text) return;
    appendConsoleLine(text);
  },
  clearConsole() {
    consoleOutputEl.innerHTML = '';
  },
  figures: {
    render(figNum, traces, layout) {
      trackFigureTouch(figNum);
      renderFigure(figNum, traces, layout);
    },
    show(figNum) {
      trackFigureTouch(figNum);
    },
  },
  io: {
    downloadText(name, text) { downloadBlob(name, new Blob([text], { type: 'text/csv' })); },
    downloadBytes(name, bytes) { downloadBlob(name, new Blob([bytes], { type: 'application/octet-stream' })); },
  },
};

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const interp = new Interpreter(host);
interp.registerBuiltins(buildBuiltinsRegistry());

function renderFigure(figNum, traces, layout) {
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
    margin: { t: layout.title ? 40 : 20, r: 20, b: 45, l: 55 },
    paper_bgcolor: '#fffdf9', plot_bgcolor: '#fffdf9',
    font: { family: 'ui-monospace, SFMono-Regular, Menlo, monospace', size: 12, color: '#2b2822' },
  }, layout);
  Plotly.react(div, traces, plotlyLayout, { responsive: true, displaylogo: false });
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
    label.textContent = `Figure ${figNum}`;
    label.onclick = () => switchFigureTab(figNum);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'figure-tab-close';
    closeBtn.textContent = '\u00d7';
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
  for (const [n, div] of figurePlotDivs.entries()) {
    div.style.display = (n === figNum) ? 'block' : 'none';
  }
  rebuildFigureTabStrip();
}

function closeFigure(figNum) {
  const div = figurePlotDivs.get(figNum);
  if (div) {
    try { Plotly.purge(div); } catch (e) { /* ignore */ }
    div.remove();
    figurePlotDivs.delete(figNum);
  }
  interp.figures.delete(figNum);

  if (figurePlotDivs.size === 0) {
    activeFigureNum = null;
    interp.figureState.current = undefined;
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

function renderWorkspace() {
  const names = [...interp.workspace.names()].sort();
  workspaceListEl.innerHTML = '';
  if (names.length === 0) {
    workspaceListEl.innerHTML = '<div class="workspace-empty">No variables yet</div>';
    return;
  }
  for (const name of names) {
    const v = interp.workspace.get(name);
    const row = document.createElement('div');
    row.className = 'workspace-row';
    const isFn = v instanceof FunctionHandle;
    const sizeStr = isFn ? 'handle' : v.sizeStr();
    const clsStr = isFn ? 'function_handle' : v.className();
    row.innerHTML = `<span class="var-name">${escapeHtml(name)}</span><span class="var-meta">${sizeStr}</span><span class="var-meta">${clsStr}</span>`;
    if (!isFn) row.onclick = () => showMatrixModal(name, v);
    workspaceListEl.appendChild(row);
  }
}

function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------------
// Sidebar: Workspace / Command History sub-tabs
// ---------------------------------------------------------------------

document.getElementById('sidebar-subtabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.sidebar-subtab');
  if (!btn) return;
  const name = btn.dataset.subtab;
  document.querySelectorAll('.sidebar-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === name));
  document.querySelectorAll('.sidebar-view').forEach(v => v.classList.toggle('active', v.dataset.subview === name));
});

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

function showMatrixModal(name, mat) {
  const box = document.getElementById('modal-box');
  let body;
  if (mat.isChar) {
    body = `<p>${escapeHtml(mat.toJSString())}</p>`;
  } else if (mat.numel > 2000) {
    body = `<p>${mat.sizeStr()} ${mat.className()} — too large to preview here (${mat.numel} elements). Use <code>disp(${escapeHtml(name)})</code> in the Command Window instead.</p>`;
  } else {
    let html = '<table><tbody>';
    for (let r = 0; r < mat.rows; r++) {
      html += '<tr>';
      for (let c = 0; c < mat.cols; c++) {
        const re = mat.re[c * mat.rows + r];
        const im = mat.isComplex ? mat.im[c * mat.rows + r] : 0;
        const text = im !== 0 ? `${fmtNum(re)}${im < 0 ? '-' : '+'}${fmtNum(Math.abs(im))}i` : fmtNum(re);
        html += `<td>${text}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    body = html;
  }
  box.innerHTML = `<button class="modal-close" data-action="close-modal">&times;</button><h2>${escapeHtml(name)} <small style="color:var(--ink-faint);font-weight:normal;">(${mat.sizeStr()} ${mat.className()})</small></h2>${body}`;
  openModal();
}
function fmtNum(x) { return Number.isInteger(x) ? String(x) : Number(x.toPrecision(5)).toString(); }

// ---------------------------------------------------------------------
// Command window (REPL)
// ---------------------------------------------------------------------

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

// Runs source through the interpreter, handling errors, refreshing the
// workspace panel, and revealing any figure(s) it produced. Shared by
// typed commands, "Run", and "Run selection" — history logging is
// layered on top by the callers that want it (see runCommand/runFullScript
// vs. runSelectionOrAll).
function executeSource(src) {
  try {
    interp.runSource(src);
  } catch (e) {
    appendConsoleLine((e && e.message) ? e.message : String(e), 'error');
  }
  renderWorkspace();
  revealTouchedFigures();
}

function runCommand(cmd) {
  if (!cmd.trim()) return;
  switchTab('command');
  appendConsoleLine(cmd, 'echo');
  pushHistory(cmd);
  executeSource(cmd);
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
    if (historyPos < history_.length) {
      historyPos++;
      consoleInputEl.value = history_[historyPos] || '';
    }
    ev.preventDefault();
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
// Script editor (CodeMirror 6)
// ---------------------------------------------------------------------

let currentFilename = 'untitled.m';
function setCurrentFilename(name) {
  currentFilename = name;
  document.getElementById('editor-filename').textContent = currentFilename;
}
document.getElementById('editor-filename').addEventListener('click', () => {
  let name = prompt('Rename script:', currentFilename);
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  if (!/\.m$/i.test(name)) name += '.m';
  setCurrentFilename(name);
});

const matlabSupport = matlabLanguageSupport();
const editorCompletion = matlabSupport.language.data.of({
  autocomplete: completeFromList(matlabCompletionWords.map(label => ({ label, type: 'keyword' }))),
});

const editorView = new EditorView({
  parent: document.getElementById('editor-mount'),
  state: EditorState.create({
    doc: `% New script\nx = linspace(0, 2*pi, 100);\ny = sin(x);\nplot(x, y, 'b-');\nxlabel('x'); ylabel('sin(x)'); title('Example');\n`,
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      matlabSupport,
      ...matlabHighlighting,
      editorCompletion,
      autocompletion(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.theme({ '&': { height: '100%' } }),
    ],
  }),
});

function runFullScript() {
  const text = editorView.state.doc.toString();
  interp.files.set(currentFilename, { kind: 'm', text });
  const cmd = `run('${currentFilename}')`;
  switchTab('command');
  appendConsoleLine(cmd, 'echo');
  pushHistory(cmd);
  executeSource(cmd);
}

function runSelectionOrAll() {
  const sel = editorView.state.selection.main;
  if (sel.from === sel.to) { runFullScript(); return; } // no selection -> same as Run
  const text = editorView.state.sliceDoc(sel.from, sel.to);
  const lineCount = text.split('\n').length;
  switchTab('command');
  // Not pushed to history: a selection snippet isn't reliably re-runnable
  // later the way a named script or typed command is, so it's shown here
  // for transparency but doesn't clutter Command History with it.
  appendConsoleLine(`% running ${lineCount} selected line(s) from ${currentFilename}`, 'echo');
  executeSource(text);
}

document.querySelector('[data-action="run-script"]').addEventListener('click', runFullScript);
document.querySelector('[data-action="run-selection"]').addEventListener('click', runSelectionOrAll);

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
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.menu-item')) closeAllMenus();
});
function closeAllMenus() { document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open')); }

function handleMenuAction(action) {
  switch (action) {
    case 'new-script':
      if (editorView.state.doc.length === 0 || confirm('Discard current script and start a new one?')) {
        editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: '' } });
        setCurrentFilename('untitled.m');
      }
      switchTab('editor');
      break;
    case 'open-m':
      document.getElementById('file-input-m').click();
      break;
    case 'save-m': {
      const text = editorView.state.doc.toString();
      downloadBlob(currentFilename, new Blob([text], { type: 'text/plain' }));
      break;
    }
    case 'import-csv':
      document.getElementById('file-input-csv').click();
      break;
    case 'open-mat':
      document.getElementById('file-input-mat').click();
      break;
    case 'save-mat':
      interp.callNamed('save', [Mat.fromString('workspace.mat')], 0, interp.workspace);
      switchTab('command');
      break;
    case 'clear-workspace':
      if (confirm('Clear all variables from the workspace?')) {
        interp.workspace.vars.clear();
        renderWorkspace();
      }
      break;
    case 'clear-console':
      host.clearConsole();
      break;
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
    case 'show-help': showHelpModal(); break;
    case 'show-about': showAboutModal(); break;
    case 'close-modal': closeModal(); break;
  }
}

document.getElementById('file-input-m').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const text = await file.text();
  editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: text } });
  setCurrentFilename(file.name);
  switchTab('editor');
  ev.target.value = '';
});

document.getElementById('file-input-csv').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    complete(results) {
      const rows = results.data
        .filter(row => row.some(cell => String(cell).trim() !== ''))
        .map(row => row.map(cell => parseFloat(cell)));
      const varName = prompt(`Import "${file.name}" as which variable name?`, 'data') || 'data';
      interp.workspace.set(varName, Mat.fromRows(rows));
      renderWorkspace();
      appendConsoleLine(`Imported ${file.name} as ${varName} (${rows.length}x${rows[0]?.length || 0})`, 'echo');
      switchTab('command');
    },
  });
  ev.target.value = '';
});

document.getElementById('file-input-mat').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  interp.files.set(file.name, { kind: 'mat', bytes: buf });
  try {
    interp.callNamed('load', [Mat.fromString(file.name)], 0, interp.workspace);
    renderWorkspace();
  } catch (e) {
    appendConsoleLine(`Could not load ${file.name}: ${e.message}`, 'error');
  }
  switchTab('command');
  ev.target.value = '';
});

// ---------------------------------------------------------------------
// Modal (help / about / matrix viewer share this overlay)
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
    <p>A lightweight, offline-capable, MATLAB-compatible console that runs entirely in your browser — a real lexer/parser/interpreter, not a wrapper around a remote service. Nothing you type ever leaves this page.</p>
    <p>See the bundled README for exactly what MATLAB syntax is and isn't supported.</p>
  `;
  openModal();
}

function showHelpModal() {
  document.getElementById('modal-box').innerHTML = `
    <button class="modal-close" data-action="close-modal">&times;</button>
    <h2>Supported functions &amp; key limitations</h2>
    <p><strong>Language:</strong> variables, matrices/vectors, complex numbers, if/for/while/switch, functions (incl. multiple outputs, anonymous functions, recursion), global/persistent, logical &amp; numeric indexing, auto-growing arrays, element/row/column deletion via <code>[]</code>.</p>
    <p><strong>Math:</strong> trig/exp/log family, sum/mean/std/var/min/max/median, sort/unique/find/any/all, isnan/isinf/isfinite, fliplr/flipud/flip/repmat/cat, size/reshape/diag/triu/tril, det/trace/rank/norm/dot/cross/inv/pinv/eig/svd/lu/qr, fft/ifft, polyfit/polyval/interp1.</p>
    <p><strong>Plotting:</strong> plot, scatter, bar, histogram, hist, figure, hold, xlabel/ylabel/title, legend, grid, xlim/ylim, axis. Close a figure with the &times; on its tab.</p>
    <p><strong>Strings:</strong> strcmp/strcmpi, upper/lower, strtrim, strrep, str2double, str2num.</p>
    <p><strong>Console:</strong> <code>clc</code> clears the Command Window. <code>help('name')</code> shows syntax for any function. Click a script's filename in the editor toolbar to rename it before saving. The left sidebar has a History tab alongside Workspace — click any past command to run it again.</p>
    <p><strong>I/O:</strong> readmatrix/writematrix (CSV), save/load (a real, rudimentary MAT5 <code>.mat</code> writer/reader — not HDF5; see README), run (execute a script from the virtual file list).</p>
    <p><strong>Not supported:</strong> structs, cell arrays, string arrays (double-quoted), N-D arrays, integer classes, command syntax (<code>disp hello</code> / <code>hold on</code> — use <code>disp('hello')</code> / <code>hold('on')</code> instead). Full list with rationale is in the README shipped alongside this app.</p>
  `;
  openModal();
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

appendConsoleLine('MatWeb — a lightweight MATLAB-compatible console. Type a command below, or open the Script Editor tab.', 'echo');
renderWorkspace();
renderHistoryList();
consoleInputEl.focus();
