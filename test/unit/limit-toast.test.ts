// A plan's refusal (a 402) opens the limit's sheet, not a toast (web/src/lib/toast.ts → the toaster in ui/layers.tsx
// loads conversion/limits/LimitSheet.tsx): what reaches the toaster is the refusal's reason and numbers with what the page
// knows was asked for (the file or the person, and how to ask again once there is room); any other error stays a toast.
// Asked before the toaster is there, it waits in the same queue as a toast does.
import assert from 'node:assert/strict';
import test from 'node:test';

const target = new EventTarget();
(globalThis as unknown as { window: EventTarget }).window = target;
const seen: { message: string; kind: string; limit?: Record<string, unknown>; action?: unknown }[] = [];
target.addEventListener('vr-toast', (e) => seen.push((e as CustomEvent).detail));
// the browser's modules, by a path the backend's typecheck doesn't follow (it has no DOM types): their shapes, here
interface Toasts {
  claimToasts: () => { limit?: Record<string, unknown> }[];
  releaseToasts: () => void;
  toastError: (e: unknown) => void;
  toastFailed: (e: unknown, ask?: Record<string, unknown>) => void;
}
type ApiErrorClass = new (message: string, status: number, retryAfter?: number | null, details?: Record<string, unknown>) => Error;
const web: string = '../../web/src';
const { claimToasts, releaseToasts, toastError, toastFailed } = (await import(`${web}/lib/toast.ts`)) as Toasts;
const { ApiError } = (await import(`${web}/api/client.ts`)) as { ApiError: ApiErrorClass };

test('a 402 opens the limit’s sheet with the refusal’s numbers; another error is a toast', () => {
  seen.length = 0;
  toastError(new ApiError('This workspace’s plan has no room for this file.', 402, null, { reason: 'storage', needed: 1.8e9, fits: 'solo' }));
  const sheet = seen.at(-1);
  assert.ok(sheet?.limit, `a sheet, not a toast: ${JSON.stringify(sheet)}`);
  assert.equal(sheet.limit.reason, 'storage');
  assert.equal(sheet.limit.needed, 1.8e9);
  assert.equal(sheet.limit.fits, 'solo');
  assert.equal(sheet.limit.message, 'This workspace’s plan has no room for this file.');
  assert.equal(sheet.action, undefined, 'no “See plans” toast button: the sheet is the way on');
  // what the page knows: who is invited, and the invite again once there is room
  let again = 0;
  toastFailed(new ApiError('No room for another member.', 402, null, { reason: 'members' }), { needed: 'ben@example.com', name: 'Ben', retry: () => again++ });
  const invite = seen.at(-1)?.limit;
  assert.equal(invite?.name, 'Ben');
  assert.equal(invite?.needed, 'ben@example.com');
  assert.equal(typeof invite?.retry, 'function');
  (invite as { retry: () => void }).retry();
  assert.equal(again, 1);
  toastError(new ApiError('the server could not use this file', 422));
  assert.equal(seen.at(-1)?.limit, undefined);
  assert.equal(seen.at(-1)?.message, 'the server could not use this file');
});

test('as a mutation’s onError (error, variables), the variables are never taken for what was asked', () => {
  seen.length = 0;
  (toastError as unknown as (e: unknown, v: unknown) => void)(new ApiError('Full.', 402, null, { reason: 'members' }), { name: 'not a person', retry: 1 });
  assert.equal(seen.at(-1)?.limit?.name, undefined);
});

test('asked before the toaster is there, the sheet waits in the queue', () => {
  claimToasts();
  releaseToasts();
  toastError(new ApiError('Full.', 402, null, { reason: 'storage' }));
  const waiting = claimToasts();
  assert.equal(waiting.at(-1)?.limit?.reason, 'storage');
  releaseToasts();
});
