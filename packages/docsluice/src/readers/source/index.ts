import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeReaderText, emitCode } from '../text-family.js';

/** Treat a caller-selected source file as one code block; source is never evaluated. */
export const reader: Reader = {
  id: 'source',
  mimeTypes: ['text/plain', 'text/x-source-code'],
  // The common reader contract is async so readers can extract nested documents.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read(ctx: ReadContext): Promise<void> {
    const text = decodeReaderText(ctx);
    if (text === undefined) return;
    const language = languageFromFilename(ctx.filename);
    emitCode(ctx, text, language);
  },
};

function languageFromFilename(filename?: string): string | undefined {
  if (filename === undefined) return undefined;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  switch (filename.slice(dot + 1).toLowerCase()) {
    case 'c':
      return 'c';
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hpp':
      return 'cpp';
    case 'cs':
      return 'csharp';
    case 'css':
      return 'css';
    case 'go':
      return 'go';
    case 'html':
    case 'htm':
      return 'html';
    case 'java':
      return 'java';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'php':
      return 'php';
    case 'py':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'rs':
      return 'rust';
    case 'sh':
    case 'bash':
      return 'bash';
    case 'sql':
      return 'sql';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return undefined;
  }
}

export default reader;
