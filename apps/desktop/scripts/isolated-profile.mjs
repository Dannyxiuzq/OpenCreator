// Isolated test profiles: an unsigned, non-official `--dir` package that can be installed
// next to the production app without sharing its bundle id, Electron userData or OpenCreator
// data root. The runtime side lives in src/main/runtime-profile.ts.
export const ISOLATED_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function resolveIsolatedProfile(input) {
  const value = input.requested?.trim();
  if (value === undefined || value === '') return undefined;
  if (!ISOLATED_PROFILE_PATTERN.test(value)) {
    throw new Error('OPENCREATOR_DESKTOP_ISOLATED_PROFILE must match ^[a-z0-9][a-z0-9-]{0,31}$');
  }
  if (input.officialBuild || input.mode !== 'dir' || input.signed) {
    throw new Error('Isolated test profiles are only allowed for unsigned, non-official --dir packages');
  }
  return value;
}

// Only plain string overrides: electron-builder does not coerce "null" for `protocols`
// and merges array options from the CLI into the file config, so the opencreator://
// declaration stays in the bundle. The isolated app never registers itself as the
// default handler (src/main/main.ts), so links keep opening the installed app.
export function isolatedProfileBuilderArguments(profile, platform) {
  if (profile === undefined) return [];
  return [
    `--config.appId=com.opencreator.desktop.isolated.${profile}`,
    ...(platform === 'linux' ? ['--config.linux.executableName=opencreator'] : [])
  ];
}
