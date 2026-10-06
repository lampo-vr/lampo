// Push notifications on this device: what the platform allows, subscribing with the server's key, and the device's
// preferences. The server decides what is worth a notification (lib/push); the device decides which kinds it wants.
import type { PushPrefs, PushState } from '../../../lib/types.ts';
import { api, enc } from '../api/client.ts';
import { t } from '../i18n/index.ts';

export type PushSupport =
  | { ok: true }
  /** iOS only allows notifications for apps added to the Home Screen. */
  | { ok: false; reason: 'ios-install' | 'insecure' | 'unsupported' | 'denied' };

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  if (isIOS() && !isStandalone()) return { ok: false, reason: 'ios-install' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, reason: 'unsupported' };
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  return { ok: true };
}

/** A name for this device in lists ("iPhone", "Android phone", "Mac"). */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? t('Android phone') : t('Android tablet');
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return t('Windows PC');
  return t('This device');
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

export async function currentEndpoint(): Promise<string | null> {
  const reg = await registration();
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
}

export async function pushState(): Promise<PushState> {
  const endpoint = await currentEndpoint();
  return api<PushState>(`/api/push${endpoint ? `?endpoint=${enc(endpoint)}` : ''}`);
}

/** Asks for permission (a tap is required on iOS) and registers this device with the server. */
export async function enablePush(prefs?: Partial<PushPrefs>): Promise<PushState> {
  const reg = (await registration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(t('Notifications were not allowed on this device.'));
  const { publicKey } = await api<PushState>('/api/push');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return api<PushState>('/api/push/subscribe', {
    method: 'POST',
    body: { subscription: { endpoint: json.endpoint, keys: json.keys }, name: deviceName(), prefs },
  });
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  try {
    return sub ? await api<PushState>('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }) : await pushState();
  } finally {
    // This browser stops whatever the server answered (offline, or signed out already: it forgets the device then).
    await sub?.unsubscribe().catch(() => {});
  }
}

export async function setPrefs(prefs: Partial<PushPrefs>): Promise<PushState> {
  const endpoint = await currentEndpoint();
  if (!endpoint) throw new Error(t('Notifications are off on this device.'));
  return api<PushState>('/api/push/prefs', { method: 'PATCH', body: { endpoint, prefs } });
}

export async function testPush(): Promise<void> {
  const endpoint = await currentEndpoint();
  if (!endpoint) throw new Error(t('Notifications are off on this device.'));
  await api('/api/push/test', { method: 'POST', body: { endpoint } });
}
