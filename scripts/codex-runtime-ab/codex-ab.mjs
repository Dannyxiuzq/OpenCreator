#!/usr/bin/env node
// Same-account / same-config / same-model A/B check for two official Codex CLI builds.
//
// Run from the repository root:
//   node --import tsx scripts/codex-runtime-ab/codex-ab.mjs --from-codex-home ~/.codex
//
// For each Codex build it drives `codex app-server` exactly like OpenCreator does
// (clientInfo "opencreator-agent", experimentalApi) and runs:
//   account/read -> model/list -> thread/start(model) -> turn/start("Reply with exactly: OK")
//
// Credential sources (pick one):
//   --from-codex-home <dir>  copy auth.json and the minimal config with OpenCreator's own
//                            createCodexIsolatedHome() (the same sync the desktop app runs
//                            from ~/.codex into its Runtime Home). Same account, same config.
//   --login                  interactive `codex login` into a throwaway test home.
//   --mock record|gate       offline: local HTTPS mock backend and a fake account.
//
// Safety: every Codex process (including `--version`) runs with a throwaway CODEX_HOME under
// --work-dir, so neither the source home nor the default ~/.codex is written. Thread working
// directories live in the system temp directory, outside any git checkout, so no repository
// AGENTS.md is added to the prompts. Tokens, e-mail addresses and auth/config contents are
// never printed. API-key environment variables are stripped, and only a ChatGPT login is
// accepted: an API-key or other login is refused before any turn is sent, so nothing is billed
// to an API key. The run refuses to start when the copied ChatGPT token would need a refresh
// (refreshing a copy rotates the refresh token and can sign the original login out).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');

// npm dist.integrity values published by the npm registry (identical to the values
// pinned in resources/codex-runtime/*/manifest.json for the respective versions).
const KNOWN_INTEGRITY = {
  '0.149.0-darwin-arm64': 'sha512-GsZJbzBWiD48RETrO8VHGAQNgfSrUVxItXZFeD87wswatPi0+lKuQo8Dx4nMYmOZhZrVtwr3al/feRrZxnDV8Q==',
  '0.149.0-darwin-x64': 'sha512-H+mMgW3Nhc5QzGWEklCoFqACuOc0cVpgPkPQRw0LShoK7P5664T6BRnyl1yzT6orKPKv49cXry7DIWWZ19SanQ==',
  '0.149.0-linux-x64': 'sha512-uZXaN9JPxu0/jjnqqJeTd4kRYPnjVZK3MiVndfG1mHhEaoDKL7ScWHfPqvAEOjwsSDEmQSlMfUkmvYp/CHciYw==',
  '0.149.0-win32-x64': 'sha512-qKbwSOOO/fdhQ5MlXE2fts6taPxRPZ/zqeC+eqHD72hLRymV9rFCUbUxOCquognUPRPvS/2/kRCV0UVhoDd3yQ==',
  '0.166.0-darwin-arm64': 'sha512-5fWH6qqUInACcRADIewjlnRxDb4QLe0uriwehiZz0+viuAAB8I+WWefqw4xwHvyKaxeiGX4uK56+vrgfvFk3FQ==',
  '0.166.0-darwin-x64': 'sha512-Vj5wXJPizKmrzNtnRNQf9PP6FJkG3iJU/UO3NE4WvkENZGoQfmImdwf4MVRI5NgwjSuC6LT0HbBRHPVVnwGHuw==',
  '0.166.0-linux-x64': 'sha512-CxDm3+D1cpbGJeHrdzINoG+3wn9BVncP4qpZaaNYkxe8iPtRJOYyCJnnPoVjWRIBvI9vPKbRoifsMSA5xDaUpw==',
  '0.166.0-win32-x64': 'sha512-NS8Ps5oG5r19pCrMCUXwUqOui6odnUIoBlQkrjCJ+h1k6KiwCzC/+mI9d3nSZCqFoVONPBTmqyq8NYq3YaFGyA=='
};
const VENDOR_TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc'
};
const STRIPPED_ENV = /^(OPENAI_|CODEX_|AZURE_OPENAI|ANTHROPIC_)/;
const CLIENT_INFO = { name: 'opencreator-agent', title: 'OpenCreator Agent', version: '0.1.0' };
const PRINTABLE_CONFIG_KEYS = new Set(['model', 'model_provider', 'service_tier', 'cli_auth_credentials_store', 'forced_login_method']);
const DEFAULT_MODEL = 'gpt-6.1-terra';

