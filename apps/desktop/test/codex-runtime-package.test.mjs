import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_RUNTIME_COMMIT,
  CODEX_RUNTIME_VERSION,
  readCodexRuntimeManifest,
  verifyCodexRuntime
} from '../scripts/codex-runtime-contract.mjs';
import { stageCodexRuntime } from '../scripts/prepare-codex-runtime.mjs';

let tempRoot = '';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shippedPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

describe('Codex Runtime package contract', () => {
  it('stages only manifest-pinned runtime and protocol files', () => {
    const fixture = createFixture();
    const result = stageCodexRuntime(fixture);

    expect(verifyCodexRuntime(result.outputRoot, process.platform, process.arch)).toMatchObject({
      version: '0.166.0',
      commit: '6ff1e1ca3b30fc8b914720681fcf5fe62e95f856'
    });
  });

  it('rejects wrong hashes, versions, platforms and extra files', () => {
    let fixture = createFixture();
    let result = stageCodexRuntime(fixture);
    writeFileSync(join(result.outputRoot, 'bin', executableName()), 'tampered');
    expect(() => verifyCodexRuntime(result.outputRoot, process.platform, process.arch)).toThrow(/hash mismatch/i);

    fixture = createFixture();
    result = stageCodexRuntime(fixture);
    expect(() => verifyCodexRuntime(result.outputRoot, process.platform, process.arch === 'x64' ? 'arm64' : 'x64')).toThrow(/targets/i);

    fixture = createFixture();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    manifest.version = '0.148.0';
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => stageCodexRuntime(fixture)).toThrow(/manifest is invalid/i);

    fixture = createFixture();
    result = stageCodexRuntime(fixture);
    writeFileSync(join(result.outputRoot, 'download-at-runtime.js'), 'fetch("https://example.com")');
    expect(() => verifyCodexRuntime(result.outputRoot, process.platform, process.arch)).toThrow(/file list differs/i);
  });

  it('extracts an integrity-pinned npm archive and rejects tampering', () => {
    const fixture = createFixture();
    const archiveRoot = join(tempRoot, 'archive');
    const vendorRoot = join(archiveRoot, 'package', 'vendor', 'fixture');
    const archivePath = join(tempRoot, 'codex.tgz');
    mkdirSync(dirname(vendorRoot), { recursive: true });
    cpSync(fixture.sourceRoot, vendorRoot, { recursive: true });
    execFileSync('tar', ['-czf', archivePath, '-C', archiveRoot, 'package']);

    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    manifest.sourceArchive.integrity = `sha512-${createHash('sha512')
      .update(readFileSync(archivePath))
      .digest('base64')}`;
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = stageCodexRuntime({
      archivePath,
      manifestPath: fixture.manifestPath,
      outputRoot: fixture.outputRoot,
      protocolRoot: fixture.protocolRoot
    });
    expect(verifyCodexRuntime(result.outputRoot, process.platform, process.arch))
      .toMatchObject({ version: '0.166.0' });

    writeFileSync(archivePath, 'tampered');
    expect(() => stageCodexRuntime({
      archivePath,
      manifestPath: fixture.manifestPath,
      outputRoot: fixture.outputRoot,
      protocolRoot: fixture.protocolRoot
    })).toThrow(/integrity mismatch/i);
  });

  it('stages the generated protocol snapshot named by the manifest by default', () => {
    const fixture = createFixture();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    const snapshot = JSON.parse(readFileSync(join(
      repositoryRoot, 'apps', 'daemon', 'src', 'codex', 'generated', 'v0_166_0', 'protocol-manifest.json'
    ), 'utf8'));
    manifest.appServerProtocol.schemaSha256 = snapshot.aggregateSha256;
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = stageCodexRuntime({
      manifestPath: fixture.manifestPath,
      outputRoot: fixture.outputRoot,
      sourceRoot: fixture.sourceRoot
    });
    expect(verifyCodexRuntime(result.outputRoot, process.platform, process.arch))
      .toMatchObject({ version: '0.166.0' });
    expect(readFileSync(join(result.outputRoot, 'protocol', 'v0_166_0', 'metadata.ts'), 'utf8'))
      .toContain("'rust-v0.166.0'");

    manifest.appServerProtocol.sourceVersion = '../v0_166_0';
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => stageCodexRuntime({
      manifestPath: fixture.manifestPath,
      outputRoot: fixture.outputRoot,
      sourceRoot: fixture.sourceRoot
    })).toThrow(/invalid app-server protocol source version/i);
  });

  it('keeps every shipped platform manifest aligned with the contract and protocol snapshot', () => {
    for (const platform of shippedPlatforms) {
      const manifest = readCodexRuntimeManifest(
        join(repositoryRoot, 'resources', 'codex-runtime', platform, 'manifest.json')
      );
      expect(`${manifest.platform}-${manifest.arch}`).toBe(platform);
      expect(manifest).toMatchObject({
        version: CODEX_RUNTIME_VERSION,
        tag: `rust-v${CODEX_RUNTIME_VERSION}`,
        commit: CODEX_RUNTIME_COMMIT,
        sourcePackage: `npm:@openai/codex@${CODEX_RUNTIME_VERSION}-${platform}`
      });
      expect(manifest.officialAsset)
        .toMatch(new RegExp(`/releases/download/rust-v${CODEX_RUNTIME_VERSION.replaceAll('.', '\\.')}/`));
      const sourceVersion = manifest.appServerProtocol.sourceVersion;
      expect(manifest.appServerProtocol.relativePath).toBe(`protocol/${sourceVersion}`);
      const snapshot = JSON.parse(readFileSync(join(
        repositoryRoot, 'apps', 'daemon', 'src', 'codex', 'generated', sourceVersion, 'protocol-manifest.json'
      ), 'utf8'));
      expect(snapshot).toMatchObject({
        sourceTag: manifest.tag,
        sourceCommit: manifest.commit,
        aggregateSha256: manifest.appServerProtocol.schemaSha256
      });
    }
  });

  it('does not download a missing archive in offline mode', () => {
    const fixture = createFixture();
    expect(() => stageCodexRuntime({
      cacheRoot: join(tempRoot, 'empty-cache'),
      manifestPath: fixture.manifestPath,
      offline: true,
      outputRoot: fixture.outputRoot,
      protocolRoot: fixture.protocolRoot
    })).toThrow(/cache is missing in offline mode/i);
  });
});

