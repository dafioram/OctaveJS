// toPlotly.js — Turns the figure model built by src/builtins/plotting.js
// into Plotly traces and layout. Pure function, no DOM: the page calls it
// right before Plotly.react, and the tests call it directly.
//
// Styling follows MATLAB's defaults rather than Plotly's: box on, ticks
// inside, no grid until `grid on`, open markers unless filled, MATLAB's
// color order. Titles, labels, legend entries and text use MATLAB's TeX
// subset (x^2, x_{i}, \alpha, \pm, ...), converted to Plotly's HTML.

import { rgbCss, PARULA } from './style.js';

const DASH = { '-': 'solid', '--': 'dash', ':': 'dot', '-.': 'dashdot' };
const SYMBOL = {
  o: 'circle', '+': 'cross-thin', '*': 'asterisk', '.': 'circle', x: 'x-thin', s: 'square', d: 'diamond',
  '^': 'triangle-up', v: 'triangle-down', '>': 'triangle-right', '<': 'triangle-left', p: 'star', h: 'hexagram',
};
const LINE_ONLY_SYMBOLS = new Set(['+', '*', 'x']);
const INK = '#262626';
const pt = (v) => (v * 4) / 3; // points -> CSS pixels

const TEX_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', infty: '∞', pm: '±', times: '×', div: '÷',
  circ: '°', leq: '≤', geq: '≥', neq: '≠', approx: '≈', cdot: '·', rightarrow: '→', leftarrow: '←',
  leftrightarrow: '↔', uparrow: '↑', downarrow: '↓', partial: '∂', nabla: '∇', surd: '√', int: '∫',
  sum: '∑', prod: '∏', in: '∈', forall: '∀', exists: '∃', propto: '∝', equiv: '≡', sim: '∼', degree: '°',
};

// MATLAB TeX-interpreter text -> Plotly HTML.
export function texToHtml(s) {
  if (s === null || s === undefined) return '';
  let out = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  out = out.replace(/\\([A-Za-z]+)/g, (m, name) => TEX_SYMBOLS[name] ?? m);
  out = out.replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>').replace(/\^(.)/g, '<sup>$1</sup>');
  out = out.replace(/_\{([^}]*)\}/g, '<sub>$1</sub>').replace(/_(.)/g, '<sub>$1</sub>');
  out = out.replace(/\\([{}_^\\])/g, '$1');
  return out.replace(/\n/g, '<br>');
}

const clean = (arr) => arr.map(v => (Number.isFinite(v) ? v : null));
const colorCss = (c, alpha = 1) => (Array.isArray(c) ? rgbCss(c, alpha) : 'rgba(0,0,0,0)');

// Plotly marker settings for a MATLAB marker on a line-like object.
function markerStyle(o, color) {
  const face = o.markerFaceColor === 'none' ? null : (o.markerFaceColor === 'auto' || o.markerFaceColor === 'flat') ? color : o.markerFaceColor;
  const edge = o.markerEdgeColor === 'none' ? null : (o.markerEdgeColor === 'auto' || o.markerEdgeColor === 'flat') ? color : o.markerEdgeColor;
  const filled = o.marker === '.' || (face && !LINE_ONLY_SYMBOLS.has(o.marker));
  const symbol = SYMBOL[o.marker] + (filled ? '' : '-open');
  const size = o.marker === '.' ? Math.max(pt(o.markerSize) / 2.5, 3) : pt(o.markerSize);
  const shown = (o.marker === '.' ? color : filled ? face : edge) || color;
  return { symbol, size, color: colorCss(shown), line: { color: colorCss(edge || shown), width: 1 } };
}

function lineWidthPx(w) { return Math.max(1.25, pt(w)); }

function lineTrace(o, color = o.color) {
  const modes = [o.lineStyle !== 'none' ? 'lines' : null, o.marker !== 'none' ? 'markers' : null].filter(Boolean);
  const t = {
    type: 'scatter', mode: modes.length ? modes.join('+') : 'none', x: clean(o.x), y: clean(o.y),
    line: { color: colorCss(color), width: lineWidthPx(o.lineWidth), dash: DASH[o.lineStyle] || 'solid' },
  };
  if (o.shape) t.line.shape = o.shape;
  if (o.marker !== 'none') t.marker = markerStyle(o, color);
  return t;
}

