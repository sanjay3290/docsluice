import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { parseXml, scanXml, type XmlContext, type XmlElementInfo } from '../../src/xml/index.js';

function context(xmlDepth = DEFAULT_LIMITS.xmlDepth, outputChars = DEFAULT_LIMITS.outputChars): XmlContext {
  const warnings = new WarningSink();
  return {
    budget: new Budget({ ...DEFAULT_LIMITS, xmlDepth, outputChars }, { warnings }),
    warnings,
  };
}

function utf16(source: string, endian: 'le' | 'be', bom = true): Uint8Array {
  const bytes = new Uint8Array(source.length * 2 + (bom ? 2 : 0));
  if (bom) {
    bytes[0] = endian === 'le' ? 0xff : 0xfe;
    bytes[1] = endian === 'le' ? 0xfe : 0xff;
  }
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    const offset = (bom ? 2 : 0) + index * 2;
    bytes[offset] = endian === 'le' ? code & 0xff : code >> 8;
    bytes[offset + 1] = endian === 'le' ? code >> 8 : code & 0xff;
  }
  return bytes;
}

describe('scanXml', () => {
  it('emits namespaced elements, attributes, text, CDATA and self-closing tags', () => {
    const events: Array<string> = [];
    const infos: XmlElementInfo[] = [];
    scanXml(
      `<?xml version="1.0"?><root xmlns="urn:root" xmlns:p='urn:part' a='&amp;'><p:item p:id="7">a&amp;b<![CDATA[<raw>]]><!--hidden--><empty/></p:item></root>`,
      {
        onOpen(name, attrs, info) {
          events.push(`+${name}:${attrs.get('a') ?? attrs.get('p:id') ?? ''}`);
          infos.push(info);
        },
        onText(text) {
          events.push(`=${text}`);
        },
        onClose(name) {
          events.push(`-${name}`);
        },
      },
      context(),
    );

    expect(events).toEqual([
      '+root:&',
      '+p:item:7',
      '=a&b',
      '=<raw>',
      '+empty:',
      '-empty',
      '-p:item',
      '-root',
    ]);
    expect(infos.map(({ localName, namespaceURI }) => [localName, namespaceURI])).toEqual([
      ['root', 'urn:root'],
      ['item', 'urn:part'],
      ['empty', 'urn:root'],
    ]);
  });

  it('resolves namespace declarations by scope and treats an empty default as no namespace', () => {
    const infos: XmlElementInfo[] = [];
    scanXml(
      `<r xmlns="urn:default" xmlns:p="urn:outer"><p:a/><i xmlns="" xmlns:p="urn:inner"><p:b/><c/></i><p:c/></r>`,
      { onOpen: (_name, _attrs, info) => infos.push(info) },
      context(),
    );
    expect(infos.map(({ name, namespaceURI }) => [name, namespaceURI])).toEqual([
      ['r', 'urn:default'],
      ['p:a', 'urn:outer'],
      ['i', undefined],
      ['p:b', 'urn:inner'],
      ['c', undefined],
      ['p:c', 'urn:outer'],
    ]);
  });

  it('keeps unknown entities literal and warns once without processing external entities', () => {
    const ctx = context();
    const texts: string[] = [];
    scanXml(
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd"><!ENTITY a "[x]">]><x>&e; &unknown; &#x1F600;</x>',
      { onText: (text) => texts.push(text) },
      ctx,
    );

    expect(texts.join('')).toBe('&e; &unknown; 😀');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED', 'UNKNOWN_ENTITY']);
  });

  it('deduplicates DTD and unknown-entity warnings per document budget', () => {
    const ctx = context();
    const xml = '<!DOCTYPE x [<!ENTITY e "value">]><x>&unknown;</x>';
    scanXml(xml, {}, ctx);
    scanXml(xml, {}, ctx);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED', 'UNKNOWN_ENTITY']);

    const childContext = { ...ctx, budget: ctx.budget.child() };
    scanXml(xml, {}, childContext);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual([
      'DTD_IGNORED',
      'UNKNOWN_ENTITY',
      'DTD_IGNORED',
      'UNKNOWN_ENTITY',
    ]);
  });

  it('decodes built-in entities and replaces invalid numeric code points', () => {
    const texts: string[] = [];
    scanXml(
      '<x>&lt;&gt;&amp;&quot;&apos;&#65;&#x20;&#xD800;&#x110000;</x>',
      { onText: (text) => texts.push(text) },
      context(),
    );
    expect(texts.join('')).toBe('<>&"\'A ��');
  });

  it('preserves an entity reference without a semicolon and replaces malformed digits', () => {
    const ctx = context();
    const texts: string[] = [];
    scanXml('<x>&oops tail &#xG;</x>', { onText: (text) => texts.push(text) }, ctx);
    expect(texts.join('')).toBe('&oops tail �');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNKNOWN_ENTITY', 'UNREADABLE_PART']);
  });

  it('does not warn when U+FFFD is referenced as a valid character', () => {
    const ctx = context();
    const texts: string[] = [];
    scanXml('<x>&#xFFFD;</x>', { onText: (text) => texts.push(text) }, ctx);
    expect(texts).toEqual(['�']);
    expect(ctx.warnings.warnings).toEqual([]);
  });

  it('skips comments, processing instructions and a bracket-aware doctype', () => {
    const ctx = context();
    const texts: string[] = [];
    scanXml(
      '<!DOCTYPE x [<!ENTITY e "one > [ two ]"><!-- ] > --><!ELEMENT x (#PCDATA)>]><?target ignored?><x>ok</x>',
      { onText: (text) => texts.push(text) },
      ctx,
    );
    expect(texts).toEqual(['ok']);
    expect(ctx.warnings.warnings).toHaveLength(1);
  });

  it('warns and leniently closes unclosed elements at end of input', () => {
    const ctx = context();
    const events: string[] = [];
    scanXml(
      '<outer><inner>tail',
      {
        onOpen: (name) => events.push(`+${name}`),
        onText: (text) => events.push(text),
        onClose: (name) => events.push(`-${name}`),
      },
      ctx,
    );
    expect(events).toEqual(['+outer', '+inner', 'tail', '-inner', '-outer']);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('recovers from mismatched and unmatched end tags without recursive unwinding', () => {
    const ctx = context();
    const closes: string[] = [];
    scanXml('<a><b></a></missing>', { onClose: (name) => closes.push(name) }, ctx);
    expect(closes).toEqual(['b', 'a']);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('accepts UTF-16 BOMs and warns when an unsupported declaration falls back to UTF-8', () => {
    const utf16le = new Uint8Array([
      0xff, 0xfe, 0x3c, 0, 0x78, 0, 0x3e, 0, 0x6f, 0, 0x6b, 0, 0x3c, 0, 0x2f, 0, 0x78, 0, 0x3e, 0,
    ]);
    const texts: string[] = [];
    scanXml(utf16le, { onText: (text) => texts.push(text) }, context());
    expect(texts).toEqual(['ok']);

    const ctx = context();
    scanXml('<?xml version="1.0" encoding="ISO-8859-1"?><x>ok</x>', {}, ctx);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['ENCODING_GUESSED']);
  });

  it('detects UTF-8 BOMs, UTF-16 byte signatures and the declared UTF-16 encoding', () => {
    const samples = [
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<x>one</x>')]),
      utf16('<?xml version="1.0" encoding="UTF-16"?><x>two</x>', 'be'),
      utf16('<x>three</x>', 'le', false),
      utf16('<x>four</x>', 'be', false),
    ];
    const results: string[][] = [];
    for (const sample of samples) {
      const texts: string[] = [];
      scanXml(sample, { onText: (text) => texts.push(text) }, context());
      results.push(texts);
    }
    expect(results).toEqual([['one'], ['two'], ['three'], ['four']]);
  });

  it('falls back to UTF-8 and warns for unsupported byte encodings', () => {
    const utf8Context = context();
    scanXml(new TextEncoder().encode('<?xml version="1.0" encoding="x-other"?><x/>'), {}, utf8Context);
    expect(utf8Context.warnings.warnings.map(({ code }) => code)).toEqual(['ENCODING_GUESSED']);

    const utf16Context = context();
    scanXml(utf16('<?xml version="1.0" encoding="x-other"?><x/>', 'le'), {}, utf16Context);
    expect(utf16Context.warnings.warnings.map(({ code }) => code)).toContain('ENCODING_GUESSED');
  });

  it('tolerates noise while scanning an XML declaration', () => {
    const ctx = context();
    const root = parseXml('<?xml !!! encoding="UTF-8"?><x/>', ctx);
    expect(root?.name).toBe('x');
    expect(ctx.warnings.warnings).toEqual([]);

    const spaced = parseXml("<?xml version = '1.0' encoding = 'UTF-8'?><x/>", context());
    expect(spaced?.name).toBe('x');

    expect(parseXml('<?xml version?><x/>', context())?.name).toBe('x');
  });

  it('stops safely when XML depth exceeds the configured budget', () => {
    const ctx = context(2);
    const opened: string[] = [];
    const closed: string[] = [];
    scanXml(
      '<a><b><c><d/></c></b></a>',
      { onOpen: (name) => opened.push(name), onClose: (name) => closed.push(name) },
      ctx,
    );
    expect(opened).toEqual(['a', 'b']);
    expect(closed).toEqual(['b', 'a']);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
  });

  it('balances a depth increment when the budget throws on the limit', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, xmlDepth: 1 }, { onLimit: 'throw', warnings });
    const ctx = { budget, warnings };
    expect(() => scanXml('<a><b/></a>', {}, ctx)).toThrow();
    expect(budget.enterDepth('xml')).toBe(true);
    budget.exitDepth('xml');
  });

  it('balances depth when a close event callback throws', () => {
    const ctx = context(1);
    expect(() =>
      scanXml(
        '<a/>',
        {
          onClose: () => {
            throw new Error('close failed');
          },
        },
        ctx,
      ),
    ).toThrow('close failed');
    expect(ctx.budget.enterDepth('xml')).toBe(true);
    ctx.budget.exitDepth('xml');
  });

  it('continues balancing entered depths while cancellation is active', () => {
    const controller = new AbortController();
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { signal: controller.signal, warnings });
    const ctx = { budget, warnings };
    expect(() =>
      scanXml(
        '<a><b/></a>',
        {
          onOpen(name) {
            if (name === 'b') {
              controller.abort();
              throw new Error('callback failed');
            }
          },
        },
        ctx,
      ),
    ).toThrow('callback failed');
    expect(budget.enterDepth('xml')).toBe(true);
    budget.exitDepth('xml');
  });

  it('balances entered depths when a text callback aborts the shared budget', () => {
    const controller = new AbortController();
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { signal: controller.signal, warnings });
    const ctx = { budget, warnings };
    expect(() =>
      scanXml(
        '<a>stop</a>',
        {
          onText() {
            controller.abort();
          },
        },
        ctx,
      ),
    ).toThrow();
    expect(budget.enterDepth('xml')).toBe(true);
    budget.exitDepth('xml');
  });

  it('checks the staged text against output limits without charging the shared counter', () => {
    const ctx = context(DEFAULT_LIMITS.xmlDepth, 2);
    const texts: string[] = [];
    scanXml('<x>abc</x>', { onText: (text) => texts.push(text) }, ctx);
    expect(texts).toEqual([]);
    expect(ctx.budget.outputChars).toBe(0);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);

    const withinLimit = context(DEFAULT_LIMITS.xmlDepth, 4);
    const accepted: string[] = [];
    scanXml('<x>text</x>', { onText: (text) => accepted.push(text) }, withinLimit);
    expect(accepted).toEqual(['text']);
    expect(withinLimit.budget.outputChars).toBe(0);
  });

  it('accounts for prior shared output when checking staged XML text', () => {
    const ctx = context(DEFAULT_LIMITS.xmlDepth, 3);
    expect(ctx.budget.addOutputChars(1)).toBe(true);
    const texts: string[] = [];
    scanXml('<x>abc</x>', { onText: (text) => texts.push(text) }, ctx);
    expect(texts).toEqual([]);
    expect(ctx.budget.outputChars).toBe(1);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
  });

  it('handles empty, BOM-prefixed string, unquoted and malformed attributes leniently', () => {
    const ctx = context();
    const attrs: Array<Map<string, string>> = [];
    expect(scanXml('', {}, ctx)).toBeUndefined();
    scanXml(
      '\uFEFF<x bare=one broken="two" bare=three>z</x>',
      { onOpen: (_name, map) => attrs.push(map) },
      ctx,
    );
    expect(attrs[0]?.get('bare')).toBe('three');
    expect(attrs[0]?.get('broken')).toBe('two');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('keeps attributes without equals empty and closes a tag with an unterminated quote', () => {
    const ctx = context();
    let attrs: Map<string, string> | undefined;
    scanXml(
      '<x bare>',
      {
        onOpen: (_name, found) => {
          attrs = found;
        },
      },
      ctx,
    );
    expect(attrs?.get('bare')).toBe('');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);

    const quotedContext = context();
    scanXml('<x value="unterminated', {}, quotedContext);
    expect(quotedContext.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('balances budget depth if an event callback throws', () => {
    const ctx = context(1);
    expect(() =>
      scanXml(
        '<x/>',
        {
          onOpen: () => {
            throw new Error('callback failed');
          },
        },
        ctx,
      ),
    ).toThrow('callback failed');
    expect(ctx.budget.enterDepth('xml')).toBe(true);
    ctx.budget.exitDepth('xml');
  });

  it('recovers from unknown declarations and invalid markup characters', () => {
    const ctx = context();
    const events: string[] = [];
    scanXml('< ><!OTHER anything><x @="v"/>', { onText: (text) => events.push(text) }, ctx);
    expect(events).toEqual(['>']);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('warns on unterminated comments, doctypes and CDATA while keeping readable text', () => {
    const commentContext = context();
    scanXml('<x><!-- never closes', {}, commentContext);
    expect(commentContext.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);

    const doctypeContext = context();
    scanXml('<!DOCTYPE x [<!ENTITY never "done">', {}, doctypeContext);
    expect(doctypeContext.warnings.warnings.map(({ code }) => code)).toEqual([
      'DTD_IGNORED',
      'UNREADABLE_PART',
    ]);

    const cdataContext = context();
    const texts: string[] = [];
    scanXml('<x><![CDATA[visible', { onText: (text) => texts.push(text) }, cdataContext);
    expect(texts).toEqual(['visible']);
    expect(cdataContext.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('skips malformed closing-tag tails and reports the part once', () => {
    const ctx = context();
    scanXml('</stray trailing junk>', {}, ctx);
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });
});

describe('parseXml', () => {
  it('builds a Map-backed tree with namespace details and mixed content', () => {
    const root = parseXml('<r xmlns="urn:r" plain="v"><p xmlns="urn:p">before<i/>after</p></r>', context());
    expect(root).toMatchObject({ name: 'r', localName: 'r', namespaceURI: 'urn:r' });
    expect(root?.attrs).toBeInstanceOf(Map);
    expect(root?.attrs.get('plain')).toBe('v');
    expect(root?.children).toEqual([
      expect.objectContaining({
        name: 'p',
        localName: 'p',
        namespaceURI: 'urn:p',
        children: [
          'before',
          expect.objectContaining({ name: 'i', namespaceURI: 'urn:p', children: [] }),
          'after',
        ],
      }),
    ]);
  });

  it('returns no element for text-only input and remains safe on 10,000 nested elements', () => {
    expect(parseXml('text only', context())).toBeUndefined();
    const ctx = context(32);
    const root = parseXml(`${'<x>'.repeat(10_000)}tail${'</x>'.repeat(10_000)}`, ctx);
    expect(root?.name).toBe('x');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
  });

  it('ignores text outside the root and retains only the first root element', () => {
    const root = parseXml('before<a/>after<b/>', context());
    expect(root?.name).toBe('a');
    expect(root?.children).toEqual([]);
  });
});