const HELP = `Usage (from the repository root):
  node --import tsx scripts/codex-runtime-ab/codex-ab.mjs --from-codex-home ~/.codex
  node scripts/codex-runtime-ab/codex-ab.mjs --login
  node scripts/codex-runtime-ab/codex-ab.mjs --mock record|gate

  --from-codex-home <dir> reuse the login/config OpenCreator syncs (read-only; needs --import tsx)
  --login                 sign in once into a throwaway test home
  --mock record|gate      offline run against a local mock backend with a fake account
  --model <slug>          model to test (default: the synced config model, else ${DEFAULT_MODEL})
  --old <version>         baseline Codex version (default 0.149.0)
  --new <version>         candidate Codex version (default 0.166.0)
  --old-bin <path>        baseline binary (for example the one inside the installed app)
  --new-bin <path>        candidate binary
  --work-dir <dir>        scratch directory (default <repo>/.tmp/codex-ab, git-ignored)
  --keep                  keep the per-version test homes (they contain a credential copy)
  --keep-login            keep the --login test credential for reruns
  --allow-refresh         run even if the copied token is due for refresh (may sign out the source)
`;

function parseArgs(argv) {
  const options = {
    old: '0.149.0',
    new: '0.166.0',
    workDir: join(REPO_ROOT, '.tmp', 'codex-ab'),
    keep: false,
    keepLogin: false,
    allowRefresh: false,
    timeoutMs: 180_000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === '--model') options.model = next();
    else if (flag === '--old') options.old = next();
    else if (flag === '--new') options.new = next();
    else if (flag === '--old-bin') options.oldBin = resolve(next());
    else if (flag === '--new-bin') options.newBin = resolve(next());
    else if (flag === '--work-dir') options.workDir = resolve(next());
    else if (flag === '--from-codex-home') options.sourceHome = resolve(next().replace(/^~(?=$|\/)/, homedir()));
    else if (flag === '--login') options.login = true;
    else if (flag === '--mock') options.mock = next();
    else if (flag === '--keep') options.keep = true;
    else if (flag === '--keep-login') options.keepLogin = true;
    else if (flag === '--allow-refresh') options.allowRefresh = true;
    else if (flag === '--timeout-ms') options.timeoutMs = Number(next());
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (options.mock !== undefined && !['record', 'gate'].includes(options.mock)) {
    throw new Error('--mock must be "record" or "gate"');
  }
  const sources = [options.sourceHome !== undefined, options.login === true, options.mock !== undefined].filter(Boolean);
  if (!options.help && sources.length !== 1) {
    throw new Error('Choose exactly one of --from-codex-home <dir>, --login or --mock record|gate (see --help)');
  }
  return options;
}

function platformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (VENDOR_TRIPLES[key] === undefined) throw new Error(`Unsupported platform ${key}`);
  return key;
}

function sha512Integrity(path) {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function registryIntegrity(version, key) {
  const response = await fetch(`https://registry.npmjs.org/@openai%2fcodex/${version}-${key}`);
  if (!response.ok) throw new Error(`npm registry lookup failed for ${version}-${key}: HTTP ${response.status}`);
  const body = await response.json();
  return { integrity: body.dist.integrity, tarball: body.dist.tarball };
}

async function obtainBinary(version, workDir) {
  const key = platformKey();
  const triple = VENDOR_TRIPLES[key];
  const root = join(workDir, 'bin', `${version}-${key}`);
  const exe = join(root, 'x', 'package', 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (existsSync(exe)) return exe;
  const known = KNOWN_INTEGRITY[`${version}-${key}`];
  const meta = known === undefined
    ? await registryIntegrity(version, key)
    : { integrity: known, tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${key}.tgz` };
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'x'), { recursive: true });
  const archive = join(root, 'package.tgz');
  console.log(`[ab] downloading official @openai/codex@${version}-${key} from npm`);
  const response = await fetch(meta.tarball);
  if (!response.ok || response.body === null) throw new Error(`download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const actual = sha512Integrity(archive);
  if (actual !== meta.integrity) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`integrity mismatch for ${version}-${key}: expected ${meta.integrity}, got ${actual}`);
  }
  execFileSync('tar', ['-xzf', archive, '-C', join(root, 'x')], { stdio: 'inherit' });
  if (!existsSync(exe)) throw new Error(`binary missing after extraction: ${exe}`);
  return exe;
}

function childEnv(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Keep the CA override (a file path, needed behind TLS-inspecting proxies).
    if (name === 'CODEX_CA_CERTIFICATE' || !STRIPPED_ENV.test(name)) env[name] = value;
  }
  return { ...env, ...extra };
}

