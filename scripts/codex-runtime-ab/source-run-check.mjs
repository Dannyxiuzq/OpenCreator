#!/usr/bin/env node
// Source-run check of OpenCreator with the staged bundled Codex Runtime.
//
// It builds the daemon from source (buildServer, the same server the desktop app starts),
// points it at the staged Runtime from apps/desktop/.pack/codex-runtime (verified against its
// manifest first) and drives the public API through: readiness/account/models, a chat run,
// Creator Agent streaming, a follow-up turn in the same thread, the thread history and a
// follow-up after a daemon restart, a command approval, a cancel, and a short subtitle
// translation through the Krillin text gateway.
//
// Run from the repository root after `node apps/desktop/scripts/prepare-codex-runtime.mjs`:
//   node --import tsx scripts/codex-runtime-ab/source-run-check.mjs --mock
//   node --import tsx scripts/codex-runtime-ab/source-run-check.mjs --from-codex-home ~/.codex
//
// All OpenCreator data lives in a fresh directory under --home-root (default
// ~/.opencreator-isolated/source-run) and is removed afterwards; reports stay under --work-dir.
// The production app data, database and Runtime Home are never used. --from-codex-home is only
// read (the daemon copies auth.json and the minimal config exactly like the desktop app does)
// and must hold a ChatGPT login: anything else is refused before a request is sent. The project
// folder lives in the system temp directory, outside any git checkout, like a real OpenCreator
// project. Tokens, e-mail addresses and file contents of auth/config are never printed.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireChatgptLogin, staleTokenMessage } from './codex-ab.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const DAEMON_SRC = join(REPO_ROOT, 'apps', 'daemon', 'src');
const TOKEN = 'source-run-check';
const SUBTITLE_SYSTEM = 'You are an assistant that helps with subtitle translation.';
const SUBTITLE_USER = [
  'Translate the following subtitles into Simplified Chinese. Keep the numbering and timestamps.',
  '1\n00:00:01,000 --> 00:00:02,500\nGood morning, everyone.',
  '2\n00:00:02,600 --> 00:00:04,000\nLet us begin the meeting.'
].join('\n\n');

function parseArgs(argv) {
  const options = {
    workDir: join(REPO_ROOT, '.tmp', 'codex-source-run'),
    homeRoot: join(homedir(), '.opencreator-isolated', 'source-run'),
    runtimeRoot: join(REPO_ROOT, 'apps', 'desktop', '.pack', 'codex-runtime'),
    keep: false,
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
    if (flag === '--mock') options.mock = true;
    else if (flag === '--from-codex-home') options.sourceHome = resolve(next().replace(/^~(?=$|\/)/, homedir()));
    else if (flag === '--model') options.model = next();
    else if (flag === '--runtime-root') options.runtimeRoot = resolve(next());
    else if (flag === '--work-dir') options.workDir = resolve(next());
    else if (flag === '--home-root') options.homeRoot = resolve(next().replace(/^~(?=$|\/)/, homedir()));
    else if (flag === '--keep') options.keep = true;
    else if (flag === '--allow-refresh') options.allowRefresh = true;
    else if (flag === '--timeout-ms') options.timeoutMs = Number(next());
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.help && (options.mock === true) === (options.sourceHome !== undefined)) {
    throw new Error('Choose exactly one of --mock or --from-codex-home <dir>');
  }
  return options;
}

