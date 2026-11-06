// Debug helper: print the blocks a reader produces for a file. node test/fixtures/readers/show.ts <file> [content-type] [url]
import { readFileSync } from 'node:fs';
import { readBody } from '../../../src/readers/index.ts';
import { blockText } from '../../../src/blocks.ts';
const [file, ct = 'application/json', url = 'https://api.github.com/x'] = process.argv.slice(2);
const buf = readFileSync(file);
const r = await readBody(ct === 'application/pdf' ? { url, contentType: ct, bytes: new Uint8Array(buf) } : { url, contentType: ct, text: buf.toString('utf8') });
console.log('TITLE', r.title, '| KIND', r.kind, '| NOTES', r.notes);
for (const b of r.blocks) console.log((b.k + (b.lv ?? '') + (b.ord !== undefined ? '#' + b.ord : '') + (b.hd ? '*' : '')).padEnd(5), b.i.map((x) => (typeof x === 'string' ? x : `[${x.l}]`)).join(''));
