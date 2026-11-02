import { describe, expect, it } from 'vitest';
import {
  readIsolatedDesktopProfile,
  resolveDesktopUserDataPath,
  resolveIsolatedDesktopPaths
} from '../src/main/runtime-profile.js';

describe('Desktop runtime profile', () => {
  it('keeps the installed userData directory unchanged', () => {
    expect(resolveDesktopUserDataPath(
      '/Users/demo/Library/Application Support/OpenCreator',
      false
    )).toBe('/Users/demo/Library/Application Support/OpenCreator');
  });

  it('isolates development Electron state from the installed app', () => {
    expect(resolveDesktopUserDataPath(
      '/Users/demo/Library/Application Support/OpenCreator',
      true
    )).toBe('/Users/demo/Library/Application Support/OpenCreator Development');
  });

  it('reads an isolated test profile only from non-official build profiles', () => {
    expect(readIsolatedDesktopProfile({ officialBuild: false, isolatedProfile: 'codex-0166' })).toBe('codex-0166');
    expect(readIsolatedDesktopProfile({ officialBuild: true, isolatedProfile: 'codex-0166' })).toBeUndefined();
    expect(readIsolatedDesktopProfile({ officialBuild: false })).toBeUndefined();
    expect(readIsolatedDesktopProfile({ officialBuild: false, isolatedProfile: '../escape' })).toBeUndefined();
    expect(readIsolatedDesktopProfile(undefined)).toBeUndefined();
  });

  it('places every isolated data path outside the installed app data', () => {
    expect(resolveIsolatedDesktopPaths({
      appDataDir: '/Users/demo/Library/Application Support',
      homeDir: '/Users/demo',
      profile: 'codex-0166'
    })).toEqual({
      userData: '/Users/demo/Library/Application Support/OpenCreator Isolated codex-0166',
      openCreatorHome: '/Users/demo/.opencreator-isolated/codex-0166/home',
      defaultProjectRoot: '/Users/demo/.opencreator-isolated/codex-0166/Documents',
      envFile: '/Users/demo/.opencreator-isolated/codex-0166/home/.env.local'
    });
  });

  it('refuses the production data root but honours other explicit locations', () => {
    const base = { appDataDir: '/Users/demo/Library/Application Support', homeDir: '/Users/demo', profile: 'codex-0166' };
    expect(resolveIsolatedDesktopPaths({ ...base, configuredHome: '/Users/demo/.opencreator/' }).openCreatorHome)
      .toBe('/Users/demo/.opencreator-isolated/codex-0166/home');
    expect(resolveIsolatedDesktopPaths({ ...base, configuredEnvFile: '/Users/demo/.opencreator/.env.local' }).envFile)
      .toBe('/Users/demo/.opencreator-isolated/codex-0166/home/.env.local');
    expect(resolveIsolatedDesktopPaths({
      ...base,
      configuredHome: '/Volumes/test/oc-home',
      configuredProjectRoot: '/Volumes/test/projects',
      configuredEnvFile: '/Volumes/test/test.env'
    })).toMatchObject({
      openCreatorHome: '/Volumes/test/oc-home',
      defaultProjectRoot: '/Volumes/test/projects',
      envFile: '/Volumes/test/test.env'
    });
  });
});
