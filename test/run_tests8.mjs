// Tests for 3-D plots, images and color (src/builtins/plotting3d.js,
// src/plot/colormaps.js), saving figures, and drawnow/pause animation.
import { makeInterp, fmtVar } from './harness.js';
import { figureToPlotly, sceneLayout } from '../src/plot/toPlotly.js';
import { colormapByName, plotlyColorscale, colorDataRange } from '../src/plot/colormaps.js';
import { rgbCss } from '../src/plot/style.js';
import { createSession } from '../src/worker/session.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkClose(label, actual, expected, tol = 1e-4) {
  const a = [actual].flat(Infinity), e = [expected].flat(Infinity);
  if (a.length === e.length && a.every((v, k) => Math.abs(v - e[k]) <= tol)) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function checkThrows(label, fn, pattern) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { fail++; console.log(`FAIL(wrong error): ${label}\n  got: ${e.message}`); }
    else pass++;
  }
}
function setup() {
  const h = makeInterp();
  h.exports = [];
  h.flushes = 0;
  h.interp.host.figures.export = (num, fig, request) => h.exports.push({ num, request, axes: fig.axes.length });
  h.interp.host.figures.flush = () => { h.flushes++; };
  h.fig = () => h.interp.figures.get(h.interp.figureState.current);
  h.ax = () => { const f = h.fig(); return f.axes.find(a => a.h === f.current); };
  h.plotly = () => figureToPlotly(h.fig());
  h.v = (name) => fmtVar(h.interp, name);
  return h;
}

// ---------------- colormaps ----------------
{
  check('jet(4) matches MATLAB', colormapByName('jet', 4), [[0, 0, 1], [0, 1, 1], [1, 1, 0], [1, 0, 0]]);
  check('jet(8) rows 2-3 (exact jet.m)', colormapByName('jet', 8).slice(1, 3), [[0, 0.5, 1], [0, 1, 1]]);
  check('gray(3)', colormapByName('gray', 3), [[0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1]]);
  checkClose('hot(8) ends white, starts dark red', [colormapByName('hot', 8)[0], colormapByName('hot', 8)[7]], [[1 / 3, 0, 0], [1, 1, 1]]);
  checkClose('parula endpoints', [colormapByName('parula', 2)[0], colormapByName('parula', 2)[1]], [[0.2422, 0.1504, 0.6603], [0.9769, 0.9839, 0.0805]]);
  check('unknown colormap', colormapByName('nope', 4), null);
  check('colorscale is capped at 64 stops', plotlyColorscale(colormapByName('parula', 256), rgbCss).length, 64);
  check('colorscale of a 2-color map', plotlyColorscale([[0, 0, 0], [1, 1, 1]], rgbCss), [[0, 'rgb(0,0,0)'], [1, 'rgb(255,255,255)']]);
  check('color range of an empty axes', colorDataRange({ objects: [] }), [0, 1]);
  check('flat color data is padded', colorDataRange({ objects: [{ type: 'image', c: [[2, 2]] }] }), [1.5, 2.5]);

  const h = setup();
  h.run('a = size(jet); b = size(parula(10)); c = gray(0); d = hot(4);');
  check('jet default size is 256-by-3', h.v('a').re, [256, 3]);
  check('parula(10) is 10-by-3', h.v('b').re, [10, 3]);
  check('gray(0) is 0-by-3', [h.v('c').rows, h.v('c').cols], [0, 3]);
  check('every colormap function exists', ['turbo', 'hsv', 'cool', 'spring', 'summer', 'autumn', 'winter', 'bone', 'copper', 'pink', 'white', 'lines']
    .map(n => { h.run(`q = size(${n}(5));`); return h.v('q').re.join('x'); }), Array(12).fill('5x3'));
  checkThrows('negative colormap size', () => h.run('jet(-1)'), /non-negative/);
}

