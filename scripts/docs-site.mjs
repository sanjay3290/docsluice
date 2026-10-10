// Build the documentation site (ADR 0013): every Markdown page under docs/ as HTML in site/, the
// limits table from DEFAULT_LIMITS, recipe code from examples/, and the API reference from TSDoc
// through TypeDoc. Usage: node scripts/docs-site.mjs [--out site] [--no-api]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = join(root, 'docs');
const REPOSITORY = 'https://github.com/sanjay3290/docsluice/blob/main/';

/** The sidebar: [title, site path] in reading order. */
const NAV = [
  ['Home', 'index.html'],
  ['Quick start', 'quickstart.html'],
  ['Security model', 'security.html'],
  ['Limits', 'limits.html'],
  ['Recipes', 'recipes/index.html'],
  ['Formats', 'formats/support-matrix.html'],
  ['Rendering', 'rendering.html'],
  ['Format plugins', 'plugins.html'],
  ['Node.js', 'node.html'],
  ['Worker isolation', 'worker.html'],
  ['Command line', 'cli.html'],
  ['API reference', 'api/index.html'],
  ['Architecture', 'architecture.html'],
  ['Decisions', 'adr/README.html'],
];

const STYLE = `body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#1f2328;background:#fff}
.layout{display:flex;min-height:100vh}nav{flex:0 0 14rem;padding:1.5rem 1rem;background:#f6f8fa;border-right:1px solid #d0d7de}
nav a{display:block;padding:.2rem 0;color:#1f2328;text-decoration:none}nav a:hover{text-decoration:underline}
nav .name{font-weight:700;margin-bottom:1rem}main{flex:1;max-width:52rem;padding:1.5rem 2rem;overflow-x:auto}
pre{background:#f6f8fa;padding:1rem;overflow-x:auto;border-radius:6px}code{font-size:.9em}
table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid #d0d7de;padding:.3rem .6rem;vertical-align:top}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}nav{background:#161b22;border-color:#30363d}
nav a{color:#e6edf3}pre{background:#161b22}th,td{border-color:#30363d}a{color:#58a6ff}}
@media (max-width:48rem){.layout{display:block}nav{border-right:0;border-bottom:1px solid #d0d7de}}`;

/** Markdown files under `dir`, as POSIX paths relative to docs/, sorted. */
async function markdownFiles(dir = docs) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith('.md')) found.push(relative(docs, path).split(sep).join('/'));
  }
  return found.sort();
}

/** GitHub-style heading ids: lower case, punctuation removed, spaces to hyphens. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replaceAll(' ', '-');
}

/** Each limit's TSDoc summary, read from the source so the table cannot drift from it. */
async function limitDescriptions() {
  const source = await readFile(join(root, 'packages/docsluice/src/core/limits.ts'), 'utf8');
  const descriptions = new Map();
  for (const match of source.matchAll(/\/\*\* ([^*]+?) \*\/\n {2}(\w+): number;/g))
    descriptions.set(match[2], match[1]);
  return descriptions;
}

const number = (value) => value.toLocaleString('en-US');

/** The limits table: name, default, and its description from the source. */
export async function limitsTable() {
  const { DEFAULT_LIMITS, ALWAYS_THROW_LIMITS } = await import(
    pathToFileURL(join(root, 'packages/docsluice/src/core/limits.ts')).href
  );
  const descriptions = await limitDescriptions();
  const rows = ['| Limit | Default | What it bounds |', '| --- | --- | --- |'];
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
    const description = descriptions.get(name);
    if (!description) throw new Error(`Limit ${name} has no TSDoc description in limits.ts.`);
    const always =
      ALWAYS_THROW_LIMITS.has(name) && !description.includes('Always throws') ? ' Always throws.' : '';
    rows.push(`| \`${name}\` | ${number(value)} | ${description}${always} |`);
  }
  return rows.join('\n');
}

/** Replace `<!-- include: path -->` with the file as a code block, and the limits placeholder. */
async function expand(markdown) {
  let text = markdown;
  for (const match of markdown.matchAll(/<!-- include: ([\w./-]+) -->/g)) {
    const code = await readFile(join(root, match[1]), 'utf8');
    const language = match[1].endsWith('.mjs') || match[1].endsWith('.js') ? 'js' : '';
    text = text.replace(match[0], `\`${match[1]}\`:\n\n\`\`\`${language}\n${code.trimEnd()}\n\`\`\``);
  }
  if (text.includes('<!-- limits-table -->'))
    text = text.replace('<!-- limits-table -->', await limitsTable());
  return text;
}