// The traces for one plotted object (several for stems).
function objectTraces(o) {
  switch (o.type) {
    case 'line': return [lineTrace(o)];
    case 'errorbar': {
      const t = lineTrace(o);
      t.error_y = {
        type: 'data', symmetric: false, array: clean(o.pos), arrayminus: clean(o.neg),
        color: colorCss(o.color), thickness: lineWidthPx(o.lineWidth), width: pt(o.capSize) / 2,
      };
      return [t];
    }
    case 'stem': {
      const xs = [], ys = [];
      o.x.forEach((x, k) => { xs.push(x, x, null); ys.push(0, o.y[k], null); });
      const stems = { type: 'scatter', mode: 'lines', x: xs, y: clean(ys), hoverinfo: 'skip', showlegend: false,
        line: { color: colorCss(o.color), width: lineWidthPx(o.lineWidth), dash: DASH[o.lineStyle] || 'solid' } };
      const heads = lineTrace({ ...o, lineStyle: 'none' });
      return [stems, heads];
    }
    case 'scatter': {
      const sizeOf = (s) => Math.sqrt(Math.max(s, 0)) * 4 / 3;
      const color = o.colorValues ? null : o.color;
      const marker = {
        symbol: SYMBOL[o.marker] + (o.filled || o.markerFaceColor !== 'none' ? '' : '-open'),
        size: Array.isArray(o.sizes) ? o.sizes.map(sizeOf) : sizeOf(o.sizes),
        line: { width: lineWidthPx(o.lineWidth) / 1.5 },
      };
      if (o.colorValues) {
        marker.color = clean(o.colorValues);
        marker.colorscale = PARULA.map((c, k) => [k / (PARULA.length - 1), rgbCss(c)]);
      } else {
        const face = Array.isArray(o.markerFaceColor) ? o.markerFaceColor : color;
        marker.color = colorCss(o.filled || o.markerFaceColor !== 'none' ? face : (Array.isArray(o.markerEdgeColor) ? o.markerEdgeColor : color));
        marker.line.color = colorCss(Array.isArray(o.markerEdgeColor) ? o.markerEdgeColor : color);
      }
      return [{ type: 'scatter', mode: 'markers', x: clean(o.x), y: clean(o.y), marker }];
    }
    case 'bar': {
      const t = { type: 'bar', marker: { color: colorCss(o.faceColor), line: { color: colorCss(o.edgeColor), width: 1 } } };
      if (o.horizontal) Object.assign(t, { orientation: 'h', x: clean(o.y), y: clean(o.x) });
      else Object.assign(t, { x: clean(o.x), y: clean(o.y) });
      return [t];
    }
    case 'histogram': {
      const centers = [], widths = [];
      for (let k = 0; k + 1 < o.edges.length; k++) { centers.push((o.edges[k] + o.edges[k + 1]) / 2); widths.push(o.edges[k + 1] - o.edges[k]); }
      return [{ type: 'bar', x: centers, y: clean(o.values), width: widths,
        marker: { color: colorCss(o.faceColor, o.faceAlpha), line: { color: colorCss(o.edgeColor), width: 1 } } }];
    }
    case 'area':
      return [{ type: 'scatter', mode: 'lines', x: clean(o.x), y: clean(o.y), stackgroup: `area${o.group}`,
        fillcolor: colorCss(o.faceColor, o.faceAlpha), line: { color: colorCss(o.edgeColor), width: 1 } }];
    case 'fill':
      return [{ type: 'scatter', mode: 'lines', x: clean([...o.x, o.x[0]]), y: clean([...o.y, o.y[0]]), fill: 'toself',
        fillcolor: colorCss(o.faceColor, o.faceAlpha), line: { color: colorCss(o.edgeColor), width: 1 } }];
    default:
      return [];
  }
}

// Paper-coordinate domain of an axes from its subplot cell (row 0 at top),
// leaving gaps between neighbours for tick labels and titles.
export function axesDomain(cell) {
  if (!cell) return { x: [0, 1], y: [0, 1] };
  const gapX = 0.08, gapY = 0.12;
  const x0 = cell.c0 / cell.cols + (cell.c0 > 0 ? gapX / 2 : 0);
  const x1 = (cell.c1 + 1) / cell.cols - (cell.c1 < cell.cols - 1 ? gapX / 2 : 0);
  const y1 = 1 - cell.r0 / cell.rows - (cell.r0 > 0 ? gapY / 2 : 0);
  const y0 = 1 - (cell.r1 + 1) / cell.rows + (cell.r1 < cell.rows - 1 ? gapY / 2 : 0);
  return { x: [x0, Math.max(x1, x0 + 0.01)], y: [y0, Math.max(y1, y0 + 0.01)] };
}

