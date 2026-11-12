export const VERSION = '0.1.0';

// The commit the bundle was built from, put in by scripts/build.mjs. Absent when run from source.
declare const __AW_COMMIT__: string | undefined;
export const COMMIT: string = typeof __AW_COMMIT__ === 'string' ? __AW_COMMIT__ : '';

/** What `agentweb --version` prints and what bug reports and test results carry: 0.1.0+c399234. */
export const BUILD = COMMIT ? `${VERSION}+${COMMIT}` : VERSION;
