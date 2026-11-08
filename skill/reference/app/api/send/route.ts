import { randomBytes } from "crypto";
import { isAuthed, notFound404 } from "../../../lib/auth";
import { appendChats, appendHistory, createChannel, dropRx, lastRefreshAt, markRefresh, reactToMessage, readChat, readChatIndex, readData, REFRESH_WINDOW_MS, sentEntries } from "../../../lib/store";
import { getConfig } from "../../../lib/config";
// Page -> the bot's webhook routine. Body:
//   { items: string[] }                                          commands (form B)
//   { kind: "refresh" }                                          refresh request (form A)
//   { kind: "chat", chat, from, text }                           a chat message (form C)
//   { kind: "react", chat, msg, emoji, op: "add"|"remove", from } a reaction (form D)
//   { kind: "channel", name, purpose?, members: string[], from } a new channel (form E)
//   { dryRun: true }                                             health check
// Targets (chats, messages, bots) are always looked up on the server, never taken from the page.
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const REFRESH_MSG = "Refresh the control center data";
let last = 0; // light per-instance limit: about one send every 5 seconds
let lastReact = 0; // reactions: about one per second
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;
const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const nameOf = (v: any) => (typeof v === "string" && v.trim() ? oneLine(v, 60) : "Someone on the team");
const bad = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

export async function POST(req: Request) {
  if (!(await isAuthed())) return notFound404();
  let body: any = null;
  try { body = await req.json(); } catch {}
  const { url, key, header } = await getConfig(); // env vars first, then the value saved on /setup
  const kind = body?.kind;
  const isRefresh = kind === "refresh";
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
  if (kind === "react") { if (now - lastReact < 800) return bad("Too fast, try again in a moment", 429); }
  else if (now - last < 5000) return bad("Too fast, try again in a few seconds", 429);
  if (!url || !key) return bad("Webhook not configured", 503);

  const hook = async (text: string): Promise<Response | null> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (header.toLowerCase() === "authorization") headers.Authorization = `Bearer ${key}`; else headers[header] = key;
    try {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ text, source: "control-center" }), signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (!r.ok) return bad(r.status === 401 || r.status === 403 ? "Webhook key rejected" : `Webhook error ${r.status}`, 502);
      return null;
    } catch (e: any) {
      return bad(e?.name === "TimeoutError" ? "The bot did not answer in time" : "Could not reach the bot", 502);
    }
  };

  // ---- C) chat message ----
  if (kind === "chat") {
    const textIn = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!textIn) return bad("Nothing to send");
    const meta = (await readChatIndex()).find((c) => c.id === body?.chat);
    if (!meta) return bad("Unknown chat");
    const msg = { id: "cc-" + randomBytes(5).toString("hex"), at: new Date(now).toISOString(), from: nameOf(body?.from), role: "user" as const, text: textIn };
    last = now;
    const err = await hook([
      `Chat message from the control center [${msg.id}]`,
      `From: ${msg.from}`,
      `Chat: ${meta.name} (${meta.kind}, id ${meta.id})`,
      `To: ${meta.kind === "direct" ? meta.bot || meta.name : `the group ${meta.name}`}`,
      "---",
      msg.text,
    ].join("\n"));
    if (err) { last = 0; return err; }
    // shown in the chat right away; the bot uploads the reply when it arrives
    try { await appendChats([{ id: meta.id, name: meta.name, kind: meta.kind, team: meta.team, bot: meta.bot, participants: meta.participants, messages: [msg] }]); } catch {}
    return Response.json({ ok: true, kind: "chat", message: msg });
  }

  // ---- D) reaction ----
  if (kind === "react") {
    const emoji = typeof body?.emoji === "string" ? body.emoji.trim() : "";
    const op = body?.op === "remove" ? "remove" : "add";
    if (!emoji || emoji.length > 32 || !EMOJI.test(emoji)) return bad("Not an emoji");
    const meta = (await readChatIndex()).find((c) => c.id === body?.chat);
    if (!meta) return bad("Unknown chat");
    const target = (await readChat(meta.id)).find((m) => m.id === body?.msg);
    if (!target) return bad("Unknown message");
    const from = nameOf(body?.from);
    lastReact = now;
    await reactToMessage(meta.id, target.id, emoji, from, op);
    const err = await hook([
      `Reaction from the control center`,
      `From: ${from}`,
      `Chat: ${meta.name} (${meta.kind}, id ${meta.id})`,
      `Message id: ${target.id}`,
      `Message: ${target.from} at ${target.at}: "${oneLine(target.text, 140)}"`,
      `Reaction: ${op} ${emoji}`,
    ].join("\n"));
    if (err) { lastReact = 0; try { await dropRx(meta.id, target.id, emoji, from); } catch {} return err; }
    return Response.json({ ok: true, kind: "react" });
  }

  // ---- E) new channel ----
  if (kind === "channel") {
    const name = (typeof body?.name === "string" ? body.name : "").trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    if (name.length < 2) return bad("Give the channel a name (letters, numbers, - or _)");
    const purpose = typeof body?.purpose === "string" ? oneLine(body.purpose, 200) : "";
    const data = await readData();
    const bots: string[] = (data.TEAMS || []).flatMap((t: any) => [t.lead?.name, ...(t.members || []).map((m: any) => m.name)]).filter((n: any) => typeof n === "string");
    const wanted: string[] = Array.isArray(body?.members) ? Array.from(new Set(body.members.filter((m: any) => typeof m === "string").map((m: string) => m.trim().toLowerCase()))) : [];
    const members = Array.from(new Set(wanted.map((w) => bots.find((b) => b.toLowerCase() === w.trim().toLowerCase())).filter(Boolean) as string[]));
    if (!members.length || members.length !== wanted.length) return bad("Pick 1 to 5 bots from your teams");
    if (members.length > 5) return bad("A Grok group holds 6 members: your Grok Bot plus up to 5 bots");
    const index = await readChatIndex();
    if (index.some((c) => c.kind === "group" && c.name.toLowerCase().replace(/\s+/g, "-") === name)) return bad("A channel with that name already exists");
    const id = `chan:${name}-${randomBytes(2).toString("hex")}`;
    const from = nameOf(body?.from);
    last = now;
    const err = await hook([
      `New channel from the control center`,
      `From: ${from}`,
      `Channel: ${name} (chat id ${id})`,
      `Members: ${members.join(", ")}`,
      `Purpose: ${purpose || "(none given)"}`,
    ].join("\n"));
    if (err) { last = 0; return err; }
    await createChannel({ id, name, purpose: purpose || undefined, members, from });
    return Response.json({ ok: true, kind: "channel", id });
  }

  // ---- A) refresh / B) commands ----
  const items: string[] = isRefresh ? [REFRESH_MSG]
    : Array.isArray(body?.items) ? body.items.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim().slice(0, 1000)).slice(0, 30) : [];
  if (!items.length) return bad("Nothing to send");
  last = now;
  const err = await hook(isRefresh ? REFRESH_MSG : `${items.length} request(s) from the control center:\n` + items.map((m, i) => `${i + 1}. ${m}`).join("\n"));
  if (err) { last = 0; return err; }
  if (isRefresh) { const at = Date.now(); await markRefresh(at); return Response.json({ ok: true, kind: "refresh", at, waitMs: REFRESH_WINDOW_MS }); }
  try { await appendHistory(sentEntries(items)); } catch {} // shown under "Sent by you" in Activity
  return Response.json({ ok: true, count: items.length });
}