const LEGEND_POSITIONS = {
  northeast: ['x1', 'y1', 'right', 'top'], northwest: ['x0', 'y1', 'left', 'top'],
  southeast: ['x1', 'y0', 'right', 'bottom'], southwest: ['x0', 'y0', 'left', 'bottom'],
  north: ['xm', 'y1', 'center', 'top'], south: ['xm', 'y0', 'center', 'bottom'],
  east: ['x1', 'ym', 'right', 'middle'], west: ['x0', 'ym', 'left', 'middle'],
};

function legendLayout(loc, dom, boxOff) {
  const d = { x0: dom.x[0] + 0.01, x1: dom.x[1] - 0.01, xm: (dom.x[0] + dom.x[1]) / 2, y0: dom.y[0] + 0.02, y1: dom.y[1] - 0.02, ym: (dom.y[0] + dom.y[1]) / 2 };
  let pos;
  if (loc === 'northeastoutside' || loc === 'eastoutside') pos = { x: dom.x[1] + 0.01, y: loc === 'eastoutside' ? d.ym : dom.y[1], xanchor: 'left', yanchor: loc === 'eastoutside' ? 'middle' : 'top' };
  else {
    const [xk, yk, xa, ya] = LEGEND_POSITIONS[loc] || LEGEND_POSITIONS.northeast;
    pos = { x: d[xk], y: d[yk], xanchor: xa, yanchor: ya };
  }
  // traceorder 'normal': Plotly would otherwise reverse the entries when the figure has stacked traces.
  return { ...pos, xref: 'paper', yref: 'paper', traceorder: 'normal', bgcolor: 'rgba(255,255,255,0.9)', bordercolor: boxOff ? 'rgba(0,0,0,0)' : INK, borderwidth: 1 };
}

function axisLayout(ax, dim, suffix, dom) {
  const scale = ax[`${dim}scale`];
  const lim = ax[`${dim}lim`];
  const a = {
    domain: dom[dim], anchor: (dim === 'x' ? 'y' : 'x') + suffix,
    type: scale === 'log' ? 'log' : 'linear', visible: ax.visible,
    showgrid: ax.grid, gridcolor: '#e0e0e0', zeroline: false,
    showline: true, linecolor: INK, mirror: ax.box ? 'ticks' : false, ticks: 'inside', tickcolor: INK, ticklen: 4,
    automargin: true,
  };
  if (ax.minorGrid) a.minor = { showgrid: true, gridcolor: '#f0f0f0' };
  if (lim) { a.range = scale === 'log' ? lim.map(v => Math.log10(v)) : lim.slice(); a.autorange = false; }
  if (dim === 'y' && ax.ydir === 'reverse') {
    if (a.range) a.range = a.range.slice().reverse(); else a.autorange = 'reversed';
  }
  if (dim === 'y' && ax.equal) { a.scaleanchor = `x${suffix}`; a.scaleratio = 1; }
  const label = ax[`${dim}label`];
  if (label) a.title = { text: texToHtml(label.text), font: label.fontSize ? { size: pt(label.fontSize) } : undefined };
  const ticks = ax[`${dim}ticks`], tickLabels = ax[`${dim}ticklabels`];
  if (ticks || tickLabels) {
    a.tickmode = 'array';
    a.tickvals = ticks || tickLabels.map((_, k) => k + 1);
    if (tickLabels) a.ticktext = tickLabels.map(texToHtml);
  }
  return a;
}

function titleAnnotation(title, dom) {
  let text = `<b>${texToHtml(title.text)}</b>`;
  if (title.subtitle) text += `<br><span style="font-size:0.85em">${texToHtml(title.subtitle)}</span>`;
  return {
    text, x: (dom.x[0] + dom.x[1]) / 2, y: dom.y[1], xref: 'paper', yref: 'paper',
    xanchor: 'center', yanchor: 'bottom', yshift: 6, showarrow: false,
    font: { size: title.fontSize ? pt(title.fontSize) : 14, color: title.color ? rgbCss(title.color) : INK },
  };
}

