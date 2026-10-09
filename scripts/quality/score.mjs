const WORD = /[\p{L}\p{N}\p{M}]+/gu;

export function tokenizeWords(value) {
  if (typeof value !== 'string') throw new TypeError('Text to tokenize must be a string.');
  const normalized = value.normalize('NFKC').toLowerCase();
  return normalized.match(WORD) ?? [];
}

function metric(correct, total) {
  return { correct, total, score: total === 0 ? null : correct / total };
}

export function scoreWordRecall(truthText, outputText) {
  const truth = tokenizeWords(truthText);
  if (truth.length === 0) return metric(0, 0);

  const remaining = new Map();
  for (const token of truth) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let correct = 0;
  for (const token of tokenizeWords(outputText)) {
    const count = remaining.get(token) ?? 0;
    if (count === 0) continue;
    correct++;
    remaining.set(token, count - 1);
  }
  return metric(correct, truth.length);
}

function cellMap(tables) {
  const cells = new Map();
  for (const table of tables) {
    for (const cell of table.cells) {
      cells.set(
        `${table.index}:${cell.row}:${cell.column}`,
        cell.text.normalize('NFKC').replace(/\r\n?/g, '\n'),
      );
    }
  }
  return cells;
}

export function scoreTableCells(truthTables, outputTables) {
  const expected = cellMap(truthTables);
  if (expected.size === 0) return metric(0, 0);
  const actual = cellMap(outputTables);
  let correct = 0;
  for (const [coordinate, expectedText] of expected) {
    if (actual.get(coordinate) === expectedText) correct++;
  }
  return metric(correct, new Set([...expected.keys(), ...actual.keys()]).size);
}

function chooseTwo(value) {
  return (value * (value - 1)) / 2;
}

function prefixSum(tree, index) {
  let sum = 0;
  for (let cursor = index; cursor > 0; cursor -= cursor & -cursor) sum += tree[cursor];
  return sum;
}

function addFenwick(tree, index) {
  for (let cursor = index; cursor < tree.length; cursor += cursor & -cursor) tree[cursor]++;
}

/** Score correctly ordered token pairs with an O(n log n) inversion count. */
export function scoreReadingOrder(truthTokens, outputTokens) {
  if (!Array.isArray(truthTokens) || !Array.isArray(outputTokens)) {
    throw new TypeError('Reading-order inputs must be token arrays.');
  }
  if (truthTokens.length < 2) return metric(0, 0);

  const positions = new Map();
  for (let index = 0; index < outputTokens.length; index++) {
    const token = outputTokens[index];
    let list = positions.get(token);
    if (!list) positions.set(token, (list = []));
    list.push(index);
  }
  const cursors = new Map();
  const matchedPositions = [];
  for (const token of truthTokens) {
    const list = positions.get(token);
    const cursor = cursors.get(token) ?? 0;
    if (list && cursor < list.length) {
      matchedPositions.push(list[cursor]);
      cursors.set(token, cursor + 1);
    }
  }

  const tree = new Uint32Array(outputTokens.length + 1);
  let inversions = 0;
  let seen = 0;
  for (const position of matchedPositions) {
    const rank = position + 1;
    inversions += seen - prefixSum(tree, rank);
    addFenwick(tree, rank);
    seen++;
  }
  const orderedPairs = chooseTwo(matchedPositions.length) - inversions;
  return metric(orderedPairs, chooseTwo(truthTokens.length));
}

function listText(items, addText) {
  const stack = [];
  for (let index = items.length - 1; index >= 0; index--) stack.push(items[index]);
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item.text === 'string') addText(item.text);
    if (Array.isArray(item.items)) {
      for (let index = item.items.length - 1; index >= 0; index--) stack.push(item.items[index]);
    }
  }
}

function collectDocumentUnits(document) {
  const textBlocks = [];
  const tables = [];
  const order = [];
  const frames = [{ blocks: document.blocks, index: 0 }];
  const addText = (text) => {
    if (typeof text !== 'string') return;
    const index = textBlocks.length;
    textBlocks.push(text);
    order.push({ kind: 'text', index, text });
  };

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.index >= frame.blocks.length) {
      frames.pop();
      continue;
    }
    const block = frame.blocks[frame.index++];
    if (!block || typeof block !== 'object') continue;
    if (block.kind === 'section') {
      if (typeof block.title === 'string') addText(block.title);
      if (Array.isArray(block.blocks)) frames.push({ blocks: block.blocks, index: 0 });
    } else if (block.kind === 'table' && Array.isArray(block.rows)) {
      const tableIndex = tables.length;
      const cells = [];
      for (let row = 0; row < block.rows.length; row++) {
        const cellsInRow = block.rows[row];
        if (!Array.isArray(cellsInRow)) continue;
        for (let column = 0; column < cellsInRow.length; column++) {
          const cell = cellsInRow[column];
          if (!cell || typeof cell.text !== 'string') continue;
          const value = { row, column, text: cell.text };
          cells.push(value);
          order.push({ kind: 'cell', table: tableIndex, ...value });
        }
      }
      tables.push({ index: tableIndex, cells });
    } else if (block.kind === 'list' && Array.isArray(block.items)) {
      listText(block.items, addText);
    } else if (
      block.kind === 'heading' ||
      block.kind === 'paragraph' ||
      block.kind === 'code' ||
      block.kind === 'note' ||
      block.kind === 'header' ||
      block.kind === 'footer'
    ) {
      addText(block.text);
    } else if (block.kind === 'image' && typeof block.alt === 'string') {
      addText(block.alt);
    }
  }
  return { textBlocks, tables, order };
}

function truthUnits(truth) {
  const cells = new Map();
  for (const table of truth.tables) {
    for (const cell of table.cells) {
      cells.set(`${table.index}:${cell.row}:${cell.column}`, cell.text);
    }
  }
  const orderText = [];
  for (const reference of truth.readingOrder) {
    if (reference.kind === 'text') {
      orderText.push(truth.textBlocks[reference.index]);
      continue;
    }
    orderText.push(cells.get(`${reference.table}:${reference.row}:${reference.column}`) ?? '');
  }
  const allText = [...truth.textBlocks];
  for (const table of truth.tables) for (const cell of table.cells) allText.push(cell.text);
  return { allText, orderText };
}

export function scoreDocument(truth, document) {
  const expected = truthUnits(truth);
  const actual = collectDocumentUnits(document);
  return {
    wordRecall: scoreWordRecall(
      expected.allText.join('\n'),
      actual.order.map((unit) => unit.text).join('\n'),
    ),
    tableCellAccuracy: scoreTableCells(truth.tables, actual.tables),
    readingOrderAccuracy: scoreReadingOrder(
      tokenizeWords(expected.orderText.join('\n')),
      tokenizeWords(actual.order.map((unit) => unit.text).join('\n')),
    ),
  };
}
