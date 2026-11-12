// Device presets for emulate('iPhone 15'). A small, hand-kept table: the popular phones and
// tablets, enough to see a site's mobile layout. Anything else: emulate(width=…, height=…, mobile=1).

import type { Emulation } from './types.ts';

const IOS = (v: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v.split('_')[0]}.0 Mobile/15E148 Safari/604.1`;
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = (m: string) => `Mozilla/5.0 (Linux; Android 14; ${m}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36`;

export const DEVICES: Record<string, Emulation> = {
  'iphone se': { width: 375, height: 667, dpr: 2, mobile: true, ua: IOS('17_5') },
  'iphone 13': { width: 390, height: 844, dpr: 3, mobile: true, ua: IOS('17_5') },
  'iphone 14': { width: 390, height: 844, dpr: 3, mobile: true, ua: IOS('17_5') },
  'iphone 15': { width: 393, height: 852, dpr: 3, mobile: true, ua: IOS('17_5') },
  'iphone 15 pro max': { width: 430, height: 932, dpr: 3, mobile: true, ua: IOS('17_5') },
  'pixel 7': { width: 412, height: 915, dpr: 2.625, mobile: true, ua: ANDROID('Pixel 7') },
  'pixel 8': { width: 412, height: 915, dpr: 2.625, mobile: true, ua: ANDROID('Pixel 8') },
  'galaxy s9': { width: 360, height: 740, dpr: 4, mobile: true, ua: ANDROID('SM-G960F') },
  'ipad': { width: 768, height: 1024, dpr: 2, mobile: true, ua: IPAD },
  'ipad mini': { width: 744, height: 1133, dpr: 2, mobile: true, ua: IPAD },
  'ipad pro': { width: 1024, height: 1366, dpr: 2, mobile: true, ua: IPAD },
  'desktop': { width: 1280, height: 800, dpr: 1, mobile: false },
  'mobile': { width: 412, height: 915, dpr: 2.625, mobile: true, ua: ANDROID('Pixel 8') },
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Exact (ignoring case and punctuation), then the longest preset that the name starts with. */
export function findDevice(name: string): { name: string; emu: Emulation } | undefined {
  const n = norm(name);
  if (DEVICES[n]) return { name: n, emu: DEVICES[n] };
  const hit = Object.keys(DEVICES)
    .filter((k) => n.startsWith(k) || k.startsWith(n))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? { name: hit, emu: DEVICES[hit] } : undefined;
}
