import type { ReadContext } from '../core/reader.js';
import type { HtmlNode } from './index.js';

/**
 * Main-content selection for HTML pages (HTM-2), loaded only when `mainContent: true`. Deterministic
 * and linear: one pre-order pass finds landmarks, one post-order pass scores containers, both with
 * explicit stacks (SEC-8).
 *
 * 1. Page chrome is never a candidate: `nav`, `aside`, `dialog`, page-level `header`/`footer`,
 *    navigation ARIA roles, hidden elements, and elements whose class or id has a chrome word (`nav`, `menu`,
 *    `sidebar`, `footer`, `comments`, `ad`, `cookie`, …).
 * 2. The first `main` (or `role="main"`) wins.
 * 3. Else the `article` with the most text wins (ties: the first).
 * 4. Else containers are scored: each paragraph-like block with at least 25 characters and at most
 *    half its text in links adds its unlinked text to its parent and half of it to its grandparent.
 *    A content word in the class or id (`content`, `article`, `post`, …) adds a quarter. The highest
 *    score wins (ties: the first in document order). With no such block, the whole page is kept.
 *
 * Inside the chosen element, chrome is still dropped (a `nav` or comment list inside `main`), but
 * an article's own `header` and `footer` stay: they hold its title and byline.
 */

const CHROME_TAGS = new Set(['nav', 'aside', 'dialog', 'menu']);
const PAGE_CHROME_TAGS = new Set(['header', 'footer']);
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog']);
const CHROME_WORDS = new Set([
  'nav',
  'navbar',
  'navigation',
  'menu',
  'breadcrumb',
  'breadcrumbs',
  'sidebar',
  'footer',
  'masthead',
  'comment',
  'comments',
  'ad',
  'ads',
  'advert',
  'advertisement',
  'sponsor',
  'sponsored',
  'promo',
  'related',
  'share',
  'social',
  'cookie',
  'cookies',
  'consent',
  'newsletter',
  'subscribe',
  'popup',
  'modal',
]);
const CONTENT_WORDS = new Set(['content', 'article', 'main', 'post', 'entry', 'story', 'prose', 'body']);
const PARAGRAPHS = new Set(['p', 'pre', 'blockquote', 'li', 'td', 'dd']);
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'td', 'body', '']);
/** A paragraph shorter than this says little about where the content is. */
const MIN_PARAGRAPH = 25;

/** Lowercase words of an element's class and id (`post-body main` → post, body, main). */
function hintWords(node: HtmlNode, ctx: ReadContext): string[] {
  const words: string[] = [];
  const text = `${node.attrs.get('class') ?? ''} ${node.attrs.get('id') ?? ''}`.toLowerCase();
  let start = -1;
  for (let index = 0; index <= text.length; index++) {
    ctx.budget.tick();
    const code = index < text.length ? text.charCodeAt(index) : 32;
    const word = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (word && start < 0) start = index;
    else if (!word && start >= 0) {
      words.push(text.slice(start, index));
      start = -1;
    }
  }
  return words;
}

/** Page chrome: never a candidate, and dropped inside the chosen content. */
function isChrome(node: HtmlNode, ctx: ReadContext, pageLevel: boolean): boolean {
  if (CHROME_TAGS.has(node.tag) || (pageLevel && PAGE_CHROME_TAGS.has(node.tag))) return true;
  const role = node.attrs.get('role')?.toLowerCase();
  if (role !== undefined && CHROME_ROLES.has(role)) return true;
  if (node.attrs.has('hidden') || node.attrs.get('aria-hidden') === 'true') return true;
  return hintWords(node, ctx).some((word) => CHROME_WORDS.has(word));
}

interface Counts {
  text: number;
  linked: number;
}

