import { describe, expect, it } from 'vitest';
import { WarningSink } from '../../src/core/warnings.js';
import { StrictModeError, DocsluiceError } from '../../src/index.js';

describe('WarningSink', () => {
  it('stores warnings and locations in emission order', () => {
    const sink = new WarningSink();
    const first = { code: 'ENCODING_GUESSED', message: 'Fallback encoding.', loc: { path: 'part' } };
    const second = { code: 'UNREADABLE_PART', message: 'Skipped part.' };
    sink.add(first);
    sink.add(second);
    expect(sink.warnings).toEqual([first, second]);
  });

  it.each(['TRUNCATED', 'ENCODING_GUESSED', 'PLUGIN_WARNING'])('strict true throws for %s', (code) => {
    const sink = new WarningSink({ strict: true });
    expect(() => sink.add({ code, message: 'No content.' })).toThrow(StrictModeError);
    expect(sink.warnings).toEqual([]);
  });

  it('strict code selection permits other warnings', () => {
    const sink = new WarningSink({ strict: ['TRUNCATED'] });
    sink.add({ code: 'ENCODING_GUESSED', message: 'Fallback encoding.' });
    expect(() => sink.add({ code: 'TRUNCATED', message: 'Skipped bytes.' })).toThrow(StrictModeError);
    expect(sink.warnings).toHaveLength(1);
    const permissive = new WarningSink({ strict: false });
    permissive.add({ code: 'TRUNCATED', message: 'Skipped bytes.' });
    expect(permissive.warnings).toHaveLength(1);
  });

  it('StrictModeError carries only the code and stable structural message', () => {
    const error = new StrictModeError('UNREADABLE_PART');
    expect(error).toBeInstanceOf(DocsluiceError);
    expect(error.name).toBe('StrictModeError');
    expect(error.code).toBe('STRICT_WARNING');
    expect(error.warningCode).toBe('UNREADABLE_PART');
    expect(error.message).toContain('UNREADABLE_PART');
  });
});
