// plotting3d.js — 3-D plots, images and color: plot3, scatter3, surf, mesh,
// contour, contourf, imagesc, image, colormap (and the colormap functions
// parula, jet, gray, ...), colorbar, clim/caxis, view, zlabel, zlim,
// shading, plus the demo-data functions peaks and sphere.
//
// Same figure model as plotting.js (see its header); new object types:
//   line3 / scatter3   x, y, z vectors
//   surface            x, y, z, c as arrays of rows (surf and mesh)
//   contour            x, y vectors and z rows, levels, filled
//   image              x, y cell centers and c rows (imagesc / image)

import { Mat, MatlabError } from '../core/values.js';
import { plotKit } from './plotting.js';
import { COLORMAPS, DEFAULT_COLORMAP_SIZE, colorDataRange } from '../plot/colormaps.js';
import { parseLinespec, markerFromText, colorFromText } from '../plot/style.js';
import { finiteScalarArg } from './numutil.js';

const {
  isText, textOf, values, handlesMat, currentFigure, currentAxes, prepareAxes, nextHandle, touch,
  parseProps, colorValue, colormapValue, defaultColormap, findHandle, columns, rowsOf, makeLine,
  takeFlags, LINE_PROPS, labelArgs, limitsArg, nextColor,
} = plotKit;

const SURFACE_PROPS = ['facecolor', 'edgecolor', 'facealpha', 'linestyle', 'linewidth', 'displayname'];

function linspace(a, b, n) {
  return Array.from({ length: n }, (_, k) => (n === 1 ? b : a + (b - a) * k / (n - 1)));
}

// X, Y, Z (and optional C) for surf/mesh/contour from (Z), (Z, C),
// (X, Y, Z) or (X, Y, Z, C); vector X and Y are expanded to grids.
function gridArgs(nums, fname, allowC) {
  let X = null, Y = null, Z, C = null;
  if (nums.length === 1) [Z] = nums;
  else if (nums.length === 2 && allowC) [Z, C] = nums;
  else if (nums.length === 3) [X, Y, Z] = nums;
  else if (nums.length === 4 && allowC) [X, Y, Z, C] = nums;
  else throw new MatlabError(`${fname}: expected ${fname}(Z) or ${fname}(X, Y, Z)${allowC ? ' (with an optional color matrix C)' : ''}`);
  if (Z.rows < 2 || Z.cols < 2) throw new MatlabError(`${fname}: Z must be a matrix (at least 2-by-2)`);
  const m = Z.rows, n = Z.cols;
  const z = rowsOf(Z);
  const expand = (v, isX) => {
    if (!v) return Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, j) => (isX ? j + 1 : i + 1)));
    if (v.isVector) {
      const vals = values(v);
      if (vals.length !== (isX ? n : m)) throw new MatlabError(`${fname}: the length of ${isX ? 'X' : 'Y'} must match the number of ${isX ? 'columns' : 'rows'} of Z`);
      return Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, j) => (isX ? vals[j] : vals[i])));
    }
    if (v.rows !== m || v.cols !== n) throw new MatlabError(`${fname}: X, Y and Z must be the same size`);
    return rowsOf(v);
  };
  const x = expand(X, true), y = expand(Y, false);
  let c = z;
  if (C) {
    if (C.rows !== m || C.cols !== n) throw new MatlabError(`${fname}: C must be the same size as Z`);
    c = rowsOf(C);
  }
  return { x, y, z, c };
}

function splitNumeric(args) {
  const nums = [];
  let i = 0;
  while (i < args.length && !isText(args[i])) nums.push(args[i++]);
  return { nums, rest: args.slice(i) };
}

// plot3(x, y, z, spec, ..., Name, Value): triplets, matrices give one line per column.
function plot3Groups(args) {
  const groups = [];
  let i = 0;
  while (i < args.length && !isText(args[i])) {
    if (i + 2 >= args.length || isText(args[i + 1]) || isText(args[i + 2])) throw new MatlabError('plot3: data must come in X, Y, Z triplets');
    const g = { x: args[i], y: args[i + 1], z: args[i + 2] };
    i += 3;
    if (i < args.length && isText(args[i]) && parseLinespec(args[i].toJSString())) g.spec = parseLinespec(args[i++].toJSString());
    groups.push(g);
  }
  if (groups.length === 0) throw new MatlabError('plot3: not enough input arguments');
  return { groups, pairs: args.slice(i) };
}