// ---------------- colormap / colorbar / clim ----------------
{
  const h = setup();
  h.run('surf(peaks(5)); colormap hot; cm = colormap;');
  check('colormap name sets the figure colormap', [h.v('cm').rows, h.v('cm').re[h.v('cm').rows - 1]], [256, 1]);
  let { layout } = h.plotly();
  check('figure colormap reaches the color axis', layout.coloraxis.colorscale[63][1], 'rgb(255,255,255)');
  check('no colorbar by default', layout.coloraxis.showscale, false);
  h.run('colormap([0 0 0; 1 0 0]); colorbar');
  ({ layout } = h.plotly());
  check('colormap matrix', layout.coloraxis.colorscale, [[0, 'rgb(0,0,0)'], [1, 'rgb(255,0,0)']]);
  check('colorbar shows the scale and takes room from the axes', [layout.coloraxis.showscale, layout.scene.domain.x[1]], [true, 0.91]);
  h.run('colormap default; cm = colormap;');
  checkClose('colormap default is parula', h.v('cm').re[0], 0.2422);
  checkThrows('colormap matrix must be N-by-3', () => h.run('colormap([1 2])'), /colormap/);
  checkThrows('colormap values must be in [0, 1]', () => h.run('colormap([2 0 0])'), /between 0 and 1/);
  checkThrows('unknown colormap name', () => h.run('colormap nope'), /colormap/);
  h.run('colorbar off');
  check('colorbar off', h.plotly().layout.coloraxis.showscale, false);
  h.run('hc = colorbar; isax = hc == gca;');
  check('colorbar returns a handle', h.v('isax'), 1);

  h.run('lims = clim; Z = peaks(5); auto = [min(Z(:)) max(Z(:))];');
  check('automatic clim is the data range', h.v('lims').re, h.v('auto').re);
  h.run('clim([-1 1]); lims = clim;');
  check('clim sets the color limits', h.v('lims').re, [-1, 1]);
  ({ layout } = h.plotly());
  check('clim reaches the color axis', [layout.coloraxis.cmin, layout.coloraxis.cmax], [-1, 1]);
  h.run('caxis auto; lims = caxis;');
  check('caxis auto restores data limits', h.v('lims').re, h.v('auto').re);
  checkThrows('clim must be increasing', () => h.run('clim([1 0])'), /low < high/);
  h.run("set(gca, 'CLim', [0 2]); lims = get(gca, 'CLim');");
  check('CLim property', h.v('lims').re, [0, 2]);
  h.run("set(gcf, 'Colormap', gray(4)); cm = get(gcf, 'Colormap');");
  check('Colormap property', [h.v('cm').rows, h.v('cm').re[1]], [4, 1 / 3]);
}
{
  // Per-axes colormaps and colorbars in subplots: one color axis each.
  const h = setup();
  h.run('subplot(1,2,1); imagesc(magic(3)); colorbar; subplot(1,2,2); surf(peaks(4)); colormap(gca, jet); colorbar;');
  const { layout, data } = h.plotly();
  check('one color axis per axes', [data[0].coloraxis, data[1].coloraxis], ['coloraxis', 'coloraxis2']);
  check('axes colormap overrides the figure colormap', layout.coloraxis2.colorscale[0][1], 'rgb(0,0,131)');
  check('colorbars sit beside their axes', layout.coloraxis.colorbar.x < layout.coloraxis2.colorbar.x, true);
  check('both colorbars shown', [layout.coloraxis.showscale, layout.coloraxis2.showscale], [true, true]);
}