function createFixture() {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = mkdtempSync(join(tmpdir(), 'codex-runtime-contract-'));
  const sourceRoot = join(tempRoot, 'source');
  const protocolRoot = join(tempRoot, 'protocol');
  const outputRoot = join(tempRoot, 'output');
  const manifestPath = join(tempRoot, 'manifest.json');
  const binaryPath = join(sourceRoot, 'bin', executableName());
  mkdirSync(dirname(binaryPath), { recursive: true });
  writeFileSync(binaryPath, 'codex-0.149.0');

  const protocolFile = join(protocolRoot, 'typescript', 'v2', 'TurnStartParams.ts');
  mkdirSync(dirname(protocolFile), { recursive: true });
  writeFileSync(protocolFile, 'export type TurnStartParams = { threadId: string };\n');
  const protocolHash = sha256(readFileSync(protocolFile));
  writeFileSync(join(protocolRoot, 'metadata.ts'), 'export const source = "fixture";\n');
  writeFileSync(join(protocolRoot, 'protocol-manifest.json'), `${JSON.stringify({
    sourceTag: 'rust-v0.166.0',
    sourceCommit: '6ff1e1ca3b30fc8b914720681fcf5fe62e95f856',
    aggregateSha256: 'a'.repeat(64),
    files: { 'typescript/v2/TurnStartParams.ts': protocolHash }
  }, null, 2)}\n`);

  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    runtime: 'codex',
    version: '0.166.0',
    tag: 'rust-v0.166.0',
    commit: '6ff1e1ca3b30fc8b914720681fcf5fe62e95f856',
    platform: process.platform,
    arch: process.arch,
    officialAsset: 'https://example.test/codex.zip',
    sourcePackage: 'npm:@openai/codex@0.149.0-fixture',
    sourceArchive: {
      url: 'https://example.test/codex.tgz',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      vendorPath: 'package/vendor/fixture'
    },
    binary: { relativePath: `bin/${executableName()}`, sha256: sha256(readFileSync(binaryPath)) },
    appServerProtocol: {
      sourceVersion: 'v0_166_0',
      relativePath: 'protocol/v0_166_0',
      schemaSha256: 'a'.repeat(64)
    },
    resources: [{
      path: `bin/${executableName()}`,
      sha256: sha256(readFileSync(binaryPath)),
      kind: 'executable'
    }],
    builtAt: '2026-08-21T00:00:00.000Z'
  }, null, 2)}\n`);

  return { sourceRoot, protocolRoot, outputRoot, manifestPath };
}

function executableName() {
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
