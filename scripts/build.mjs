// Bundle the CLI into one file with no runtime dependencies, so `npx agentweb` installs nothing else.
// Heavy optional pieces (the ghost engine's DOM library, the PDF reader) stay external and are
// loaded only if present.
import { build } from 'esbuild';
import { chmodSync, mkdirSync, statSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
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
});
chmodSync('dist/agentweb.mjs', 0o755);
for (const f of ['dist/agentweb.mjs', 'dist/ghost-child.mjs']) console.log(`${f} ${(statSync(f).size / 1024).toFixed(0)} KB`);
