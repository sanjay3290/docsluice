#!/usr/bin/env node
// Work-queue helper for agents. Uses the `gh` CLI (set GH_TOKEN for the sanjay3290 account).
//
//   node scripts/board.mjs next            # print the next issue to work, or why there is none
//   node scripts/board.mjs ready           # list every ready issue in work order
//   node scripts/board.mjs sync            # recompute Ready/Backlog on the board for open issues
//   node scripts/board.mjs status 12 "In review"
//
// `next` and `ready` fall back to the REST API when GraphQL is refused; `sync` and `status` need GraphQL.
// "Ready" means: open, not an epic, no needs-human/needs-decision label, and every blocked-by issue closed.
// Work order: milestone (M0 first), then priority (P0 first), then issue number.
import { execFileSync } from 'node:child_process';

const OWNER = 'sanjay3290';
const REPO = 'docsluice';
const PROJECT_NUMBER = 3;
const SKIP_LABELS = new Set(['type:epic', 'needs-human', 'needs-decision']);

// stderr is captured, so a refused GraphQL call stays quiet; a failure still reports it in the thrown error.
const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const graphql = (query, vars = {}) =>
  JSON.parse(
    gh([
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      ...Object.entries(vars).flatMap(([k, v]) => ['-F', `${k}=${v}`]),
    ]),
  );

/** Open issues from GraphQL, or from the REST API where GraphQL is refused (some sandboxes block it). */
function openIssues() {
  try {
    return openIssuesGraphql();
  } catch {
    return openIssuesRest();
  }
}

/** The REST equivalent of the GraphQL query, in the same shape. */
function openIssuesRest() {
  const rest = (path) => JSON.parse(gh(['api', path]));
  const all = [];
  for (let page = 1; ; page++) {
    const batch = rest(`repos/${OWNER}/${REPO}/issues?state=open&per_page=100&page=${page}`);
    for (const issue of batch) {
      if (issue.pull_request) continue;
      const blockedBy =
        issue.issue_dependencies_summary?.blocked_by > 0
          ? rest(`repos/${OWNER}/${REPO}/issues/${issue.number}/dependencies/blocked_by?per_page=100`)
          : [];
      all.push({
        number: issue.number,
        title: issue.title,
        labels: { nodes: issue.labels.map((l) => ({ name: l.name })) },
        milestone: issue.milestone ? { title: issue.milestone.title } : null,
        blockedBy: { nodes: blockedBy.map((b) => ({ number: b.number, state: b.state.toUpperCase() })) },
      });
    }
    if (batch.length < 100) return all;
  }
}

function openIssuesGraphql() {
  const all = [];
  let cursor = null;
  for (;;) {
    const res = graphql(
      `query($cursor: String) { repository(owner: "${OWNER}", name: "${REPO}") {
        issues(first: 100, after: $cursor, states: OPEN) {
          pageInfo { hasNextPage endCursor }
          nodes { number title labels(first: 30) { nodes { name } } milestone { title }
                  blockedBy(first: 50) { nodes { number state } } } } } }`,
      cursor ? { cursor } : {},
    );
    const page = res.data.repository.issues;
    all.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return all;
    cursor = page.pageInfo.endCursor;
  }
}

const labelsOf = (i) => i.labels.nodes.map((l) => l.name);
const priority = (i) =>
  ({ 'priority:P0': 0, 'priority:P1': 1, 'priority:P2': 2 })[
    labelsOf(i).find((l) => l.startsWith('priority:'))
  ] ?? 3;
const milestone = (i) => {
  const m = /^M(\d)/.exec(i.milestone?.title ?? '');
  return m ? Number(m[1]) : 9;
};
const openBlockers = (i) => i.blockedBy.nodes.filter((b) => b.state === 'OPEN').map((b) => b.number);
const isReady = (i) => !labelsOf(i).some((l) => SKIP_LABELS.has(l)) && openBlockers(i).length === 0;
const byWorkOrder = (a, b) => milestone(a) - milestone(b) || priority(a) - priority(b) || a.number - b.number;

function setStatus(numbers, statusName, onlyFrom) {
  const p = graphql(`{ user(login: "${OWNER}") { projectV2(number: ${PROJECT_NUMBER}) { id
      field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first: 100) { nodes { id content { ... on Issue { number } }
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`)
    .data.user.projectV2;
  // The project holds under 100 items today; page if that changes.
  const option = p.field.options.find((o) => o.name === statusName);
  if (!option) throw new Error(`No Status option "${statusName}"`);
  const itemByNumber = new Map(
    p.items.nodes
      .filter((n) => n.content && (!onlyFrom || onlyFrom.includes(n.status?.name ?? 'Backlog')))
      .map((n) => [n.content.number, n.id]),
  );
  for (const n of numbers) {
    const item = itemByNumber.get(n);
    if (!item) continue;
    gh([
      'project',
      'item-edit',
      '--project-id',
      p.id,
      '--id',
      item,
      '--field-id',
      p.field.id,
      '--single-select-option-id',
      option.id,
    ]);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'next' || cmd === 'ready') {
  const issues = openIssues();
  const ready = issues.filter(isReady).sort(byWorkOrder);
  if (cmd === 'ready') {
    for (const i of ready) console.log(`#${i.number}\t${i.milestone?.title ?? '-'}\t${i.title}`);
  } else if (ready[0]) {
    console.log(ready[0].number);
  } else {
    const human = issues.filter((i) =>
      labelsOf(i).some((l) => l === 'needs-human' || l === 'needs-decision'),
    );
    const work = issues.filter((i) => !labelsOf(i).includes('type:epic'));
    console.error(
      work.length === 0
        ? 'NONE: every issue is closed.'
        : `NONE: ${work.length} open issues, all blocked. Waiting on owner: ${human.map((i) => `#${i.number}`).join(', ') || 'none'}.`,
    );
    process.exitCode = 3;
  }
} else if (cmd === 'sync') {
  const issues = openIssues().filter((i) => !labelsOf(i).includes('type:epic'));
  setStatus(
    issues
      .filter((i) => labelsOf(i).some((l) => l === 'needs-human' || l === 'needs-decision'))
      .map((i) => i.number),
    'Needs human',
    ['Backlog', 'Ready'],
  );
  setStatus(
    issues.filter(isReady).map((i) => i.number),
    'Ready',
    ['Backlog'],
  );
  console.log('board synced');
} else if (cmd === 'status' && rest.length === 2) {
  setStatus([Number(rest[0])], rest[1]);
} else {
  console.error('usage: board.mjs next | ready | sync | status <issue> <Status>');
  process.exitCode = 2;
}
