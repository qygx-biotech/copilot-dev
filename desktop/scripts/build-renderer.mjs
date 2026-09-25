import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'docs/desktop-assets');
await mkdir(output, { recursive: true });
// Keep the existing auth, initialization confirmation and service view contracts
// in one source. Desktop replaces their workbench composition after binding.
const html = (await readFile(path.join(root, 'docs/index.html'), 'utf8'))
  .replace('</head>', '<link rel="stylesheet" href="desktop-assets/renderer.css">\n</head>')
  .replace('<body>', '<body class="desktop-ui">')
  .replace('<script src="app.js"></script>', '<script src="desktop-adapter.js"></script>\n<script src="app.js"></script>\n<script defer src="desktop-assets/renderer.js"></script>');
await writeFile(path.join(root, 'docs/desktop.html'), html);
await copyFile(path.join(root, 'desktop/renderer/upstream/nanobot-LICENSE'), path.join(output, 'nanobot-LICENSE.txt'));
const options = { absWorkingDir: root, entryPoints: ['desktop/renderer/main.jsx'], outdir: output,
  entryNames: 'renderer', bundle: true, format: 'iife', platform: 'browser', target: 'chrome140',
  define: { 'process.env.NODE_ENV': '"production"' }, minify: true, legalComments: 'linked', logLevel: 'info' };
if (process.argv.includes('--watch')) { const ctx = await context(options); await ctx.watch(); }
else await build(options);
