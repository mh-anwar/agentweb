// Run the farm standalone:  node bench/sites/serve.ts --port 4600 [--seed 7] [--latency 0]
import { startFarm } from './farm.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const t0 = Date.now();
const farm = await startFarm({ port: arg('port') ? Number(arg('port')) : 4600, seed: arg('seed') ? Number(arg('seed')) : 7, latencyMs: arg('latency') ? Number(arg('latency')) : 0 });
console.log(`agentweb farm ready in ${Date.now() - t0} ms (seed ${farm.truth.seed})`);
console.log(`  main  ${farm.url}/`);
console.log(`  other ${farm.other}/   (second origin; every request it receives is recorded)`);
for (const p of ['shop', 'spa', 'spa-vue', 'spa-preact', 'spa-vanilla', 'news', 'docs', 'forms', 'bank', 'untrusted', 'hard', 'misc']) console.log(`  ${farm.url}/${p}/`);
const stop = async () => { await farm.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
