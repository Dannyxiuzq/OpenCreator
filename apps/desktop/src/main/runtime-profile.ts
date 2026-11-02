import { basename, dirname, join, resolve } from 'node:path';

export function resolveDesktopUserDataPath(
  defaultPath: string,
  development: boolean
): string {
  if (!development) return defaultPath;
  return join(
    dirname(defaultPath),
    `${basename(defaultPath)} Development`
  );
}

// Must stay in sync with apps/desktop/scripts/isolated-profile.mjs.
const ISOLATED_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function readIsolatedDesktopProfile(buildProfile: unknown): string | undefined {
  if (typeof buildProfile !== 'object' || buildProfile === null) return undefined;
  const profile = buildProfile as Record<string, unknown>;
  if (profile.officialBuild === true) return undefined;
  const value = profile.isolatedProfile;
  return typeof value === 'string' && ISOLATED_PROFILE_PATTERN.test(value) ? value : undefined;
}

export type IsolatedDesktopPaths = {
  userData: string;
  openCreatorHome: string;
  defaultProjectRoot: string;
  envFile: string;
};

export function resolveIsolatedDesktopPaths(input: {
  appDataDir: string;
  homeDir: string;
  profile: string;
  configuredHome?: string;
  configuredProjectRoot?: string;
  configuredEnvFile?: string;
}): IsolatedDesktopPaths {
  const root = join(input.homeDir, '.opencreator-isolated', input.profile);
  const productionHome = resolve(input.homeDir, '.opencreator');
  const configuredHome = input.configuredHome?.trim();
  // An isolated build never runs on the production data root, even if it is configured.
  const openCreatorHome = configuredHome !== undefined && configuredHome !== ''
    && resolve(configuredHome) !== productionHome
    ? resolve(configuredHome)
    : join(root, 'home');
  const configuredProjectRoot = input.configuredProjectRoot?.trim();
  // The daemon otherwise falls back to ~/.opencreator/.env.local for provider credentials.
  const configuredEnvFile = input.configuredEnvFile?.trim();
  const envFile = configuredEnvFile !== undefined && configuredEnvFile !== ''
    && resolve(configuredEnvFile) !== join(productionHome, '.env.local')
    ? resolve(configuredEnvFile)
    : join(openCreatorHome, '.env.local');
  return {
    userData: join(input.appDataDir, `OpenCreator Isolated ${input.profile}`),
    openCreatorHome,
    defaultProjectRoot: configuredProjectRoot !== undefined && configuredProjectRoot !== ''
      ? resolve(configuredProjectRoot)
      : join(root, 'Documents'),
    envFile
  };
}
