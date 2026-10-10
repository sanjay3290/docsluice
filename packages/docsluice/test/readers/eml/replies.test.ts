import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { extract } from '../../../src/core/extract.js';
import type { Block } from '../../../src/core/model.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { dropQuotedText } from '../../../src/readers/eml/replies.js';

const budget = () => new Budget(DEFAULT_LIMITS, { warnings: new WarningSink() });
const drop = (text: string) => dropQuotedText(text, budget());

function message(body: string, type = 'text/plain'): Uint8Array {
  return new TextEncoder().encode(
    [
      'From: Casey Example <casey@example.test>',
      'To: Reader <reader@example.test>',
      'Subject: Re: Field plan',
      'MIME-Version: 1.0',
      `Content-Type: ${type}; charset=utf-8`,
      '',
      body,
    ].join('\r\n'),
  );
}

async function texts(bytes: Uint8Array, quotedReplies?: 'keep' | 'drop', filename = 'reply.eml') {
  const doc = await extract(bytes, { filename, ...(quotedReplies ? { quotedReplies } : {}) });
  return doc.blocks
    .filter((block): block is Extract<Block, { kind: 'paragraph' }> => block.kind === 'paragraph')
    .map((block) => block.text);
}

describe('quoted reply history in plain text (EML-4)', () => {
  it.each([
    [
      'Gmail',
      'Sounds good.\n\nOn Mon, Oct 5, 2026 at 8:15 AM Alex <alex@example.test> wrote:\n> Earlier line one\n> Earlier line two\n',
    ],
    [
      'Gmail, attribution wrapped over two lines',
      'Sounds good.\n\nOn Mon, Oct 5, 2026 at 8:15 AM Alex Example\n<alex@example.test> wrote:\n\n> Earlier line\n',
    ],
    [
      'Apple Mail',
      'Sounds good.\n\nOn Oct 5, 2026, at 08:15, Alex Example <alex@example.test> wrote:\n\nEarlier unquoted body\n',
    ],
    [
      'Outlook desktop',
      'Sounds good.\n\n________________________________\nFrom: Alex Example <alex@example.test>\nSent: Monday, October 5, 2026 8:15 AM\nTo: Reader\nSubject: Field plan\n\nEarlier body\n',
    ],
    [
      'Outlook, no rule',
      'Sounds good.\n\nFrom: Alex Example <alex@example.test>\nSent: Monday, October 5, 2026 8:15 AM\nTo: Reader\n\nEarlier body\n',
    ],
    [
      'Outlook on the web and Mac',
      'Sounds good.\n\nFROM: Alex Example\nDATE: Monday, October 5, 2026 at 8:15 AM\nTO: Reader\nSUBJECT: Field plan\n\nEarlier body\n',
    ],
    ['Original Message', 'Sounds good.\n\n-----Original Message-----\nFrom: Alex\nEarlier body\n'],
    ['Original Message, spaced', 'Sounds good.\n\n----- original message -----\nEarlier body\n'],
  ])('%s', async (_client, body) => {
    expect(drop(body).trim()).toBe('Sounds good.');
    expect(await texts(message(body), 'drop')).toEqual(['Sounds good.']);
    expect((await texts(message(body))).length).toBeGreaterThan(1);
  });

  it('drops interleaved > quotes and keeps everything else as written', () => {
    expect(drop('  Intro\n> quoted\n   > indented quote\nAnswer\r\n\tIndented answer\n>')).toBe(
      '  Intro\nAnswer\r\n\tIndented answer',
    );
  });

  it('keeps text that only looks like a header', () => {
    const body = [
      'On Monday we sample the estuary.',
      'On second thought, it wrote: nothing',
      'From: the north site',
      'To: the south site',
      '__________',
      'Not a header after the rule.',
      '______',
      '-- signature --',
      '---- forwarded ----',
    ].join('\n');
    expect(drop(body)).toBe(body);
    expect(drop(`On ${'x'.repeat(2_000)} wrote:`)).toBe(`On ${'x'.repeat(2_000)} wrote:`);
    expect(drop('Body\n__________\n\n\nFrom: three blank lines later')).toBe(
      'Body\n__________\n\n\nFrom: three blank lines later',
    );
    expect(drop('Body\n__________')).toBe('Body\n__________');
  });

  it('stays linear on many attribution-like and header-like lines', () => {
    const body = `${'On a line that never ends with the word\n'.repeat(20_000)}${'From: x\n'.repeat(20_000)}`;
    const started = performance.now();
    expect(drop(body)).toBe(body);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('quoted reply history in HTML bodies (EML-4)', () => {
  it.each([
    [
      'Gmail',
      '<div dir="ltr">Sounds good.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Oct 5, 2026 at 8:15 AM Alex wrote:<br></div><blockquote class="gmail_quote"><div>Earlier body</div></blockquote></div>',
    ],
    [
      'Apple Mail',
      '<div>Sounds good.</div><div><br><blockquote type="cite"><div>Earlier body</div></blockquote></div><div>On Oct 5, 2026, at 08:15, Alex Example &lt;alex@example.test&gt; wrote:</div><blockquote type="cite"><div>Earlier body</div></blockquote>',
    ],
    [
      'Thunderbird',
      '<p>Sounds good.</p><div class="moz-cite-prefix">On 05/10/2026 08:15, Alex wrote:<br></div><blockquote type="cite" cite="mid:x">Earlier body</blockquote>',
    ],
    [
      'Yahoo',
      '<div>Sounds good.</div><div class="yahoo_quoted"><div>On Monday, Alex wrote:</div><div>Earlier body</div></div>',
    ],
    [
      'Outlook on the web',
      '<div>Sounds good.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Alex<br><b>Sent:</b> Monday</div><div>Earlier body</div>',
    ],
    [
      'Outlook desktop',
      '<div class="WordSection1"><p class="MsoNormal">Sounds good.</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p class="MsoNormal"><b>From:</b> Alex Example<br><b>Sent:</b> Monday, October 5, 2026 8:15 AM<br><b>To:</b> Reader</p></div></div><p class="MsoNormal">Earlier body</p></div>',
    ],
  ])('%s', async (_client, html) => {
    const bytes = message(`<html><body>${html}</body></html>`, 'text/html');
    expect(await texts(bytes, 'drop')).toEqual(['Sounds good.']);
    expect(await texts(bytes, 'keep')).toContain('Earlier body');
  });

  it('keeps an attribution-like element that is not followed by a quote, and plain blockquotes', async () => {
    const html =
      '<p>Sounds good.</p><p>On Monday, Alex wrote:</p><p>More text</p><blockquote>Kept quotation</blockquote>' +
      `<div>From: ${'word '.repeat(600)} Sent: a div too long to be a header</div><p>Last</p>`;
    const bytes = message(`<html><body>${html}</body></html>`, 'text/html');
    const kept = await texts(bytes, 'drop');
    expect(kept.slice(0, 4)).toEqual([
      'Sounds good.',
      'On Monday, Alex wrote:',
      'More text',
      'Kept quotation',
    ]);
    expect(kept.at(-1)).toBe('Last');
    expect(kept).toHaveLength(6);
  });

  it('bounds probing in deeply nested containers', async () => {
    const html = `${'<div>'.repeat(2_000)}${'<span></span>'.repeat(500)}Deep text${'</div>'.repeat(2_000)}`;
    const started = performance.now();
    expect(await texts(message(`<html><body>${html}</body></html>`, 'text/html'), 'drop')).toEqual([
      'Deep text',
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('quoted reply history in MSG bodies (EML-4)', () => {
  it('applies to plain and HTML Outlook message bodies', async () => {
    for (const name of ['embedded-message.msg', 'html-body.msg']) {
      const bytes = new Uint8Array(
        readFileSync(new URL(`../../../../../corpus/msg/${name}`, import.meta.url)),
      );
      const kept = await texts(bytes, 'keep', name);
      const dropped = await texts(bytes, 'drop', name);
      expect(dropped.length).toBeGreaterThan(0);
      expect(kept).toEqual(expect.arrayContaining(dropped));
    }
  });
});
