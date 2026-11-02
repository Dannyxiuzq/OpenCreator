import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isolatedProfileBuilderArguments,
  resolveIsolatedProfile
} from '../scripts/isolated-profile.mjs';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromBuilder = createRequire(
  createRequire(join(desktopDir, 'package.json')).resolve('electron-builder')
);
const appBuilderLib = dirname(requireFromBuilder.resolve('app-builder-lib/package.json'));
const requireFromLib = createRequire(join(appBuilderLib, 'package.json'));

async function validateWithOverrides(overrides) {
  const { validateConfiguration } = requireFromLib('./out/util/config/config.js');
  const { DebugLogger } = requireFromLib('builder-util');
  const config = requireFromLib('js-yaml').load(readFileSync(join(desktopDir, 'electron-builder.yml'), 'utf8'));
  for (const argument of overrides) {
    const [path, value] = argument.replace(/^--config\./, '').split('=');
    const keys = path.split('.');
    let target = config;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  await validateConfiguration(config, new DebugLogger(false));
  return config;
}

describe('isolated Desktop test profile build inputs', () => {
  it('stays disabled unless a profile is requested', () => {
    expect(resolveIsolatedProfile({ requested: undefined, officialBuild: false, mode: 'dir', signed: false })).toBeUndefined();
    expect(resolveIsolatedProfile({ requested: '  ', officialBuild: true, mode: 'release', signed: true })).toBeUndefined();
    expect(isolatedProfileBuilderArguments(undefined, 'darwin')).toEqual([]);
  });

  it('accepts only unsigned, non-official directory packages', () => {
    expect(resolveIsolatedProfile({ requested: 'codex-0166', officialBuild: false, mode: 'dir', signed: false })).toBe('codex-0166');
    for (const input of [
      { officialBuild: true, mode: 'dir', signed: false },
      { officialBuild: false, mode: 'dist', signed: false },
      { officialBuild: false, mode: 'release', signed: false },
      { officialBuild: false, mode: 'dir', signed: true }
    ]) {
      expect(() => resolveIsolatedProfile({ requested: 'codex-0166', ...input })).toThrow(/only allowed/);
    }
    for (const requested of ['Codex', '../x', 'a b', '-lead', 'x'.repeat(33)]) {
      expect(() => resolveIsolatedProfile({ requested, officialBuild: false, mode: 'dir', signed: false })).toThrow(/must match/);
    }
  });

  it('gives the package its own bundle id through overrides electron-builder accepts', async () => {
    expect(isolatedProfileBuilderArguments('codex-0166', 'darwin')).toEqual([
      '--config.appId=com.opencreator.desktop.isolated.codex-0166'
    ]);
    const linux = isolatedProfileBuilderArguments('codex-0166', 'linux');
    expect(linux).toContain('--config.linux.executableName=opencreator');
    for (const platform of ['darwin', 'linux', 'win32']) {
      const config = await validateWithOverrides(isolatedProfileBuilderArguments('codex-0166', platform));
      expect(config.appId).toBe('com.opencreator.desktop.isolated.codex-0166');
    }
    // electron-builder keeps "null" as a string for protocols, so such an override would break the build.
    await expect(validateWithOverrides(['--config.protocols=null'])).rejects.toThrow(/protocols/);
  });
});
