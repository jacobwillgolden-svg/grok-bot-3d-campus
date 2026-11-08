import { get, put } from "@vercel/blob";
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
