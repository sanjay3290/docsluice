import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { AbortError, LimitExceededError, StrictModeError } from '../../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { parseXml } from '../../../src/xml/index.js';
import { parseSpeakerNotes, slideIsHidden } from '../../../src/readers/pptx/notes.js';
import type { XmlElement } from '../../../src/xml/tree.js';
import { fuzzPptxNotes } from '../../../fuzz/pptx-notes.fuzz.js';

const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function root(xml: string): XmlElement {
  const warnings = new WarningSink();
  const budget = new Budget(DEFAULT_LIMITS, { warnings });
  const parsed = parseXml(xml, { budget, warnings });
  if (!parsed) throw new Error('Fixture XML has no root.');
  return parsed;
}

function noteShape(type: string, body: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function notesXml(shapes: string): string {
  return `<p:notes xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:notes>`;
}

function budget(
  limits: Partial<typeof DEFAULT_LIMITS> = {},
  onLimit: 'truncate' | 'throw' = 'throw',
  strict = false,
  signal?: AbortSignal,
) {
  const warnings = new WarningSink({ strict });
  return {
    warnings,
    budget: new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings, onLimit, signal }),
  };
}

describe('parseSpeakerNotes', () => {
  it('reads Unicode runs, fields and line breaks as paragraphs from the body placeholder', () => {
    const xml = notesXml(
      `${noteShape('sldImg', '<a:p><a:r><a:t>image placeholder</a:t></a:r></a:p>')}${noteShape(
        'body',
        '<a:p><a:r><a:t>Speaker Ω</a:t></a:r><a:fld id="f"><a:t>field</a:t></a:fld><a:br/><a:r><a:t>line</a:t></a:r></a:p><a:p><a:r><a:t>Next paragraph</a:t></a:r></a:p>',
      )}${noteShape('sldNum', '<a:p><a:r><a:t>slide 4</a:t></a:r></a:p>')}`,
    );
    const { budget: active } = budget();
    expect(parseSpeakerNotes(root(xml), active)).toEqual(['Speaker Ωfield\nline\nNext paragraph']);
    expect(active.outputChars).toBe(0);
    expect(active.cells).toBe(0);
  });

  it('returns one note string per body placeholder and omits empty bodies', () => {
    const xml = notesXml(
      `${noteShape('body', '<a:p><a:r><a:t>First</a:t></a:r></a:p>')}${noteShape(
        'body',
        '<a:p><a:r><a:t>Second</a:t></a:r></a:p><a:p/>',
      )}${noteShape('body', '<a:p/>')}`,
    );
    const { budget: active } = budget();
    expect(parseSpeakerNotes(root(xml), active)).toEqual(['First', 'Second']);
  });

  it('ignores non-body shapes, nested text, unrelated namespaces and extension injections', () => {
    const xml = notesXml(
      `${noteShape('sldNum', '<a:p><a:r><a:t>SECRET_SLIDE</a:t></a:r></a:p>')}` +
        `${noteShape('body', '<a:p><a:ext><a:r><a:t>SECRET_NESTED</a:t></a:r></a:ext><x:r xmlns:x="urn:attacker"><x:t>SECRET_NS</x:t></x:r><a:r><a:t>visible</a:t></a:r></a:p>')}` +
        `<p:extLst><p:ext uri="x">${noteShape('body', '<a:p><a:r><a:t>SECRET_EXTENSION</a:t></a:r></a:p>')}</p:ext></p:extLst>`,
    );
    const { budget: active, warnings } = budget();
    const result = parseSpeakerNotes(root(xml), active);
    expect(result).toEqual(['visible']);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_/);
    expect(warnings.warnings).toEqual([]);
  });

  it('returns no notes when the root path or body placeholder is missing', () => {
    const { budget: active } = budget();
    expect(parseSpeakerNotes(root('<p:notes xmlns:p="urn:wrong"><p:cSld/></p:notes>'), active)).toEqual([]);
    expect(parseSpeakerNotes(root(notesXml(noteShape('sldNum', '<a:p/>'))), active)).toEqual([]);
  });

  it('truncates only at a complete paragraph boundary and reserves across placeholders', () => {
    const xml = notesXml(
      `${noteShape('body', '<a:p><a:r><a:t>one</a:t></a:r></a:p><a:p><a:r><a:t>long paragraph</a:t></a:r></a:p>')}${noteShape('body', '<a:p><a:r><a:t>last</a:t></a:r></a:p>')}`,
    );
    const { budget: active, warnings } = budget({ outputChars: 7 }, 'truncate');
    expect(parseSpeakerNotes(root(xml), active)).toEqual(['one']);
    expect(active.outputChars).toBe(0);
    expect(active.truncated).toBe(true);
    expect(warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('propagates strict-mode output warnings and aborts', () => {
    const parsed = root(notesXml(noteShape('body', '<a:p><a:r><a:t>too long</a:t></a:r></a:p>')));
    const strict = budget({ outputChars: 1 }, 'truncate', true);
    expect(() => parseSpeakerNotes(parsed, strict.budget)).toThrow(StrictModeError);
    const controller = new AbortController();
    controller.abort();
    const aborted = budget({}, 'truncate', false, controller.signal);
    expect(() => parseSpeakerNotes(parsed, aborted.budget)).toThrow(AbortError);
  });

  it('hard-limits source characters even in unused shapes before retaining any note', () => {
    const parsed = root(
      notesXml(
        `<p:extLst>${'x'.repeat(5_000_001)}</p:extLst>${noteShape('body', '<a:p><a:r><a:t>note</a:t></a:r></a:p>')}`,
      ),
    );
    const { budget: active } = budget({ outputChars: 5_000_010 });
    expect(() => parseSpeakerNotes(parsed, active)).toThrow(LimitExceededError);
  });

  it('hard-limits source tree objects before retaining a note', () => {
    const attrs = new Map<string, string>();
    for (let index = 0; index < 50_000; index += 1) attrs.set(`a${index}`, '');
    const parsed: XmlElement = {
      name: 'p:notes',
      localName: 'notes',
      namespaceURI: PRESENTATION_NS,
      attrs,
      children: [],
    };
    const { budget: active } = budget();
    try {
      parseSpeakerNotes(parsed, active);
      throw new Error('Expected notes source object cap to be exceeded.');
    } catch (error) {
      expect(error).toBeInstanceOf(LimitExceededError);
      expect((error as LimitExceededError).limit).toBe('pptxObjects');
      expect((error as Error).message).not.toContain('a49999');
    }
  });
});

describe('slideIsHidden', () => {
  it.each(['0', 'false'])('recognizes show="%s" as hidden', (show) => {
    expect(slideIsHidden(root(`<p:sld xmlns:p="${PRESENTATION_NS}" show="${show}"/>`))).toBe(true);
  });

  it.each(['1', 'true', 'invalid', undefined])('does not treat show=%s as hidden', (show) => {
    const attribute = show === undefined ? '' : ` show="${show}"`;
    expect(slideIsHidden(root(`<p:sld xmlns:p="${PRESENTATION_NS}"${attribute}/>`))).toBe(false);
  });

  it('ignores elements outside the presentation slide namespace', () => {
    expect(slideIsHidden(root('<x:sld xmlns:x="urn:attacker" show="0"/>'))).toBe(false);
  });
});

it('keeps the fuzz entry point bounded for arbitrary bytes', () => {
  expect(() => fuzzPptxNotes(new Uint8Array([0, 1, 2, 3, 0xff]))).not.toThrow();
  expect(() => fuzzPptxNotes(new TextEncoder().encode(notesXml(noteShape('body', '<a:p/>'))))).not.toThrow();
});