function redact(text) {
  return String(text)
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>')
    .replace(/\b(sk|rk|pk)-[\w-]{10,}/g, '<key>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b(acct|user|org)[-_][\w-]{6,}/gi, '<id>');
}

// Even `codex --version` prepares helper aliases under CODEX_HOME/tmp, so never let it fall back
// to the default ~/.codex.
function versionOf(bin, scratchHome) {
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });
  return execFileSync(bin, ['--version'], { encoding: 'utf8', env: childEnv({ CODEX_HOME: scratchHome }) })
    .trim().split(/\s+/).at(-1);
}

function jwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// Same precedence as Codex's AuthDotJson::resolved_mode (login/src/auth/manager.rs).
function resolvedAuthMode(auth) {
  if (typeof auth.auth_mode === 'string') return auth.auth_mode;
  if (auth.personal_access_token != null) return 'personalAccessToken';
  if (auth.bedrock_api_key != null) return 'bedrockApiKey';
  if (auth.bedrock_access_keys != null) return 'bedrockAccessKeys';
  if (auth.OPENAI_API_KEY != null) return 'apikey';
  return 'chatgpt';
}

// Mirrors Codex's proactive refresh rule (proactive_refresh_reason in
// login/src/auth/manager.rs): when the access token's exp parses, Codex refreshes only within
// 5 minutes of expiry; only when it does not parse does the 8-day last_refresh rule apply.
// The margins here are 30 minutes and 7 days. No token material is printed.
export function credentialFreshness(authJsonText, now = Date.now()) {
  const auth = JSON.parse(authJsonText);
  const authMode = resolvedAuthMode(auth);
  if (authMode !== 'chatgpt' || auth.tokens === undefined || auth.tokens === null) {
    return { chatgpt: false, authMode, fresh: true };
  }
  const expiry = jwtExpiry(auth.tokens.access_token);
  if (expiry !== undefined) {
    const accessOk = expiry - now > 30 * 60_000;
    return { chatgpt: true, authMode, fresh: accessOk, accessOk };
  }
  const lastRefresh = Date.parse(auth.last_refresh ?? '');
  const refreshOk = Number.isNaN(lastRefresh) || now - lastRefresh < 7 * 24 * 60 * 60_000;
  return { chatgpt: true, authMode, fresh: refreshOk, refreshOk };
}

export function staleTokenMessage(freshness) {
  const reason = freshness.accessOk === false
    ? 'expires within 30 minutes'
    : 'was last refreshed about a week ago, so Codex is about to refresh it';
  return `The ChatGPT access token in the source home ${reason}. Keep using the official Codex app until it has refreshed the token in place, then rerun. --allow-refresh overrides this, but refreshing a copy can sign the official app out.`;
}

// Refuses anything but a ChatGPT login before a single request is sent.
export function requireChatgptLogin(authJsonText, where) {
  const freshness = credentialFreshness(authJsonText);
  if (!freshness.chatgpt) {
    throw new Error(`The login in ${where} is not a ChatGPT login (auth mode ${freshness.authMode}). These checks only use your own ChatGPT login and never send requests billed to an API key.`);
  }
  return freshness;
}

async function loadOpenCreatorHomeSync() {
  const codexSource = join(REPO_ROOT, 'apps', 'daemon', 'src', 'codex');
  try {
    const { createCodexIsolatedHome } = await import(pathToFileURL(join(codexSource, 'probe-home.ts')).href);
    const { ensureCodexFileCredentialStore } = await import(pathToFileURL(join(codexSource, 'credential-storage.ts')).href);
    // Mirrors OpenCreator: auth.json plus the minimal config keys (probe-home.ts), then
    // cli_auth_credentials_store = "file" as server.ts enforces on its runtime home.
    return {
      async prepareHome(sourceHome, home) {
        createCodexIsolatedHome(sourceHome, home);
        await ensureCodexFileCredentialStore(home);
      }
    };
  } catch (error) {
    throw new Error(`--from-codex-home reuses OpenCreator's sync code; run with "node --import tsx" (${error instanceof Error ? error.message : String(error)})`);
  }
}

