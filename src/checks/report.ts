// What the page-side checks found, as the few lines an agent reads. Pure functions: no browser here.

import { renderAct, type Refs } from '../render.ts';
import type { Act } from '../types.ts';
import { AwError } from '../types.ts';
import { RULE_IDS, type AuditReport, type Hit, type OverflowReport } from './inpage.ts';

/** The built-in rules: the WCAG 2.2 success criterion each one relates to. This is not axe-core. */
export const RULES: Record<string, { sc: string; what: string }> = {
  alt: { sc: '1.1.1', what: 'images without alt text (alt="" and role=presentation are decorative, and fine)' },
  labels: { sc: '4.1.2', what: 'form controls with no accessible name (label, aria-label, aria-labelledby, title)' },
  placeholder: { sc: '3.3.2', what: 'form controls named only by their placeholder, which is a weak name' },
  buttons: { sc: '4.1.2', what: 'buttons with no name' },
  links: { sc: '2.4.4', what: 'links with no name' },
  lang: { sc: '3.1.1', what: '<html> without a lang attribute' },
  title: { sc: '2.4.2', what: 'missing or empty <title>' },
  ids: { sc: '4.1.2', what: 'duplicate ids that a label or an aria attribute refers to' },
  headings: { sc: '1.3.1', what: 'heading levels that skip (h1 then h3)' },
  main: { sc: '2.4.1', what: 'no <main>, or more than one' },
  tabindex: { sc: '2.4.3', what: 'positive tabindex (it overrides the natural tab order)' },
  contrast: { sc: '1.4.3', what: 'text contrast below AA: 4.5:1, or 3:1 for large text; elements over an image or gradient are skipped and counted' },
  target: { sc: '2.5.8', what: 'actionable elements under 24x24 px, unless inline in a sentence or with enough space around them' },
  'aria-hidden': { sc: '4.1.2', what: 'aria-hidden elements that contain focusable elements' },
};

/** Names an agent may use instead of listing rules. */
export const GROUPS: Record<string, string[]> = {
  names: ['labels', 'placeholder', 'buttons', 'links'],
  forms: ['labels', 'placeholder'],
  images: ['alt'],
  color: ['contrast'],
  colour: ['contrast'],
  targets: ['target'],
  touch: ['target'],
  language: ['lang'],
  heading: ['headings'],
  aria: ['aria-hidden'],
  structure: ['lang', 'title', 'headings', 'main', 'ids'],
  all: [...RULE_IDS],
};

export const RULE_LIST = [...RULE_IDS].join(', ');

/** `contrast,names` -> rule ids. Empty or 'all' means every rule. */
export function parseRules(spec: unknown): string[] {
  const text = spec === undefined || spec === null || spec === true || spec === 1 ? '' : String(spec);
  const want: string[] = [];
  for (const raw of text.split(/[\s,;+]+/).filter(Boolean)) {
    const w = raw.toLowerCase().replace(/_/g, '-');
    const ids = (RULES[w] ? [w] : GROUPS[w]) ?? undefined;
    if (!ids) throw new AwError('bad_request', `unknown audit rule '${raw}'`, `rules: ${RULE_LIST}; groups: ${Object.keys(GROUPS).filter((g) => g !== 'colour').join(', ')}`);
    for (const id of ids) if (!want.includes(id)) want.push(id);
  }
  return want.length ? RULE_IDS.filter((id) => want.includes(id)) : [...RULE_IDS];
}

/** A hit as one short phrase, with the page view's own notation when the element is actionable: `<a.btn>[Book now]12`. */
export function describeHit(h: Hit, acts: Map<number, Act>, refs: Refs | null): string {
  const act = h.n !== undefined ? acts.get(h.n) : undefined;
  let s = h.tag;
  if (act && refs) s += renderAct(act, refs);
  else if (h.text) s += ` "${h.text}"`;
  return s;
}

const px = (n: number) => `${n} px`;

/** The lines of an overflow report. `none` is true when the page has no horizontal overflow at all. */
export function overflowLines(r: OverflowReport, acts: Map<number, Act>, refs: Refs | null): { lines: string[]; none: boolean } {
  const lines: string[] = [];
  const none = !r.scrolls && !r.total && !r.locked;
  const where = `in a ${px(r.vw)} viewport`;
  if (none) lines.push(`no horizontal overflow ${where}`);
  else {
    if (r.scrolls) lines.push(`the page scrolls sideways: ${px(r.scrollW)} of content ${where} (${px(r.scrollW - r.vw)} too wide)`);
    else if (r.locked) lines.push(`overflow-x is hidden on <${r.locked}>, so the page does not scroll but content past ${px(r.vw)} is cut off`);
    for (const h of r.hits) lines.push(`overflows by ${px(h.by ?? 0)}: ${describeHit(h, acts, refs)} ${px(h.w ?? 0)} wide ${where}`);
    if (r.total > r.hits.length) lines.push(`… ${r.total - r.hits.length} more`);
    if (!r.total && r.scrolls) lines.push('no single element box explains it (a negative margin, a transform or a pseudo-element)');
  }
  if (r.clipped) {
    if (!r.clipped.total) lines.push('no text is clipped by its own box');
    else {
      lines.push(`${r.clipped.total} text box${r.clipped.total === 1 ? '' : 'es'} cut text off:`);
      for (const h of r.clipped.hits) lines.push(`clipped: ${describeHit(h, acts, refs)} needs ${px(h.need ?? 0)}, box is ${px(h.have ?? 0)}`);
      if (r.clipped.total > r.clipped.hits.length) lines.push(`… ${r.clipped.total - r.clipped.hits.length} more`);
    }
  }
  return { lines, none };
}

/** Total offending elements in an audit report. */
export const violations = (r: AuditReport): number => Object.values(r.rules).reduce((n, x) => n + x.count, 0);

const MAX_LINES = 12;

/**
 * The lines of an audit: one for each rule that failed (its count and the first two offenders), under
 * a header that says how many rules were run. At most 12 lines.
 */
export function auditLines(r: AuditReport, ran: string[], acts: Map<number, Act>, refs: Refs | null): string[] {
  const failed = ran.filter((id) => r.rules[id]?.count);
  const what = ran.length === RULE_IDS.length ? `${ran.length} rules` : `rules ${ran.join(', ')}`;
  const tail: string[] = [];
  if (ran.includes('contrast')) tail.push(`contrast: ${r.checkedText} text elements checked${r.skipped ? `, ${r.skipped} skipped (background is an image or gradient)` : ''}`);
  const note = `built-in WCAG 2.2 AA subset, not axe-core${tail.length ? '; ' + tail.join('; ') : ''}`;
  if (!failed.length) return [`audit: no violations in ${what} (${note})`];
  const lines = [`audit: ${failed.length} of ${ran.length} rules failed, ${violations(r)} elements (${note})`];
  const room = MAX_LINES - 1;
  const shown = failed.length > room ? failed.slice(0, room - 1) : failed;
  for (const id of shown) {
    const x = r.rules[id];
    const items = x.items.slice(0, 2).map((h) => `${describeHit(h, acts, refs)}${h.d ? ' ' + h.d : ''}`);
    lines.push(`${id} (${RULES[id].sc}) ×${x.count}: ${items.join(' · ')}${x.count > items.length ? ' …' : ''}`);
  }
  if (shown.length < failed.length) {
    const rest = failed.slice(shown.length);
    lines.push(`… ${rest.length} more rules failed: ${rest.map((id) => `${id} ×${r.rules[id].count}`).join(', ')} (audit('${rest[0]}') lists one)`);
  }
  return lines;
}
