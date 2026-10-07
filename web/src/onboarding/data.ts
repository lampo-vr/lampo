// The first run's data, shared by Get started (GetStarted.tsx) and the setup (Setup.tsx), never by the first paint
// (what only the setup writes, like the personas, is in steps.tsx: Get started never loads the workspaces' code):
// where it stands now, putting it away (the card, or everything for good) and bringing it back, the setup finished, the
// agent picked, the workspace's
// personas, the sample, a self-hosted server's health check and test mail, the machine's folders with videos.
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatus, MailTestResult, OnboardingPrefs, OnboardingResponse, OnboardingUpdate, ServerHealth, SetupAgent } from '../../../lib/types.ts';
import { authKeys } from '../api/auth.ts';
import { api } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import { currentLang, t } from '../i18n/index.ts';
import { later } from '../lib/toast.ts';
import { endSetupHere } from './state.ts';

export const onboardingKey = ['onboarding'] as const;

/** GET /api/onboarding/folders (the machine only): folders that hold videos, newest first. */
export interface OnboardingFolders {
  folders: { path: string; count: number; files: { name: string; path: string; size: number | null; mtime: string | null }[] }[];
}

/** What the server recorded goes into the account as cached, so every reader (the account menu too) agrees. */
export function keepFirstRun(qc: QueryClient, o: OnboardingPrefs | null): void {
  qc.setQueryData<AuthStatus>(authKeys.status, (s) => {
    const user = s?.user;
    if (!user || JSON.stringify(user.prefs?.onboarding ?? null) === JSON.stringify(o)) return s;
    const { onboarding: _, ...prefs } = user.prefs ?? {};
    return { ...s, user: { ...user, prefs: o ? { ...prefs, onboarding: o } : prefs } };
  });
}

/** Where the first run stands now: the steps the server found done, the sample, the video the steps open. */
export function useOnboarding(enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: onboardingKey,
    enabled,
    queryFn: async () => {
      const r = await api<OnboardingResponse>('/api/onboarding');
      // read while a change is on its way: shown with it, never undoing it (the setup’s end lost, a pick forgotten)
      const o = withWrites(r.onboarding);
      keepFirstRun(qc, o);
      return { ...r, onboarding: o };
    },
  });
}

/** A change to the account's first run (PUT /api/onboarding), written into the cache as the server answered it. The
 * account's copy is changed at once (optimistic): the setup moves on without waiting. */
/** The changes on their way to the server (`update`): an answer read meanwhile is shown with them on top. */
const onTheWay = new Set<(o: OnboardingPrefs) => OnboardingPrefs>();
const withWrites = (o: OnboardingPrefs | null): OnboardingPrefs | null => (o ? [...onTheWay].reduce((x, guess) => guess(x), o) : o);

async function update(qc: QueryClient, change: OnboardingUpdate, guess?: (o: OnboardingPrefs) => OnboardingPrefs): Promise<OnboardingResponse> {
  const before = qc.getQueryData<AuthStatus>(authKeys.status)?.user?.prefs?.onboarding ?? null;
  if (before && guess) keepFirstRun(qc, guess(before));
  if (guess) onTheWay.add(guess);
  try {
    const r = await api<OnboardingResponse>('/api/onboarding', { method: 'PUT', body: change });
    if (guess) onTheWay.delete(guess);
    const o = withWrites(r.onboarding);
    qc.setQueryData(onboardingKey, { ...r, onboarding: o });
    keepFirstRun(qc, o);
    return r;
  } catch (e) {
    if (guess) onTheWay.delete(guess);
    if (before && guess) keepFirstRun(qc, before);
    throw e;
  }
}

/** Puts the card away (its ×: the sidebar's row stays) or brings it back (the account menu's "Get started"). */
export async function setHidden(qc: QueryClient, hidden: boolean): Promise<void> {
  await update(qc, { hidden });
}

const firstRunOf = (qc: QueryClient) => qc.getQueryData<AuthStatus>(authKeys.status)?.user?.prefs?.onboarding ?? null;

/**
 * "Hide for good": the card and the sidebar's row go at once, with Undo; the account hears it once the toast is gone
 * (lib/toast.ts later: sent on leaving the page too). Until then an answer read meanwhile is shown with it on top. Where
 * the account menu shows (a desk, a tablet, an empty library on a phone) it still brings Get started back.
 */
