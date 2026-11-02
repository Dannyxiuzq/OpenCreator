#!/usr/bin/env node
// Thread history probe for the Codex Runtime upgrade (offline, mock backend, fake account).
//
// 1. For each binary: create a thread, restart app-server, then compare thread/resume with and
//    without excludeTurns (returned turns, deprecation notices, thread/turns/list afterwards).
// 2. Rollback: create a thread with --new-bin, then open it with --old-bin in the same
//    CODEX_HOME (list, read, resume, follow-up turn) and read it again with --new-bin.
//
// Usage (binaries from the A/B tool's cache or any official build):
//   node scripts/codex-runtime-ab/thread-history-probe.mjs --old-bin <codex 0.149.0> --new-bin <codex 0.166.0>
//
// Everything runs in a fresh directory under --work-dir that is removed afterwards except
// report.json. No real credential is read.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockTls, startMockBackend } from './mock-backend.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function parseArgs(argv) {
  const options = { workDir: join(REPO_ROOT, '.tmp', 'codex-history-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argv[index - 1]} needs a value`);
      return next;
    };
    if (argv[index] === '--old-bin') options.oldBin = resolve(value());
    else if (argv[index] === '--new-bin') options.newBin = resolve(value());
    else if (argv[index] === '--work-dir') options.workDir = resolve(value());
    else throw new Error(`Unknown option ${argv[index]}`);
  }
  if (!options.oldBin || !options.newBin) throw new Error('--old-bin and --new-bin are required');
  return options;
}

function fakeHome(home, origin) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 86_400,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct_mock' }
  })}.mock`;
  writeFileSync(join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: 'mock', account_id: 'acct_mock' },
    last_refresh: new Date().toISOString()
  }), { mode: 0o600 });
  // gpt-5.5 is in both bundled catalogs, so the old binary can run the follow-up turn.
  writeFileSync(join(home, 'config.toml'), [
    'model = "gpt-5.5"',
    `openai_base_url = "${origin}/backend-api/codex"`,
    `chatgpt_base_url = "${origin}/backend-api/"`,
    'cli_auth_credentials_store = "file"', ''
  ].join('\n'));
}

function appServer(bin, env) {
  const child = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notes = [];
  let next = 0;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && message.method === undefined) {
        const waiter = pending.get(String(message.id));
        pending.delete(String(message.id));
        if (message.error) waiter?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else waiter?.resolve(message.result);
      } else if (message.method !== undefined) {
        notes.push(message);
      }
    }
  });
  child.stderr.resume();
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  const request = (method, params, timeoutMs = 60_000) => new Promise((resolveRequest, reject) => {
    const id = `probe_${++next}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolveRequest(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return {
    notes,
    request,
    async init() {
      await request('initialize', {
        clientInfo: { name: 'opencreator-agent', title: 'OpenCreator', version: '3.2.9' },
        capabilities: { experimentalApi: true }
      });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    },
    async turn(threadId, text, timeoutMs = 60_000) {
      const before = notes.length;
      await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const completed = notes.slice(before).find(note => note.method === 'turn/completed');
        if (completed) return completed.params?.turn?.status ?? 'unknown';
        await sleep(100);
      }
      return 'timeout';
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 3_000);
      await exited;
      clearTimeout(timer);
    }
  };
}

const settle = async run => {
  try { return await run(); } catch (error) { return { error: `${error.code ?? ''} ${error.message}`.trim().slice(0, 200) }; }
};
const TURNS = threadId => ({ threadId, cursor: null, limit: 50, sortDirection: 'desc', itemsView: 'summary' });
const itemTypes = turns => turns.flatMap(turn => (turn.items ?? []).map(item => item.type));

async function createThread(bin, env, cwd, text) {
  const server = appServer(bin, env);
  try {
    await server.init();
    const started = await server.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    const status = await server.turn(started.thread.id, text);
    return { threadId: started.thread.id, historyMode: started.thread.historyMode ?? null, turn: status };
  } finally {
    await server.close();
  }
}

async function resumeVariants(bin, env, cwd) {
  const created = await createThread(bin, env, cwd, 'Reply with exactly: OK');
  const result = { historyMode: created.historyMode, firstTurn: created.turn };
  for (const [label, params] of [
    ['excludeTurns', { threadId: created.threadId, excludeTurns: true }],
    ['fullHistory', { threadId: created.threadId }]
  ]) {
    const server = appServer(bin, env);
    try {
      await server.init();
      const entry = {};
      entry.turnsListBeforeResume = await settle(async () => (await server.request('thread/turns/list', TURNS(created.threadId))).data.length);
      const before = server.notes.length;
      const resumed = await server.request('thread/resume', params);
      await sleep(500);
      entry.resumeReturnedTurns = resumed.thread?.turns?.length ?? null;
      entry.deprecationNotices = server.notes.slice(before)
        .filter(note => note.method === 'deprecationNotice')
        .map(note => String(note.params?.summary ?? '').slice(0, 160));
      entry.turnsListAfterResume = await settle(async () => itemTypes((await server.request('thread/turns/list', TURNS(created.threadId))).data));
      result[label] = entry;
    } finally {
      await server.close();
    }
  }
  return result;
}

