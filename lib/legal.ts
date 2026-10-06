// The operator's legal pages, linked where people meet the server: the imprint and the privacy policy on every way in
// (sign-in, sign-up, a review link's pages) and in Settings → About; the terms where people sign up and buy; the
// withdrawal information beside the checkout's order button; the page where a contract is cancelled (§ 312k BGB) beside
// the imprint wherever a billing provider runs. The texts are the operator's own (their lawyer's): the app only links
// them, so each is an http(s) URL from the environment or config.json. VR_TERMS_URL and VR_PRIVACY_URL predate these
// (lib/mail/config.ts reads them with sign-up, which refuses to open without them).
//   VR_IMPRINT_URL / imprint_url         who runs the server (§ 5 DDG): on every way in, review links included
//   VR_WITHDRAWAL_URL / withdrawal_url   the right of withdrawal, beside the checkout's order button
//   VR_CANCEL_URL / cancel_url           a page where anyone cancels a contract without signing in ("Cancel contracts
//                                        here"); without it the link opens Settings → Billing's own cancellation
import type { ConfigFile } from './paths.ts';

export interface LegalUrls {
  imprint_url: string | null;
  withdrawal_url: string | null;
  cancel_url: string | null;
}

const SETTINGS = [
  ['imprint_url', 'VR_IMPRINT_URL'],
  ['withdrawal_url', 'VR_WITHDRAWAL_URL'],
  ['cancel_url', 'VR_CANCEL_URL'],
] as const;

export function legalConfig(file: ConfigFile, env: NodeJS.ProcessEnv): LegalUrls {
  const out = { imprint_url: null, withdrawal_url: null, cancel_url: null } as LegalUrls;
  for (const [key, name] of SETTINGS) out[key] = env[name]?.trim() || file[key]?.trim() || null;
  return out;
}

/** An address people open in their browser: http or https, nothing that runs. */
export function httpUrl(u: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

/** Settings the server must not start with, one sentence each: a link that isn't a web page. */
export function legalProblems(c: LegalUrls): string[] {
  return SETTINGS.filter(([key]) => c[key] && !httpUrl(c[key] as string)).map(([, name]) => `${name} must be an http(s) URL.`);
}
