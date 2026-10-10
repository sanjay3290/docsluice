import { describe, expect, it } from 'vitest';
import { detect } from '../../src/detect/detect.js';
import { detectTextKind } from '../../src/detect/text-kind.js';

const kind = (text: string) => detectTextKind(text);

describe('XML after a DOCTYPE declaration (#172)', () => {
  it.each([
    ['<!DOCTYPE x [ <!ENTITY e "v"> ]><x/>', 'xml'],
    ['<!DOCTYPE note SYSTEM "note.dtd">\n<note><to>A</to></note>', 'xml'],
    [
      '<!doctype svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="x"/>',
      'xml',
    ],
    [
      '<!DOCTYPE x [ <!-- a ] and a > in a comment --> <!ATTLIST x a CDATA "]>"> ]>\n<!-- c --><?pi x?>\n<x a="1">t</x>',
      'xml',
    ],
    ['<!DOCTYPE html><html><body>Hi</body></html>', 'html'],
    ['<!DOCTYPE x [ unterminated', 'txt'],
    ['<!DOCTYPE x "unterminated', 'txt'],
    ['<!DOCTYPE x [ <!-- unterminated', 'txt'],
    ['<!DOCTYPE x>\nplain text after', 'txt'],
    ['<!DOCTYPE x><!-- unterminated comment', 'txt'],
  ])('%j is %s', (text, expected) => {
    expect(kind(text)).toBe(expected);
  });

  it('routes an XXE sample to the XML reader without a format hint', async () => {
    const xml = '<!DOCTYPE r [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]><r>&x;</r>';
    expect((await detect(new TextEncoder().encode(xml), { filename: 'a.xml' })).format).toBe('xml');
  });
});
