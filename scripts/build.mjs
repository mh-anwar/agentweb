// Bundle the CLI into one file with no runtime dependencies, so `npx agentweb` installs nothing else.
// Heavy optional pieces (the ghost engine's DOM library, the PDF reader) stay external and are
// loaded only if present.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, statSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
// the commit being built, so `agentweb --version` can say which build is installed (0.1.0+c399234)
let commit = process.env.AGENTWEB_COMMIT ?? '';
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
}
const define = { __AW_COMMIT__: JSON.stringify(/^[0-9a-f]{7,40}$/.test(commit) ? commit : '') };
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/agentweb.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minifySyntax: true,
  minifyWhitespace: true,
  keepNames: false,
  legalComments: 'none',
  external: ['jsdom', 'happy-dom', 'unpdf', 'esbuild', 'playwright-core', 'playwright'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
  define,
});
// the ghost engine's page process: one per live page, found next to the bundle at run time
await build({
  entryPoints: ['src/engines/ghost/child.ts'],
  outfile: 'dist/ghost-child.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  external: ['jsdom', 'happy-dom'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
  define,
});
chmodSync('dist/agentweb.mjs', 0o755);
for (const f of ['dist/agentweb.mjs', 'dist/ghost-child.mjs']) console.log(`${f} ${(statSync(f).size / 1024).toFixed(0)} KB`);