// ---------------- plot3 / scatter3 ----------------
{
  const h = setup();
  h.run("t = linspace(0, 1, 5); hl = plot3(t, 2*t, t.^2, 'r--o', 'LineWidth', 2); xlabel('x'); zlabel('z');");
  let { data, layout } = h.plotly();
  check('plot3 makes a scatter3d trace in a scene', [data[0].type, data[0].scene, data[0].mode], ['scatter3d', 'scene', 'lines+markers']);
  check('plot3 data', [data[0].x.length, data[0].y[4], data[0].z[4]], [5, 2, 1]);
  check('plot3 line spec and properties', [data[0].line.color, data[0].line.dash, data[0].line.width], ['rgb(255,0,0)', 'dash', 8 / 3]);
  check('zlabel goes to the scene', [layout.scene.xaxis.title.text, layout.scene.zaxis.title.text], ['x', 'z']);
  h.run("zd = get(hl, 'ZData'); set(hl, 'ZData', [5 4 3 2 1]);");
  check('ZData get/set', [h.v('zd').re[4], h.plotly().data[0].z[0]], [1, 5]);
  h.run('plot3([1 2; 3 4], [1 2; 3 4], [5 6; 7 8]);');
  check('plot3 matrices give one line per column', h.plotly().data.map(t => t.z), [[5, 7], [6, 8]]);
  checkThrows('plot3 needs triplets', () => h.run('plot3(1:3, 1:3)'), /triplets/);
  checkThrows('plot3 lengths must match', () => h.run('plot3(1:3, 1:3, 1:2)'), /same length/);

  h.run("scatter3([1 2 3], [4 5 6], [7 8 9], 50, [1 2 3], 'filled');");
  ({ data, layout } = h.plotly());
  check('scatter3 with color values uses the color axis', [data[0].type, data[0].marker.coloraxis, data[0].marker.color], ['scatter3d', 'coloraxis', [1, 2, 3]]);
  check('scatter3 per-point colors set the color limits', [layout.coloraxis.cmin, layout.coloraxis.cmax], [1, 3]);
  h.run("scatter3(1:3, 1:3, 1:3, 'r', 'DisplayName', 'pts'); legend show;");
  ({ data } = h.plotly());
  check('scatter3 solid color, open markers, legend name', [data[0].marker.color, data[0].marker.symbol, data[0].name], ['rgb(255,0,0)', 'circle-open', 'pts']);
}

