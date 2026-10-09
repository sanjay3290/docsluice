import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TextDecoder } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import { DEFAULT_CORPUS_ROOT, parseRunnerArgs, runGoldenCorpus } from '../golden-run.mjs';

async function withCorpus(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'docsluice-golden-'));
  try {
    await mkdir(path.join(root, 'text'), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addInput(root, relativePath, text, { expectedJson, expectedMarkdown, license = true } = {}) {
  const sourcePath = path.join(root, relativePath);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, text);
  if (license) {
    await writeFile(
      `${sourcePath}.license`,
      'SPDX-License-Identifier: CC0-1.0\nSource: synthetic golden-run test fixture\nRequirements: IN-6, DET-1\n',
    );
  }
  if (expectedJson !== undefined) await writeFile(`${sourcePath}.expected.json`, expectedJson);
  if (expectedMarkdown !== undefined) await writeFile(`${sourcePath}.expected.md`, expectedMarkdown);
  return sourcePath;
}

function fakePipeline({ json = (doc) => JSON.stringify(doc), markdown = (doc) => doc.text } = {}) {
  const calls = { extract: [], json: [], markdown: [] };
  return {
    calls,
    extract: async (bytes, options) => {
      calls.extract.push({ bytes: [...bytes], options });
      return { stats: { durationMs: 18 }, text: new TextDecoder().decode(bytes) };
    },
    toJSON: (doc, options) => {
      calls.json.push({ doc: JSON.parse(JSON.stringify(doc)), options });
      const stableDoc = options?.stable ? { ...doc, stats: { ...doc.stats, durationMs: 0 } } : doc;
      return json(stableDoc, options);
    },
    toMarkdown: (doc, options) => {
      calls.markdown.push({ doc: JSON.parse(JSON.stringify(doc)), options });
      return markdown(doc, options);
    },
  };
}

test('recursively compares inputs and excludes license, expected, and metadata sidecars', async () => {
  await withCorpus(async (root) => {
    await addInput(root, 'text/one.txt', 'one', {
      expectedJson: '{"stats":{"durationMs":0},"text":"one"}\n',
      expectedMarkdown: 'one',
    });
    await addInput(root, 'text/nested/two.txt', 'two', {
      expectedJson: '{"stats":{"durationMs":0},"text":"two"}\n',
      expectedMarkdown: 'two',
    });
    await writeFile(path.join(root, 'text/one.txt.metadata.json'), '{"ignored":true}');
    const pipeline = fakePipeline();

    const result = await runGoldenCorpus({ corpusRoot: root, ...pipeline });

    assert.deepEqual(result, { files: 2, updated: 0 });
    assert.equal(pipeline.calls.extract.length, 2);
    assert.deepEqual(
      pipeline.calls.json.map(({ options }) => options),
      [{ stable: true }, { stable: true }],
    );
    assert.ok(pipeline.calls.json.every(({ doc }) => doc.stats.durationMs === 18));
    assert.equal(pipeline.calls.markdown.length, 2);
  });
});

test('defaults to the complete corpus and accepts a scoped corpus root option', () => {
  assert.equal(
    DEFAULT_CORPUS_ROOT,
    path.resolve(path.dirname(fileURLToPath(new URL('../golden-run.mjs', import.meta.url))), '../corpus'),
  );
  assert.deepEqual(parseRunnerArgs(['--corpus-root', './corpus/package-a']), {
    corpusRoot: path.resolve('./corpus/package-a'),
  });
});

test('excludes quality truth sidecars without ignoring ordinary Markdown inputs', async () => {
  await withCorpus(async (root) => {
    await addInput(root, 'text/document.md', 'document', {
      expectedJson: '{"stats":{"durationMs":0},"text":"document"}\n',
      expectedMarkdown: 'document',
    });
    await writeFile(path.join(root, 'text/document.md.truth.md'), 'independent quality truth');
    const pipeline = fakePipeline();
    assert.deepEqual(await runGoldenCorpus({ corpusRoot: root, ...pipeline }), {
      files: 1,
      updated: 0,
    });
    assert.deepEqual(
      pipeline.calls.extract.map(({ options }) => options.filename),
      ['document.md'],
    );
  });
});

test('ignores only explicitly named repository metadata files', async () => {
  await withCorpus(async (root) => {
    await addInput(root, 'text/valid.txt', 'valid', {
      expectedJson: '{"stats":{"durationMs":0},"text":"valid"}\n',
      expectedMarkdown: 'valid',
    });
    await writeFile(path.join(root, 'README.md'), 'corpus documentation');
    await writeFile(path.join(root, '.gitkeep'), '');
    await writeFile(path.join(root, '.gitattributes'), '* text=auto\n');
    await writeFile(path.join(root, 'legacy.native.txt'), 'matching native application text');
    const result = await runGoldenCorpus({ corpusRoot: root, ...fakePipeline() });
    assert.deepEqual(result, { files: 1, updated: 0 });
  });
});

test('does not ignore files based on a broad README-like name', async () => {
  await withCorpus(async (root) => {
    await writeFile(path.join(root, 'README.txt'), 'this is an input, not repository metadata');
    await assert.rejects(
      runGoldenCorpus({ corpusRoot: root, ...fakePipeline() }),
      /README\.txt.*missing.*\.license/i,
    );
  });
});

test('rejects special filesystem entries instead of silently skipping them', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Creating a FIFO requires a POSIX filesystem.');
    return;
  }
  await withCorpus(async (root) => {
    await addInput(root, 'text/valid.txt', 'valid');
    const fifoPath = path.join(root, 'text/unexpected.pipe');
    const result = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    await assert.rejects(
      runGoldenCorpus({ corpusRoot: root, ...fakePipeline(), updateGolden: true }),
      /unsupported filesystem entry.*unexpected\.pipe/i,
    );
  });
});

