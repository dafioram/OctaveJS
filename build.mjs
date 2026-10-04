// build.mjs — Bundles the app into dist/: a fully self-contained static
// site (no CDN dependencies at runtime) suitable for GitHub Pages,
// Cloudflare Pages, or simply opening index.html locally.
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, existsSync } from 'fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/ui/main.js'],
  bundle: true,
  outfile: 'dist/main.js',
  format: 'esm',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

// The interpreter's Web Worker (see src/ui/backend.js). A classic (iife)
// worker script, so it loads in every browser that supports workers.
await esbuild.build({
  entryPoints: ['src/worker/worker.js'],
  bundle: true,
  outfile: 'dist/worker.js',
  format: 'iife',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

copyFileSync('public/index.html', 'dist/index.html');
copyFileSync('public/favicon.svg', 'dist/favicon.svg');
copyFileSync('public/favicon.ico', 'dist/favicon.ico');
copyFileSync('public/apple-touch-icon.png', 'dist/apple-touch-icon.png');
copyFileSync('src/ui/styles.css', 'dist/styles.css');

console.log('Build complete -> dist/');
