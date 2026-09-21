// Explicit integration check. Only ':' (the shell no-op) enters the native API.
// A final stop hook always throws, so even an allowed review never spawns a shell.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'ironwatch-native-'));
for (const name of ['config', 'data', 'cache', 'state', 'work', 'fixture']) await mkdir(path.join(root, name));
const decisionFile = path.join(root, 'decision.json');
const markerFile = path.join(root, 'stopped.txt');
const entrypoint = new URL('../index.js', import.meta.url).href;
await writeFile(path.join(root, 'fixture', 'index.js'), `
import plugin from ${JSON.stringify(entrypoint)};
import { readFile, appendFile } from 'node:fs/promises';
export default {
  id: 'ironwatch.native-smoke',
  async setup(ctx) {
    const cleanup = await plugin.setup({ ...ctx,
      options: { model: { providerID: 'fixture', id: 'fixture' } },
      generate: { text: async () => ({ text: await readFile(${JSON.stringify(decisionFile)}, 'utf8') }) }
    });
    await ctx.shell.hook('create.before', async () => {
      await appendFile(${JSON.stringify(markerFile)}, 'stopped\\n');
      throw new Error('SMOKE_EXECUTION_STOP');
    });
    return cleanup;
  }
};
`);
await writeFile(path.join(root, 'fixture', 'package.json'), '{"type":"module"}');
await writeFile(path.join(root, 'work', 'opencode.json'), JSON.stringify({
  snapshots: false, plugins: [path.join(root, 'fixture')],
}));
const env = { ...process.env,
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
};
// Exclude explicit configuration overrides from the invoking environment.
for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key];
const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
  cwd: path.join(root, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async check => {
  for (let i = 0; i < 100; i++) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error('Native smoke check timed out');
};
try {
  const server = await until(() => {
    if (child.exitCode !== null) throw new Error('Isolated OpenCode server could not start');
    const url = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    const password = output.match(/server password (\S+)/)?.[1];
    return url && password && { url, password };
  });
  const request = async (route, body) => {
    const response = await fetch(server.url + route, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, text: await response.text() };
  };
  const active = async () => {
    const response = await request('/api/plugin');
    return JSON.parse(response.text).data.some(item => item.id === 'ironwatch.native-smoke' && item.state.status === 'active');
  };
  assert.ok(await until(active));
  const marker = async () => readFile(markerFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  for (const decision of ['deny', 'allow', 'deny']) {
    await writeFile(decisionFile, JSON.stringify({ type: 'decision', decision, risk: 'low', effect: 'read', authorized: true, reason: 'native fixture', analysis: 'The harmless no-op is the only command under review.' }));
    const before = await marker();
    const result = await request('/api/shell', { command: ':', cwd: path.join(root, 'work'), timeout: 1000 });
    assert.ok(result.status >= 400, 'Stop hook must prevent native process creation');
    assert.equal(await marker(), decision === 'allow' ? before + 'stopped\n' : before);
    assert.ok(await active(), 'A rejection must not unload the review plugin');
  }
  console.log('Native OpenCode 2.0.11: plugin active; deny/allow/deny hooks enforced; no shell spawned.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
