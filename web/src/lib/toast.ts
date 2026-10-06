import { ApiError } from '../api/client.ts';
import type { LimitAsk } from '../conversion/facts.ts';
import { t } from '../i18n/index.ts';
export type ToastKind = 'info' | 'ok' | 'error';

export type { LimitAsk };
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** An Undo button carries the undo arrow. */
  undo?: boolean;
}
export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
  /** Called once when the toast goes away without its action being used (timed out, swiped, closed). */
  onDismiss?: () => void;
  /** ms on screen; the timer pauses while the pointer or focus is on the toast. */
  duration?: number;
  /** Not a toast: the limit's sheet (the toaster opens it). */
  limit?: LimitAsk;
}

// The toaster (ui/layers.tsx) arrives after the first paint: toasts asked for before it did wait here for it.
let claimed = false;
const early: ToastItem[] = [];

/** For the toaster: the toasts that came before it (it listens for the rest). */
export function claimToasts(): ToastItem[] {
  claimed = true;
  return early.splice(0);
}
export function releaseToasts(): void {
  claimed = false;
}

// action: optional {label, onClick} rendered as a button in the toast (e.g. Undo).
export function toast(message: string, kind: ToastKind = 'info', action?: ToastAction, more: Pick<ToastItem, 'onDismiss' | 'duration'> = {}) {
  show(message, kind, action, more);
}

/** Opens the limit's sheet: what was asked for and why there is no room, what fits, paying in place, making room. */
export const openLimit = (limit: LimitAsk) => show(limit.message ?? '', 'error', undefined, { limit });

/** `toast`, returning the toast's id (for closeToast). */
function show(message: string, kind: ToastKind, action?: ToastAction, more: Pick<ToastItem, 'onDismiss' | 'duration' | 'limit'> = {}): number {
  const item: ToastItem = { message, kind, action, id: Math.random(), ...more };
  if (!claimed) early.push(item);
  window.dispatchEvent(new CustomEvent<ToastItem>('vr-toast', { detail: item }));
  return item.id;
}

/** Takes a toast away without it counting as dismissed (its `onDismiss` doesn't run). */
export function closeToast(id: number) {
  const i = early.findIndex((x) => x.id === id);
  if (i >= 0) early.splice(i, 1);
  window.dispatchEvent(new CustomEvent<number>('vr-toast-close', { detail: id }));
}

/** Something that has been done and can be taken back: the toast offers Undo for a few seconds. */
export function toastUndo(message: string, undo: () => unknown) {
  toast(message, 'ok', { label: t('Undo'), undo: true, onClick: () => void Promise.resolve(undo()).catch(toastError) }, { duration: 7000 });
}

// Deletions that happen only once the toast is gone: until then the change is only on screen and Undo simply puts it
// back. A tab that closes or reloads in the meantime still sends them (fetch keepalive): on beforeunload, because
// Chrome drops a keepalive request started in pagehide on a reload, and on pagehide for the browsers without
// beforeunload (iOS). `run` takes itself out of `pending`, so nothing goes twice.
const pending = new Map<number, () => void>();
if (typeof window !== 'undefined') {
  const sendAll = () => {
    for (const run of [...pending.values()]) run();
  };
  window.addEventListener('beforeunload', sendAll);
  window.addEventListener('pagehide', sendAll);
}

export function later({
  message,
  apply,
  revert,
  commit,
  ms = 7000,
}: {
  message: string;
  apply: () => void;
  revert: () => void;
  commit: () => Promise<unknown>;
  ms?: number;
}): Deferred {
  const id = Math.random();
  let settled = false;
  const run = () => {
    if (settled) return;
    settled = true;
    pending.delete(id);
    commit().catch((e) => {
      revert();
      toastError(e);
    });
  };
  apply();
  pending.set(id, run);
  const shown = show(
    message,
    'ok',
    {
      label: t('Undo'),
      undo: true,
      onClick: () => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        revert();
      },
    },
    { onDismiss: run, duration: ms },
  );
  return {
    flush: () => {
      if (settled) return;
      closeToast(shown);
      run();
    },
    drop: () => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      closeToast(shown);
    },
  };
}

/** A change `later` holds back. */
export interface Deferred {
  /** Sends it now; its toast goes. */
  flush: () => void;
  /** Forgets it without sending or undoing it (a newer change took its place); its toast goes. */
  drop: () => void;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** An error as a toast; a plan's refusal (402) opens the limit's sheet (`ask`: what the page knows was asked for). */
export const toastFailed = (e: unknown, ask?: LimitAsk) =>
  e instanceof ApiError && e.status === 402 ? openLimit({ ...e.details, message: e.message, ...ask }) : toast(errorMessage(e), 'error');
/** One argument only: it is handed to `.catch` and to a mutation's `onError` (whose second argument isn't an ask). */
export const toastError = (e: unknown) => toastFailed(e);

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