function tripletLines(g) {
  const parts = [g.x, g.y, g.z];
  if (parts.every(p => p.isVector)) {
    const [x, y, z] = parts.map(values);
    if (x.length !== y.length || x.length !== z.length) throw new MatlabError('plot3: X, Y and Z must be the same length');
    return [{ x, y, z }];
  }
  const ref = parts.find(p => !p.isVector);
  const cols = (p) => (p.isVector ? Array.from({ length: ref.cols }, () => values(p)) : columns(p));
  const [xc, yc, zc] = parts.map(cols);
  return zc.map((z, k) => {
    if (xc[k].length !== z.length || yc[k].length !== z.length) throw new MatlabError('plot3: X, Y and Z must be the same size');
    return { x: xc[k], y: yc[k], z };
  });
}

function peaksGrid(x, y) {
  return x.map((row, i) => row.map((xv, j) => {
    const yv = y[i][j];
    return 3 * (1 - xv) ** 2 * Math.exp(-(xv ** 2) - (yv + 1) ** 2)
      - 10 * (xv / 5 - xv ** 3 - yv ** 5) * Math.exp(-(xv ** 2) - yv ** 2)
      - Math.exp(-((xv + 1) ** 2) - yv ** 2) / 3;
  }));
}

function addSurface(ctx, nargout, style, args) {
  const { nums, rest } = splitNumeric(args);
  const { x, y, z, c } = gridArgs(nums, style, true);
  const props = parseProps(rest, SURFACE_PROPS, style);
  const ax = prepareAxes(ctx, '3d');
  if (!ax.hold) ax.grid = true; // surf and mesh turn the grid on, as in MATLAB
  let edgeColor = props.edgeColor ?? (style === 'mesh' ? 'flat' : [0, 0, 0]);
  if (props.lineStyle === 'none') edgeColor = 'none';
  const obj = {
    h: nextHandle(ctx.interp), type: 'surface', style, x, y, z, c,
    faceColor: props.faceColor ?? (style === 'mesh' ? [1, 1, 1] : 'flat'),
    edgeColor, faceAlpha: props.faceAlpha ?? 1, lineWidth: props.lineWidth ?? 0.5,
    displayName: props.displayName ?? null,
  };
  ax.objects.push(obj);
  touch(ctx);
  return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
}

function contourFn(fname, filled) {
  return (args, nargout, ctx) => {
    const { nums, rest } = splitNumeric(args);
    let levels = null;
    // contour(Z, n), contour(X, Y, Z, levels): a trailing scalar or vector after the data.
    if (nums.length === 2 || nums.length === 4) {
      const l = nums.pop();
      levels = l.isScalar ? Math.round(l.re[0]) : values(l);
    }
    let lineSpecColor = null;
    let pairs = rest;
    if (pairs.length && parseLinespec(pairs[0].toJSString()) && pairs.length % 2 === 1) {
      const spec = parseLinespec(pairs[0].toJSString());
      lineSpecColor = spec.color || null;
      pairs = pairs.slice(1);
    }
    const props = parseProps(pairs, ['linewidth', 'linecolor', 'showtext', 'levellist', 'displayname', 'linestyle'], fname);
    if (props.levelList) levels = props.levelList;
    const { x, y, z } = gridArgs(nums, fname, false);
    const ax = prepareAxes(ctx, 'cartesian');
    const obj = {
      h: nextHandle(ctx.interp), type: 'contour', filled,
      x: x[0].slice(), y: y.map(r => r[0]), z, levels,
      lineWidth: props.lineWidth ?? 0.5,
      lineColor: props.lineColor ?? lineSpecColor ?? (filled ? [0, 0, 0] : 'flat'),
      showText: props.showText ?? false, displayName: props.displayName ?? null,
    };
    ax.objects.push(obj);
    touch(ctx);
    return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
  };
}

