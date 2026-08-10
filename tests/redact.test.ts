import { describe, expect, it } from 'vitest';
import { redactPII, redactText } from '../src/privacy/redact';

describe('redactPII', () => {
  it('redacts names after common introductions', () => {
    const { text, redactions } = redactPII(
      "Hello, my name is Margaret Hughes and I vote Labour.",
    );
    expect(text).not.toContain('Margaret Hughes');
    expect(text).toContain('[NAME]');
    expect(text).toContain('vote Labour');
    expect(redactions.some((r) => r.kind === 'name')).toBe(true);
  });

  it('redacts "I\'m <name>" introductions', () => {
    const { text } = redactPII("Hi, I'm David from number 42, come in.");
    expect(text).toContain('[NAME]');
    expect(text).not.toMatch(/I'm David/);
  });

  it('redacts names with titles', () => {
    const { text } = redactPII('My name is Dr Priya Sharma, pleased to meet you.');
    expect(text).toContain('[NAME]');
    expect(text).not.toContain('Priya Sharma');
  });

  it('redacts UK postcodes', () => {
    expect(redactText('I live at SW1A 1AA.')).toContain('[POSTCODE]');
    expect(redactText('Postcode is M1 1AE')).toContain('[POSTCODE]');
    expect(redactText('B33 8TH')).toContain('[POSTCODE]');
  });

  it('redacts UK phone numbers', () => {
    expect(redactText('Call me on 07700 900123.')).toContain('[PHONE]');
    expect(redactText('Ring 020 7946 0018')).toContain('[PHONE]');
    expect(redactText('+44 7700 900123')).toContain('[PHONE]');
  });

  it('redacts email addresses', () => {
    expect(redactText('email me at voter@example.com please')).toContain(
      '[EMAIL]',
    );
  });

  it('redacts street addresses', () => {
    expect(redactText('I live at 42 Acacia Avenue.')).toContain('[ADDRESS]');
    expect(redactText('10 Downing Street is nearby')).toContain('[ADDRESS]');
  });

  it('redacts multiple kinds of PII in one pass', () => {
    const { text, redactions } = redactPII(
      "My name is John Smith, I'm at 15 Church Road, postcode LE1 5BD, call 0116 496 0123.",
    );
    expect(text).not.toContain('John Smith');
    expect(text).not.toContain('15 Church Road');
    expect(text).not.toContain('LE1 5BD');
    expect(text).not.toContain('0116 496 0123');
    expect(redactions.length).toBeGreaterThanOrEqual(4);
  });

  it('leaves non-PII political content intact', () => {
    const clean =
      'I usually vote Green and I care about the NHS and the cost of living.';
    expect(redactText(clean)).toBe(clean);
  });

  it('does not mangle ordinary numbers that are not phones or addresses', () => {
    const clean = 'I have 3 children and my energy bill went up by 40 percent.';
    expect(redactText(clean)).toBe(clean);
  });

  it('is idempotent on already-redacted text', () => {
    const once = redactText('My name is Jane Doe, phone 07700 900123.');
    expect(redactText(once)).toBe(once);
  });
});
