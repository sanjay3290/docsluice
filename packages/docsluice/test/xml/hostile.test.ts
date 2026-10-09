import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { parseXml, scanXml, type XmlContext } from '../../src/xml/index.js';

function context(): XmlContext {
  const warnings = new WarningSink();
  return { budget: new Budget(DEFAULT_LIMITS, { warnings }), warnings };
}

describe('hostile XML samples', () => {
  it('does not expand the billion-laughs entity declarations', () => {
    const bytes = new TextEncoder().encode(
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;"><!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">]><lolz>&lol5;</lolz>',
    );
    const ctx = context();
    const started = performance.now();
    const texts: string[] = [];
    scanXml(bytes, { onText: (text) => texts.push(text) }, ctx);
    expect(performance.now() - started).toBeLessThan(100);
    expect(texts.join('')).toBe('&lol5;');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED', 'UNKNOWN_ENTITY']);
  });

  it('does not read the file named by an external entity', () => {
    const bytes = new TextEncoder().encode(
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>',
    );
    const ctx = context();
    const texts: string[] = [];
    scanXml(bytes, { onText: (text) => texts.push(text) }, ctx);
    expect(texts.join('')).toBe('&e;');
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED', 'UNKNOWN_ENTITY']);
  });

  it('stops building a 10,000-level tree at the XML depth budget', () => {
    const bytes = new TextEncoder().encode(`${'<x>'.repeat(10_000)}deep${'</x>'.repeat(10_000)}`);
    const ctx = context();
    const root = parseXml(bytes, ctx);
    expect(root).toBeDefined();
    expect(ctx.warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
    let depth = 0;
    let element = root;
    while (element) {
      depth += 1;
      const child = element.children.find((value) => typeof value !== 'string');
      element = typeof child === 'string' || child === undefined ? undefined : child;
    }
    expect(depth).toBe(DEFAULT_LIMITS.xmlDepth);
  });
});