function imageFn(fname, scaled) {
  return (args, nargout, ctx) => {
    const { nums, rest } = splitNumeric(args);
    let X = null, Y = null, Cm, clims = null;
    if (nums.length === 1) [Cm] = nums;
    else if (nums.length === 2 && scaled) [Cm, clims] = nums;
    else if (nums.length === 3) [X, Y, Cm] = nums;
    else if (nums.length === 4 && scaled) [X, Y, Cm, clims] = nums;
    else throw new MatlabError(`${fname}: expected ${fname}(C) or ${fname}(x, y, C)`);
    if (rest.length) parseProps(rest, [], fname);
    const m = Cm.rows, n = Cm.cols;
    // x and y give the centers of the first and last columns/rows (or all of them).
    const centers = (v, count) => {
      if (!v) return Array.from({ length: count }, (_, k) => k + 1);
      const a = values(v);
      if (a.length === count) return a;
      return linspace(a[0], a[a.length - 1], count);
    };
    const ax = prepareAxes(ctx, 'cartesian');
    if (!ax.hold) ax.ydir = 'reverse'; // images put row 1 at the top
    if (clims) {
      const c = values(clims);
      if (c.length !== 2 || !(c[0] < c[1])) throw new MatlabError(`${fname}: color limits must be [low high] with low < high`);
      ax.clim = c;
    }
    const obj = { h: nextHandle(ctx.interp), type: 'image', scaled, x: centers(X, n), y: centers(Y, m), c: rowsOf(Cm) };
    ax.objects.push(obj);
    touch(ctx);
    return nargout >= 1 ? [Mat.scalar(obj.h)] : [];
  };
}

