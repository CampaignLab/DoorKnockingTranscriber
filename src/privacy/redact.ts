/**
 * Rule-based PII redaction.
 *
 * Deterministic regex/pattern redaction applied to transcripts BEFORE
 * anything is written to disk.
 *
 * All functions here are pure and unit-testable.
 */

export interface Redaction {
  /** The kind of PII that was matched. */
  kind: RedactionKind;
  /** The text that was replaced (kept only in memory for the audit log; never persisted with the transcript). */
  matched: string;
  /** Character offset of the match in the original text. */
  index: number;
}

export type RedactionKind =
  | 'name'
  | 'postcode'
  | 'phone'
  | 'email'
  | 'address';

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Optional transform on the match before it counts (e.g. to keep surrounding words). */
  replaceWith?: string;
}

const PLACEHOLDER: Record<RedactionKind, string> = {
  name: '[NAME]',
  postcode: '[POSTCODE]',
  phone: '[PHONE]',
  email: '[EMAIL]',
  address: '[ADDRESS]',
};

// UK outward+inward postcode, e.g. "SW1A 1AA", "M1 1AE", "B33 8TH".
const POSTCODE =
  /\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/g;

// UK-style phone numbers: landline & mobile, with optional +44/0 prefix and separators.
const PHONE =
  /(?:\+44\s?\d{2,4}|0\d{2,5})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

// "my name is John Smith", "I'm Sarah", "this is Mr Patel" → redact the name part.
// First letter of the intro is case-flexible; the name itself must be
// capitalised so phrases like "I'm voting Labour" don't over-match.
const NAME_INTRO =
  /\b([Mm]y name is|[Ii] am|[Ii]'m|[Tt]his is|[Ii]t's)\s+((?:mr|mrs|ms|miss|dr)\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;

// House number + street, e.g. "42 Acacia Avenue", "10 Downing Street", "7B Church Road".
const STREET_ADDRESS =
  /\b\d{1,4}[A-Za-z]?\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Cl|Court|Ct|Way|Terrace|Place|Gardens|Crescent)\b/g;

const RULES: Rule[] = [
  { kind: 'email', pattern: EMAIL },
  { kind: 'phone', pattern: PHONE },
  { kind: 'postcode', pattern: POSTCODE },
  { kind: 'address', pattern: STREET_ADDRESS },
  { kind: 'name', pattern: NAME_INTRO },
];

/**
 * Redact PII from `input`, returning the cleaned text plus an in-memory
 * audit list of what was removed.
 *
 * Note on ordering: more specific patterns (email/phone/postcode/address) run
 * before the name rule so e.g. a number inside an address is not first
 * mangled by a different rule.
 */
export function redactPII(input: string): RedactionResult {
  let text = input;
  const redactions: Redaction[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (matched, ...args) => {
      const groups = args.slice(0, -2) as (string | undefined)[];
      const offset = args[args.length - 2] as number;

      if (rule.kind === 'name') {
        // Preserve the intro phrase ("my name is") and any title, redact only
        // the captured name (group 3).
        const intro = groups[0] ?? '';
        const title = groups[1] ?? '';
        const name = groups[2] ?? '';
        redactions.push({ kind: 'name', matched: name.trim(), index: offset });
        return `${intro} ${title}${PLACEHOLDER.name}`;
      }

      redactions.push({
        kind: rule.kind,
        matched,
        index: offset,
      });
      return rule.replaceWith ?? PLACEHOLDER[rule.kind];
    });
  }

  // Collapse whitespace left behind by removals.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1');

  return { text: text.trim(), redactions };
}

/** Convenience: redacted text only. */
export function redactText(input: string): string {
  return redactPII(input).text;
}