const daemonModule = path => import(pathToFileURL(join(DAEMON_SRC, path)).href);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const redact = text => String(text)
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
  .replace(/\b(acct|user|org)[-_][\w-]{6,}/gi, '<id>');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node --import tsx scripts/codex-runtime-ab/source-run-check.mjs --mock | --from-codex-home <dir> [--model <slug>] [--work-dir <reports>] [--home-root <dir>] [--keep]\n');
    return;
  }
  const { verifyCodexRuntime } = await import(pathToFileURL(join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'codex-runtime-contract.mjs')).href);
  const manifest = verifyCodexRuntime(options.runtimeRoot, process.platform, process.arch);
  const codexBin = join(options.runtimeRoot, manifest.binary.relativePath);
  const runName = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runRoot = join(options.workDir, runName);
  // The OpenCreator home (Runtime Homes, data, Creator workspaces) sits outside the checkout, so
  // no turn picks up the repository's AGENTS.md, and outside the system temp directory, because
  // Codex refuses to put its helper aliases (apply_patch on PATH) under a temporary CODEX_HOME.
  const appHome = join(options.homeRoot, runName);
  const dataDir = join(appHome, 'data');
  const codexHome = join(appHome, 'runtime', 'codex');
  // Outside the checkout, so Codex does not add the repository's AGENTS.md to the prompts.
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'opencreator-source-run-')));
  for (const dir of [runRoot, dataDir, codexHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The isolated homes hold a copy of the ChatGPT credential: remove them on every exit path.
  const cleanup = () => {
    if (options.keep) return;
    rmSync(appHome, { recursive: true, force: true });
    rmSync(join(runRoot, 'local-codex'), { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    // Drop the parents only when they are empty (an isolated test package may live next to them).
    for (const dir of [options.homeRoot, dirname(options.homeRoot)]) {
      try { rmdirSync(dir); } catch { /* not empty or already gone */ }
    }
  };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  let mock;
  let localCodexHome = options.sourceHome;
  const scenario = { approvalSeen: false };
  if (options.mock) {
    mock = await startScenarioMock(runRoot, scenario);
    localCodexHome = join(runRoot, 'local-codex');
    mkdirSync(localCodexHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(localCodexHome, 'auth.json'), fakeChatgptAuth(), { mode: 0o600 });
    writeFileSync(join(localCodexHome, 'config.toml'), [
      'model = "gpt-6.1-terra"',
      `openai_base_url = "${mock.origin}/backend-api/codex"`,
      `chatgpt_base_url = "${mock.origin}/backend-api/"`,
      'cli_auth_credentials_store = "file"', ''
    ].join('\n'), { mode: 0o600 });
    process.env.CODEX_CA_CERTIFICATE = mock.caPath;
  } else {
    const authPath = join(localCodexHome, 'auth.json');
    if (!existsSync(authPath)) throw new Error(`No auth.json in ${localCodexHome}`);
    const freshness = requireChatgptLogin(readFileSync(authPath, 'utf8'), localCodexHome);
    if (!freshness.fresh && !options.allowRefresh) {
      throw new Error(staleTokenMessage(freshness));
    }
  }
  // Same rule as codex-ab.mjs, plus provider keys: Codex honours e.g. CODEX_ACCESS_TOKEN and
  // CODEX_SQLITE_HOME, which would change the identity or move the state database.
  for (const name of Object.keys(process.env)) {
    if (/^(OPENAI_|CODEX_|AZURE_OPENAI|ANTHROPIC_|VOLCENGINE_)/.test(name) && name !== 'CODEX_CA_CERTIFICATE') delete process.env[name];
  }
  // Never pick up paid provider credentials from the production ~/.opencreator/.env.local:
  // point the daemon at a file inside the isolated home that does not exist.
  process.env.OPENCREATOR_ENV_FILE = join(appHome, '.env.local');
  process.env.OPENCREATOR_CODEX_RUNTIME_MODE = 'bundled';

  const { buildServer } = await daemonModule('api/server.ts');
  const { createCodexAppServerClient } = await daemonModule('codex/app-server-client.ts');
  const { resolveBundledCodexStartupSnapshot } = await daemonModule('codex/capabilities.ts');
  const { synchronizeLocalCodexConfiguration, createFollowingLocalCodexHome } = await daemonModule('codex/probe-home.ts');
  const { readLocalCodexModelConfiguration } = await daemonModule('codex/local-provider.ts');
  const { createKrillinCodexLlmGateway, KRILLIN_LLM_ROUTE_PREFIX } = await daemonModule('creator/krillin/codex-llm-gateway.ts');
  const snapshot = resolveBundledCodexStartupSnapshot({ mode: 'bundled', version: manifest.version, commit: manifest.commit });
  if (snapshot === undefined) throw new Error(`Daemon constants do not match the staged Runtime ${manifest.version}`);

  const results = [];
  const check = async (name, run) => {
    const started = Date.now();
    try {
      const evidence = await run();
      results.push({ name, status: evidence?.status ?? 'PASS', ms: Date.now() - started, evidence });
    } catch (error) {
      results.push({ name, status: 'FAIL', ms: Date.now() - started, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 600) });
    }
    const last = results.at(-1);
    console.log(`[source-run] ${last.status.padEnd(9)} ${name} (${last.ms} ms)${last.error ? ` - ${last.error}` : ''}`);
    if (last.status !== 'PASS' && last.evidence !== undefined) console.log(`             evidence: ${JSON.stringify(last.evidence).slice(0, 800)}`);
  };

  // Same startup order as apps/daemon/src/main.ts.
  synchronizeLocalCodexConfiguration(localCodexHome, codexHome);
  const start = () => buildServer({
    token: TOKEN, appHome, dataDir, codexBin, codexHome, localCodexHome,
    runtimeDir: join(appHome, 'runtime'), creatorDir: join(appHome, 'creator'),
    configFile: join(appHome, 'config.toml'), credentialsFile: join(appHome, 'credentials.json'),
    capabilities: snapshot.capabilities, resumeCapabilityVerified: true,
    persistentAppServerEnabled: true, agentToolsEnabled: false, schedulerAutostart: false
  });
  let server = await start();
  const api = async (method, url, payload) => {
    const response = await server.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });
    let json;
    try { json = response.json(); } catch { json = undefined; }
    return { status: response.statusCode, json, body: response.body };
  };
  const waitRun = async (runId, statuses, timeoutMs = options.timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = (await api('GET', `/runs/${runId}`)).json;
      if (statuses.includes(run?.status)) return run;
      await sleep(200);
    }
    throw new Error(`run ${runId} did not reach ${statuses.join('/')} within ${timeoutMs} ms`);
  };
  const runEvents = async runId => {
    const response = await server.inject({ method: 'GET', url: `/runs/${runId}/events`, headers: { authorization: `Bearer ${TOKEN}` } });
    return response.body.split('\n\n').flatMap(block => {
      const data = block.split('\n').find(line => line.startsWith('data: '));
      if (data === undefined) return [];
      try { return [JSON.parse(data.slice(6))]; } catch { return []; }
    });
  };
  const assistantText = events => events
    .filter(event => event.type === 'assistant_message' && event.payload?.delivery === 'message')
    .map(event => event.payload.text).join('\n').trim();
  const project = (await api('POST', '/projects', { cwd: projectDir, profile: 'default', sandbox: 'read-only' })).json?.project;
  if (project?.id === undefined) throw new Error('could not create the check project');
  const createThread = async model => {
    const response = await api('POST', '/threads', { projectId: project.id, ...(model === undefined ? {} : { model }) });
    if (response.status !== 201) throw new Error(`thread create failed: HTTP ${response.status} ${redact(response.body).slice(0, 300)}`);
    return response.json.thread.id;
  };
  // Chat threads pin the target model when it differs from what the synced config selects.
  // Creator Agent turns and the Krillin gateway always use the synced config model, so those
  // checks are labelled with the model they actually run.
  const configModel = readCodexModel(codexHome);
  const targetModel = options.model ?? configModel ?? 'gpt-6.1-terra';
  const threadModel = options.model !== undefined || configModel === undefined ? targetModel : undefined;
  const configModelLabel = configModel ?? 'Codex default model';
  const requestModelsSince = start => (mock === undefined ? undefined : [...new Set(mock.responseBodies().slice(start).map(body => body.model))]);
  let mainThread;

  try {
    let chatgptLogin = false;
    await check('readiness, account and model list', async () => {
      const readiness = (await api('GET', '/codex/readiness')).json;
      const account = (await api('GET', '/codex/account')).json;
      const picker = (await api('GET', '/codex/models')).json;
      const pickerIds = (picker?.models ?? []).map(model => model.model ?? model.id);
      // The picker keeps only the two newest GPT families, so also read Codex's full model list,
      // and the account type straight from Codex.
      const client = createCodexAppServerClient({ codexBin, codexHome, cwd: dataDir });
      let accountType;
      const catalogIds = [];
      try {
        accountType = (await client.request('account/read', { refreshToken: false }))?.account?.type ?? null;
        let cursor;
        do {
          const page = await client.request('model/list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
          catalogIds.push(...(page?.data ?? []).map(entry => entry.model ?? entry.id));
          cursor = page?.nextCursor ?? undefined;
        } while (cursor !== undefined);
      } finally {
        await client.close();
      }
      chatgptLogin = accountType === 'chatgpt';
      const evidence = {
        runtimeVersion: manifest.version, runtimeCommit: manifest.commit,
        readinessState: readiness?.state ?? readiness?.readiness?.state,
        accountStatus: account?.account?.accountStatus ?? account?.accountStatus,
        accountType, plan: account?.account?.account?.plan ?? account?.account?.plan,
        targetModel, configModel: configModel ?? null,
        targetModelAvailable: catalogIds.includes(targetModel), targetModelInPicker: pickerIds.includes(targetModel),
        pickerModels: pickerIds
      };
      if (!chatgptLogin || !evidence.targetModelAvailable) return { ...evidence, status: 'FAIL' };
      return evidence;
    });
    if (!chatgptLogin) {
      throw new Error('Codex does not report a ChatGPT login; the remaining checks were not run so nothing is billed to an API key');
    }

    await check(`chat run with ${targetModel} (final message)`, async () => {
      const sent = mock?.responseBodies().length ?? 0;
      mainThread = await createThread(threadModel);
      const created = await api('POST', '/runs', { threadId: mainThread, prompt: 'Reply with exactly: OK' });
      if (created.status !== 202) throw new Error(`run create failed: HTTP ${created.status} ${redact(created.body).slice(0, 300)}`);
      const run = await waitRun(created.json.id, ['succeeded', 'failed', 'canceled']);
      // The /runs event log keeps completed messages; live text streaming is checked below.
      const events = await runEvents(created.json.id);
      const reply = assistantText(events);
      const errors = events.filter(event => event.type === 'error').map(event => redact(JSON.stringify(event.payload)).slice(0, 300));
      const warnings = events.filter(event => event.type === 'diagnostic').map(event => redact(JSON.stringify(event.payload)).slice(0, 200));
      // Offline, the mock also proves which model the requests carried.
      const requestModels = requestModelsSince(sent);
      const modelOk = requestModels === undefined || (requestModels.length > 0 && requestModels.every(model => model === targetModel));
      return {
        status: run.status === 'succeeded' && /\bOK\b/.test(reply) && modelOk ? 'PASS' : 'FAIL',
        runStatus: run.status, reply: reply.slice(0, 200), ...(requestModels === undefined ? {} : { requestModels }), errors, warnings
      };
    });

    await check(`Creator Agent turn streams text deltas to subscribers (${configModelLabel})`, async () => {
      const job = await api('POST', '/creator/jobs', { projectId: 'source-run-check', templateId: 'video-download' });
      if (job.status !== 201) throw new Error(`creator job create failed: HTTP ${job.status} ${redact(job.body).slice(0, 300)}`);
      const jobId = job.json.job.id;
      await server.listen({ host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${server.server.address().port}`;
      const controller = new AbortController();
      const received = [];
      const reading = (async () => {
        const response = await fetch(`${base}/creator/jobs/${jobId}/events`, {
          headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received.push(decoder.decode(value, { stream: true }));
        }
      })().catch(() => undefined);
      await sleep(500);
      const turn = await api('POST', `/creator/jobs/${jobId}/agent-turns`, { message: 'Reply with exactly: OK' });
      await sleep(1_000);
      controller.abort();
      await reading;
      const streamed = received.join('');
      const deltas = (streamed.match(/item\/agentMessage\/delta/g) ?? []).length;
      const timeline = (await api('GET', `/creator/jobs/${jobId}/agent-timeline`)).json;
      const assistant = (timeline?.items ?? []).filter(item => item.kind === 'assistant_message').map(item => item.text ?? '').join('\n');
      return {
        status: turn.status === 200 && deltas > 0 && /\bOK\b/.test(assistant) ? 'PASS' : 'FAIL',
        turnHttp: turn.status, streamedDeltaEvents: deltas, assistant: redact(assistant).slice(0, 200),
        ...(turn.status === 200 ? {} : { turnError: redact(turn.body).slice(0, 400) })
      };
    });

    const continuityPrompt = 'Repeat exactly the reply you gave in the previous turn, with nothing else.';
    await check('follow-up turn in the same thread', async () => {
      const created = await api('POST', '/runs', { threadId: mainThread, prompt: continuityPrompt });
      const run = await waitRun(created.json.id, ['succeeded', 'failed', 'canceled']);
      const reply = assistantText(await runEvents(created.json.id));
      return { status: run.status === 'succeeded' && /\bOK\b/.test(reply) ? 'PASS' : 'FAIL', runStatus: run.status, reply: reply.slice(0, 200) };
    });

    await check('thread history after a daemon restart', async () => {
      await server.close();
      server = await start();
      // A fresh daemon has a fresh history app-server, so this exercises the provider's
      // "thread not loaded" fallback (thread/resume without turns, then thread/turns/list).
      const history = await api('GET', `/threads/${mainThread}/history?limit=50`);
      const items = Array.isArray(history.json?.items) ? history.json.items : [];
      const users = items.filter(item => item.type === 'user_message').map(item => item.text ?? '');
      const assistants = items.filter(item => item.type === 'assistant_message').map(item => item.text ?? '');
      const ok = history.status === 200
        && users.some(text => text.includes('Reply with exactly: OK'))
        && assistants.some(text => /\bOK\b/.test(text));
      return {
        status: ok ? 'PASS' : 'FAIL', http: history.status, userMessages: users.length, assistantMessages: assistants.length,
        ...(history.status === 200 ? {} : { error: redact(history.body).slice(0, 300) })
      };
    });

    await check('follow-up after a daemon restart (thread resume)', async () => {
      const created = await api('POST', '/runs', { threadId: mainThread, prompt: continuityPrompt });
      if (created.status !== 202) throw new Error(`run create failed after restart: HTTP ${created.status} ${redact(created.body).slice(0, 300)}`);
      const run = await waitRun(created.json.id, ['succeeded', 'failed', 'canceled']);
      const reply = assistantText(await runEvents(created.json.id));
      return { status: run.status === 'succeeded' && /\bOK\b/.test(reply) ? 'PASS' : 'FAIL', runStatus: run.status, reply: reply.slice(0, 200) };
    });

    await check('command approval round trip', async () => {
      const approvalModel = options.mock ? 'gpt-5.5' : targetModel;
      const threadId = await createThread(approvalModel);
      const marker = join(projectDir, 'approved.txt');
      const created = await api('POST', '/runs', {
        threadId,
        prompt: 'APPROVAL_SCENARIO: run exactly the shell command `touch approved.txt` in the current folder with escalated permissions (it needs my approval), then reply DONE.'
      });
      const deadline = Date.now() + options.timeoutMs;
      let approval;
      while (Date.now() < deadline && approval === undefined) {
        const list = (await api('GET', '/approvals')).json;
        approval = (list?.approvals ?? list ?? []).find?.(entry => entry.runId === created.json.id && entry.status === 'pending');
        const run = (await api('GET', `/runs/${created.json.id}`)).json;
        if (approval === undefined && ['succeeded', 'failed', 'canceled'].includes(run?.status)) break;
        if (approval === undefined) await sleep(200);
      }
      if (approval === undefined) {
        const run = await waitRun(created.json.id, ['succeeded', 'failed', 'canceled']);
        return { status: options.mock ? 'FAIL' : 'UNVERIFIED', note: 'the model finished without requesting an approval', runStatus: run.status, model: approvalModel };
      }
      // Approve only the exact command in the check project folder; anything else would run
      // outside the sandbox with your permissions, so reject it.
      const command = typeof approval.details?.command === 'string' ? approval.details.command : '';
      const cwd = typeof approval.details?.cwd === 'string' && existsSync(approval.details.cwd) ? realpathSync(approval.details.cwd) : undefined;
      const expected = approval.kind === 'command_execution' && isExpectedTouchCommand(command) && cwd === projectDir;
      if (!expected) {
        const decision = await api('POST', `/approvals/${approval.id}/reject`);
        const run = await waitRun(created.json.id, ['succeeded', 'failed', 'canceled']);
        return {
          status: options.mock ? 'FAIL' : 'UNVERIFIED', note: 'the requested command was not `touch approved.txt` in the check project, so it was rejected',
          model: approvalModel, approvalKind: approval.kind, requestedCommand: redact(command).slice(0, 200), rejectHttp: decision.status, runStatus: run.status
        };
      }
      const decision = await api('POST', `/approvals/${approval.id}/approve`);
      const run = await waitRun(created.json.id, ['succeeded', 'failed', 'canceled']);
      return {
        status: run.status === 'succeeded' && existsSync(marker) ? 'PASS' : 'FAIL',
        model: approvalModel, approvalKind: approval.kind, approvedCommand: command, approveHttp: decision.status,
        runStatus: run.status, commandExecuted: existsSync(marker)
      };
    });

    await check('cancel a streaming run', async () => {
      const threadId = await createThread(threadModel);
      const created = await api('POST', '/runs', { threadId, prompt: 'SLOW_SCENARIO: write a very long essay about the history of subtitles.' });
      // The event stream stays open while a run is active, so poll the run status instead.
      const deadline = Date.now() + options.timeoutMs;
      let runningSince;
      while (Date.now() < deadline) {
        const run = (await api('GET', `/runs/${created.json.id}`)).json;
        if (['succeeded', 'failed', 'canceled'].includes(run?.status)) break;
        if (run?.status === 'running') runningSince ??= Date.now();
        const streaming = options.mock ? scenario.slowStarted === true : runningSince !== undefined && Date.now() - runningSince > 4_000;
        if (streaming) break;
        await sleep(200);
      }
      const requested = Date.now();
      const cancel = await api('POST', `/runs/${created.json.id}/cancel`);
      const run = await waitRun(created.json.id, ['succeeded', 'failed', 'canceled'], 30_000);
      return {
        status: run.status === 'canceled' ? 'PASS' : 'FAIL', cancelHttp: cancel.status,
        runStatus: run.status, terminationReason: run.terminationReason, cancelLatencyMs: Date.now() - requested
      };
    });

    await check(`short subtitle translation (Krillin text gateway, ${configModelLabel})`, async () => {
      const Fastify = await loadDaemonDependency('fastify');
      const gatewayServer = Fastify();
      // Same construction as apps/daemon/src/api/server.ts.
      const gateway = createKrillinCodexLlmGateway({
        codexBin, codexHome, cwd: dataDir,
        readLocalConfiguration: () => readLocalCodexModelConfiguration({ codexHome: localCodexHome }),
        readConfiguration: createFollowingLocalCodexHome(localCodexHome, join(appHome, 'runtime', 'creator-text-codex'))
      });
      try {
        await gateway.register(gatewayServer);
        const config = gateway.config('http://127.0.0.1');
        const response = await gatewayServer.inject({
          method: 'POST', url: `${KRILLIN_LLM_ROUTE_PREFIX}/v1/chat/completions`,
          headers: { authorization: `Bearer ${config.apiKey}` },
          payload: { model: config.model, stream: false, messages: [
            { role: 'system', content: SUBTITLE_SYSTEM }, { role: 'user', content: SUBTITLE_USER }
          ] }
        });
        const content = response.json()?.choices?.[0]?.message?.content ?? '';
        const keepsTimestamps = content.includes('00:00:01,000 --> 00:00:02,500') && content.includes('00:00:02,600 --> 00:00:04,000');
        return {
          status: response.statusCode === 200 && /[一-鿿]/.test(content) && keepsTimestamps ? 'PASS' : 'FAIL',
          http: response.statusCode, keepsTimestamps, translation: redact(content).slice(0, 400)
        };
      } finally {
        await gateway.close();
        await gatewayServer.close();
      }
    });
  } finally {
    await server?.close();
    await mock?.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.mock ? 'mock-backend' : 'real-chatgpt-login',
    platform: `${process.platform}-${process.arch}`,
    runtime: { version: manifest.version, commit: manifest.commit, binarySha256: manifest.binary.sha256 },
    targetModel,
    configModel: configModel ?? null,
    mockRequests: mock?.takeRequests(),
    results
  };
  writeFileSync(join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  cleanup();
  const failed = results.filter(result => result.status === 'FAIL');
  console.log(`\nreport: ${join(runRoot, 'report.json')}`);
  console.log(`summary: ${results.length - failed.length}/${results.length} not failed, ${failed.length} failed`);
  if (failed.length > 0) process.exitCode = 1;
}

// `touch approved.txt`, optionally wrapped in a login shell (`/bin/zsh -lc '...'`).
function isExpectedTouchCommand(command) {
  const unwrapped = command.trim().replace(/^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])(.*)\1$/s, '$2').trim();
  return unwrapped === 'touch approved.txt';
}

function readCodexModel(codexHome) {
  const path = join(codexHome, 'config.toml');
  if (!existsSync(path)) return undefined;
  return /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(path, 'utf8'))?.[1];
}

async function loadDaemonDependency(name) {
  const require = createRequire(join(REPO_ROOT, 'apps', 'daemon', 'package.json'));
  const module = await import(pathToFileURL(require.resolve(name)).href);
  return module.default ?? module;
}

function fakeChatgptAuth() {
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct_mock', chatgpt_user_id: 'user_mock' }
  })}.mock`;
  return JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: 'mock-refresh', account_id: 'acct_mock' },
    last_refresh: new Date().toISOString()
  });
}

// Offline backend: deterministic answers for each scenario, keyed on the prompt text.
async function startScenarioMock(runRoot, scenario) {
  const { createMockTls, startMockBackend } = await import('./mock-backend.mjs');
  const { tlsDir } = createMockTls(join(runRoot, 'mock-tls'), 'OpenCreator Source Run Mock CA');
  const catalog = JSON.parse(readFileSync(join(SCRIPT_DIR, 'fixtures', 'models-rust-v0.166.0.json'), 'utf8'));
  const mock = await startMockBackend({
    tlsDir, catalog, mode: 'record',
    respond({ body, res, id, sse, textReplyEvents, functionCallEvents, writeEvent }) {
      const input = JSON.stringify(body?.input ?? '');
      if (input.includes(SUBTITLE_SYSTEM.slice(0, 40))) {
        sse(res, textReplyEvents('1\n00:00:01,000 --> 00:00:02,500\n大家早上好。\n\n2\n00:00:02,600 --> 00:00:04,000\n我们开始开会吧。', id));
        return true;
      }
      if (input.includes('APPROVAL_SCENARIO')) {
        if (input.includes('function_call_output')) {
          sse(res, textReplyEvents('DONE', id));
        } else {
          scenario.approvalSeen = true;
          sse(res, functionCallEvents('exec_command', {
            cmd: 'touch approved.txt', sandbox_permissions: 'require_escalated',
            justification: 'Source-run approval check'
          }, id));
        }
        return true;
      }
      if (input.includes('SLOW_SCENARIO')) {
        scenario.slowStarted = true;
        sse(res, [
          { type: 'response.created', response: { id } },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: `msg_${id}`, delta: 'Subtitles began ' }
        ], { end: false });
        const keepAlive = setInterval(() => writeEvent(res, {
          type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: `msg_${id}`, delta: '. '
        }), 1_000);
        res.on('close', () => clearInterval(keepAlive));
        return true;
      }
      if (input.includes('Repeat exactly the reply you gave in the previous turn')) {
        // Only answer "OK" when the earlier turn is part of the request (context kept).
        sse(res, textReplyEvents(input.includes('Reply with exactly: OK') ? 'OK' : 'CONTEXT_MISSING', id));
        return true;
      }
      return false;
    }
  });
  return { ...mock, caPath: join(tlsDir, 'ca.pem') };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`[source-run] ${redact(error instanceof Error ? error.stack ?? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