/** The page's main content: the element to emit and the chrome inside it to leave out. */
export function mainContent(root: HtmlNode, ctx: ReadContext): { node: HtmlNode; skip: Set<HtmlNode> } {
  const node = selectMainContent(root, ctx);
  const skip = new Set<HtmlNode>();
  const landmark =
    node.tag === 'article' || node.tag === 'main' || node.attrs.get('role')?.toLowerCase() === 'main';
  const stack: Array<{ node: HtmlNode; inArticle: boolean }> = [{ node, inArticle: landmark }];
  while (stack.length > 0) {
    ctx.budget.tick();
    const entry = stack.pop()!;
    if (entry.node !== node && isChrome(entry.node, ctx, !entry.inArticle)) {
      skip.add(entry.node);
      continue;
    }
    for (const child of entry.node.children) {
      ctx.budget.tick();
      if (typeof child !== 'string')
        stack.push({ node: child, inArticle: entry.inArticle || entry.node.tag === 'article' });
    }
  }
  return { node, skip };
}

/** The element whose blocks are the page's main content (see the module comment). */
function selectMainContent(root: HtmlNode, ctx: ReadContext): HtmlNode {
  // Pass 1, pre-order: landmarks, articles, and the order for pass 2.
  const order: Array<{ node: HtmlNode; parent?: HtmlNode; grandparent?: HtmlNode }> = [];
  const articles: HtmlNode[] = [];
  const stack: Array<{ node: HtmlNode; parent?: HtmlNode; grandparent?: HtmlNode; inArticle: boolean }> = [
    { node: root, inArticle: false },
  ];
  while (stack.length > 0) {
    ctx.budget.tick();
    const entry = stack.pop()!;
    const { node } = entry;
    if (node !== root && isChrome(node, ctx, !entry.inArticle)) continue;
    if (node.tag === 'main' || node.attrs.get('role')?.toLowerCase() === 'main') return node;
    if (node.tag === 'article' && !entry.inArticle) articles.push(node);
    order.push(entry);
    for (let index = node.children.length - 1; index >= 0; index--) {
      ctx.budget.tick();
      const child = node.children[index]!;
      if (typeof child !== 'string')
        stack.push({
          node: child,
          parent: node,
          ...(entry.parent ? { grandparent: entry.parent } : {}),
          inArticle: entry.inArticle || node.tag === 'article',
        });
    }
  }

  // Pass 2, post-order (reverse pre-order): text and linked text of every kept element.
  const counts = new Map<HtmlNode, Counts>();
  const scores = new Map<HtmlNode, number>();
  for (let index = order.length - 1; index >= 0; index--) {
    ctx.budget.tick();
    const { node, parent, grandparent } = order[index]!;
    const total: Counts = { text: 0, linked: 0 };
    for (const child of node.children) {
      ctx.budget.tick();
      if (typeof child === 'string') total.text += child.trim().length;
      else {
        const count = counts.get(child);
        if (count) {
          total.text += count.text;
          total.linked += count.linked;
        }
      }
    }
    if (node.tag === 'a') total.linked = total.text;
    counts.set(node, total);
    if (PARAGRAPHS.has(node.tag) && total.text >= MIN_PARAGRAPH && total.linked * 2 <= total.text) {
      const value = total.text - total.linked;
      if (parent) scores.set(parent, (scores.get(parent) ?? 0) + value);
      if (grandparent) scores.set(grandparent, (scores.get(grandparent) ?? 0) + value / 2);
    }
  }

  if (articles.length > 0) {
    let best = articles[0]!;
    for (const article of articles) {
      ctx.budget.tick();
      if ((counts.get(article)?.text ?? 0) > (counts.get(best)?.text ?? 0)) best = article;
    }
    return best;
  }

  let best = root;
  let bestScore = 0;
  for (const { node } of order) {
    ctx.budget.tick();
    const base = scores.get(node);
    if (base === undefined || !CONTAINERS.has(node.tag)) continue;
    const bonus = hintWords(node, ctx).some((word) => CONTENT_WORDS.has(word)) ? base / 4 : 0;
    if (base + bonus > bestScore) {
      best = node;
      bestScore = base + bonus;
    }
  }
  return best;
}
