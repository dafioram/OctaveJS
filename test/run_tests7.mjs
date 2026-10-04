// Tests for plotting: the figure model built by src/builtins/plotting.js
// and its conversion to Plotly (src/plot/toPlotly.js).
import { makeInterp, fmtVar } from './harness.js';
import { figureToPlotly, texToHtml, axesDomain } from '../src/plot/toPlotly.js';
import { parseLinespec, colorFromText } from '../src/plot/style.js';
import { createSession } from '../src/worker/session.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkThrows(label, fn, pattern) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { fail++; console.log(`FAIL(wrong error): ${label}\n  got: ${e.message}`); }
    else pass++;
  }
}
// A fresh interpreter plus helpers to inspect the current figure.
function setup() {
  const h = makeInterp();
  const touched = [];
  h.interp.host.figures.render = (num) => touched.push(num);
  h.fig = () => h.interp.figures.get(h.interp.figureState.current);
  h.ax = () => { const f = h.fig(); return f.axes.find(a => a.h === f.current); };
  h.plotly = () => figureToPlotly(h.fig());
  h.touched = touched;
  return h;
}
const BLUE = 'rgb(0,114,189)', ORANGE = 'rgb(217,83,25)', YELLOW = 'rgb(237,177,32)';

// ---------------- style helpers ----------------
check('line spec r--o', parseLinespec('r--o'), { lineStyle: '--', color: [1, 0, 0], marker: 'o' });
check('line spec order-free', parseLinespec('o:k'), { lineStyle: ':', marker: 'o', color: [0, 0, 0] });
check('not a line spec', parseLinespec('LineWidth'), null);
check('named and hex colors', [colorFromText('red'), colorFromText('#00FF00'), colorFromText('nope')], [[1, 0, 0], [0, 1, 0], null]);
check('TeX to HTML', texToHtml('x^2 + y_{12} \\alpha<b>'), 'x<sup>2</sup> + y<sub>12</sub> α&lt;b&gt;');
check('subplot domain (2x1, top)', axesDomain({ rows: 2, cols: 1, r0: 0, r1: 0, c0: 0, c1: 0 }), { x: [0, 1], y: [0.56, 1] });

// ---------------- plot: data, colors, line specs, properties ----------------
{
  const h = setup();
  h.run("plot(1:3, [1 2 3; 4 5 6]');");
  let { data } = h.plotly();
  check('matrix Y gives one line per column', data.map(t => t.y), [[1, 2, 3], [4, 5, 6]]);
  check('lines follow the color order', data.map(t => t.line.color), [BLUE, ORANGE]);
  checkThrows('mismatched vectors', () => h.run('plot(1:3, [1 2])'), /same length/);
  h.run("plot(1:3, [2 4 6], 'r--s', 'LineWidth', 2, 'MarkerFaceColor', 'g', 'DisplayName', 'mine');");
  ({ data } = h.plotly());
  check('line spec color/dash', [data[0].line.color, data[0].line.dash], ['rgb(255,0,0)', 'dash']);
  check('Name,Value after line spec', [data[0].line.width, data[0].marker.symbol, data[0].marker.color, data[0].name], [8 / 3, 'square', 'rgb(0,255,0)', 'mine']);
  h.run("plot(1:3, 'o');");
  ({ data } = h.plotly());
  check("marker-only spec draws no line, open markers", [data[0].mode, data[0].marker.symbol], ['markers', 'circle-open']);
  h.run('plot([1+2i, 3+4i]);');
  check('plot(complex) is imag vs real', [h.plotly().data[0].x, h.plotly().data[0].y], [[1, 3], [2, 4]]);
  checkThrows('unknown property', () => h.run("plot(1:3, 'Colour', 'r')"), /unsupported property 'Colour'/);
  checkThrows('dangling property name', () => h.run("plot(1:3, 'LineWidth')"), /pairs/);
  h.run("plot(1:3); hold on; plot(2:4); plot(3:5); hold off;");
  check('hold on: blue, orange, yellow', h.plotly().data.map(t => t.line.color), [BLUE, ORANGE, YELLOW]);
  h.run("title('t'); plot(1:2);");
  check('plot with hold off resets axes properties', h.ax().title, null);
}

