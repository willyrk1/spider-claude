// Post-build step for `npm run build:play`: fold the play table's JS and CSS
// into its HTML so the whole game is one self-contained file. Writes
//   dist-play/index.html     — a complete page; drop it on any static host
//   dist-play/fragment.html  — the same without <html>/<head>/<body>, for hosts
//                              that supply their own document shell
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-play');
const read = (rel) => readFileSync(join(dist, rel), 'utf8');

let html = read('play.html');
let js = 0;
let css = 0;
html = html.replace(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/g, (_, src) => {
  js++;
  return `<script type="module">${read(src).replace(/<\/script/gi, '<\\/script')}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/g, (_, href) => {
  css++;
  return `<style>${read(href)}</style>`;
});
if (js !== 1 || css !== 1) throw new Error(`expected 1 script + 1 stylesheet, inlined ${js} + ${css}`);
writeFileSync(join(dist, 'index.html'), html);

const head = html.match(/<head>([\s\S]*)<\/head>/)[1].replace(/<meta (charset|name="viewport")[^>]*>\s*/g, '');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
writeFileSync(join(dist, 'fragment.html'), `${head.trim()}\n${body.trim()}\n`);
console.log(`dist-play/index.html: ${(html.length / 1024).toFixed(0)} KB, single file`);
