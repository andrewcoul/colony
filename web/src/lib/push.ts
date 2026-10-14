import { api } from "./api";

export type PushStatus = "unsupported" | "needs-install" | "insecure" | "blocked" | "off" | "on";

const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Registers the service worker and follows notification taps to their chat. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !isSecureContext) return;
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ type?: string; url?: string }>) => {
    if (event.data?.type === "open" && event.data.url) location.hash = new URL(event.data.url, location.origin).hash;
  });
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function pushStatus(): Promise<PushStatus> {
  if (!isSecureContext) return "insecure";
  // iOS only offers Web Push to apps added to the Home Screen.
  if (isIos() && !isStandalone()) return "needs-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const subscription = await currentSubscription();
  if (!subscription) return "off";
  // The server may have dropped it (e.g. a fresh data folder); re-register quietly.
  const { subscribed } = await api.pushStatus(subscription.endpoint);
  if (!subscribed) await api.pushSubscribe(subscription.toJSON());
  return "on";
}

function keyBytes(base64url: string) {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export async function enablePush(): Promise<PushStatus> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSubscribe(subscription.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushStatus> {
  const subscription = await currentSubscription();
  if (subscription) {
    await api.pushUnsubscribe(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  }
  return "off";
}