function readConfigSummary(home) {
  const path = join(home, 'config.toml');
  if (!existsSync(path)) return { keys: [], printable: {} };
  const keys = [];
  const printable = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    keys.push(match[1]);
    if (PRINTABLE_CONFIG_KEYS.has(match[1])) printable[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return { keys, printable };
}

class AppServer {
  constructor(bin, env, onNotification) {
    this.pending = new Map();
    this.nextId = 0;
    this.stderr = '';
    this.child = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { if (this.stderr.length < 64_000) this.stderr += chunk; });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined && message.method === undefined) {
          const waiter = this.pending.get(String(message.id));
          if (waiter === undefined) continue;
          this.pending.delete(String(message.id));
          if (message.error !== undefined) waiter.reject(Object.assign(new Error(message.error.message ?? 'request failed'), { rpc: message.error }));
          else waiter.resolve(message.result);
        } else if (message.id !== undefined && message.method !== undefined) {
          // Server-initiated request (approvals etc.). Decline: this check runs read-only.
          this.write({ id: message.id, result: { decision: 'decline' } });
          onNotification({ method: `server-request:${message.method}`, params: {} });
        } else if (message.method !== undefined) {
          onNotification(message);
        }
      }
    });
    this.exited = new Promise(resolveExit => this.child.once('exit', code => resolveExit(code)));
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 60_000) {
    const id = `ab_${++this.nextId}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolvePromise(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 3_000);
    await this.exited;
    clearTimeout(timer);
  }
}

async function probeVersion({ bin, cwd, model, env, timeoutMs }) {
  const result = { version: versionOf(bin, env.CODEX_HOME), binarySha256: sha256File(bin), model };
  let deltas = 0;
  let agentText = '';
  let turnCompleted;
  let lastError;
  const done = new Promise(resolveDone => { turnCompleted = resolveDone; });
  const server = new AppServer(bin, env, message => {
    const method = message.method;
    if (method === 'item/agentMessage/delta') {
      deltas += 1;
      agentText += message.params?.delta ?? '';
    } else if (method === 'error' && message.params?.willRetry !== true) {
      // Retried transport errors (e.g. websocket fallback) are not final failures.
      lastError = message.params?.error ?? message.params;
    } else if (method === 'turn/completed') {
      turnCompleted(message.params?.turn);
    }
  });
  try {
    await server.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    server.notify('initialized');
    const account = await server.request('account/read', { refreshToken: false });
    result.authMode = account?.account?.type ?? null;
    result.planType = account?.account?.planType ?? null;
    if (result.authMode !== 'chatgpt') {
      // Never send a turn that could be billed to an API key or another account type.
      result.turnStatus = 'skipped-no-chatgpt-login';
      result.error = { message: `Codex reports account type ${result.authMode ?? 'none'}; no turn was sent`, codexErrorInfo: null };
      return result;
    }
    const models = [];
    let cursor;
    do {
      const page = await server.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...(page?.data ?? []));
      cursor = page?.nextCursor ?? undefined;
    } while (cursor);
    result.modelListed = models.some(entry => entry.model === model || entry.id === model);
    result.visibleGpt6 = models.filter(entry => !entry.hidden && /^gpt-6/.test(entry.model)).map(entry => entry.model);
    const thread = await server.request('thread/start', {
      model, cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true
    });
    await server.request('turn/start', {
      threadId: thread?.thread?.id,
      input: [{ type: 'text', text: 'Reply with exactly: OK', text_elements: [] }]
    });
    let timer;
    const turn = await Promise.race([
      done,
      new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout({ status: 'timeout' }), timeoutMs); })
    ]).finally(() => clearTimeout(timer));
    result.turnStatus = turn?.status ?? 'unknown';
    if (result.turnStatus === 'completed' && turn?.error == null) lastError = undefined;
    result.streamDeltas = deltas;
    result.reply = agentText.trim().slice(0, 200);
    const turnError = turn?.error ?? lastError;
    if (turnError) {
      result.error = {
        message: redact(turnError.message ?? JSON.stringify(turnError)).slice(0, 400),
        codexErrorInfo: turnError.codexErrorInfo ?? null
      };
    }
  } catch (error) {
    result.turnStatus = 'client-error';
    result.error = { message: redact(error.message).slice(0, 400), rpc: error.rpc?.code ?? null };
  } finally {
    await server.close();
  }
  result.stderrTail = redact(server.stderr.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    .filter(line => /error|warn/i.test(line) && !/websocket/i.test(line)).slice(-5).join('\n')).slice(0, 1200);
  return result;
}

function isModelNotFound(entry) {
  return entry.error !== undefined && (
    entry.error.codexErrorInfo === 'modelNotFound'
    || /model_not_found|does not exist or you do not have access|model .*not (found|supported)/i.test(entry.error.message)
  );
}

export function verdict(oldResult, newResult) {
  if ([oldResult, newResult].some(result => result.turnStatus === 'skipped-no-chatgpt-login')) {
    return 'NO_CHATGPT_LOGIN: Codex did not report a ChatGPT login, so no turn was sent; sign in with your own ChatGPT account and rerun.';
  }
  const oldOk = oldResult.turnStatus === 'completed' && oldResult.error === undefined;
  const newOk = newResult.turnStatus === 'completed' && newResult.error === undefined;
  if (!oldOk && isModelNotFound(oldResult) && newOk) {
    return 'VERSION_GATED: the baseline fails with model_not_found while the candidate succeeds with the same account, config and model.';
  }
  if (isModelNotFound(oldResult) && isModelNotFound(newResult)) {
    return 'ACCOUNT_OR_MODEL_AVAILABILITY: both versions get model_not_found; check plan/workspace access to the model before blaming the client version.';
  }
  if (oldOk && newOk) return 'BOTH_OK: both versions succeed; the original failure is not reproduced with this account/config.';
  if (!newOk) return `CANDIDATE_FAILED: candidate did not succeed (${newResult.error?.message ?? newResult.turnStatus}); investigate auth/network/config first.`;
  return `INCONCLUSIVE: baseline=${oldResult.turnStatus}, candidate=${newResult.turnStatus}.`;
}

async function startMock(options, workDir) {
  const { createMockTls, startMockBackend } = await import('./mock-backend.mjs');
  const { tlsDir } = createMockTls(join(workDir, 'mock-tls'), 'Codex AB Mock CA');
  const catalog = JSON.parse(readFileSync(join(SCRIPT_DIR, 'fixtures', 'models-rust-v0.166.0.json'), 'utf8'));
  const mock = await startMockBackend({ tlsDir, catalog, mode: options.mock });
  return { ...mock, caPath: join(tlsDir, 'ca.pem') };
}

function fakeAuth() {
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    exp: 4102444800,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct_mock', chatgpt_user_id: 'user_mock' }
  })}.mock`;
  return JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: 'mock-refresh', account_id: 'acct_mock' },
    last_refresh: new Date().toISOString()
  });
}

