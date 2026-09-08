// plotting.js — MATLAB plotting command compatibility layer. Owns MATLAB
// semantics (figures, hold, linespecs, labels); Plotly is just the
// rendering engine underneath, invoked via ctx.host.figures.render(...).
//
// Supported: plot, scatter, bar, histogram, figure, hold, xlabel, ylabel,
// title, legend, grid, xlim, ylim, axis(equal|tight|[xmin xmax ymin ymax]).
// NOT supported: Name-Value style option pairs on plot() (e.g.
// plot(x,y,'LineWidth',2)) — only inline linespec strings like 'r--' are
// parsed. See README.

import { Mat, MatlabError } from '../core/values.js';

const COLOR_MAP = { r: '#d62728', g: '#2ca02c', b: '#1f77b4', c: '#17becf', m: '#e377c2', y: '#bcbd22', k: '#111111', w: '#ffffff' };
const DASH_MAP = { '--': 'dash', ':': 'dot', '-.': 'dashdot', '-': 'solid' };
const MARKER_MAP = { o: 'circle', x: 'x', '+': 'cross', '*': 'star', s: 'square', d: 'diamond', '^': 'triangle-up', v: 'triangle-down', '.': 'circle' };

function parseLinespec(spec) {
  let s = spec;
  const style = {};
  for (const ls of ['--', '-.', ':', '-']) { if (s.includes(ls)) { style.dash = DASH_MAP[ls]; s = s.replace(ls, ''); break; } }
  for (const ch of Object.keys(MARKER_MAP)) { if (s.includes(ch)) { style.marker = MARKER_MAP[ch]; s = s.replace(ch, ''); break; } }
  for (const ch of Object.keys(COLOR_MAP)) { if (s.includes(ch)) { style.color = COLOR_MAP[ch]; s = s.replace(ch, ''); break; } }
  return style;
}

function colVec(mat) {
  const out = [];
  for (let k = 0; k < mat.numel; k++) out.push(mat.re[k]);
  return out;
}

function getFig(interp, n) {
  if (!interp.figures) interp.figures = new Map();
  if (!interp.figures.has(n)) interp.figures.set(n, { traces: [], layout: { xaxis: {}, yaxis: {} }, hold: false });
  return interp.figures.get(n);
}
function currentFig(interp) {
  if (interp.figureState.current === undefined) interp.figureState.current = 1;
  return getFig(interp, interp.figureState.current);
}
function render(ctx, figState) {
  if (ctx.host.figures && ctx.host.figures.render) {
    ctx.host.figures.render(ctx.interp.figureState.current, figState.traces, figState.layout);
  }
}

