import { get, put } from "@vercel/blob";
import { createHash } from "crypto";
import seed from "../data.json"; // a small valid DATA file shipped with the app (fallback)
// Everything lives in a PRIVATE Vercel Blob store. No database needed.
const DATA_PATH = "control-center/data.json";
const REFRESH_PATH = "control-center/refresh-request.json";
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

async function readJson(path: string): Promise<any> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const r: any = await get(path, { access: "private", useCache: false } as any);
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch { return null; }
}
async function writeJson(path: string, v: any) {
  await put(path, JSON.stringify(v), { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json" } as any);
}
export async function readData(): Promise<any> {
  const j = await readJson(DATA_PATH);
  return j && Array.isArray(j.TEAMS) ? j : seed;
}
export const writeData = (d: any) => writeJson(DATA_PATH, d);
export function validData(d: any) {
  return d && typeof d.UPDATED === "string" && d.USAGE && typeof d.USAGE.weeklyPct === "number" && Array.isArray(d.TEAMS)
    && d.TEAMS.every((t: any) => t && typeof t.id === "string" && typeof t.name === "string");
}
// ---- history archive: every activity line ever pushed plus every request sent from the page ----
// Each push replaces data.json (about 15 events per team), so older events are copied here first.
// Newest-added first; capped by count and age. Read by /api/history (cookie-protected, like /api/data).
const HISTORY_PATH = "control-center/history.json";
const HISTORY_MAX = 2000;
const HISTORY_DAYS = 90;
export type HistEntry = { k: string; kind: "event" | "sent"; team: string; teamName: string; time: string; text: string; at: number };
export async function readHistory(): Promise<HistEntry[]> {
  const j = await readJson(HISTORY_PATH);
  return j && Array.isArray(j.entries) ? j.entries : [];
}
export async function appendHistory(add: HistEntry[]) {
  if (!add.length || !process.env.BLOB_READ_WRITE_TOKEN) return;
  const cur = await readHistory();
  const have = new Set(cur.map((e) => e.k));
  const fresh = add.filter((e) => (have.has(e.k) ? false : (have.add(e.k), true)));
  if (!fresh.length) return;
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  await writeJson(HISTORY_PATH, { entries: [...fresh, ...cur].filter((e) => e.at >= cutoff).slice(0, HISTORY_MAX) });
}
export function activityEntries(d: any): HistEntry[] {
  const at = Date.now();
  return d.TEAMS.flatMap((t: any) => (Array.isArray(t.activity) ? t.activity : [])
    .filter((a: any) => a && typeof a.text === "string" && a.text.trim())
    .map((a: any) => ({ k: `a:${t.id}:${a.time}:${a.text}`, kind: "event" as const, team: t.id, teamName: t.name, time: String(a.time || ""), text: a.text.slice(0, 2000), at })));
}
export function sentEntries(items: string[]): HistEntry[] {
  const at = Date.now();
  return items.map((text, i) => ({ k: `s:${at}:${i}`, kind: "sent" as const, team: "", teamName: "", time: "", text, at }));
}
// refresh-request rate limit, shared by all server instances through the Blob
let refreshMem = 0;
export async function lastRefreshAt() {
  const j = await readJson(REFRESH_PATH);
  return Math.max(refreshMem, Number(j?.at) || 0);
}
export async function markRefresh(at: number) {
  refreshMem = at;
  try { await writeJson(REFRESH_PATH, { at }); } catch {}
}

// ---- chat history: the real conversations between the user's team and the bots ----
// The bot uploads new messages on every full refresh (push-messages.sh -> /api/admin/messages).
// One private Blob file per chat (newest CHAT_MAX messages) plus an index with a preview of each chat.
const CHAT_DIR = "control-center/chats/";
const CHAT_INDEX = CHAT_DIR + "index.json";
const CHAT_MAX = 3000;
// reactions: what Grok shows on the message (uploaded by the bot), plus page reactions still on their way to Grok (rx)
export type Reaction = { emoji: string; by: string[] };
export type RxOp = { emoji: string; by: string; op: "add" | "remove"; at: number };
export type ChatMsg = { id: string; at: string; from: string; role: "user" | "bot" | "system"; text: string; reactions?: Reaction[]; rx?: RxOp[]; patch?: boolean };
export type ChatMeta = { id: string; name: string; kind: "group" | "direct"; team?: string; bot?: string; participants?: string[]; count: number; lastAt: string; lastFrom: string; lastText: string; updatedAt: number; channel?: boolean; purpose?: string; pending?: boolean };
export type ChatIn = { id: string; name: string; kind: "group" | "direct"; team?: string; bot?: string; participants?: string[]; messages: ChatMsg[]; channel?: boolean; purpose?: string; pending?: boolean };
const RX_TTL = 30 * 60 * 1000; // a page reaction Grok never confirmed disappears after 30 minutes
const cleanReactions = (v: any): Reaction[] | undefined => !Array.isArray(v) ? undefined : v
  .filter((r: any) => r && typeof r.emoji === "string" && r.emoji.trim() && r.emoji.length <= 32 && Array.isArray(r.by))
  .slice(0, 30)
  .map((r: any) => ({ emoji: r.emoji.trim(), by: r.by.filter((b: any) => typeof b === "string" && b.trim()).map((b: string) => b.slice(0, 60)).slice(0, 50) }))
  .filter((r: Reaction) => r.by.length);
// pending page reactions that Grok's reactions already show (or that are too old) are dropped
export function settleRx(rx: RxOp[] | undefined, reactions: Reaction[] | undefined, now = Date.now()): RxOp[] | undefined {
  if (!rx || !rx.length) return undefined;
  const has = (e: string, b: string) => !!(reactions || []).find((r) => r.emoji === e && r.by.includes(b));
  const left = rx.filter((o) => now - o.at < RX_TTL && (o.op === "add" ? !has(o.emoji, o.by) : has(o.emoji, o.by)));
  return left.length ? left : undefined;
}
const chatPath = (id: string) => CHAT_DIR + createHash("sha1").update(id).digest("hex").slice(0, 24) + ".json";
const str = (v: any, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
const msgTime = (m: ChatMsg) => { const v = Date.parse(m.at); return isNaN(v) ? 0 : v; };
// validate and normalise one uploaded chat; returns null when it is unusable
export function cleanChat(c: any): ChatIn | null {
  if (!c || typeof c.id !== "string" || !c.id.trim() || typeof c.name !== "string" || !Array.isArray(c.messages)) return null;
  const full = c.messages
    .filter((m: any) => m && typeof m.text === "string" && m.text.trim() && typeof m.at === "string" && !isNaN(Date.parse(m.at)))
    .map((m: any) => {
      const from = str(m.from, 120) || "?", text = str(m.text, 12000), at = m.at;
      const id = typeof m.id === "string" && m.id.trim() ? m.id.slice(0, 160) : createHash("sha1").update(`${c.id}|${at}|${from}|${text.slice(0, 300)}`).digest("hex").slice(0, 20);
      const msg: ChatMsg = { id, at, from, role: m.role === "user" || m.role === "system" ? m.role : "bot", text };
      const reactions = cleanReactions(m.reactions); if (reactions) msg.reactions = reactions; // absent = unknown: keep what is stored
      return msg;
    });
  // { id, reactions } without text: only the reactions of a message that is already stored changed
  const patches: ChatMsg[] = c.messages
    .filter((m: any) => m && typeof m.id === "string" && m.id.trim() && !(typeof m.text === "string" && m.text.trim()) && Array.isArray(m.reactions))
    .map((m: any) => ({ id: m.id.slice(0, 160), at: "", from: "", role: "bot" as const, text: "", reactions: cleanReactions(m.reactions) || [], patch: true }));
  const messages = [...full, ...patches];
  return {
    id: c.id.slice(0, 200), name: str(c.name, 200) || c.id, kind: c.kind === "group" ? "group" : "direct",
    team: str(c.team, 120) || undefined, bot: str(c.bot, 120) || undefined,
    participants: Array.isArray(c.participants) ? c.participants.filter((p: any) => typeof p === "string").slice(0, 30).map((p: string) => p.slice(0, 120)) : undefined,
    messages,
  };
}
// pure merge: dedupe by id, oldest first, keep the newest CHAT_MAX
export function mergeMessages(prev: ChatMsg[], add: ChatMsg[]): ChatMsg[] {
  const byId = new Map<string, ChatMsg>();
  prev.forEach((m) => byId.set(m.id, m));
  add.forEach((m) => {
    const old = byId.get(m.id);
    if (m.patch) { // reactions only, for a message we already have
      if (old) byId.set(m.id, { ...old, reactions: m.reactions, rx: settleRx(old.rx, m.reactions) });
      return;
    }
    const next: ChatMsg = { ...m }; // a re-sent message replaces the stored copy (edits)
    if (old) {
      if (next.reactions === undefined && old.reactions) next.reactions = old.reactions;
      const rx = settleRx(old.rx, next.reactions); if (rx) next.rx = rx;
    }
    byId.set(m.id, next);
  });
  return Array.from(byId.values()).sort((a, b) => msgTime(a) - msgTime(b)).slice(-CHAT_MAX);
}
export async function readChatIndex(): Promise<ChatMeta[]> {
  const j = await readJson(CHAT_INDEX);
  return j && Array.isArray(j.chats) ? j.chats : [];
}
export async function readChat(id: string): Promise<ChatMsg[]> {
  const j = await readJson(chatPath(id));
  return j && Array.isArray(j.messages) ? j.messages : [];
}
export async function appendChats(chats: ChatIn[], opts: { fromBot?: boolean } = {}): Promise<{ chats: number; added: number }> {
  const index = await readChatIndex();
  let added = 0;
  for (const c of chats) {
    const prev = await readChat(c.id);
    const merged = mergeMessages(prev, c.messages);
    added += Math.max(0, merged.length - prev.length);
    await writeJson(chatPath(c.id), { id: c.id, messages: merged });
    const last = merged[merged.length - 1];
    const i = index.findIndex((x) => x.id === c.id);
    const old = i >= 0 ? index[i] : undefined;
    const meta: ChatMeta = {
      id: c.id, name: c.name, kind: c.kind, team: c.team ?? old?.team, bot: c.bot ?? old?.bot, participants: c.participants ?? old?.participants, count: merged.length,
      lastAt: last ? last.at : "", lastFrom: last ? last.from : "", lastText: last ? last.text.slice(0, 160) : "", updatedAt: Date.now(),
    };
    const channel = c.channel ?? old?.channel, purpose = c.purpose ?? old?.purpose;
    const pending = opts.fromBot ? false : (c.pending ?? old?.pending); // the bot's first upload means the channel exists in Grok
    if (channel) meta.channel = true;
    if (purpose) meta.purpose = purpose;
    if (pending) meta.pending = true;
    if (i >= 0) index[i] = meta; else index.push(meta);
  }
  index.sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0));
  await writeJson(CHAT_INDEX, { chats: index });
  return { chats: chats.length, added };
}
// search every chat (small orgs: dozens of chats); newest hits first
export async function searchChats(q: string, limit = 60): Promise<{ chat: string; name: string; msg: ChatMsg }[]> {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const index = await readChatIndex();
  const all = await Promise.all(index.map(async (c) => ({ c, msgs: await readChat(c.id) })));
  const hits: { chat: string; name: string; msg: ChatMsg }[] = [];
  all.forEach(({ c, msgs }) => msgs.forEach((m) => { if ((m.text + " " + m.from).toLowerCase().includes(needle)) hits.push({ chat: c.id, name: c.name, msg: m }); }));
  return hits.sort((a, b) => msgTime(b.msg) - msgTime(a.msg)).slice(0, limit);
}

// a reaction clicked on the page: stored as a pending op until Grok's own reactions show it (or 30 minutes pass)
export async function reactToMessage(chatId: string, msgId: string, emoji: string, by: string, op: "add" | "remove"): Promise<ChatMsg | null> {
  const msgs = await readChat(chatId);
  const m = msgs.find((x) => x.id === msgId);
  if (!m) return null;
  const rx = (m.rx || []).filter((o) => !(o.emoji === emoji && o.by === by));
  rx.push({ emoji, by, op, at: Date.now() });
  m.rx = rx;
  await writeJson(chatPath(chatId), { id: chatId, messages: msgs });
  return m;
}
export async function dropRx(chatId: string, msgId: string, emoji: string, by: string) {
  const msgs = await readChat(chatId);
  const m = msgs.find((x) => x.id === msgId);
  if (!m || !m.rx) return;
  m.rx = m.rx.filter((o) => !(o.emoji === emoji && o.by === by));
  if (!m.rx.length) delete m.rx;
  await writeJson(chatPath(chatId), { id: chatId, messages: msgs });
}
// a channel asked for on the page: shows at once as "setting up", the bot creates the Grok group and uploads to this id
export async function createChannel(c: { id: string; name: string; purpose?: string; members: string[]; from: string }) {
  const text = `${c.from} created #${c.name}${c.members.length ? " with " + c.members.join(", ") : ""}. Your Grok Bot is setting it up in Grok…`;
  await appendChats([{ id: c.id, name: c.name, kind: "group", participants: [c.from, ...c.members], channel: true, purpose: c.purpose, pending: true,
    messages: [{ id: c.id + "-created", at: new Date().toISOString(), from: "Control center", role: "system", text }] }]);
}
// links to the bots' computers (the monitor button in Grok); saved from the page, never part of data.json
const DESKTOP_PATH = "control-center/desktop.json";
export type DesktopLink = { name: string; url: string };
export async function readDesktop(): Promise<DesktopLink[]> {
  const j = await readJson(DESKTOP_PATH);
  return j && Array.isArray(j.links) ? j.links : [];
}
export const writeDesktop = (links: DesktopLink[]) => writeJson(DESKTOP_PATH, { links });
