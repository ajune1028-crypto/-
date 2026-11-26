// 공유로 받기 (the owner, 26 November: "다른 진짜 녹음 어플로 들어가서 녹음, 거기도 저장되고 여기로 또
// 옮겨지고"): on the public address the app can be put on the home screen (Chrome on Android); then
// the phone's recorder app's '공유' lists it, and a sound sent that way comes into 비서's 녹음 (sw.js
// keeps it, this file takes it). Inside Claude's trial page, or on a computer's local copy, nothing
// here does anything.

const SHARED = "hamkke-share";

function params() {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
}

/** Whether this page can be put on the home screen with a share sheet entry (a public https address, not framed). */
export function canShareIn() {
  try {
    if (!("serviceWorker" in navigator) || !window.isSecureContext || window.top !== window) return false;
    return location.protocol === "https:" || params().has("sw");
  } catch {
    return false;
  }
}

/** Already on the home screen (opened from its icon). */
export function onHomeScreen() {
  try {
    return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  } catch {
    return false;
  }
}

/** The manifest and the service worker, where they can work. Never throws; nothing waits on it. */
export function offerShareIn() {
  if (!canShareIn()) return;
  try {
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = "manifest.webmanifest";
      document.head.append(link);
    }
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn(err));
  } catch (err) {
    console.warn(err);
  }
}

/**
 * What the share sheet brought (?shared=<id>): the files, taken out of the cache and the address.
 * Resolves with [] when nothing came.
 */
export async function takeShared() {
  const id = params().get("shared");
  if (!id || !/^[a-z0-9]+$/.test(id)) return [];
  try {
    const url = new URL(location.href);
    url.searchParams.delete("shared");
    url.searchParams.delete("n");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    // the address stays as it is
  }
  try {
    const cache = await caches.open(SHARED);
    const keys = (await cache.keys()).filter((req) => new URL(req.url).pathname.includes(`/shared/${id}/`));
    keys.sort((a, b) => Number(a.url.split("/").pop()) - Number(b.url.split("/").pop()));
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) {
        const blob = await res.blob();
        let name = "녹음";
        try {
          name = decodeURIComponent(res.headers.get("x-name") || "") || name;
        } catch {
          // a name it could not read
        }
        files.push(new File([blob], name, { type: res.headers.get("content-type") || blob.type || "" }));
      }
      await cache.delete(req);
    }
    return files;
  } catch (err) {
    console.warn(err);
    return [];
  }
}

/** The one line that tells how a recording already in the recorder app comes here, or null where it cannot. */
export function shareInHint() {
  if (onHomeScreen()) return "녹음 앱에 이미 있는 녹음은 그 앱의 '공유'에서 이 앱을 골라 보내요.";
  if (!canShareIn()) return null;
  return "녹음 앱에 이미 있는 녹음은 그 앱의 '공유'로 보내요. 크롬 메뉴 ⋮ → '홈 화면에 추가'를 한 번 하면 공유 목록에 이 앱이 나와요.";
}
