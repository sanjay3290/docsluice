import type { ReadContext } from '../../core/reader.js';

/** Source code file extensions and the `language` their code block gets. */
const CODE_LANGUAGES = new Map<string, string>([
  ['c', 'c'],
  ['h', 'c'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['cs', 'csharp'],
  ['css', 'css'],
  ['go', 'go'],
  ['java', 'java'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'jsx'],
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'tsx'],
  ['kt', 'kotlin'],
  ['lua', 'lua'],
  ['php', 'php'],
  ['pl', 'perl'],
  ['ps1', 'powershell'],
  ['py', 'python'],
  ['r', 'r'],
  ['rb', 'ruby'],
  ['rs', 'rust'],
  ['scala', 'scala'],
  ['scss', 'scss'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  ['sql', 'sql'],
  ['swift', 'swift'],
  ['toml', 'toml'],
  ['ini', 'ini'],
]);

/**
 * Read a source file (by extension) as one `code` block with its language. Returns false for other
 * files, so the text reader reads them as paragraphs. Loaded lazily by the text reader, so the
 * language table stays out of the core bundle.
 */
export function readSourceCode(ctx: ReadContext, text: string, extension: string): boolean {
  const language = CODE_LANGUAGES.get(extension);
  if (language === undefined) return false;
  if (text.trim().length === 0) return true;
  const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
  if (text.length > remaining) ctx.budget.checkOutputChars(text.length);
  ctx.out.code(
    text.length > remaining ? text.slice(0, remaining) : text,
    ctx.path ? { path: ctx.path } : {},
    language,
  );
  return true;
}