export function registerPlotting(reg) {
  reg.set('figure', {
    fn: (args, _n, ctx) => {
      const num = args.length ? Math.round(args[0].toScalarNumber()) : (ctx.interp.figureState.current || 0) + 1;
      ctx.interp.figureState.current = num;
      getFig(ctx.interp, num);
      if (ctx.host.figures && ctx.host.figures.show) ctx.host.figures.show(num);
      return [];
    },
  });

  reg.set('hold', {
    fn: (args, _n, ctx) => {
      const fig = currentFig(ctx.interp);
      if (args.length === 0) fig.hold = !fig.hold;
      else fig.hold = args[0].toJSString().toLowerCase() === 'on';
      return [];
    },
  });

  function addTraces(ctx, newTraces) {
    const fig = currentFig(ctx.interp);
    if (!fig.hold) fig.traces = [];
    fig.traces.push(...newTraces);
    render(ctx, fig);
  }

  reg.set('plot', {
    fn: (args, _n, ctx) => {
      const traces = [];
      let i = 0;
      while (i < args.length) {
        let x, y;
        const a = args[i];
        if (a.isChar) { i++; continue; } // stray linespec with no preceding pair; skip
        const b = args[i + 1];
        if (b && !b.isChar) { x = colVec(a); y = colVec(b); i += 2; }
        else { y = colVec(a); x = y.map((_, k) => k + 1); i += 1; }
        let style = {};
        if (args[i] && args[i].isChar) { style = parseLinespec(args[i].toJSString()); i++; }
        const trace = {
          type: 'scatter', mode: style.marker ? 'lines+markers' : 'lines', x, y,
          line: { color: style.color, dash: style.dash || 'solid' },
        };
        if (style.marker) trace.marker = { symbol: style.marker, color: style.color };
        traces.push(trace);
      }
      addTraces(ctx, traces);
      return [];
    },
  });

  reg.set('scatter', {
    fn: (args, _n, ctx) => {
      const x = colVec(args[0]), y = colVec(args[1]);
      addTraces(ctx, [{ type: 'scatter', mode: 'markers', x, y }]);
      return [];
    },
  });

  reg.set('bar', {
    fn: (args, _n, ctx) => {
      let x, y;
      if (args.length >= 2 && !args[1].isChar) { x = colVec(args[0]); y = colVec(args[1]); }
      else { y = colVec(args[0]); x = y.map((_, k) => k + 1); }
      addTraces(ctx, [{ type: 'bar', x, y }]);
      return [];
    },
  });

  reg.set('histogram', {
    fn: (args, _n, ctx) => {
      const x = colVec(args[0]);
      const trace = { type: 'histogram', x };
      if (args.length >= 2) trace.nbinsx = Math.round(args[1].toScalarNumber());
      addTraces(ctx, [trace]);
      return [];
    },
  });

  // Classic MATLAB `hist`: with no output args it plots a bar chart of
  // computed bin counts; with output args it returns [counts, centers]
  // instead of plotting (matching real hist's dual behavior). `histogram`
  // above is the modern, Plotly-native-binned equivalent and is the more
  // robust choice for most new code — this is here because it's what a lot
  // of existing MATLAB scripts already call.
  reg.set('hist', {
    fn: (args, nargout, ctx) => {
      const vals = colVec(args[0]);
      let centers;
      if (args.length >= 2 && args[1].numel > 1) {
        centers = colVec(args[1]);
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
      addTraces(ctx, [{ type: 'bar', x: centers, y: counts }]);
      return [];
    },
  });

  reg.set('xlabel', { fn: (args, _n, ctx) => { const fig = currentFig(ctx.interp); fig.layout.xaxis.title = args[0].toJSString(); render(ctx, fig); return []; } });
  reg.set('ylabel', { fn: (args, _n, ctx) => { const fig = currentFig(ctx.interp); fig.layout.yaxis.title = args[0].toJSString(); render(ctx, fig); return []; } });
  reg.set('title', { fn: (args, _n, ctx) => { const fig = currentFig(ctx.interp); fig.layout.title = args[0].toJSString(); render(ctx, fig); return []; } });
  reg.set('legend', {
    fn: (args, _n, ctx) => {
      const fig = currentFig(ctx.interp);
      fig.layout.showlegend = true;
      args.forEach((a, i) => { if (fig.traces[i]) fig.traces[i].name = a.toJSString(); });
      render(ctx, fig);
      return [];
    },
  });
  reg.set('grid', {
    fn: (args, _n, ctx) => {
      const fig = currentFig(ctx.interp);
      const on = args.length ? args[0].toJSString().toLowerCase() === 'on' : true;
      fig.layout.xaxis.showgrid = on; fig.layout.yaxis.showgrid = on;
      render(ctx, fig);
      return [];
    },
  });
  reg.set('xlim', {
    fn: (args, _n, ctx) => { const fig = currentFig(ctx.interp); fig.layout.xaxis.range = colVec(args[0]); fig.layout.xaxis.autorange = false; render(ctx, fig); return []; },
  });
  reg.set('ylim', {
    fn: (args, _n, ctx) => { const fig = currentFig(ctx.interp); fig.layout.yaxis.range = colVec(args[0]); fig.layout.yaxis.autorange = false; render(ctx, fig); return []; },
  });
  reg.set('axis', {
    fn: (args, _n, ctx) => {
      const fig = currentFig(ctx.interp);
      if (args[0] && args[0].isChar) {
        const mode = args[0].toJSString();
        if (mode === 'equal') { fig.layout.yaxis.scaleanchor = 'x'; fig.layout.yaxis.scaleratio = 1; }
        else if (mode === 'tight') { fig.layout.xaxis.autorange = true; fig.layout.yaxis.autorange = true; }
      } else if (args[0]) {
        const v = colVec(args[0]);
        fig.layout.xaxis.range = [v[0], v[1]]; fig.layout.xaxis.autorange = false;
        fig.layout.yaxis.range = [v[2], v[3]]; fig.layout.yaxis.autorange = false;
      }
      render(ctx, fig);
      return [];
    },
  });
}
