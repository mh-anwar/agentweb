// Debug helper: node test/fixtures/readers/show-embedded.ts <file.html> <url>
import { readFileSync } from 'node:fs';
import { parseHtml } from '../../../src/parse.ts';
import { mineEmbedded } from '../../../src/readers/index.ts';
const [file, url = 'https://shop.example.com/p/x'] = process.argv.slice(2);
const r = mineEmbedded(parseHtml(readFileSync(file, 'utf8')), url);
if (!r) console.log('undefined');
else {
  console.log('TITLE', r.title, '| NOTES', r.notes);
  for (const b of r.blocks) console.log((b.k + (b.lv ?? '') + (b.ord !== undefined ? '#' + b.ord : '') + (b.hd ? '*' : '')).padEnd(5), b.i.map((x) => (typeof x === 'string' ? x : `[${x.l}]`)).join(''));
}
