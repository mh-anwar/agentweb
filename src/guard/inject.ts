// Indirect prompt-injection heuristic: does this text address an AI assistant with instructions?
//
// Deterministic and conservative. It looks for the moves real injections make (override earlier
// instructions, address the AI, ask for the prompt or secrets, tell it to send data somewhere,
// tell it to hide this from the user, urgency plus a credential request) and discounts text that
// is *about* prompt injection: phrases inside quotes or code, phrases introduced as examples
// ("such as", "for example", "an attacker might write"), and pages dense with security vocabulary.
// The score is a noisy-OR of the strongest weight per category, in [0, 1]; ≥ 0.5 means "likely".
// It is a signal for the renderer to flag text, never a reason to drop content silently, and a
// determined attacker can phrase around any fixed pattern list.

export interface InjectionScore {
  score: number;
  reasons: string[];
}

export const INJECTION_THRESHOLD = 0.5;

const AI = String.raw`(?:ai|a\.i\.|assistant|ai assistant|agent|ai agent|llm|large language model|language model|chat ?bot|bot|gpt|chatgpt|claude|gemini|copilot|model|automated (?:agent|system|browser))s?`;

type Rule = { cat: string; w: number; re: RegExp };

const RULES: Rule[] = [
  // overriding prior instructions
  {
    cat: 'override',
    w: 0.6,
    re: /\b(?:ignore|disregard|forget|override|bypass|abandon|discard|drop)\b[^.!?\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the|original|initial|system|existing|other)\b[^.!?\n]{0,30}?\b(?:instructions?|prompts?|directions?|rules|guidelines|directives?|programming|guardrails|constraints|commands)\b/gi,
  },
  { cat: 'override', w: 0.5, re: /\b(?:ignore|disregard|forget)\b (?:the |all |everything )?(?:above|(?:the )?user'?s? (?:request|instructions?|question|query|task|wishes))\b/gi },
  { cat: 'override', w: 0.5, re: /\b(?:these|the following|this|my) (?:instructions?|commands?|rules) (?:override|supersede|replace|take precedence over)\b/gi },
  { cat: 'override', w: 0.5, re: /\byour (?:new|real|true|actual|updated) (?:task|goal|objective|instructions?|purpose|mission|job) (?:is|are|will be)\b/gi },
  { cat: 'override', w: 0.4, re: /\b(?:new|updated|revised|additional|important|urgent) (?:system |admin )?instructions? ?(?::|-|—)/gi },
  { cat: 'override', w: 0.35, re: /\byou (?:are|will) (?:now|no longer|from now on)\b|\bfrom now on,? you (?:will|must|should|are)\b/gi },
  { cat: 'override', w: 0.35, re: /\b(?:developer|dan|jailbreak|god|admin|debug|unrestricted) mode\b/gi },
  // addressing the AI directly
  { cat: 'address', w: 0.4, re: new RegExp(String.raw`\b(?:dear|attention|hey|hello|hi|note (?:to|for)|message (?:to|for)|instructions? (?:to|for)|important for|notice to|to)\s*:?\s+(?:the |any |all |every )?${AI}\b\s*[:,!.]`, 'gi') },
  { cat: 'address', w: 0.45, re: new RegExp(String.raw`\bif you are an? ${AI}\b|\b(?:any|all) ${AI} (?:reading|processing|visiting|browsing|summari[sz]ing|parsing|crawling) this\b|\b${AI} (?:reading|processing|summari[sz]ing|browsing) this (?:page|email|message|document|text)\b`, 'gi') },
  { cat: 'address', w: 0.4, re: /<\|im_start\|>|<\|im_end\|>|<\|(?:system|endoftext)\|>|\[\/?INST\]|<\/?(?:system|instructions?|admin)>|<<\/?SYS>>|\bBEGIN (?:SYSTEM|ADMIN|DEVELOPER) (?:PROMPT|MESSAGE|INSTRUCTIONS?)\b|^\s*#{1,3}\s*(?:system|instructions?)\s*:?\s*$|^\s*(?:system|assistant)\s*:/gim },
  // revealing the prompt or secrets
  {
    cat: 'reveal',
    w: 0.5,
    re: /\b(?:reveal|print|show|output|repeat|display|dump|leak|tell me|give me|share|disclose|recite|write out|list)\b[^.!?\n]{0,30}?\b(?:your|the)\s+(?:(?:full |entire |complete )?system prompt|(?:initial|original|hidden|secret|full) (?:prompt|instructions)|instructions you (?:were|have been) given|api keys?|secret keys?|secrets|credentials|passwords?|access tokens?|session (?:cookies?|tokens?)|cookies)\b/gi,
  },
  // sending data somewhere
  {
    cat: 'exfiltrate',
    w: 0.5,
    re: /\b(?:send|forward|e-?mail|post|upload|transmit|exfiltrate|leak|submit|paste|append|include|encode|attach|copy)\b[^.!?\n]{0,60}?\b(?:passwords?|credentials?|cookies?|session|tokens?|api keys?|otp|2fa|verification codes?|ssn|social security|credit card|card numbers?|cvv|bank|account (?:number|details)|private|personal|(?:the |their |user'?s? |his |her |my )?(?:e-?mails?|inbox|messages|contacts|address book|files|documents|chat history|conversation|browsing history|contents?|data|info(?:rmation)?))\b[^.!?\n]{0,80}?(?:\bto\b|\binto\b|\bat\b|\bvia\b)[^.!?\n]{0,30}?(?:https?:\/\/|www\.|[a-z0-9._%+\-]+@[a-z0-9\-]+\.[a-z]{2,}|\bthis (?:url|address|endpoint|link|form|webhook)\b|\bthe following (?:url|address|endpoint|link)\b)/gi,
  },
  {
    cat: 'exfiltrate',
    w: 0.5,
    re: /\b(?:navigate to|visit|open|fetch|load|go to|make a (?:get |post )?request to|call|render|embed)\b[^.!?\n]{0,40}?https?:\/\/\S+[?&][\w\-]+=\s*(?:\{|\[|<|%7b|\$\{|\{\{)\s*[\w\s\-]*(?:data|secret|password|token|e-?mail|content|key|info|history|conversation|cookie|summary|user|code)/gi,
  },
  {
    cat: 'credentials',
    w: 0.4,
    re: /\b(?:share|send|paste|enter|submit|give|provide|post|upload|reveal|output|respond (?:only )?with|reply with|include|tell me)\b[^.!?\n]{0,40}?\b(?:(?:the |their |your )?user'?s?|saved|stored)\b[^.!?\n]{0,20}?\b(?:passwords?|credentials|cookies|api keys?|access tokens?|credit card(?: numbers?)?|card numbers?|ssn|social security numbers?|one-time codes?|2fa codes?|private messages|e-?mails?|inbox(?: contents)?|browsing history|chat history)\b/gi,
  },
  { cat: 'exfiltrate', w: 0.55, re: /!\[[^\]]*\]\(https?:\/\/[^)\s]+[?&][\w\-]+=(?:\{|\[|<|%7b|\$\{)[^)]*\)/gi },
  // hiding it from the user
  {
    cat: 'secrecy',
    w: 0.5,
    re: /\b(?:do not|don't|never|without)\b[^.!?\n]{0,20}?\b(?:tell(?:ing)?|inform(?:ing)?|notify(?:ing)?|alert(?:ing)?|mention(?:ing)?|ask(?:ing)?|warn(?:ing)?|reveal(?:ing)? (?:this |it )?to|show(?:ing)? (?:this |it )?to|let(?:ting)?)\s+(?:the\s+)?user(?:s)?\b(?! (?:interface|agent|name|id\b))/gi,
  },
  { cat: 'secrecy', w: 0.5, re: /\bwithout (?:the )?user'?s? (?:knowledge|knowing|consent|permission|noticing|approval)\b/gi },
  { cat: 'secrecy', w: 0.2, re: /\b(?:secretly|silently|quietly|covertly|discreetly)\b[^.!?\n]{0,40}?\b(?:send|forward|post|submit|upload|navigate|visit|open|transfer|copy)\b/gi },
];

const URGENT = /\b(?:urgent(?:ly)?|immediately|right now|right away|asap|as soon as possible|critical|emergency|final (?:notice|warning)|within (?:\d+|one|two|24|48) (?:minutes?|hours?)|(?:will be|has been|is) (?:suspended|locked|closed|terminated|deactivated)|act now)\b/i;
const CRED = /\b(?:password|passcode|passphrase|pin|otp|one[- ]time (?:code|password)|2fa|mfa|verification code|security code|auth(?:entication)? code|api key|secret key|private key|seed phrase|recovery phrase|credentials?|login details|ssn|social security number|credit card|card number|cvv|cvc|bank account)\b/i;
const ASK = /\b(?:enter|provide|send|share|type|submit|confirm|verify|reply with|give|paste|tell)\b/i;
// "we will never ask for your password" and friends: the classic anti-phishing sentence
const REASSURE = /\b(?:never|not|won't|will not|don't|do not)\b[^.!?\n]{0,30}?\b(?:ask|request|email|call)\b/i;

const META = /\b(?:prompt injections?|injection attacks?|jailbreak(?:s|ing)?|attack(?:s|er|ers)?|adversar(?:y|ies|ial)|researchers?|vulnerabilit(?:y|ies)|exploit(?:s|ed|ation)?|malicious|red[- ]team(?:ing)?|mitigat(?:e|es|ion|ions)|defen[cs]es?|threat model|security|phishing|example|examples|payloads?)\b/gi;
const QUOTES = /["“”'‘’«»`]/;
const REPORTING = /(?:such as|e\.g\.?|i\.e\.?|for example|for instance|like|phrases? (?:like|such as)|text (?:like|such as)|strings? (?:like|such as)|called|known as|example|examples|says?|said|wrote|writes|write|writing|instructing|instructs|instructed|containing|contains|contained|told|tells|reads?|typed|hidden text|payload|prompt)\s*[:"“'‘`(\[]?\s*$/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

/** Heuristic injection score for page text. See the comment at the top for what it does not do. */
export function scoreInjection(text: string): InjectionScore {
  if (!text || text.length < 12) return { score: 0, reasons: [] };
  const best = new Map<string, number>();
  const bump = (cat: string, w: number) => best.set(cat, Math.max(best.get(cat) ?? 0, w));

  for (const r of RULES) {
    r.re.lastIndex = 0;
    for (const m of text.matchAll(r.re)) {
      const start = m.index ?? 0;
      const before = text.slice(Math.max(0, start - 60), start);
      let w = r.w;
      // quoted or inside code: "…ignore previous instructions…"
      if (QUOTES.test(text.slice(Math.max(0, start - 2), start)) || /`[^`\n]*$/.test(before)) w *= 0.3;
      // introduced as an example: "phrases such as", "an attacker might write"
      else if (REPORTING.test(before) || /\b(?:attacker|adversary|malicious (?:page|site|actor|content))\b[^.!?\n]{0,40}$/i.test(before)) w *= 0.35;
      bump(r.cat, w);
    }
  }

  for (const s of sentences(text)) {
    if (s.length > 400) continue;
    if (URGENT.test(s) && CRED.test(s) && ASK.test(s) && !REASSURE.test(s)) bump('urgent-credentials', 0.5);
  }

  if (!best.size) return { score: 0, reasons: [] };
  let keep = 1;
  for (const w of best.values()) keep *= 1 - w;
  let score = 1 - keep;
  // pages about security: several distinct meta terms
  const meta = new Set<string>();
  for (const m of text.matchAll(META)) meta.add(m[0].toLowerCase().replace(/s$/, ''));
  if (meta.size >= 3) score *= 0.5;
  else if (meta.size === 2) score *= 0.8;
  score = Math.round(score * 1000) / 1000;
  const reasons = [...best.entries()].filter(([, w]) => w >= 0.15).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return { score, reasons };
}
