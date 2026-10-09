import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerConfig = path.join(repoRoot, 'packages/docsluice/test-runtime/workers/wrangler.toml');
export const MAX_WORKERS_RESPONSE_BYTES = 64 * 1024;

async function findOpenPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port');
  server.close();
  await once(server, 'close');
  return address.port;
}

function appendBounded(current, chunk) {
  return `${current}${chunk.toString('utf8')}`.slice(-16_384);
}

export async function createWranglerStateDirectory(parent = os.tmpdir()) {
  return mkdtemp(path.join(parent, 'docsluice-runtime-web-wrangler-'));
}

export async function startWrangler(command, args, options) {
  const child = spawn(command, args, options);
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    const cause = spawnError ?? error;
    throw new Error(`Could not start Wrangler (${cause.code ?? 'error'}): ${cause.message}`, {
      cause: error,
    });
  }
  return child;
}

function terminal(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForTerminal(child, timeoutMs) {
  if (terminal(child)) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(value || terminal(child));
    };
    const onExit = () => finish(true);
    const onError = () => finish(terminal(child));
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (terminal(child)) finish(true);
  });
}

function signalChild(child, signal) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') throw error;
  }
}

export async function stopWrangler(child, { termGraceMs = 5_000, killGraceMs = 2_000 } = {}) {
  if (terminal(child)) return;
  signalChild(child, 'SIGTERM');
  if (await waitForTerminal(child, termGraceMs)) return;
  signalChild(child, 'SIGKILL');
  if (!(await waitForTerminal(child, killGraceMs))) {
    throw new Error(`Wrangler process ${child.pid ?? '(unknown pid)'} did not exit after SIGKILL`);
  }
}

export async function readBoundedResponse(response, maxBytes = MAX_WORKERS_RESPONSE_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('Workers runtime response exceeded configured size limit');
        throw new Error(`Workers response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function runWorkersRuntime() {
  const port = await findOpenPort();
  const stateDirectory = await createWranglerStateDirectory();
  const configDirectory = path.join(stateDirectory, 'config');
  const cacheDirectory = path.join(stateDirectory, 'cache');
  const wrangler = path.join(repoRoot, 'node_modules/.bin/wrangler');
  let child;
  let output = '';
  try {
    await mkdir(configDirectory, { recursive: true });
    await mkdir(cacheDirectory, { recursive: true });
    const environment = {
      ...process.env,
      XDG_CONFIG_HOME: configDirectory,
      XDG_CACHE_HOME: cacheDirectory,
      WRANGLER_SEND_METRICS: 'false',
    };
    delete environment.CLOUDFLARE_API_TOKEN;
    delete environment.CLOUDFLARE_API_KEY;
    delete environment.CLOUDFLARE_EMAIL;
    child = await startWrangler(
      wrangler,
      [
        'dev',
        '--local',
        '--config',
        wranglerConfig,
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--log-level',
        'error',
      ],
      {
        cwd: repoRoot,
        env: environment,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk) => (output = appendBounded(output, chunk)));
    child.stderr.on('data', (chunk) => (output = appendBounded(output, chunk)));

    const endpoint = `http://127.0.0.1:${port}/runtime-contract`;
    const deadline = Date.now() + 60_000;
    let response;
    while (Date.now() < deadline) {
      if (terminal(child)) throw new Error(`Wrangler exited before serving the test request.\n${output}`);
      try {
        response = await globalThis.fetch(endpoint, {
          signal: globalThis.AbortSignal.timeout(2_000),
        });
        break;
      } catch {
        await delay(250);
      }
    }
    if (!response) throw new Error(`Wrangler did not become ready within 60 seconds.\n${output}`);
    const body = await readBoundedResponse(response);
    if (!response.ok) throw new Error(`Workers request failed (${response.status}): ${body}\n${output}`);
    const result = JSON.parse(body);
    if (result.ok !== true || result.bufferAbsent !== true || result.bufferAccessTrap !== 'passed') {
      throw new Error(`Workers returned an unexpected result: ${body}`);
    }
    return result;
  } finally {
    try {
      if (child) await stopWrangler(child);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await runWorkersRuntime();
    process.stdout.write('Built package passed the local Workers runtime contract.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