function writeTestConfig(home, lines) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.toml'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const workDir = options.workDir;
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const runRoot = join(workDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const loginHome = join(workDir, 'login-home');
  // Thread working directories sit outside any git checkout so Codex adds no repository AGENTS.md.
  const cwdRoot = mkdtempSync(join(tmpdir(), 'opencreator-codex-ab-'));
  // Per-version homes hold a credential copy: remove them on every exit path, not only on success.
  const cleanup = () => {
    if (!options.keep) {
      for (const entry of readdirSync(runRoot)) {
        if (entry.startsWith('home-')) rmSync(join(runRoot, entry), { recursive: true, force: true });
      }
    }
    rmSync(join(runRoot, 'version-home'), { recursive: true, force: true });
    rmSync(cwdRoot, { recursive: true, force: true });
    if (options.login && !options.keepLogin) rmSync(loginHome, { recursive: true, force: true });
  };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  let sync;
  if (options.sourceHome !== undefined) {
    const sourceAuth = join(options.sourceHome, 'auth.json');
    if (!existsSync(sourceAuth)) throw new Error(`No auth.json in ${options.sourceHome}; sign in with the official Codex app or use --login`);
    const freshness = requireChatgptLogin(readFileSync(sourceAuth, 'utf8'), options.sourceHome);
    if (!freshness.fresh && !options.allowRefresh) {
      throw new Error(staleTokenMessage(freshness));
    }
    sync = await loadOpenCreatorHomeSync();
  }

  const oldBin = options.oldBin ?? await obtainBinary(options.old, workDir);
  const newBin = options.newBin ?? await obtainBinary(options.new, workDir);

  let mock;
  let env = childEnv();
  if (options.mock !== undefined) {
    mock = await startMock(options, workDir);
    env = childEnv({ CODEX_CA_CERTIFICATE: mock.caPath });
  } else if (options.login && !existsSync(join(loginHome, 'auth.json'))) {
    writeTestConfig(loginHome, ['cli_auth_credentials_store = "file"']);
    console.log('[ab] Sign in with your own ChatGPT account in the browser window that opens (test login only).');
    execFileSync(newBin, ['login'], { stdio: 'inherit', env: childEnv({ CODEX_HOME: loginHome }) });
    if (!existsSync(join(loginHome, 'auth.json'))) throw new Error('login did not produce a file-backed test credential');
    chmodSync(join(loginHome, 'auth.json'), 0o600);
  }
  if (options.login) requireChatgptLogin(readFileSync(join(loginHome, 'auth.json'), 'utf8'), 'the test login');

  const results = [];
  let configSummary;
  try {
    for (const bin of [oldBin, newBin]) {
      const version = versionOf(bin, join(runRoot, 'version-home'));
      const home = join(runRoot, `home-${version}`);
      const cwd = join(cwdRoot, `cwd-${version}`);
      mkdirSync(cwd, { recursive: true });
      if (sync !== undefined) {
        await sync.prepareHome(options.sourceHome, home);
      } else if (mock !== undefined) {
        writeTestConfig(home, [
          `openai_base_url = "${mock.origin}/backend-api/codex"`,
          `chatgpt_base_url = "${mock.origin}/backend-api/"`,
          'cli_auth_credentials_store = "file"'
        ]);
        writeFileSync(join(home, 'auth.json'), fakeAuth(), { mode: 0o600 });
      } else {
        writeTestConfig(home, ['cli_auth_credentials_store = "file"']);
        writeFileSync(join(home, 'auth.json'), readFileSync(join(loginHome, 'auth.json')), { mode: 0o600 });
      }
      if (existsSync(join(home, 'auth.json'))) chmodSync(join(home, 'auth.json'), 0o600);
      configSummary ??= readConfigSummary(home);
      const model = options.model ?? configSummary.printable.model ?? DEFAULT_MODEL;
      console.log(`[ab] probing codex ${version} with model ${model}`);
      const result = await probeVersion({ bin, cwd, model, env: { ...env, CODEX_HOME: home }, timeoutMs: options.timeoutMs });
      if (mock !== undefined) result.mockRequests = mock.takeRequests();
      results.push(result);
      if (!options.keep) rmSync(home, { recursive: true, force: true });
    }
  } finally {
    await mock?.close();
    if (options.login && !options.keepLogin) rmSync(loginHome, { recursive: true, force: true });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    platform: platformKey(),
    mode: options.mock !== undefined ? `mock-${options.mock}` : options.login ? 'test-login' : 'opencreator-sync-from-codex-home',
    clientInfo: CLIENT_INFO,
    syncedConfig: { keysPresent: configSummary?.keys ?? [], values: configSummary?.printable ?? {} },
    results,
    verdict: verdict(results[0], results[1])
  };
  writeFileSync(join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`\nmode=${report.mode} synced config keys=[${report.syncedConfig.keysPresent.join(', ')}] values=${JSON.stringify(report.syncedConfig.values)}`);
  for (const entry of results) {
    console.log(`\n== codex ${entry.version} (sha256 ${entry.binarySha256.slice(0, 16)}...) model=${entry.model}`);
    console.log(`   auth=${entry.authMode} plan=${entry.planType} modelListed=${entry.modelListed} gpt-6 visible=[${(entry.visibleGpt6 ?? []).join(', ')}]`);
    console.log(`   turn=${entry.turnStatus} deltas=${entry.streamDeltas ?? 0} reply=${JSON.stringify(entry.reply ?? '')}`);
    if (entry.error) console.log(`   error=${JSON.stringify(entry.error)}`);
    for (const request of entry.mockRequests ?? []) console.log(`   mock-request ${request}`);
  }
  console.log(`\nVERDICT: ${report.verdict}`);
  console.log(`report: ${join(runRoot, 'report.json')}`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`[ab] ${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