// ---------------- handles: get / set / gcf / gca / isgraphics ----------------
{
  const h = setup();
  h.run("hl = plot(1:3, [1 2 3; 3 2 1]'); n = numel(hl); set(hl(1), 'LineWidth', 3, 'Color', 'r', 'YData', [5 5 5]); lw = get(hl(1), 'LineWidth'); c = get(hl(1), 'Color'); yd = get(hl(1), 'YData');");
  check('plot returns one handle per line', fmtVar(h.interp, 'n'), 2);
  check('set/get LineWidth', fmtVar(h.interp, 'lw'), 3);
  check('get Color returns RGB', fmtVar(h.interp, 'c'), { rows: 1, cols: 3, re: [1, 0, 0], im: null });
  check('set YData updates the data', h.plotly().data[0].y, [5, 5, 5]);
  check('get YData', fmtVar(h.interp, 'yd'), { rows: 1, cols: 3, re: [5, 5, 5], im: null });
  h.run("s = get(hl(2)); hasName = isfield(s, 'DisplayName'); f = gcf; a = gca; set(a, 'YScale', 'log'); ys = get(a, 'YScale'); g = isgraphics([hl(1) f a 123456]);");
  check('get(h) returns a struct of properties', fmtVar(h.interp, 'hasName'), 1);
  check('gcf is the figure number', fmtVar(h.interp, 'f'), 1);
  check('set on an axes handle', [fmtVar(h.interp, 'ys'), h.plotly().layout.yaxis.type], ['log', 'log']);
  check('isgraphics', fmtVar(h.interp, 'g'), { rows: 1, cols: 4, re: [1, 1, 1, 0], im: null });
  checkThrows('unsupported property on set', () => h.run("set(hl(1), 'Parent', 1)"), /not supported for line objects/);
  checkThrows('invalid handle', () => h.run("set(424242, 'Color', 'r')"), /invalid or deleted graphics handle/);
  h.run("hf = figure('Name', 'Results'); nm = get(hf, 'Name');");
  check("figure('Name') and get", [fmtVar(h.interp, 'hf'), fmtVar(h.interp, 'nm')], [2, 'Results']);
}

// ---------------- figures and subplots ----------------
{
  const h = setup();
  h.run("subplot(2,1,1); plot(1:3); title('top'); subplot(2,1,2); bar([1 2 3]); title('bottom'); sgtitle('All');");
  let { data, layout } = h.plotly();
  check('two subplots', h.fig().axes.length, 2);
  check('second subplot uses its own axes', [data[1].xaxis, data[1].yaxis], ['x2', 'y2']);
  check('subplot domains stack vertically', [layout.yaxis.domain, layout.yaxis2.domain], [[0.56, 1], [0, 0.44]]);
  check('per-subplot titles', layout.annotations.map(a => a.text), ['<b>top</b>', '<b>bottom</b>']);
  check('sgtitle', layout.title.text, '<b>All</b>');
  h.run('subplot(2,1,1); hold on; plot(3:-1:1);');
  check('subplot(m,n,p) returns to an existing axes', h.fig().axes.length, 2);
  check('...and plots into it', h.fig().axes[0].objects.length, 2);
  h.run('subplot(1,1,1);');
  check('an overlapping subplot replaces the old ones', h.fig().axes.length, 1);
  h.run('clf; subplot(2,2,[1 2]); plot(1:3); subplot(223); plot(1:3); a4 = subplot(2,2,4);');
  ({ layout } = h.plotly());
  check('spanning subplot and subplot(mnp)', [layout.xaxis.domain, layout.xaxis2.domain], [[0, 1], [0, 0.46]]);
  check('subplot returns an axes handle', fmtVar(h.interp, 'a4') > 1000, true);
  h.run('figure; plot(1:2); figure(7); f = gcf;');
  check('figure picks the lowest unused number; figure(n) selects n', [h.interp.figures.has(2), fmtVar(h.interp, 'f')], [true, 7]);
  h.touched.length = 0;
  h.run('close all;');
  check('close all removes every figure and reports them', [h.interp.figures.size, [...h.touched].sort((a, b) => a - b)], [0, [1, 2, 7]]);
  h.run('figure; plot(1:3); figure; close; c = gcf;');
  check('close makes another figure current', fmtVar(h.interp, 'c'), 1);
  check('hold/ishold', (h.run('hold on; t = ishold; hold off; u = ishold;'), [fmtVar(h.interp, 't'), fmtVar(h.interp, 'u')]), [1, 0]);
}

