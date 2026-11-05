// Deterministic, realistic session-record JSON for store tests and benchmarks.
// Text-heavy (Zipf-distributed English words in headings, paragraphs and links), with the
// incompressible bits a real record carries (cookie values, ids, hashes), so compression
// ratios are representative rather than flattering.

const WORDS = (
  'the of and to in a is that for it as was with be by on not he this are or his from at which but have an they ' +
  'you were her she there one all we their been has will more if can when out so up said what about into than its ' +
  'only other new some could time these two may then do first any my now such like our over man me even most made ' +
  'after also did many before must through back years where much your way well down should because each just those ' +
  'people how too little state good very make world still own see men work long get here between both life being ' +
  'under never day same another know while last might us great old year off come since against go came right used ' +
  'take three home small found thought went say part once general high upon school every keep price order cart ' +
  'account search results product shipping review rating checkout login password email address delivery returns ' +
  'available stock size color quantity total subtotal discount free next previous page help contact privacy terms ' +
  'policy cookies settings language country store open closed hours today tomorrow weekly offer sale new arrivals ' +
  'popular featured category brand model specification warranty support download manual compare wishlist share'
).split(' ');

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleRecord(targetBytes: number, seed = 1): Record<string, unknown> {
  const r = rng(seed);
  const word = () => WORDS[Math.floor(WORDS.length * r() ** 2.2)];
  const words = (n: number) => Array.from({ length: n }, word).join(' ');
  const sentence = () => { const s = words(6 + Math.floor(r() * 14)); return s[0].toUpperCase() + s.slice(1) + '.'; };
  const token = (n: number) => { let s = ''; const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; for (let i = 0; i < n; i++) s += A[Math.floor(r() * 64)]; return s; };
  const host = `www.${word()}${word()}.example`;
  const path = () => '/' + Array.from({ length: 1 + Math.floor(r() * 3) }, word).join('/');
  const t0 = 1_760_000_000_000 + Math.floor(r() * 1e9);

  const blocks: Record<string, unknown>[] = [];
  const rec = {
    v: 1,
    id: `s_${token(21)}`,
    createdAt: t0,
    updatedAt: t0 + 61_000,
    cookies: Array.from({ length: 6 }, () => ({
      name: `${word()}_${token(4)}`, value: token(32 + Math.floor(r() * 64)), domain: '.' + host.slice(4), path: '/',
      expires: t0 + 86_400_000 * 30, httpOnly: r() < 0.5, secure: true, sameSite: r() < 0.5 ? 'Lax' : 'None',
    })),
    page: { url: `https://${host}${path()}?q=${word()}`, title: sentence(), kind: 'html', tier: 'wire', blocks },
    refs: {} as Record<string, unknown>,
    history: Array.from({ length: 5 }, (_, i) => ({ url: `https://${host}${path()}`, at: t0 + i * 9000, status: 200 })),
    seen: Array.from({ length: 8 }, () => token(16)),
  };
  let size = JSON.stringify(rec).length;
  let n = 0;
  while (size < targetBytes) {
    const k = r();
    let b: Record<string, unknown>;
    if (k < 0.1) b = { id: `b${n}`, t: 'h', level: 1 + Math.floor(r() * 3), text: words(3 + Math.floor(r() * 6)) };
    else if (k < 0.55) b = { id: `b${n}`, t: 'p', text: Array.from({ length: 1 + Math.floor(r() * 4) }, sentence).join(' ') };
    else if (k < 0.85) {
      b = { id: `b${n}`, t: 'link', text: words(2 + Math.floor(r() * 5)), href: `https://${host}${path()}`, ref: `e${n}` };
      rec.refs[`e${n}`] = { n: Math.floor(r() * 5000), role: 'link' };
    } else if (k < 0.95) b = { id: `b${n}`, t: 'li', text: `${words(3)} $${(r() * 200).toFixed(2)}` };
    else {
      b = { id: `b${n}`, t: 'input', label: words(2), name: word(), value: '', ref: `e${n}` };
      rec.refs[`e${n}`] = { n: Math.floor(r() * 5000), role: 'textbox' };
    }
    blocks.push(b);
    size += JSON.stringify(b).length + 1;
    n++;
  }
  return rec;
}