export function registerPlotting3d(reg) {
  reg.set('plot3', {
    fn: (args, nargout, ctx) => {
      const { groups, pairs } = plot3Groups(args);
      const props = parseProps(pairs, LINE_PROPS, 'plot3');
      const ax = prepareAxes(ctx, '3d');
      const hs = [];
      for (const g of groups) {
        for (const xyz of tripletLines(g)) {
          const obj = makeLine(ctx, ax, xyz, g.spec, props, 'line3');
          obj.z = xyz.z;
          ax.objects.push(obj);
          hs.push(obj.h);
        }
      }
      touch(ctx);
      return nargout >= 1 ? [handlesMat(hs)] : [];
    },
  });

  // scatter3(x, y, z), (..., sz), (..., sz, c), 'filled', marker, Name, Value.
  reg.set('scatter3', {
    fn: (args, nargout, ctx) => {
      if (args.length < 3) throw new MatlabError('scatter3 requires x, y and z');
      const [x, y, z] = args.slice(0, 3).map(values);
      if (x.length !== y.length || x.length !== z.length) throw new MatlabError('scatter3: X, Y and Z must be the same length');
      let i = 3, sizes = 36, color = null, colorValues = null;
      if (i < args.length && !isText(args[i])) { const s = args[i++]; if (!s.isEmpty) sizes = s.numel === 1 ? s.re[0] : values(s); }
      if (i < args.length && !isText(args[i])) {
        const c = args[i++];
        if (c.numel === 3 && x.length !== 3) color = values(c); else if (!c.isEmpty) colorValues = values(c);
      } else if (i < args.length && colorFromText(args[i].toJSString()) && !markerFromText(args[i].toJSString())) color = colorFromText(args[i++].toJSString());
      const { rest, found } = takeFlags(args.slice(i), ['filled']);
      let marker = 'o';
      if (rest.length && isText(rest[0]) && rest[0].toJSString().length === 1 && markerFromText(rest[0].toJSString())) marker = markerFromText(rest.shift().toJSString());
      const props = parseProps(rest, ['marker', 'markerfacecolor', 'markeredgecolor', 'linewidth', 'displayname', 'color'], 'scatter3');
      const ax = prepareAxes(ctx, '3d');
      const filled = found.has('filled');
      const obj = {
        h: nextHandle(ctx.interp), type: 'scatter3', x, y, z, sizes,
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

  reg.set('surf', { fn: (args, nargout, ctx) => addSurface(ctx, nargout, 'surf', args) });
  reg.set('mesh', { fn: (args, nargout, ctx) => addSurface(ctx, nargout, 'mesh', args) });
  reg.set('contour', { fn: contourFn('contour', false) });
  reg.set('contourf', { fn: contourFn('contourf', true) });
  reg.set('imagesc', { fn: imageFn('imagesc', true) });
  reg.set('image', { fn: imageFn('image', false) });

  // ---- color ----
  // colormap(name | map), colormap(target, ...), colormap default, map = colormap
  reg.set('colormap', {
    fn: (args, _n, ctx) => {
      let target = null;
      let rest = args;
      if (rest.length && !isText(rest[0]) && rest[0].isScalar) {
        const found = findHandle(ctx.interp, rest[0].re[0]);
        if (!found) throw new MatlabError('colormap: invalid graphics handle');
        target = found;
        rest = rest.slice(1);
      }
      const fig = target ? target.fig : currentFigure(ctx);
      const ax = target && target.kind === 'axes' ? target.ax : null;
      if (rest.length === 0) {
        const map = (ax && ax.colormap) || fig.colormap || defaultColormap();
        return [Mat.fromRows(map)];
      }
      const map = isText(rest[0]) && rest[0].toJSString().toLowerCase() === 'default' ? null : colormapValue(rest[0]);
      if (ax) ax.colormap = map; else fig.colormap = map;
      touch(ctx, fig.num);
      return [];
    },
  });
  for (const name of Object.keys(COLORMAPS)) {
    reg.set(name, {
      fn: (args) => {
        const n = args.length ? Math.round(finiteScalarArg(args[0], name, 'the number of colors')) : DEFAULT_COLORMAP_SIZE;
        if (!(n >= 0)) throw new MatlabError(`${name}: the number of colors must be non-negative`);
        return [n === 0 ? Mat.zeros(0, 3) : Mat.fromRows(COLORMAPS[name](n))];
      },
    });
  }

  // colorbar | colorbar off | colorbar('off')
  reg.set('colorbar', {
    fn: (args, nargout, ctx) => {
      const ax = currentAxes(ctx);
      const mode = args.length && isText(args[0]) ? args[0].toJSString().toLowerCase() : 'on';
      ax.colorbar = !(mode === 'off' || mode === 'hide' || mode === 'delete');
      touch(ctx);
      return nargout >= 1 ? [Mat.scalar(ax.h)] : [];
    },
  });

  // clim([low high]) | clim auto | lims = clim   (caxis is the older name)
  const climFn = {
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      if (args.length === 0) return [Mat.fromRows([ax.clim || colorDataRange(ax)])];
      if (isText(args[0])) {
        const mode = args[0].toJSString().toLowerCase();
        if (mode === 'auto') ax.clim = null;
        else if (mode !== 'manual') throw new MatlabError(`clim: unsupported mode '${mode}'`);
      } else {
        const v = values(args[0]);
        if (v.length !== 2 || !(v[0] < v[1])) throw new MatlabError('clim: limits must be [low high] with low < high');
        ax.clim = v;
      }
      touch(ctx);
      return [];
    },
  };
  reg.set('clim', climFn);
  reg.set('caxis', climFn);

  // view(az, el) | view([az el]) | view(2) | view(3) | [az, el] = view
  reg.set('view', {
    fn: (args, nargout, ctx) => {
      const ax = currentAxes(ctx);
      if (args.length === 0) {
        return nargout >= 2 ? [Mat.scalar(ax.view[0]), Mat.scalar(ax.view[1])] : [Mat.fromRows([ax.view])];
      }
      let v;
      if (args.length >= 2) v = [args[0].toScalarNumber(), args[1].toScalarNumber()];
      else if (args[0].numel === 2) v = values(args[0]);
      else {
        const d = args[0].toScalarNumber();
        if (d === 2) v = [0, 90];
        else if (d === 3) v = [-37.5, 30];
        else throw new MatlabError('view: expected view(2), view(3), view(az, el) or view([az el])');
      }
      ax.view = v;
      touch(ctx);
      return [];
    },
  });

  reg.set('zlabel', {
    fn: (args, _n, ctx) => {
      const ax = currentAxes(ctx);
      ax.zlabel = labelArgs(args, 'zlabel');
      touch(ctx);
      return [];
    },
  });
  reg.set('zlim', { fn: (args, _n, ctx) => limitsArg(args, currentAxes(ctx), 'zlim', 'zlim', ctx) });

  // shading flat | interp | faceted (applies to the surfaces in the current axes)
  reg.set('shading', {
    fn: (args, _n, ctx) => {
      const mode = args.length ? textOf(args[0], 'shading').toLowerCase() : '';
      if (!['flat', 'interp', 'faceted'].includes(mode)) throw new MatlabError('shading: expected flat, interp or faceted');
      const ax = currentAxes(ctx);
      for (const o of ax.objects) {
        if (o.type !== 'surface') continue;
        if (o.style === 'mesh') { o.edgeColor = mode === 'interp' ? 'interp' : 'flat'; continue; }
        o.faceColor = mode === 'interp' ? 'interp' : 'flat';
        o.edgeColor = mode === 'faceted' ? [0, 0, 0] : 'none';
      }
      touch(ctx);
      return [];
    },
  });

  // ---- demo data ----
  // Z = peaks(n) | [X, Y, Z] = peaks(n) | peaks(X, Y) | peaks (plots it)
  reg.set('peaks', {
    fn: (args, nargout, ctx) => {
      let x, y;
      if (args.length >= 2) {
        const X = args[0], Y = args[1];
        if (X.isVector && Y.isVector) {
          const xv = values(X), yv = values(Y);
          x = yv.map(() => xv.slice()); y = yv.map(v => xv.map(() => v));
        } else {
          if (X.rows !== Y.rows || X.cols !== Y.cols) throw new MatlabError('peaks: X and Y must be vectors or matrices of the same size');
          x = rowsOf(X); y = rowsOf(Y);
        }
      } else {
        const n = args.length ? args[0] : Mat.scalar(49);
        const v = n.isScalar ? linspace(-3, 3, Math.max(0, Math.round(finiteScalarArg(n, 'peaks')))) : values(n);
        x = v.map(() => v.slice()); y = v.map(w => v.map(() => w));
      }
      const z = peaksGrid(x, y);
      if (nargout === 0) return addSurface(ctx, 0, 'surf', [Mat.fromRows(x), Mat.fromRows(y), Mat.fromRows(z)]);
      if (nargout === 1) return [Mat.fromRows(z)];
      return [Mat.fromRows(x), Mat.fromRows(y), Mat.fromRows(z)];
    },
  });
  // [X, Y, Z] = sphere(n) (unit sphere, (n+1)-by-(n+1)) | sphere (plots it)
  reg.set('sphere', {
    fn: (args, nargout, ctx) => {
      const n = args.length ? Math.round(finiteScalarArg(args[0], 'sphere')) : 20;
      if (!(n >= 2)) throw new MatlabError('sphere: n must be at least 2');
      const theta = linspace(-Math.PI, Math.PI, n + 1), phi = linspace(-Math.PI / 2, Math.PI / 2, n + 1);
      const X = phi.map(p => theta.map(t => Math.cos(p) * Math.cos(t)));
      const Y = phi.map(p => theta.map(t => Math.cos(p) * Math.sin(t)));
      const Z = phi.map(p => theta.map(() => Math.sin(p)));
      if (nargout === 0) return addSurface(ctx, 0, 'surf', [Mat.fromRows(X), Mat.fromRows(Y), Mat.fromRows(Z)]);
      return [Mat.fromRows(X), Mat.fromRows(Y), Mat.fromRows(Z)];
    },
  });
}