// ---------------- axes decorations ----------------
{
  const h = setup();
  h.run("plot(1:3, [1 4 9]); xlabel('t_{0}'); ylabel({'a', 'b'}); grid on; box off; axis([0 4 0 10]); xticks([1 2 3]); xticklabels({'a', 'b', 'c'}); legend('sq', 'Location', 'southwest'); text(2, 4, '\\pi');");
  const { data, layout } = h.plotly();
  check('xlabel with TeX', layout.xaxis.title.text, 't<sub>0</sub>');
  check('multi-line ylabel', layout.yaxis.title.text, 'a<br>b');
  check('grid on / box off', [layout.xaxis.showgrid, layout.xaxis.mirror], [true, false]);
  check('axis limits', [layout.xaxis.range, layout.yaxis.range], [[0, 4], [0, 10]]);
  check('ticks and tick labels', [layout.xaxis.tickvals, layout.xaxis.ticktext], [[1, 2, 3], ['a', 'b', 'c']]);
  check('legend label and location', [data[0].name, data[0].showlegend, layout.legend.xanchor, layout.legend.yanchor], ['sq', true, 'left', 'bottom']);
  check('legend keeps plotting order', layout.legend.traceorder, 'normal');
  check('text annotation', [layout.annotations[0].text, layout.annotations[0].x, layout.annotations[0].xref], ['π', 2, 'x']);
  h.run('v = axis; legend off; axis ij; axis equal; ylim auto;');
  check('axis returns the limits', fmtVar(h.interp, 'v'), { rows: 1, cols: 4, re: [0, 4, 0, 10], im: null });
  const l2 = h.plotly().layout;
  check('legend off', h.plotly().data[0].showlegend, false);
  check('axis ij reverses y; axis equal locks the aspect', [l2.yaxis.autorange, l2.yaxis.scaleanchor], ['reversed', 'x']);
  h.run('semilogy(1:3, [1 10 100]); grid minor; xl = xlim;');
  check('semilogy sets a log y axis', h.plotly().layout.yaxis.type, 'log');
  check('xlim reports the data range when automatic', fmtVar(h.interp, 'xl'), { rows: 1, cols: 2, re: [1, 3], im: null });
  h.run('loglog([1 10], [1 100]); xlim([1 10]); text(10, 100, \'end\');');
  check('log-axis limits and text positions use log10', [h.plotly().layout.xaxis.range, h.plotly().layout.annotations[0].x], [[0, 1], 1]);
  checkThrows('bad limits', () => h.run('xlim([3 1])'), /increasing/);
}

