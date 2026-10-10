import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EncryptedError } from '../../src/core/errors.js';
import { extract } from '../../src/core/extract.js';
import { detect } from '../../src/detect/detect.js';
import { toMarkdown } from '../../src/render/markdown.js';

// LibreOffice-made Agile-encrypted packages (AES-256, SHA-512, 100,000 spins): each key derivation
// takes about two seconds through Web Crypto, so these tests have a long timeout.
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`fixtures/libreoffice/${name}`, import.meta.url)));
const TIMEOUT = { timeout: 60_000 };

describe('password-protected OOXML made by LibreOffice (#90)', () => {
  it.each([
    ['encrypted.docx', 'docx', '# Field Notes: Tidal Gardens'],
    ['encrypted.xlsx', 'xlsx', '## Sheet: Observations'],
    ['encrypted.pptx', 'pptx', '## Slide 1'],
  ])('opens %s with the password', TIMEOUT, async (name, format, start) => {
    const doc = await extract(fixture(name), { password: 'docsluice' });
    expect(doc.format).toBe(format);
    expect(doc.features.isEncrypted).toBe(true);
    expect(toMarkdown(doc).startsWith(start)).toBe(true);
  });

  it('asks for a password, rejects a wrong one, and detects the inner format', TIMEOUT, async () => {
    const bytes = fixture('encrypted.docx');
    await expect(extract(bytes)).rejects.toMatchObject({ code: 'ENCRYPTED', reason: 'password-required' });
    await expect(detect(bytes)).rejects.toBeInstanceOf(EncryptedError);
    await expect(extract(bytes, { password: 'wrong' })).rejects.toMatchObject({
      code: 'ENCRYPTED',
      reason: 'wrong-password',
    });
    expect((await detect(bytes, { password: 'docsluice' })).format).toBe('docx');
  });

  it('fails with LIMIT_EXCEEDED when the decrypted package does not fit the allowance', TIMEOUT, async () => {
    await expect(
      extract(fixture('encrypted.docx'), {
        password: 'docsluice',
        limits: { totalUncompressedBytes: 1_000 },
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});
