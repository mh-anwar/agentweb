// A tiny Prometheus registry: labelled counters/gauges and fixed-bucket histograms, with a
// plain-data snapshot that can be summed across cluster workers before rendering.

export type Labels = Record<string, string>;
type Kind = 'counter' | 'gauge' | 'histogram' | 'untyped';

export const BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export interface Hist {
  /** non-cumulative counts per bucket; last entry = +Inf */
  b: number[];
  sum: number;
  count: number;
}

export interface Snapshot {
  /** "name{labels}" -> value */
  v: Record<string, number>;
  h: Record<string, Hist>;
}

function labelStr(l?: Labels): string {
  if (!l) return '';
  let s = '';
  for (const k in l) s += (s ? ',' : '{') + k + '="' + esc(l[k]) + '"';
  return s ? s + '}' : '';
}

const NEEDS_ESC = /[\\"\n]/;
function esc(v: string): string {
  if (!NEEDS_ESC.test(v)) return v;
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** "agentweb_" + a valid metric name derived from an arbitrary key */
export function metricName(key: string, prefix = 'agentweb_'): string {
  let n = key.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/_+/g, '_');
  if (/^[0-9]/.test(n)) n = '_' + n;
  return prefix + n;
}

export class Registry {
  #meta = new Map<string, { kind: Kind; help: string }>();
  #v = new Map<string, number>();
  #h = new Map<string, Hist>();

  define(name: string, kind: Kind, help: string): this {
    this.#meta.set(name, { kind, help });
    return this;
  }

  inc(name: string, labels?: Labels, by = 1): void {
    const k = name + labelStr(labels);
    this.#v.set(k, (this.#v.get(k) ?? 0) + by);
  }

  set(name: string, labels: Labels | undefined, value: number): void {
    this.#v.set(name + labelStr(labels), value);
  }

  observe(name: string, labels: Labels | undefined, seconds: number): void {
    const k = name + labelStr(labels);
    let h = this.#h.get(k);
    if (!h) {
      h = { b: new Array(BUCKETS.length + 1).fill(0), sum: 0, count: 0 };
      this.#h.set(k, h);
    }
    let i = 0;
    while (i < BUCKETS.length && seconds > BUCKETS[i]) i++;
    h.b[i]++;
    h.sum += seconds;
    h.count++;
  }

  snapshot(): Snapshot {
    const h: Record<string, Hist> = {};
    for (const [k, v] of this.#h) h[k] = { b: v.b.slice(), sum: v.sum, count: v.count };
    return { v: Object.fromEntries(this.#v), h };
  }

  static merge(snaps: Snapshot[]): Snapshot {
    const out: Snapshot = { v: {}, h: {} };
    for (const s of snaps) {
      for (const [k, x] of Object.entries(s.v)) out.v[k] = (out.v[k] ?? 0) + x;
      for (const [k, x] of Object.entries(s.h)) {
        const o = (out.h[k] ??= { b: new Array(x.b.length).fill(0), sum: 0, count: 0 });
        for (let i = 0; i < x.b.length; i++) o.b[i] += x.b[i];
        o.sum += x.sum;
        o.count += x.count;
      }
    }
    return out;
  }

  /** Prometheus text exposition format 0.0.4 */
  render(snap: Snapshot, runtime?: Record<string, number>): string {
    const lines: string[] = [];
    const byName = new Map<string, string[]>();
    const group = (key: string) => {
      const i = key.indexOf('{');
      const n = i < 0 ? key : key.slice(0, i);
      let g = byName.get(n);
      if (!g) byName.set(n, (g = []));
      return g;
    };
    for (const k of Object.keys(snap.v)) group(k).push(k);
    for (const k of Object.keys(snap.h)) group(k).push(k);
    for (const n of this.#meta.keys()) group(n);
    for (const [name, keys] of [...byName].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const meta = this.#meta.get(name);
      if (meta) {
        lines.push(`# HELP ${name} ${meta.help}`, `# TYPE ${name} ${meta.kind}`);
      }
      if (meta?.kind === 'histogram') {
        for (const k of keys) {
          const h = snap.h[k];
          if (!h) continue;
          const i = k.indexOf('{');
          const inner = i < 0 ? '' : k.slice(i + 1, -1);
          const withLe = (le: string) => `{${inner ? inner + ',' : ''}le="${le}"}`;
          let acc = 0;
          for (let j = 0; j < BUCKETS.length; j++) {
            acc += h.b[j];
            lines.push(`${name}_bucket${withLe(String(BUCKETS[j]))} ${acc}`);
          }
          lines.push(`${name}_bucket${withLe('+Inf')} ${h.count}`);
          const ls = inner ? `{${inner}}` : '';
          lines.push(`${name}_sum${ls} ${fmt(h.sum)}`, `${name}_count${ls} ${h.count}`);
        }
      } else {
        if (!keys.length && meta && meta.kind !== 'untyped') lines.push(`${name} 0`);
        for (const k of keys.sort()) lines.push(`${k} ${fmt(snap.v[k])}`);
      }
    }
    if (runtime) {
      for (const [k, v] of Object.entries(runtime).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const n = metricName(k, 'agentweb_runtime_');
        lines.push(`# TYPE ${n} untyped`, `${n} ${fmt(v)}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

function fmt(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

/** sum runtime metric maps from several workers */
export function sumMaps(maps: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = (out[k] ?? 0) + v;
  return out;
}
