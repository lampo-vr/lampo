// Settings from the environment, in one place. They are named LAMPO_*. Before the command was `lampo` they were VR_*,
// and that spelling is still read: an env file, a CI job or an agent's saved setup from then keeps working unchanged.
// Every setting goes through `setting()`, so no reader has to know both spellings; a name that has only ever been
// LAMPO_ (LAMPO_OPERATOR, LAMPO_RUN) has no older spelling to fall back to. No Node imports: plain lookups.

/** Settings that were VR_<name> before they were LAMPO_<name>: what people set to run, configure or point Lampo. */
export const RENAMED = [
  // the server: where it listens, who reaches it, behind what
  'MODE',
  'HOST',
  'PORT',
  'LAN',
  'PUBLIC_URL',
  'MEDIA_ORIGIN',
  'SOURCE_URL',
  'TRUST_PROXY',
  'ALLOW_HTTP',
  'ALLOW_NO_PUBLIC_URL',
  'CLOUD_MODULE',
  // the store
  'HOME',
  'CONFIG',
  'DATA',
  'CACHE',
  'USER',
  'WORKSPACE',
  'UPLOAD_MAX',
  'MIN_FREE',
  'WORK_CACHE',
  'STORAGE',
  'BUNNY_ZONE',
  'BUNNY_ACCESS_KEY',
  'BUNNY_REGION',
  'BUNNY_CDN_URL',
  'BUNNY_TOKEN_KEY',
  'BUNNY_PREFIX',
  'BUNNY_STORAGE_URL',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PREFIX',
  'S3_PRESIGN',
  // the command and MCP: which store or server, as whom
  'REMOTE',
  'SERVER',
  'TOKEN',
  'PASSWORD',
  'BY',
  'NODE',
  'MCP_TOOLS',
  'MCP_LOG',
  'CLAUDE_BIN',
  'AGENT_RUN_TIMEOUT',
  'RENDER_WAIT_MS',
  // accounts, mail, links, the team
  'SIGNUP',
  'TERMS_URL',
  'PRIVACY_URL',
  'IMPRINT_URL',
  'WITHDRAWAL_URL',
  'CANCEL_URL',
  'SMTP_URL',
  'MAIL_FROM',
  'MAIL_REPLY_TO',
  'MAIL_PER_HOUR',
  'MAIL_PER_WORKSPACE_HOUR',
  'ORG_NAME',
  'PUSH_SUBJECT',
  'SESSION_DAYS',
  'SESSION_IDLE_DAYS',
  'WORKSPACE_CREATE',
  'WORKSPACE_CREATE_LIMIT',
  'ONBOARDING',
  'ONBOARDING_SAMPLE',
  'WEBHOOK_URL',
  'WEBHOOK_FORMAT',
  'WEBHOOK_SECRET',
  'WEBHOOK_EVENTS',
  'WEBHOOK_ALLOW_PRIVATE',
  'PUBLISH_ENDPOINTS',
  // media and the tools Lampo runs
  'FFMPEG',
  'FFPROBE',
  'MEDIA_TIMEOUT',
  'MAX_SIDE',
  'MAX_ASPECT',
  'MAX_DURATION',
  'OCR',
  'TESSERACT',
  'HUNSPELL',
  'STT',
  'STT_MODEL',
  'STT_LANGUAGES',
  'STT_VOCABULARY',
  'STT_THREADS',
  'STT_IDLE_MINUTES',
  'STT_PREFETCH',
  'STT_MODELS_DIR',
  'STT_URL',
  'STT_API_KEY',
  'STT_HTTP_MODEL',
  'FOOTAGE',
  'FOOTAGE_MODEL',
  'FOOTAGE_MODELS',
  'FOOTAGE_THREADS',
  'FOOTAGE_IDLE_MINUTES',
  'FOOTAGE_HWACCEL',
  // building the UI
  'STYLEGUIDE',
] as const;

/** The same for working on Lampo itself: the tests, the benches and the scripts that make the docs' pictures. */
export const RENAMED_DEV = [
  'TEST_JOBS',
  'TEST_MEDIA_CACHE',
  'TEST_VERBOSE',
  'UPDATE_SNAPSHOTS',
  'STT_TEST_MODEL',
  'E2E_JOBS',
  'E2E_SUITE_MINUTES',
  'E2E_CPU',
  'E2E_SKIP_OK',
  'SHOTS',
  'CHECK',
  'PERF_TIMES',
  'PERF_STRICT',
  'UPDATE_BASELINE',
  'BASELINE_MISSING',
  'MOVING_BASE',
  'MOVING_EMAIL',
  'MOVING_PASSWORD',
  'SAMPLE_FILM',
  'FOOTAGE_CACHE',
  'FONT',
  'ORT_SPIN',
] as const;

/** Settings that were born LAMPO_: read as they are, with no older spelling (a VR_OPERATOR never meant anything). */
export const LAMPO_ONLY = ['LAMPO_OPERATOR', 'LAMPO_RUN', 'LAMPO_TEST_CLI'] as const;

type Renamed = (typeof RENAMED)[number] | (typeof RENAMED_DEV)[number];
export type SettingName = `LAMPO_${Renamed}` | (typeof LAMPO_ONLY)[number];
type Env = Record<string, string | undefined>;

