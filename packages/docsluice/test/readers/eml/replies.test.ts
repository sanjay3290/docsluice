import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { decodeMimeText, parseMime } from '../../../src/mime/index.js';
import { dropQuotedReplies } from '../../../src/readers/eml/replies.js';

describe('dropQuotedReplies', () => {
  it('drops Gmail, Apple Mail and Outlook history after the new reply', () => {
    const budget = { tick() {} };
    expect(dropQuotedReplies('NEW REPLY\n\nOn Mon, Oct 5, 2026, Alice wrote:\n> quoted', budget)).toBe(
      'NEW REPLY\n',
    );
    expect(dropQuotedReplies('NEW REPLY\n\nOn Oct 5, 2026, at 8:15 AM, Alice wrote:\nquoted', budget)).toBe(
      'NEW REPLY\n',
    );
    expect(
      dropQuotedReplies(
        'NEW REPLY\n\nFrom: Alice\nSent: Monday, October 5, 2026\nTo: Bob\nSubject: Old\n\nquoted',
        budget,
      ),
    ).toBe('NEW REPLY\n');
  });

  it('drops leading quoted lines when no client separator exists', () => {
    expect(dropQuotedReplies('Reply\n> quote\n> another', { tick() {} })).toBe('Reply\n');
  });

  it('drops reviewed Gmail, Outlook, and Apple Mail history fixtures', () => {
    for (const client of ['gmail', 'outlook', 'apple']) {
      const bytes = readFileSync(new URL(`../../../../../corpus/eml/quoted-${client}.eml`, import.meta.url));
      const message = parseMime(bytes, new Budget(DEFAULT_LIMITS));
      const body = message.parts[0] ? decodeMimeText(message.parts[0]) : '';
      const cleaned = dropQuotedReplies(body, new Budget(DEFAULT_LIMITS));
      expect(cleaned).toContain(`NEW REPLY ${client.toUpperCase()}`);
      expect(cleaned).not.toContain('quoted line');
      expect(cleaned).not.toContain('quoted body');
      expect(cleaned).not.toContain('On Mon, Oct 5');
      expect(cleaned).not.toContain('On Oct 5');
    }
  });
});