// ---------------- other plot types ----------------
{
  const h = setup();
  h.run("stem(1:3, [1 2 1], 'filled');");
  let { data } = h.plotly();
  check('stem: stems plus filled heads', [data.length, data[0].y, data[1].marker.symbol, data[0].showlegend], [2, [0, 1, null, 0, 2, null, 0, 1, null], 'circle', false]);
  h.run('stairs(1:3, [1 3 2]);');
  check('stairs uses step lines', h.plotly().data[0].line.shape, 'hv');
  h.run('errorbar(1:3, [2 4 3], [0.5 0.2 0.1]);');
  check('errorbar', [h.plotly().data[0].error_y.array, h.plotly().data[0].error_y.arrayminus], [[0.5, 0.2, 0.1], [0.5, 0.2, 0.1]]);
  h.run('errorbar(1:2, [1 1], [0.1 0.2], [0.3 0.4]);');
  check('errorbar with separate lower/upper', [h.plotly().data[0].error_y.arrayminus, h.plotly().data[0].error_y.array], [[0.1, 0.2], [0.3, 0.4]]);
  h.run('area([1 2; 3 4]);');
  ({ data } = h.plotly());
  check('area stacks columns', [data.length, data[0].stackgroup === data[1].stackgroup, data[0].fillcolor], [2, true, BLUE]);
  h.run("fill([0 1 0.5], [0 0 1], 'r');");
  check('fill closes the polygon', [h.plotly().data[0].fill, h.plotly().data[0].x, h.plotly().data[0].fillcolor], ['toself', [0, 1, 0.5, 0], 'rgb(255,0,0)']);
  h.run("pie([1 2 3], {'a', 'b', 'c'});");
  check('pie', [h.plotly().data[0].type, h.plotly().data[0].labels, h.ax().kind], ['pie', ['a', 'b', 'c'], 'pie']);
  h.run("polarplot([0 pi/2 pi], [1 2 1], 'r');");
  ({ data } = h.plotly());
  check('polarplot', [data[0].type, data[0].r, data[0].thetaunit, h.plotly().layout.polar !== undefined], ['scatterpolar', [1, 2, 1], 'radians', true]);
  h.run("scatter(1:3, [3 1 2], 50, 'filled');");
  ({ data } = h.plotly());
  check('scatter filled with size (area in points^2)', [data[0].mode, data[0].marker.symbol, Math.round(data[0].marker.size * 100) / 100], ['markers', 'circle', Math.round(Math.sqrt(50) * 4 / 3 * 100) / 100]);
  h.run('scatter(1:3, [3 1 2], [], [1 2 3]);');
  check('scatter with per-point color values', h.plotly().data[0].marker.color, [1, 2, 3]);
  h.run("bar([1 2; 3 4], 'stacked');");
  check('stacked bars', [h.plotly().data.length, h.plotly().layout.barmode], [2, 'stack']);
  h.run('barh([3 1 2]);');
  check('barh is horizontal', [h.plotly().data[0].orientation, h.plotly().data[0].x], ['h', [3, 1, 2]]);
  h.run("histogram([1 2 2 3 3 3 4], [0.5 1.5 2.5 3.5 4.5], 'Normalization', 'probability');");
  check('histogram with edges and normalization', h.plotly().data[0].y, [1 / 7, 2 / 7, 3 / 7, 1 / 7]);
  h.run('histogram([1 2 3 4], 2);');
  check('histogram bin count', h.ax().objects[0].edges, [1, 2.5, 4]);
  h.run('hist([1 2 2 3 3 3], 3); [cnt, ctr] = hist([1 2 2 3 3 3], 3);');
  check('hist plots bars or returns counts', [h.plotly().data[0].type, fmtVar(h.interp, 'cnt').re], ['bar', [1, 2, 3]]);
}

// ---------------- session payload and Stop/restore ----------------
{
  const msgs = [];
  const s1 = createSession((m) => msgs.push(m));
  s1.handle({ type: 'init', files: [] });
  s1.handle({ type: 'run', id: 1, src: "hl = plot(1:3); title('kept'); figure(2); bar(1:2); close(2);" });
  const done = msgs.find(m => m.type === 'done');
  check('payload carries the figure model', done.figures.find(f => f.num === 1).fig.axes[0].title.text, 'kept');
  check('closed figures are reported as gone', done.figures.find(f => f.num === 2).fig, null);
  const out = [];
  const s2 = createSession((m) => out.push(m));
  s2.handle({ type: 'init', files: [], snapshot: { vars: done.delta.vars, figures: [[1, done.figures.find(f => f.num === 1).fig]], figureState: done.delta.figureState } });
  s2.handle({ type: 'run', id: 1, src: "set(hl, 'Color', 'r'); hold on; h2 = plot(3:-1:1); fresh = h2 ~= hl;" });
  const d2 = out.find(m => m.type === 'done');
  check('handles still work after restore', d2.error, null);
  const fig = d2.figures.find(f => f.num === 1).fig;
  check('restored figure keeps its content', [fig.axes[0].objects.length, fig.axes[0].objects[0].color], [2, [1, 0, 0]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
