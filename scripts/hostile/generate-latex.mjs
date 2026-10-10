import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile LaTeX sources: braces nested 100,000 deep, lists nested 5,000 deep, 200,000 unmatched
// dollar signs, and an environment that never ends.
const directory = new URL('../../hostile/latex/', import.meta.url);
await mkdir(directory, { recursive: true });
const head = '\\documentclass{article}\n\\begin{document}\n';
await writeFile(new URL('deep-braces.tex', directory), `${head}${'{'.repeat(100_000)}x${'}'.repeat(100_000)}\n\\end{document}\n`);
await writeFile(
  new URL('deep-lists.tex', directory),
  `${head}${'\\begin{itemize}\\item a\n'.repeat(5_000)}${'\\end{itemize}\n'.repeat(5_000)}\\end{document}\n`,
);
await writeFile(new URL('dollar-flood.tex', directory), `${head}${'$a'.repeat(200_000)}\n`);
await writeFile(new URL('unterminated-verbatim.tex', directory), `${head}\\begin{verbatim}\n${'raw line\n'.repeat(20_000)}`);
