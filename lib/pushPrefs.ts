// What a device's notifications ping for until its person chooses (browser-safe: the settings' loading layout shows it).
import type { PushPrefs } from './types.ts';

export const DEFAULT_PREFS: PushPrefs = {
  questions: true,
  fixes: true,
  versions: false,
  clients: true,
  answers: true,
  posts: true,
  // an agent stopped (failed) or waits for your OK; one gone quiet for 30 min only when asked for
  agents: true,
  quiet: false,
};
