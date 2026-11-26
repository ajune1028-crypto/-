// The app's service worker, with one job: 공유로 받기 (Web Share Target). A sound shared from the
// phone's recorder app ('공유' → this app, once it is on the home screen) arrives as a form post to
// ./share. It is kept in Cache Storage and the app opens with ?shared=<id>, which takes it into 비서's
// 녹음 (ui/share-in.js). Nothing else is touched: no request is answered from a cache, so the app is
// always the newest one at its address.
//
// The way of it follows Squoosh's share target (GoogleChromeLabs/squoosh, Apache-2.0): the post is
// answered with a redirect into the app. Here the files wait in a cache instead of a message, so a
// slow start of the page loses nothing.

const SHARED = "hamkke-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || !url.pathname.endsWith("/share")) return;
  event.respondWith(
    (async () => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      let n = 0;
      try {
        const form = await event.request.formData();
        const cache = await caches.open(SHARED);
        for (const file of form.getAll("sound")) {
          if (!file || typeof file !== "object" || !("size" in file) || !file.size) continue;
          const headers = { "content-type": file.type || "application/octet-stream", "x-name": encodeURIComponent(file.name || "녹음") };
          await cache.put(new URL(`shared/${id}/${n}`, self.registration.scope).href, new Response(file, { headers }));
          n++;
        }
      } catch (err) {
        console.warn(err);
      }
      return Response.redirect(new URL(`./?shared=${id}&n=${n}`, self.registration.scope).href, 303);
    })(),
  );
});
