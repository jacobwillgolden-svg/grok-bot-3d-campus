import { isAuthed, notFound404 } from "../../../lib/auth";
import { appendHistory, lastRefreshAt, markRefresh, REFRESH_WINDOW_MS, sentEntries } from "../../../lib/store";
import { getConfig } from "../../../lib/config";
// Page buttons -> the bot's webhook routine. Body: { items: string[] } or { kind: "refresh" }; { dryRun: true } = health check.
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const REFRESH_MSG = "Refresh the control center data";
let last = 0; // light per-instance limit: about one send every 5 seconds

export async function POST(req: Request) {
  if (!(await isAuthed())) return notFound404();
  let body: any = null;
  try { body = await req.json(); } catch {}
  const { url, key, header } = await getConfig(); // env vars first, then the value saved on /setup
  const isRefresh = body?.kind === "refresh";
  if (body?.dryRun === true) {
    const waitMs = isRefresh ? Math.max(0, REFRESH_WINDOW_MS - (Date.now() - (await lastRefreshAt()))) : 0;
    return Response.json({ ok: true, dryRun: true, configured: !!(url && key), waitMs }); // never calls the webhook
  }
  if (isRefresh) {
    const prev = await lastRefreshAt();
    const w = REFRESH_WINDOW_MS - (Date.now() - prev);
    if (w > 0) return Response.json({ ok: false, limited: true, at: prev, waitMs: w, error: "A refresh request was already sent" }, { status: 429 });
  }
  const now = Date.now();
  if (now - last < 5000) return Response.json({ ok: false, error: "Too fast, try again in a few seconds" }, { status: 429 });
  const items: string[] = isRefresh ? [REFRESH_MSG]
    : Array.isArray(body?.items) ? body.items.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim().slice(0, 1000)).slice(0, 30) : [];
  if (!items.length) return Response.json({ ok: false, error: "Nothing to send" }, { status: 400 });
  if (!url || !key) return Response.json({ ok: false, error: "Webhook not configured" }, { status: 503 });
  last = now;
  const text = isRefresh ? REFRESH_MSG : `${items.length} request(s) from the control center:\n` + items.map((m, i) => `${i + 1}. ${m}`).join("\n");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header.toLowerCase() === "authorization") headers.Authorization = `Bearer ${key}`; else headers[header] = key;
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ text, source: "control-center" }), signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) { last = 0; return Response.json({ ok: false, error: r.status === 401 || r.status === 403 ? "Webhook key rejected" : `Webhook error ${r.status}` }, { status: 502 }); }
    if (isRefresh) { const at = Date.now(); await markRefresh(at); return Response.json({ ok: true, kind: "refresh", at, waitMs: REFRESH_WINDOW_MS }); }
    try { await appendHistory(sentEntries(items)); } catch {} // shown under "Sent by you" in History
    return Response.json({ ok: true, count: items.length });
  } catch (e: any) {
    last = 0;
    return Response.json({ ok: false, error: e?.name === "TimeoutError" ? "The bot did not answer in time" : "Could not reach the bot" }, { status: 502 });
  }
}