function renderer() {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  // Heading ids, so `page.md#section` links work as on GitHub.
  md.core.ruler.push('heading_ids', (state) => {
    const used = new Map();
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type !== 'heading_open') continue;
      const base = slug(state.tokens[index + 1].children.map((child) => child.content).join(''));
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      token.attrSet('id', count === 0 ? base : `${base}-${count}`);
    }
  });
  return md;
}

/**
 * Where a link from `page` (a path under docs/) points on the site: `.md` becomes `.html`, files
 * outside docs/ link to the repository, and the target is recorded for the link check.
 */
function rewriteLink(href, page, targets) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
  const [path, fragment] = href.split('#');
  // A directory link shows its README, as on GitHub.
  const file = path.endsWith('/') ? `${path}README.md` : path;
  const resolved = posix.normalize(posix.join(posix.dirname(page), file));
  if (resolved.startsWith('../')) return `${REPOSITORY}${resolved.slice(3)}${fragment ? `#${fragment}` : ''}`;
  const target = resolved.endsWith('.md') ? `${resolved.slice(0, -3)}.html` : resolved;
  targets.push({ page, target, fragment });
  return `${posix.relative(posix.dirname(page), target) || posix.basename(target)}${fragment ? `#${fragment}` : ''}`;
}

function layout(title, body, depth) {
  const up = '../'.repeat(depth);
  const nav = NAV.map(([name, path]) => `<a href="${up}${path}">${name}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · docsluice</title><link rel="stylesheet" href="${up}style.css"></head>
<body><div class="layout"><nav><div class="name"><a href="${up}index.html">docsluice</a></div>${nav}</nav>
<main>${body}</main></div></body></html>
`;
}

/** Build the site. Returns the pages and the internal links that did not resolve. */
export async function buildSite({ out = join(root, 'site'), api = true } = {}) {
  await rm(out, { recursive: true, force: true });
  const md = renderer();
  const pages = new Map();
  const targets = [];
  for (const page of await markdownFiles()) {
    const source = await expand(await readFile(join(docs, page), 'utf8'));
    const env = {};
    const tokens = md.parse(source, env);
    const ids = new Set();
    for (const token of tokens) {
      if (token.type === 'heading_open') ids.add(token.attrGet('id'));
      for (const child of token.children ?? []) {
        if (child.type === 'link_open')
          child.attrSet('href', rewriteLink(child.attrGet('href'), page, targets));
      }
    }
    const title = tokens.find((token) => token.type === 'inline')?.content ?? page;
    const html = md.renderer.render(tokens, md.options, env);
    const path = `${page.slice(0, -3)}.html`;
    pages.set(path, { ids, html });
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), layout(title, html, path.split('/').length - 1));
  }
  await writeFile(join(out, 'style.css'), `${STYLE}\n`);
  if (api) {
    const typedoc = join(root, 'node_modules/typedoc/bin/typedoc');
    const result = spawnSync(
      process.execPath,
      [
        typedoc,
        '--entryPoints',
        'packages/docsluice/src/index.ts',
        '--entryPoints',
        'packages/docsluice/src/node/index.ts',
        '--entryPoints',
        'packages/docsluice/src/node/worker/index.ts',
        '--tsconfig',
        'packages/docsluice/tsconfig.json',
        '--out',
        relative(root, join(out, 'api')),
        '--name',
        'docsluice',
        '--readme',
        'none',
        '--disableSources',
        '--excludeInternal',
        '--logLevel',
        'Error',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`TypeDoc failed:\n${result.stdout}${result.stderr}`);
  }
  const broken = targets.filter(({ target, fragment }) => {
    // TypeDoc writes the API pages; without it they are not checked.
    if (target.startsWith('api/')) return api && !existsSync(join(out, target));
    const page = pages.get(target);
    return !page || (fragment !== undefined && fragment.length > 0 && !page.ids.has(fragment));
  });
  return { pages: [...pages.keys()], broken };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const { pages, broken } = await buildSite({
    ...(outIndex >= 0 ? { out: join(process.cwd(), args[outIndex + 1]) } : {}),
    api: !args.includes('--no-api'),
  });
  if (broken.length > 0) {
    console.error(
      broken
        .map(({ page, target, fragment }) => `${page}: ${target}${fragment ? `#${fragment}` : ''}`)
        .join('\n'),
    );
    console.error(`${broken.length} broken link(s).`);
    process.exit(1);
  }
  console.log(`Built ${pages.length} pages${args.includes('--no-api') ? '' : ' and the API reference'}.`);
}
