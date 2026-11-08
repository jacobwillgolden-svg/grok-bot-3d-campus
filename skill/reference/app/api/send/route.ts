import { randomBytes } from "crypto";
import { isAuthed, notFound404 } from "../../../lib/auth";
import { appendChats, appendHistory, lastRefreshAt, markRefresh, readChatIndex, REFRESH_WINDOW_MS, sentEntries } from "../../../lib/store";
import { getConfig } from "../../../lib/config";
// Page -> the bot's webhook routine. Body: { items: string[] } (commands), { kind: "refresh" },
// or { kind: "chat", chat: <chat id>, from: <sender name>, text } (a chat message for a bot or a team group);
// { dryRun: true } = health check.
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
  const isChat = body?.kind === "chat";
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

  // a chat message: the target comes from the stored chat list, never from the page
  let chatMsg: any = null, chatMeta: any = null;
  if (isChat) {
    const textIn = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
    const from = (typeof body?.from === "string" && body.from.trim() ? body.from.trim() : "Someone on the team").slice(0, 60).replace(/[\r\n]+/g, " ");
    if (!textIn) return Response.json({ ok: false, error: "Nothing to send" }, { status: 400 });
    chatMeta = (await readChatIndex()).find((c) => c.id === body?.chat);
    if (!chatMeta) return Response.json({ ok: false, error: "Unknown chat" }, { status: 400 });
    chatMsg = { id: "cc-" + randomBytes(5).toString("hex"), at: new Date(now).toISOString(), from, role: "user", text: textIn };
  }
  const items: string[] = isRefresh ? [REFRESH_MSG] : isChat ? [chatMsg.text]
    : Array.isArray(body?.items) ? body.items.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim().slice(0, 1000)).slice(0, 30) : [];
  if (!items.length) return Response.json({ ok: false, error: "Nothing to send" }, { status: 400 });
  if (!url || !key) return Response.json({ ok: false, error: "Webhook not configured" }, { status: 503 });
  last = now;
  const text = isRefresh ? REFRESH_MSG
    : isChat ? [
      `Chat message from the control center [${chatMsg.id}]`,
      `From: ${chatMsg.from}`,
      `Chat: ${chatMeta.name} (${chatMeta.kind}, id ${chatMeta.id})`,
      `To: ${chatMeta.kind === "direct" ? chatMeta.bot || chatMeta.name : `the group ${chatMeta.name}`}`,
      "---",
      chatMsg.text,
    ].join("\n")
    : `${items.length} request(s) from the control center:\n` + items.map((m, i) => `${i + 1}. ${m}`).join("\n");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header.toLowerCase() === "authorization") headers.Authorization = `Bearer ${key}`; else headers[header] = key;
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ text, source: "control-center" }), signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) { last = 0; return Response.json({ ok: false, error: r.status === 401 || r.status === 403 ? "Webhook key rejected" : `Webhook error ${r.status}` }, { status: 502 }); }
    if (isRefresh) { const at = Date.now(); await markRefresh(at); return Response.json({ ok: true, kind: "refresh", at, waitMs: REFRESH_WINDOW_MS }); }
    if (isChat) {
      // shown in the chat right away; the bot uploads the reply when it arrives
      try { await appendChats([{ id: chatMeta.id, name: chatMeta.name, kind: chatMeta.kind, team: chatMeta.team, bot: chatMeta.bot, participants: chatMeta.participants, messages: [chatMsg] }]); } catch {}
      return Response.json({ ok: true, kind: "chat", message: chatMsg });
    }
    try { await appendHistory(sentEntries(items)); } catch {} // shown under "Sent by you" in History
    return Response.json({ ok: true, count: items.length });
  } catch (e: any) {
    last = 0;
    return Response.json({ ok: false, error: e?.name === "TimeoutError" ? "The bot did not answer in time" : "Could not reach the bot" }, { status: 502 });
  }
}
