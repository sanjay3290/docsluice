import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreReadingOrder,
  scoreTableCells,
  scoreWordRecall,
  scoreDocument,
  tokenizeWords,
} from '../quality/score.mjs';

test('word tokenization applies NFKC and locale-independent lowercasing', () => {
  assert.deepEqual(tokenizeWords('Café ＣＡＦÉ cafe\u0301'), ['café', 'café', 'café']);
});

test('word recall counts duplicate truth tokens as a multiset and ignores extra output copies', () => {
  assert.deepEqual(scoreWordRecall('echo echo echo', 'echo echo echo echo'), {
    correct: 3,
    total: 3,
    score: 1,
  });
  assert.deepEqual(scoreWordRecall('echo echo echo', 'echo echo'), {
    correct: 2,
    total: 3,
    score: 2 / 3,
  });
});

test('empty truth returns an unavailable word score instead of a perfect score', () => {
  assert.deepEqual(scoreWordRecall('', 'unexpected output'), {
    correct: 0,
    total: 0,
    score: null,
  });
});

test('table-cell accuracy uses coordinate matches and penalizes missing, changed, and extra cells', () => {
  const truth = [
    {
      index: 0,
      cells: [
        { row: 0, column: 0, text: 'Item' },
        { row: 0, column: 1, text: 'Count' },
      ],
    },
  ];
  const output = [
    {
      index: 0,
      cells: [
        { row: 0, column: 0, text: 'Item' },
        { row: 0, column: 1, text: 'Total' },
        { row: 1, column: 0, text: 'extra' },
      ],
    },
  ];

  assert.deepEqual(scoreTableCells(truth, output), {
    correct: 1,
    total: 3,
    score: 1 / 3,
  });
  assert.deepEqual(scoreTableCells(truth, []), {
    correct: 0,
    total: 2,
    score: 0,
  });
});

test('empty table truth returns n/a even when output contains cells', () => {
  assert.deepEqual(scoreTableCells([], [{ index: 0, cells: [{ row: 0, column: 0, text: 'extra' }] }]), {
    correct: 0,
    total: 0,
    score: null,
  });
});

test('reading-order pair accuracy counts ordered pairs and penalizes omissions', () => {
  assert.deepEqual(scoreReadingOrder(['a', 'b', 'c'], ['a', 'c', 'b']), {
    correct: 2,
    total: 3,
    score: 2 / 3,
  });
  assert.deepEqual(scoreReadingOrder(['a', 'b', 'c'], ['a', 'c']), {
    correct: 1,
    total: 3,
    score: 1 / 3,
  });
});

test('reading-order score uses occurrence matching for duplicate tokens', () => {
  assert.deepEqual(scoreReadingOrder(['echo', 'x', 'echo'], ['echo', 'echo', 'x']), {
    correct: 2,
    total: 3,
    score: 2 / 3,
  });
});

test('a one-token truth has no pairwise reading-order score', () => {
  assert.deepEqual(scoreReadingOrder(['only'], ['only']), {
    correct: 0,
    total: 0,
    score: null,
  });
});

test('reading-order scoring handles a large reversed token sequence iteratively', () => {
  const truth = Array.from({ length: 10_000 }, (_, index) => `token${index}`);
  const output = [...truth].reverse();

  assert.deepEqual(scoreReadingOrder(truth, output), { correct: 0, total: 49_995_000, score: 0 });
});

test('document scoring walks nested sections iteratively and includes table cells', () => {
  const truth = {
    textBlocks: ['First', 'Last'],
    tables: [{ index: 0, cells: [{ row: 0, column: 0, text: 'Cell' }] }],
    readingOrder: [
      { kind: 'text', index: 0 },
      { kind: 'cell', table: 0, row: 0, column: 0 },
      { kind: 'text', index: 1 },
    ],
  };
  const document = {
    blocks: [
      {
        kind: 'section',
        blocks: [
          { kind: 'paragraph', text: 'First' },
          { kind: 'table', rows: [[{ text: 'Cell' }]] },
          { kind: 'paragraph', text: 'Last' },
        ],
      },
    ],
  };

  assert.deepEqual(scoreDocument(truth, document), {
    wordRecall: { correct: 3, total: 3, score: 1 },
    tableCellAccuracy: { correct: 1, total: 1, score: 1 },
    readingOrderAccuracy: { correct: 3, total: 3, score: 1 },
  });
});

test('an entirely empty truth is n/a for every metric, never three perfect scores', () => {
  assert.deepEqual(scoreDocument({ textBlocks: [], tables: [], readingOrder: [] }, { blocks: [] }), {
    wordRecall: { correct: 0, total: 0, score: null },
    tableCellAccuracy: { correct: 0, total: 0, score: null },
    readingOrderAccuracy: { correct: 0, total: 0, score: null },
  });
});