async function rollback(newBin, oldBin, env, cwd, mock) {
  const created = await createThread(newBin, env, cwd, 'FIRST_TURN_MARKER Reply with exactly: OK');
  const result = { createdByNew: { historyMode: created.historyMode, turn: created.turn }, old: {}, newAgain: {} };
  const old = appServer(oldBin, env);
  try {
    await old.init();
    result.old.listed = await settle(async () => (await old.request('thread/list', { limit: 50 })).data.some(thread => thread.id === created.threadId));
    result.old.turnsList = await settle(async () => itemTypes((await old.request('thread/turns/list', TURNS(created.threadId))).data));
    result.old.readWithTurns = await settle(async () => itemTypes((await old.request('thread/read', { threadId: created.threadId, includeTurns: true })).thread?.turns ?? []));
    result.old.resume = await settle(async () => {
      await old.request('thread/resume', { threadId: created.threadId, excludeTurns: true });
      return 'ok';
    });
    const sent = mock.responseBodies().length;
    result.old.followUpTurn = await settle(() => old.turn(created.threadId, 'Repeat exactly the reply you gave in the previous turn.'));
    const followUp = mock.responseBodies().slice(sent).at(-1);
    result.old.followUpCarriesFirstTurn = followUp === undefined ? null : followUp.input.includes('FIRST_TURN_MARKER');
  } finally {
    await old.close();
  }
  const again = appServer(newBin, env);
  try {
    await again.init();
    result.newAgain.turnsList = await settle(async () => itemTypes((await again.request('thread/turns/list', TURNS(created.threadId))).data));
  } finally {
    await again.close();
  }
  return result;
}

function expectations(report) {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  for (const label of ['old', 'new']) {
    const entry = report.resume[label];
    expect(entry.excludeTurns.resumeReturnedTurns === 0, `${label}: resume with excludeTurns returned turns`);
    expect(entry.excludeTurns.deprecationNotices.length === 0, `${label}: resume with excludeTurns emitted a deprecation notice`);
    expect(Array.isArray(entry.excludeTurns.turnsListAfterResume) && entry.excludeTurns.turnsListAfterResume.includes('agentMessage'),
      `${label}: thread/turns/list after resume misses the reply`);
  }
  const rollbackResult = report.rollback;
  expect(rollbackResult.old.listed === true, 'old binary does not list the new thread');
  expect(Array.isArray(rollbackResult.old.turnsList) && rollbackResult.old.turnsList.includes('agentMessage'), 'old binary cannot page the new thread');
  expect(rollbackResult.old.followUpTurn === 'completed', 'old binary cannot continue the new thread');
  expect(rollbackResult.old.followUpCarriesFirstTurn === true, 'old binary lost the earlier turn on follow-up');
  expect(Array.isArray(rollbackResult.newAgain.turnsList) && rollbackResult.newAgain.turnsList.length === 4, 'new binary does not see the turn added by the old binary');
  return failures;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runRoot = join(options.workDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const cleanup = () => {
    for (const dir of ['tls', 'old', 'new', 'rollback']) rmSync(join(runRoot, dir), { recursive: true, force: true });
  };
  process.once('exit', cleanup);
  const catalog = JSON.parse(readFileSync(join(SCRIPT_DIR, 'fixtures', 'models-rust-v0.166.0.json'), 'utf8'));
  const tls = createMockTls(join(runRoot, 'tls'));
  const mock = await startMockBackend({ tlsDir: tls.tlsDir, catalog, mode: 'record' });
  const envFor = root => {
    const home = join(root, 'home');
    const cwd = join(root, 'cwd');
    fakeHome(home, mock.origin);
    mkdirSync(cwd, { recursive: true });
    return { env: { PATH: process.env.PATH ?? '', HOME: root, CODEX_HOME: home, CODEX_CA_CERTIFICATE: tls.caPath }, cwd };
  };
  const report = { oldBin: options.oldBin, newBin: options.newBin, resume: {} };
  try {
    for (const [label, bin] of [['old', options.oldBin], ['new', options.newBin]]) {
      const { env, cwd } = envFor(join(runRoot, label));
      report.resume[label] = await resumeVariants(bin, env, cwd);
    }
    const { env, cwd } = envFor(join(runRoot, 'rollback'));
    report.rollback = await rollback(options.newBin, options.oldBin, env, cwd, mock);
  } finally {
    await mock.close();
  }
  report.failures = expectations(report);
  writeFileSync(join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(report.failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${report.failures.join('; ')})`);
  process.exitCode = report.failures.length === 0 ? 0 : 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
