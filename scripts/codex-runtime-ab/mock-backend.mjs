// Local HTTPS mock of the ChatGPT Codex backend used by the offline checks in this folder.
// It records which client identity and model each Codex build sends. In "record" mode it
// never gates; "gate" mode emulates a minimal_client_version check so the client-side
// error path can be exercised (a simulation, not evidence of real server behaviour).
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

// Codex compresses ChatGPT request bodies with zstd; Node gained zstd in 22.15.
const zstdAvailable = typeof zlib.zstdDecompressSync === 'function';

// Self-signed CA and 127.0.0.1 server certificate, trusted only through
// CODEX_CA_CERTIFICATE by the Codex processes these scripts start. Uses extension
// config files (no -addext) so both OpenSSL and the macOS LibreSSL work.
function certificateValidForAnHour(path) {
  try {
    execFileSync('openssl', ['x509', '-checkend', '3600', '-noout', '-in', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function createMockTls(tlsDir, commonName = 'OpenCreator Codex Mock CA') {
  mkdirSync(tlsDir, { recursive: true });
  // The certificates live for 2 days; regenerate cached ones that are about to expire.
  if (!existsSync(join(tlsDir, 'server.pem')) || !certificateValidForAnHour(join(tlsDir, 'server.pem'))
    || !certificateValidForAnHour(join(tlsDir, 'ca.pem'))) {
    for (const name of ['ca.key', 'ca.pem', 'ca.srl', 'server.key', 'server.csr', 'server.pem']) {
      rmSync(join(tlsDir, name), { force: true });
    }
    writeFileSync(join(tlsDir, 'ca.cnf'), [
      '[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', `CN = ${commonName}`,
      '[v3_ca]', 'basicConstraints = critical,CA:TRUE', 'keyUsage = critical,keyCertSign,cRLSign', ''
    ].join('\n'));
    writeFileSync(join(tlsDir, 'server.cnf'), [
      'subjectAltName = IP:127.0.0.1', 'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature,keyEncipherment', 'extendedKeyUsage = serverAuth', ''
    ].join('\n'));
    const openssl = (...args) => execFileSync('openssl', args, { cwd: tlsDir, stdio: 'ignore' });
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2',
      '-config', 'ca.cnf', '-extensions', 'v3_ca');
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1');
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'server.pem', '-days', '2', '-extfile', 'server.cnf');
  }
  return { tlsDir, caPath: join(tlsDir, 'ca.pem') };
}

export function compareVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function decodeBody(raw, encoding) {
  try {
    if (encoding === 'zstd') return zlib.zstdDecompressSync(raw).toString('utf8');
    if (encoding === 'gzip') return zlib.gunzipSync(raw).toString('utf8');
  } catch {
    return '';
  }
  return raw.toString('utf8');
}

function writeEvent(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function sse(res, events, { end = true } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) writeEvent(res, event);
  if (end) res.end();
}

const usage = {
  input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11
};

// A complete Responses stream with a single assistant text message.
export function textReplyEvents(text, id = 'resp_mock') {
  const item = { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, usage } }
  ];
}

// A complete Responses stream whose only output is one function call.
export function functionCallEvents(name, args, id = 'resp_mock_call') {
  const item = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: 'completed' };
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, usage } }
  ];
}

// respond(context) may take over a /codex/responses request by returning true. The context
// carries the decoded body, request headers, the response object and the SSE helpers.
export function startMockBackend({ tlsDir, catalog, mode = 'record', respond }) {
  if (!zstdAvailable) {
    throw new Error(`The offline mock needs Node >= 22.15 for zstd request bodies (running ${process.version})`);
  }
  const requests = [];
  const bodies = [];
  let responseCount = 0;
  const record = (method, path, headers, extra = '') => {
    if (!/\/codex\/(models|responses)$/.test(path)) return;
    requests.push(`${method} ${path}${extra} version=${headers.version ?? '-'} originator=${headers.originator ?? '-'} routing-hint=${headers['x-codex-routing-hint'] ?? '-'}`);
  };
  const server = createServer({
    key: readFileSync(`${tlsDir}/server.key`),
    cert: readFileSync(`${tlsDir}/server.pem`)
  }, (req, res) => {
    const url = new URL(req.url, 'https://127.0.0.1');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = decodeBody(Buffer.concat(chunks), req.headers['content-encoding']);
      let body;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
      const clientVersion = req.headers.version ?? url.searchParams.get('client_version') ?? '0.0.0';
      if (req.method === 'GET' && url.pathname.endsWith('/wham/accounts/check')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          accounts: [{ id: 'acct_mock', can_access_with_session: true, plan_type: 'plus',
            workspace_backend_origin: 'NO_CONSTRAINT', account_routing_override: 'NO_CONSTRAINT', structure: 'personal' }],
          account_ordering: ['acct_mock'], default_account_id: 'acct_mock'
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/codex/models')) {
        record('GET', url.pathname, req.headers, `?client_version=${url.searchParams.get('client_version')}`);
        const models = mode === 'gate'
          ? catalog.models.filter(model => compareVersions(clientVersion, model.minimal_client_version ?? '0.0.0') >= 0)
          : catalog.models;
        res.writeHead(200, { 'content-type': 'application/json', etag: '"mock"' });
        res.end(JSON.stringify({ models }));
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/codex/responses')) {
        record('POST', url.pathname, req.headers, ` body.model=${body?.model ?? '-'}`);
        bodies.push({ model: body?.model, version: req.headers.version, input: JSON.stringify(body?.input ?? '') });
        const model = catalog.models.find(entry => entry.slug === body?.model);
        if (mode === 'gate' && (!model || compareVersions(clientVersion, model.minimal_client_version ?? '0.0.0') < 0)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'model_not_found',
            message: `The model '${body?.model}' does not exist or you do not have access to it.` } }));
          return;
        }
        responseCount += 1;
        const id = `resp_mock_${responseCount}`;
        if (respond?.({ body, headers: req.headers, res, id, sse, textReplyEvents, functionCallEvents, writeEvent }) === true) return;
        sse(res, textReplyEvents('OK', id));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not mocked' } }));
    });
  });
  server.on('upgrade', (req, socket) => {
    record('UPGRADE', new URL(req.url, 'https://127.0.0.1').pathname, req.headers);
    socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n');
  });
  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        origin: `https://127.0.0.1:${port}`,
        takeRequests: () => [...new Set(requests.splice(0))],
        responseBodies: () => [...bodies],
        close: () => new Promise(resolveClose => {
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        })
      });
    });
  });
}