export function hideForGood(qc: QueryClient, menu: boolean): void {
  const before = firstRunOf(qc);
  if (!before || before.dismissed) return;
  const at = new Date().toISOString();
  const guess = (o: OnboardingPrefs): OnboardingPrefs => (o.dismissed ? o : { ...o, dismissed: at });
  later({
    message: menu ? t('Get started is hidden. Your account menu still has it.') : t('Get started is hidden.'),
    apply: () => {
      onTheWay.add(guess);
      const o = firstRunOf(qc);
      if (o) keepFirstRun(qc, guess(o));
    },
    revert: () => {
      onTheWay.delete(guess);
      const o = firstRunOf(qc);
      if (!o?.dismissed) return;
      const { dismissed: _, ...rest } = o;
      keepFirstRun(qc, rest);
    },
    commit: () => update(qc, { dismissed: true }).finally(() => onTheWay.delete(guess)),
  });
}

/** Back from the account menu: the sidebar's row (hidden for good no longer), and the card too when `card`. */
export async function comeBack(qc: QueryClient, card: boolean): Promise<void> {
  const o = firstRunOf(qc);
  if (!o?.dismissed && !(card && o?.hidden)) return;
  await update(qc, card ? { hidden: false, dismissed: false } : { dismissed: false }, ({ dismissed: _, hidden, ...rest }) =>
    card || !hidden ? rest : { ...rest, hidden },
  );
}

/** The setup is over (finished or skipped): it doesn't show again. Get started then asks where things stand (what the
 * setup did — an agent connected, invites sent — is recorded by GET /api/onboarding, not by this answer). */
export async function finishSetup(qc: QueryClient): Promise<void> {
  endSetupHere(qc.getQueryData<AuthStatus>(authKeys.status)?.user?.id);
  await update(qc, { setup: 'done' }, (o) => ({ ...o, setup_done: o.setup_done ?? new Date().toISOString() }));
  void qc.invalidateQueries({ queryKey: onboardingKey });
}

/** The agent picked in the setup or in Get started: their words name it. */
export const pickAgent = (qc: QueryClient, agent: SetupAgent) => update(qc, { agent }, (o) => ({ ...o, agent }));

const refresh = (qc: QueryClient) => Promise.all([qc.invalidateQueries({ queryKey: onboardingKey }), qc.invalidateQueries({ queryKey: keys.library })]);

/** "Try it with a sample": made on the server in this page's language (a second ask gets the one there is); its slug. */
export async function makeSample(qc: QueryClient): Promise<string> {
  const r = await api<{ slug: string }>('/api/onboarding/sample', { method: 'POST', body: { lang: currentLang() } });
  await refresh(qc);
  return r.slug;
}

/** The sample goes for good (it is never archived; the first run offers it again). */
export async function removeSample(qc: QueryClient): Promise<void> {
  await api('/api/onboarding/sample', { method: 'DELETE' });
  await refresh(qc);
}

/** A self-hosted server's health check (whoever runs it: lib/operator.ts). */
export const healthKey = ['server-health'] as const;
export const useServerHealth = (enabled: boolean) =>
  useQuery({ queryKey: healthKey, enabled, queryFn: () => api<ServerHealth>('/api/server/health'), staleTime: Number.POSITIVE_INFINITY });

/** A test mail to the asker's own address, through the server's relay (or its outbox). */
export const mailTest = () => api<MailTestResult>('/api/server/mail-test', { method: 'POST' });

/** Folders on this machine that hold videos (the local setup's renders step). */
export const useFolders = (enabled: boolean) =>
  useQuery({ queryKey: ['onboarding-folders'], enabled, queryFn: () => api<OnboardingFolders>('/api/onboarding/folders'), staleTime: 60_000 });

/** Links files where they are (the machine): each one a video in the library; nothing is copied. */
export async function linkVideos(qc: QueryClient, paths: string[]): Promise<number> {
  let n = 0;
  for (const path of paths) {
    await api('/api/library', { method: 'POST', body: { path } });
    n++;
  }
  await refresh(qc);
  return n;
}