test('rejects a symlink corpus root', async () => {
  await withCorpus(async (root) => {
    const alias = `${root}-alias`;
    await symlink(root, alias);
    try {
      await assert.rejects(runGoldenCorpus({ corpusRoot: alias, ...fakePipeline() }), /symlink/i);
    } finally {
      await rm(alias, { force: true });
    }
  });
});

test('rejects symlinks before filtering metadata sidecars', async () => {
  await withCorpus(async (root) => {
    const target = path.join(root, 'target.txt');
    await writeFile(target, 'metadata link target');
    await symlink(target, path.join(root, '.gitkeep'));
    await assert.rejects(runGoldenCorpus({ corpusRoot: root, ...fakePipeline() }), /symlink/i);
  });
});

test('sorts corpus paths by binary string order', async () => {
  await withCorpus(async (root) => {
    await addInput(root, 'text/é.txt', 'accent', {
      expectedJson: '{"stats":{"durationMs":0},"text":"accent"}\n',
      expectedMarkdown: 'accent',
    });
    await addInput(root, 'text/z.txt', 'plain', {
      expectedJson: '{"stats":{"durationMs":0},"text":"plain"}\n',
      expectedMarkdown: 'plain',
    });
    const pipeline = fakePipeline();
    await runGoldenCorpus({ corpusRoot: root, ...pipeline });
    assert.deepEqual(
      pipeline.calls.extract.map(({ options }) => options.filename),
      ['z.txt', 'é.txt'],
    );
  });
});

test('fails a discovered input without an SPDX and source license sidecar', async () => {
  await withCorpus(async (root) => {
    await addInput(root, 'text/unlicensed.txt', 'content', { license: false });
    const pipeline = fakePipeline();

    await assert.rejects(
      runGoldenCorpus({ corpusRoot: root, ...pipeline }),
      /unlicensed\.txt.*missing.*\.license/i,
    );
  });
});

test('requires a readable license with both SPDX identifier and source', async () => {
  await withCorpus(async (root) => {
    const sourcePath = await addInput(root, 'text/bad-license.txt', 'content');
    await writeFile(`${sourcePath}.license`, 'Source: no SPDX line\n');
    const pipeline = fakePipeline();

    await assert.rejects(runGoldenCorpus({ corpusRoot: root, ...pipeline }), /SPDX-License-Identifier/i);
  });
});

test('rejects a license sidecar without its source record', async () => {
  await withCorpus(async (root) => {
    const sourcePath = await addInput(root, 'text/no-source.txt', 'content');
    await writeFile(`${sourcePath}.license`, 'SPDX-License-Identifier: CC0-1.0\n');

    await assert.rejects(
      runGoldenCorpus({ corpusRoot: root, ...fakePipeline() }),
      /must contain exactly one Source field/i,
    );
  });
});

test('validates identity fields on one line and rejects empty or duplicate values', async () => {
  const cases = [
    ['SPDX-License-Identifier: \nSource: valid source\n', /non-empty SPDX-License-Identifier/i],
    ['SPDX-License-Identifier: CC0-1.0\nSource:\nRequirements: IN-6\n', /non-empty Source line/i],
    [
      'SPDX-License-Identifier: CC0-1.0\nSPDX-License-Identifier: MIT\nSource: valid source\n',
      /exactly one SPDX-License-Identifier/i,
    ],
    ['SPDX-License-Identifier: CC0-1.0\nSource: first\nSource: second\n', /exactly one Source/i],
  ];
  for (const [licenseText, expectedError] of cases) {
    await withCorpus(async (root) => {
      const sourcePath = await addInput(root, 'text/license-case.txt', 'content');
      await writeFile(`${sourcePath}.license`, licenseText);
      await assert.rejects(runGoldenCorpus({ corpusRoot: root, ...fakePipeline() }), expectedError);
    });
  }
});

