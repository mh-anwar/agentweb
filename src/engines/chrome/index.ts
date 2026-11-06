// Public surface of the chrome engine.

export { createChromeEngine, RESTORED, type ChromeEngine, type ChromeEngineOptions } from './engine.ts';
export { Cdp, CdpError, CdpSession, connect, isContextLost, mapCdpError, pipeTransport, resolveEndpoint, wsTransport, type Transport } from './cdp.ts';
export { chromeArgs, findBrowser, launch, treeMemory, type Browser, type BrowserMemory, type LaunchOptions } from './launch.ts';
export { Pool, type PoolHooks, type PoolOptions, type Slot } from './pool.ts';
export { chordEvents, parseChord } from './keys.ts';
export { hostMatcher, TRACKER_HOSTS } from './blocklist.ts';
