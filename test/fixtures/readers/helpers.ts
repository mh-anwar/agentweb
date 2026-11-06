import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockText } from '../../../src/blocks.ts';
import type { Act, Block, ReadOutput } from '../../../src/types.ts';

export const FIX = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
export const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));

/** One line per block, the way `find` and the content hash see it. */
export const lines = (out: ReadOutput | { blocks: Block[] }) => out.blocks.map(blockText);
export const text = (out: ReadOutput | { blocks: Block[] }) => lines(out).join('\n');
export const acts = (out: ReadOutput | { blocks: Block[] }): Act[] => out.blocks.flatMap((b) => b.i.filter((x): x is Act => typeof x !== 'string'));
export const line = (out: ReadOutput, re: RegExp) => lines(out).find((l) => re.test(l));
