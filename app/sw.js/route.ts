// Service worker for the installable app. It keeps nothing offline (the page is private and always live):
// page loads go to the network, and a friendly message shows when there is no connection.
const SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#141414;color:#fff;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:40px">📡</div><p>No connection. The control center comes back when you are online.</p></div>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
`;
export async function GET() {
  return new Response(SW, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" } });
}