export function figureToPlotly(fig) {
  const data = [];
  const layout = { annotations: [], showlegend: false, barmode: 'group', bargap: 0.2, hovermode: 'closest' };
  let cartesian = 0, polar = 0, legends = 0;
  let objectCount = 0;
  let topTitle = false;
  for (const ax of fig.axes) {
    const dom = axesDomain(ax.cell);
    if (ax.title && dom.y[1] > 0.99) topTitle = true;
    const legendId = ax.legend.show ? (++legends === 1 ? 'legend' : `legend${legends}`) : null;
    if (legendId) { layout[legendId] = legendLayout(ax.legend.location, dom, ax.legend.boxOff); layout.showlegend = true; }
    const withLegend = (t, o) => {
      objectCount++;
      t.name = texToHtml(o.displayName ?? `data${objectCount}`);
      if (t.showlegend !== false) t.showlegend = !!legendId;
      if (legendId) t.legend = legendId;
      return t;
    };

    if (ax.kind === 'pie') {
      for (const o of ax.objects) {
        data.push({
          type: 'pie', values: o.values, labels: o.labels || o.values.map((_, k) => `data${k + 1}`),
          textinfo: o.labels ? 'label' : 'percent', sort: false, direction: 'counterclockwise',
          marker: { colors: o.colors.map(c => rgbCss(c)), line: { color: INK, width: 1 } },
          domain: { x: dom.x, y: dom.y }, showlegend: !!legendId, ...(legendId ? { legend: legendId } : {}),
        });
      }
    } else if (ax.kind === 'polar') {
      polar++;
      const sub = polar === 1 ? 'polar' : `polar${polar}`;
      layout[sub] = { domain: { x: dom.x, y: dom.y }, angularaxis: { direction: 'counterclockwise', rotation: 0, gridcolor: '#e0e0e0' }, radialaxis: { gridcolor: '#e0e0e0' } };
      for (const o of ax.objects) {
        for (const t of objectTraces(o)) {
          const { x, y, ...rest } = t;
          data.push(withLegend({ ...rest, type: 'scatterpolar', r: y, theta: x, thetaunit: 'radians', subplot: sub }, o));
        }
      }
    } else {
      cartesian++;
      const suffix = cartesian === 1 ? '' : String(cartesian);
      layout[`xaxis${suffix}`] = axisLayout(ax, 'x', suffix, dom);
      layout[`yaxis${suffix}`] = axisLayout(ax, 'y', suffix, dom);
      for (const o of ax.objects) {
        if (o.type === 'bar') {
          if (o.layout === 'stacked') layout.barmode = 'stack';
          layout.bargap = Math.min(Math.max(1 - o.barWidth, 0), 0.95);
        }
        const traces = objectTraces(o);
        traces.forEach((t, k) => {
          t.xaxis = `x${suffix}`; t.yaxis = `y${suffix}`;
          // Only the last trace of a multi-trace object (the stem heads) gets a legend entry.
          if (k < traces.length - 1) { t.showlegend = false; data.push(t); }
          else data.push(withLegend(t, o));
        });
      }
      const logx = ax.xscale === 'log', logy = ax.yscale === 'log';
      for (const tx of ax.texts) {
        layout.annotations.push({
          text: texToHtml(tx.str), x: logx ? Math.log10(tx.x) : tx.x, y: logy ? Math.log10(tx.y) : tx.y,
          xref: `x${suffix}`, yref: `y${suffix}`, showarrow: false,
          xanchor: tx.hAlign === 'right' ? 'right' : tx.hAlign === 'center' ? 'center' : 'left',
          yanchor: tx.vAlign === 'top' || tx.vAlign === 'cap' ? 'top' : tx.vAlign === 'bottom' || tx.vAlign === 'baseline' ? 'bottom' : 'middle',
          font: { size: pt(tx.fontSize), color: rgbCss(tx.color) },
        });
      }
    }
    if (ax.title) layout.annotations.push(titleAnnotation(ax.title, dom));
  }
  if (fig.sgtitle) {
    layout.title = { text: `<b>${texToHtml(fig.sgtitle.text)}</b>`, font: { size: fig.sgtitle.fontSize ? pt(fig.sgtitle.fontSize) : 16 }, x: 0.5, xanchor: 'center' };
  }
  if (fig.axes.length === 0) { layout.xaxis = { visible: false }; layout.yaxis = { visible: false }; } // an empty figure window
  layout.margin = { t: (fig.sgtitle ? 50 : 10) + (topTitle ? 35 : 10), r: 20, b: 45, l: 55 };
  return { data, layout };
}