const NEW = 'LAMPO_';
const OLD = 'VR_';
const renamed = new Set<string>([...RENAMED, ...RENAMED_DEV]);

/** The older spelling of a setting (`LAMPO_DATA` → `VR_DATA`), or null for one that has none. */
export function oldSpelling(name: string): string | null {
  const rest = name.startsWith(NEW) ? name.slice(NEW.length) : null;
  return rest !== null && renamed.has(rest) ? OLD + rest : null;
}

/**
 * A setting's value: LAMPO_<name>, else VR_<name>. An empty LAMPO_ value counts as unset while the VR_ one has a
 * value (an env file that lists every name, some left empty, keeps what the other spelling says); empty on its own,
 * it stays empty (`LAMPO_STT_LANGUAGES=` still means "none").
 */
export function setting(name: SettingName, env: Env = process.env): string | undefined {
  const value = env[name];
  if (value !== undefined && value !== '') return value;
  const old = oldSpelling(name);
  const before = old === null ? undefined : env[old];
  return before !== undefined ? before : value;
}

/**
 * The name a message gives a setting: the spelling the operator wrote (an env file still in VR_ reads VR_TRUST_PROXY
 * back), else the new one, LAMPO_<name>, for a setting to set.
 */
export function spelledAs(name: SettingName, env: Env = process.env): string {
  const value = env[name];
  if (value !== undefined && value !== '') return name;
  const old = oldSpelling(name);
  return old !== null && env[old] !== undefined && env[old] !== '' ? old : name;
}

/**
 * Settings that only make sense together (a server and its token), from one spelling: the LAMPO_ pair when either of
 * it is set, else the VR_ pair. Never one spelling's server with the other's token.
 */
export function settingPair(a: SettingName, b: SettingName, env: Env = process.env): [string | undefined, string | undefined] {
  const given = (n: string | null) => (n !== null && env[n] !== undefined && env[n] !== '' ? env[n] : undefined);
  if (given(a) !== undefined || given(b) !== undefined) return [given(a), given(b)];
  return [given(oldSpelling(a)), given(oldSpelling(b))];
}

/**
 * What the Docker image sets for itself in the older spelling (its ENV, kept VR_ so a run-time value of either
 * spelling wins): a LAMPO_ value given at run time is meant to replace these, so it is no conflict.
 */
export const IMAGE_DEFAULTS: Readonly<Record<string, string>> = {
  VR_MODE: 'server',
  VR_HOME: '/data',
  VR_PORT: '4747',
  VR_STT_PREFETCH: '1',
  VR_USER: 'admin',
};

/**
 * Settings given in both spellings, differently, by name (never a value): an empty LAMPO_ one leaves the VR_ one in
 * force, a non-empty one replaces it. Either can surprise someone halfway through renaming an env file.
 */
export function spellingConflicts(env: Env = process.env): { name: string; old: string; empty: boolean }[] {
  const out: { name: string; old: string; empty: boolean }[] = [];
  for (const rest of RENAMED) {
    const name = NEW + rest;
    const old = OLD + rest;
    const now = env[name];
    const before = env[old];
    if (now === undefined || before === undefined || before === '' || now === before) continue;
    if (now !== '' && IMAGE_DEFAULTS[old] === before) continue;
    out.push({ name, old, empty: now === '' });
  }
  return out;
}

/** One line a server says at start for each of them. */
export const spellingWarnings = (env: Env = process.env): string[] =>
  spellingConflicts(env).map((c) =>
    c.empty
      ? `warning: ${c.name} is empty, so ${c.old} still applies (an empty LAMPO_ setting leaves the older one in force): remove ${c.old}, or give ${c.name} a value`
      : `warning: ${c.name} and ${c.old} are both set, differently: ${c.name} applies; remove ${c.old}`,
  );

/** Every setting by its LAMPO_ name, each read as `setting()` reads it. */
export type Settings = { readonly [K in SettingName]?: string };

/**
 * The settings of an environment as one object (`s.LAMPO_PORT`), read when asked: for code that reads several, so a
 * check and its use name the same thing (`if (s.LAMPO_PORT) port = Number(s.LAMPO_PORT)`).
 */
export function settingsIn(env: Env): Settings {
  return new Proxy({} as Settings, { get: (_, name) => (typeof name === 'string' ? setting(name as SettingName, env) : undefined) });
}

/** This process's settings, read from `process.env` at each use (tests change it as they go). */
export const settings: Settings = new Proxy({} as Settings, {
  get: (_, name) => (typeof name === 'string' ? setting(name as SettingName, process.env) : undefined),
});

/**
 * The environment with every renamed setting under both spellings, as `setting()` resolves it: for code that reads
 * the variables itself (the Cloud module, VR_CLOUD_MODULE), whichever spelling the operator used.
 */
export function bothSpellings(env: Env = process.env): Env {
  const out: Env = { ...env };
  for (const rest of renamed) {
    const value = setting(`${NEW}${rest}` as SettingName, env);
    if (value === undefined) continue;
    out[NEW + rest] = value;
    out[OLD + rest] = value;
  }
  return out;
}

/** The LAMPO_ names of the settings above (what a test strips from its own environment so its VR_ values count). */
export const LAMPO_NAMES: readonly string[] = RENAMED.map((rest) => NEW + rest);
