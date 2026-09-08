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

copyFileSync('public/index.html', 'dist/index.html');
copyFileSync('src/ui/styles.css', 'dist/styles.css');

console.log('Build complete -> dist/');