test('fails clearly when expected files are missing without creating them', async () => {
  await withCorpus(async (root) => {
    const sourcePath = await addInput(root, 'text/new.txt', 'content');
    const pipeline = fakePipeline();

    await assert.rejects(
      runGoldenCorpus({ corpusRoot: root, ...pipeline }),
      /missing.*expected.*UPDATE_GOLDEN=1.*node scripts\/golden-run\.mjs/is,
    );
    await assert.rejects(readFile(`${sourcePath}.expected.json`), { code: 'ENOENT' });
  });
});

test('rewrites both expected files only when explicitly requested', async () => {
  await withCorpus(async (root) => {
    const sourcePath = await addInput(root, 'text/refresh.txt', 'fresh');
    const pipeline = fakePipeline();

    const result = await runGoldenCorpus({ corpusRoot: root, ...pipeline, updateGolden: true, ci: false });

    assert.deepEqual(result, { files: 1, updated: 1 });
    assert.equal(
      await readFile(`${sourcePath}.expected.json`, 'utf8'),
      '{"stats":{"durationMs":0},"text":"fresh"}\n',
    );
    assert.equal(await readFile(`${sourcePath}.expected.md`, 'utf8'), 'fresh');
  });
});

test('refuses to rewrite expected files on CI', async () => {
  await withCorpus(async (root) => {
    const sourcePath = await addInput(root, 'text/ci.txt', 'ci');
    const pipeline = fakePipeline();

    await assert.rejects(
      runGoldenCorpus({ corpusRoot: root, ...pipeline, updateGolden: true, ci: true }),
      /UPDATE_GOLDEN.*CI/i,
    );
    await assert.rejects(readFile(`${sourcePath}.expected.json`), { code: 'ENOENT' });
  });
});

test('refuses to follow a pre-existing expected-file symlink during update', async () => {
  await withCorpus(async (root) => {
    const sourcePath = await addInput(root, 'text/symlink-update.txt', 'updated');
    const outside = path.join(path.dirname(root), 'outside-golden-expected.json');
    await writeFile(outside, 'keep this file');
    await symlink(outside, `${sourcePath}.expected.json`);
    try {
      await assert.rejects(
        runGoldenCorpus({ corpusRoot: root, ...fakePipeline(), updateGolden: true }),
        /symlink/i,
      );
      assert.equal(await readFile(outside, 'utf8'), 'keep this file');
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test('compares invalid UTF-8 expected bytes without replacement-character aliasing', async () => {
  await withCorpus(async (root) => {
    await addInput(root, 'text/invalid-utf8.txt', 'content', {
      expectedJson: Buffer.from([0xff, 0x0a]),
      expectedMarkdown: 'content',
    });
    const pipeline = fakePipeline({ json: () => '\uFFFD' });
    await assert.rejects(
      runGoldenCorpus({ corpusRoot: root, ...pipeline }),
      /first differing byte.*0xff.*0xef/i,
    );
  });
});

test('reports the first differing line when actual output changes', async () => {
  await withCorpus(async (root) => {
    await addInput(root, 'text/changed.txt', 'new text', {
      expectedJson: '{"text":"old text"}\n',
      expectedMarkdown: 'new text',
    });
    const pipeline = fakePipeline();

    await assert.rejects(runGoldenCorpus({ corpusRoot: root, ...pipeline }), (error) => {
      assert.match(error.message, /text\/changed\.txt\.expected\.json/);
      assert.match(error.message, /- \{"text":"old text"\}/);
      assert.match(error.message, /\+ \{"stats":\{"durationMs":0\},"text":"new text"\}/);
      return true;
    });
  });
});

test('uses the built package stable serializer when the package has been built', async (context) => {
  let library;
  try {
    library = await import('../../packages/docsluice/dist/index.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      context.skip('Run npm run build to exercise the built package serializer.');
      return;
    }
    throw error;
  }

  const doc = {
    format: 'txt',
    mimeType: 'text/plain',
    metadata: {},
    features: {
      hasMacros: false,
      hasExternalLinks: false,
      hasEmbeddedFiles: false,
      isEncrypted: false,
      hasJavaScript: false,
    },
    blocks: [],
    children: [],
    warnings: [],
    stats: { bytesRead: 3, durationMs: 87, truncated: false, needsOcr: false },
  };

  const rendered = library.toJSON(doc, { stable: true });
  assert.equal(JSON.parse(rendered).stats.durationMs, 0);
  assert.ok(rendered.indexOf('"format"') < rendered.indexOf('"mimeType"'));
});
