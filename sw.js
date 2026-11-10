// v4.16 · Etapa 7: service worker de retiro. Borra la caché de la app vieja, se da de baja y recarga las ventanas
// abiertas, que ahora reciben la página de redirección hacia /sige-jaguares/.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  const ks = await caches.keys();
  await Promise.all(ks.filter(k => !/^sige4/.test(k)).map(k => caches.delete(k)));
  await self.registration.unregister();
  const cs = await self.clients.matchAll({ type: "window" });
  cs.forEach(c => { try { c.navigate(c.url); } catch (x) {} });
})()));