// ---------------- surf / mesh / view / shading ----------------
{
  const h = setup();
  h.run('[X, Y] = meshgrid(1:3, 1:2); Z = X + Y; hs = surf(X, Y, Z);');
  let { data, layout } = h.plotly();
  check('surf gives a surface and its grid lines', data.map(t => t.type), ['surface', 'scatter3d']);
  check('surface data is rows', [data[0].z, data[0].surfacecolor], [[[2, 3, 4], [3, 4, 5]], [[2, 3, 4], [3, 4, 5]]]);
  check('surface uses the color axis, unlit', [data[0].coloraxis, data[0].lighting.ambient, data[0].lighting.diffuse], ['coloraxis', 1, 0]);
  check('surf edges are black', data[1].line.color, 'rgb(0,0,0)');
  check('grid lines: rows then columns, broken by nulls', data[1].z, [2, 3, 4, null, 3, 4, 5, null, 2, 3, null, 3, 4, null, 4, 5, null]);
  check('surf turns the grid on', layout.scene.xaxis.showgrid, true);
  check('default 3-D view', h.ax().view, [-37.5, 30]);
  check('orthographic camera', layout.scene.camera.projection.type, 'orthographic');
  checkClose('camera eye for view(-37.5, 30)', [layout.scene.camera.eye.x, layout.scene.camera.eye.y, layout.scene.camera.eye.z],
    [1.9 * Math.sin(-37.5 * Math.PI / 180) * Math.cos(Math.PI / 6), -1.9 * Math.cos(-37.5 * Math.PI / 180) * Math.cos(Math.PI / 6), 0.95]);
  checkClose('cube box sized for the default view', [layout.scene.aspectratio.x, layout.scene.aspectratio.z], [1.0004, 1.0004], 1e-3);

  h.run('view(2); [az, el] = view;');
  check('view(2) is the top view', [h.v('az'), h.v('el')], [0, 90]);
  ({ layout } = h.plotly());
  checkClose('top view looks down with +y up, zoomed to fill', [layout.scene.camera.eye.z, layout.scene.camera.up.y, layout.scene.aspectratio.x], [1.9, 1, 1.567]);
  check('top view hides the end-on z axis', layout.scene.zaxis.visible, false);
  h.run('view(45, 60); v = view;');
  check('view(az, el)', h.v('v').re, [45, 60]);
  h.run('view([10 20]); v1 = view; view(3); v2 = view;');
  check('view([az el]) and view(3)', [h.v('v1').re, h.v('v2').re], [[10, 20], [-37.5, 30]]);
  h.run("set(gca, 'View', [0 0]); vv = get(gca, 'View');");
  check('View property', h.v('vv').re, [0, 0]);
  checkThrows('bad view', () => h.run('view(4)'), /view/);

  h.run('zlim([0 10]); z = zlim; axis equal');
  ({ layout } = h.plotly());
  check('zlim reaches the scene', [h.v('z').re, layout.scene.zaxis.range], [[0, 10], [0, 10]]);
  checkClose('axis equal keeps data proportions', [layout.scene.aspectratio.x / layout.scene.aspectratio.z, layout.scene.aspectratio.y / layout.scene.aspectratio.z], [0.2, 0.1]); // x 1..3, y 1..2, zlim [0 10]
  h.run('axis([0 4 0 3 1 6]); a = axis;');
  check('6-element axis limits in 3-D', h.v('a').re, [0, 4, 0, 3, 1, 6]);
  h.run('axis auto; a = axis;');
  check('axis query in 3-D includes z', h.v('a').re, [1, 3, 1, 2, 2, 5]);

  h.run('shading interp');
  ({ data } = h.plotly());
  check('shading interp hides edges', [data.length, h.ax().objects[0].faceColor], [1, 'interp']);
  h.run('shading faceted');
  check('shading faceted restores black edges', [h.plotly().data.length, h.ax().objects[0].faceColor, h.ax().objects[0].edgeColor], [2, 'flat', [0, 0, 0]]);
  h.run('shading flat');
  check('shading flat: no edges', h.ax().objects[0].edgeColor, 'none');
  checkThrows('bad shading mode', () => h.run('shading smooth'), /flat, interp or faceted/);

  h.run("set(hs, 'FaceAlpha', 0.5, 'EdgeColor', 'r'); fa = get(hs, 'FaceAlpha');");
  ({ data } = h.plotly());
  check('surface FaceAlpha / EdgeColor', [h.v('fa'), data[0].opacity, data[1].line.color], [0.5, 0.5, 'rgb(255,0,0)']);
  h.run("set(hs, 'FaceColor', 'none');");
  check('FaceColor none leaves only the grid lines', h.plotly().data.map(t => t.type), ['scatter3d']);
  h.run("set(hs, 'FaceColor', [0 1 0]);");
  check('solid face color', h.plotly().data[0].colorscale, [[0, 'rgb(0,255,0)'], [1, 'rgb(0,255,0)']]);

  h.run('surf(magic(3), ones(3)); ');
  check('surf(Z, C) colors by C', h.plotly().data[0].surfacecolor, [[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
  h.run("surf(peaks(4), 'LineStyle', 'none');");
  check("LineStyle 'none' hides the edges", h.plotly().data.length, 1);
  h.run('mesh(peaks(4));');
  ({ data } = h.plotly());
  check('mesh: white faces, data-colored edges', [data[0].colorscale[0][1], Array.isArray(data[1].line.color), data[1].line.colorscale.length > 1], ['rgb(255,255,255)', true, true]);
  checkThrows('surf of a vector', () => h.run('surf(1:3)'), /2-by-2/);
  checkThrows('surf X must match Z', () => h.run('surf(1:2, 1:3, magic(3))'), /length of X/);
  checkThrows('surf C must match Z', () => h.run('surf(magic(3), ones(2))'), /same size/);
}

// ---------------- peaks / sphere ----------------
{
  const h = setup();
  h.run('z = peaks(3); [X, Y, Z] = peaks(5); zz = peaks(0, 0); s = size(peaks);');
  checkClose('peaks(3) (column-major)', h.v('z').re, [0.0001, -0.0365, 0.0000, -0.2450, 0.9810, 0.2999, -0.0000, 0.0331, 0.0000], 1e-4);
  check('[X, Y, Z] = peaks(5) grids', [h.v('X').re.slice(0, 5), h.v('Y').re.slice(0, 5)], [[-3, -3, -3, -3, -3], [-3, -1.5, 0, 1.5, 3]]);
  checkClose('peaks(0, 0)', h.v('zz'), 0.9810, 1e-4);
  check('peaks default is 49-by-49', h.v('s').re, [49, 49]);
  h.run('[x, y, z] = sphere(4); r = max(abs(x(:).^2 + y(:).^2 + z(:).^2 - 1)); n = size(x);');
  check('sphere(4) is 5-by-5 on the unit sphere', [h.v('n').re, h.v('r') < 1e-12], [[5, 5], true]);
  h.run('figure; peaks(10);');
  check('peaks with no outputs plots a surface', h.ax().objects.map(o => o.type), ['surface']);
  h.run('figure; sphere;');
  check('sphere with no outputs plots a 21-by-21 surface', [h.ax().objects[0].z.length, h.ax().kind], [21, '3d']);
  checkThrows('sphere(1)', () => h.run('sphere(1)'), /at least 2/);
}

// ---------------- contour / contourf ----------------
{
  const h = setup();
  h.run('contour(peaks(10));');
  let { data, layout } = h.plotly();
  check('contour trace in cartesian axes', [data[0].type, data[0].xaxis, data[0].contours.coloring], ['contour', 'x', 'lines']);
  check('automatic levels at round steps', [data[0].autocontour, data[0].contours.size], [false, 2]);
  check('contour lines use the color axis', [data[0].coloraxis, typeof layout.coloraxis.cmin], ['coloraxis', 'number']);
  h.run('contour(magic(4), 3);');
  ({ data } = h.plotly());
  check('n levels evenly inside the range', [data[0].autocontour, data[0].contours.start, data[0].contours.end, data[0].contours.size], [false, 4.75, 12.25, 3.75]);
  h.run("[X, Y] = meshgrid(1:4); contour(X, Y, X.*Y, [2 4 6 8], 'ShowText', 'on', 'LineColor', 'k');");
  ({ data } = h.plotly());
  check('level vector', [data[0].contours.start, data[0].contours.end, data[0].contours.size], [2, 8, 2]);
  check('ShowText and LineColor', [data[0].contours.showlabels, data[0].contours.coloring, data[0].line.color], [true, 'none', 'rgb(0,0,0)']);
  check('contour x/y vectors', [data[0].x, data[0].y], [[1, 2, 3, 4], [1, 2, 3, 4]]);
  h.run("contour(magic(3), 'LevelList', [3 5]);");
  check('LevelList', [h.plotly().data[0].contours.start, h.plotly().data[0].contours.end], [3, 5]);
  h.run("contour(magic(3), 'r');");
  check('contour line spec color', h.plotly().data[0].line.color, 'rgb(255,0,0)');
  h.run('hc = contourf(peaks(8), 5); colorbar; lv = get(hc, \'LevelList\');');
  ({ data, layout } = h.plotly());
  check('contourf fills with black lines', [data[0].contours.coloring, data[0].line.color, layout.coloraxis.showscale], ['fill', 'rgb(0,0,0)', true]);
  check('LevelList get gives the level values', h.v('lv').cols, 5);
  h.run("set(hc, 'LevelList', [0 1], 'ShowText', 'on'); lv = get(hc, 'LevelList'); st = get(hc, 'ShowText');");
  check('LevelList / ShowText set', [h.v('lv').re, h.v('st'), h.plotly().data[0].contours.showlabels], [[0, 1], 'on', true]);
  h.run('[X, Y] = meshgrid(0:10); hc = contour(X + Y); lv = get(hc, \'LevelList\');');
  check('automatic LevelList', h.v('lv').re, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  checkThrows('contour of a vector', () => h.run('contour(1:4)'), /2-by-2/);
}

// ---------------- imagesc / image ----------------
{
  const h = setup();
  h.run('imagesc(magic(3)); colorbar');
  let { data, layout } = h.plotly();
  check('imagesc is a heatmap', [data[0].type, data[0].z, data[0].x, data[0].y], ['heatmap', [[8, 1, 6], [3, 5, 7], [4, 9, 2]], [1, 2, 3], [1, 2, 3]]);
  check('imagesc scales to the data range', [layout.coloraxis.cmin, layout.coloraxis.cmax], [1, 9]);
  check('row 1 at the top', layout.yaxis.autorange, 'reversed');
  h.run('imagesc(magic(3), [0 20]);');
  ({ layout } = h.plotly());
  check('imagesc with clims', [layout.coloraxis.cmin, layout.coloraxis.cmax], [0, 20]);
  h.run('imagesc([10 20], [1 2], magic(3));');
  check('imagesc x/y centers', [h.plotly().data[0].x, h.plotly().data[0].y], [[10, 15, 20], [1, 1.5, 2]]);
  h.run('image(magic(3));');
  ({ layout } = h.plotly());
  check('image indexes the colormap directly', [layout.coloraxis.cmin, layout.coloraxis.cmax], [1, 256]);
  h.run('hi = image(magic(2)); cd = get(hi, \'CData\'); set(hi, \'CData\', [1 2; 3 4]);');
  check('image CData get/set', [h.v('cd').re, h.plotly().data[0].z], [[4, 1, 3, 2], [[1, 2], [3, 4]]]);
  checkThrows('bad clims', () => h.run('imagesc(magic(3), [2 1])'), /low < high/);
  checkThrows('image takes no clims', () => h.run('image(magic(3), [1 2])'), /expected image/);
}

// ---------------- mixing 2-D and 3-D, hold ----------------
{
  const h = setup();
  h.run("subplot(2,1,1); plot(1:3); subplot(2,1,2); surf(peaks(3)); hold on; plot3([1 2], [1 2], [0 0], 'k'); title('both');");
  const { data, layout } = h.plotly();
  check('2-D and 3-D axes side by side', [data[0].xaxis, data[1].scene, data[3].scene], ['x', 'scene', 'scene']);
  check('scene placed in its subplot', layout.scene.domain.y[1] < 0.5, true);
  check('hold on adds to the 3-D axes', h.ax().objects.map(o => o.type), ['surface', 'line3']);
  h.run('hold off; plot(1:2);');
  check('a 2-D plot replaces a 3-D axes', [h.ax().kind, h.plotly().layout.scene2], ['cartesian', undefined]);
  const s = sceneLayout({ view: [0, -90], xlim: null, ylim: null, zlim: null, xscale: 'linear', yscale: 'linear', visible: true, grid: false, equal: false }, { x: [0, 1], y: [0, 1] });
  h.run('figure; subplot(1,3,1); surf(peaks(5));');
  check('a narrow 3-D subplot shrinks its box to fit', h.plotly().layout.scene.aspectratio.x < 0.7, true);
  checkClose('view from below', s.camera.eye.z, -1.9);
}

// ---------------- every emitted trace type exists in the bundled Plotly ----------------
{
  // Plotly quietly draws an unknown trace type as a 2-D scatter, so check
  // the names against the trace modules registered in the bundle.
  const bundle = readFileSync(createRequire(import.meta.url).resolve('plotly.js-dist-min'), 'utf8');
  const known = new Set([...bundle.matchAll(/moduleType:"trace",name:"(\w+)"/g)].map(m => m[1]));
  const h = setup();
  h.run([
    "subplot(3,4,1); plot(1:3); subplot(3,4,2); stem(1:3); subplot(3,4,3); scatter(1:3, 1:3, 20, 1:3); subplot(3,4,4); bar(1:3);",
    "subplot(3,4,5); histogram(randn(1, 20)); subplot(3,4,6); area(1:3); subplot(3,4,7); fill([0 1 0], [0 0 1], 'r'); subplot(3,4,8); pie([1 2]);",
    "subplot(3,4,9); polarplot(0:0.1:1, 1:11); subplot(3,4,10); surf(peaks(4)); hold on; plot3(1:2, 1:2, 1:2); scatter3(1:2, 1:2, 1:2);",
    "subplot(3,4,11); contourf(peaks(5)); subplot(3,4,12); imagesc(magic(3));",
  ].join(' '));
  const types = [...new Set(h.plotly().data.map(t => t.type))];
  check('trace types are registered Plotly traces', types.filter(t => !known.has(t)), []);
  check('the gallery covers the 3-D traces', ['surface', 'scatter3d', 'contour', 'heatmap'].every(t => types.includes(t)), true);
}

// ---------------- saving figures ----------------
{
  const h = setup();
  h.run("plot(1:3); saveas(gcf, 'line.png');");
  check('saveas sends an export request', h.exports[0], { num: 1, request: { name: 'line.png', format: 'png', width: 800, height: 600, scale: 1 }, axes: 1 });
  h.run("saveas(1, 'pic', 'svg'); saveas(gca, 'p.JPG');");
  check('saveas format argument adds the extension', h.exports[1].request.name, 'pic.svg');
  check('saveas of an axes handle exports its figure (jpg)', [h.exports[2].num, h.exports[2].request.format], [1, 'jpeg']);
  h.run("exportgraphics(gca, 'hi.png', 'Resolution', 300);");
  check('exportgraphics resolution', h.exports[3].request.scale, 300 / 96);
  h.run("figure(3); bar(1:3); print('-f1', 'f1', '-dsvg'); print('cur.png'); print(3, '-dpng', '-r192', 'three');");
  check('print -f1 -dsvg', [h.exports[4].num, h.exports[4].request.name, h.exports[4].request.format], [1, 'f1.svg', 'svg']);
  check('print defaults to the current figure', [h.exports[5].num, h.exports[5].request.name], [3, 'cur.png']);
  check('print figure, -dpng, -r192', [h.exports[6].num, h.exports[6].request.name, h.exports[6].request.scale], [3, 'three.png', 2]);
  checkThrows('saveas needs an extension or format', () => h.run("saveas(gcf, 'noext')"), /extension/);
  checkThrows('unsupported format', () => h.run("saveas(gcf, 'a.pdf')"), /unsupported format 'pdf'/);
  checkThrows('invalid handle', () => h.run("saveas(99, 'a.png')"), /invalid graphics handle/);
  checkThrows('print needs a file name', () => h.run("print('-dpng')"), /file name/);
  const plain = makeInterp();
  plain.run('plot(1:3);');
  checkThrows('saving needs the browser app', () => plain.run("saveas(gcf, 'a.png')"), /only available in the browser/);
}

// ---------------- drawnow / pause ----------------
{
  const h = setup();
  h.run('plot(1:3); drawnow; drawnow');
  check('drawnow flushes the figures', h.flushes, 2);
  const t0 = Date.now();
  h.run('pause(0.05)');
  check('pause waits', Date.now() - t0 >= 45, true);
  check('pause also flushes', h.flushes, 3);
  h.run("pause('off'); s = pause('query');");
  check('pause off / query', h.v('s'), 'off');
  const t1 = Date.now();
  h.run('pause(5); pause on; s = pause(\'query\');');
  check('pause off skips the wait', [Date.now() - t1 < 1000, h.v('s')], [true, 'on']);
  h.clearOutput();
  h.run('pause; pause;');
  check('pause with no duration warns once', h.getOutput().split('Warning').length - 1, 1);
  checkThrows('negative pause', () => h.run('pause(-1)'), /non-negative/);
  checkThrows('bad pause option', () => h.run("pause('maybe')"), /unknown option/);
}

// ---------------- session: mid-command figures and export messages ----------------
{
  const msgs = [];
  // postMessage copies each message when it is sent; do the same here.
  const s = createSession((m) => msgs.push(structuredClone(m)));
  s.handle({ type: 'init', files: [] });
  s.handle({ type: 'run', id: 1, src: "for k = 1:3, plot(1:k); drawnow; end, title('end');" });
  const frames = msgs.filter(m => m.type === 'figures');
  check('drawnow posts a figures message (throttled)', frames.length >= 1 && frames.length <= 3, true);
  check('frame carries the figure model', frames[0].figures[0].num, 1);
  const done = msgs.find(m => m.type === 'done');
  check('done still carries the final figure', done.figures[0].fig.axes[0].title.text, 'end');

  msgs.length = 0;
  s.handle({ type: 'run', id: 2, src: "plot(1:2); pause(0.04); plot(1:4); pause(0.04);" });
  check('each pause shows the frame so far', msgs.filter(m => m.type === 'figures').map(m => m.figures[0].fig.axes[0].objects[0].x.length), [2, 4]);

  msgs.length = 0;
  s.handle({ type: 'run', id: 3, src: "surf(peaks(3)); saveas(gcf, 'out.png'); title('later');" });
  const ex = msgs.find(m => m.type === 'exportFigure');
  check('export message', [ex.num, ex.request.name, ex.request.format], [1, 'out.png', 'png']);
  check('export carries a snapshot of the figure', [ex.fig.axes[0].kind, ex.fig.axes[0].title], ['3d', null]);
  check('the export runs before the command finishes', msgs.indexOf(ex) < msgs.findIndex(m => m.type === 'done'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
