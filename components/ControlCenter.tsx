"use client";
import { useState, useEffect, useRef } from "react";
import { useGrokTheme } from "../lib/theme";
import { TZ } from "../lib/tz";
import Campus3D from "./Campus3DLazy";

// ===== DATA (a refresh routine edits only these constants) =====
// UPDATED: string shown in the HUD.
// USAGE: { weeklyPct, reset, onDemandPct, period, byTeam[{label,pct}], topBots[{label,pct}] }
// TEAMS[]: {
//   id, name, status: "active" | "partial" | "hold" | "frozen",
//   lead: {name, role}, members: [{name, role}],
//   work: string, next?: string, lines: string[] (short bubble lines),
//   pending: [{ id (stable, unique), what, since }],   // items waiting for the user
//   usage?: "49%" (team share of this week's usage),
//   goal?: { label, current: number | null (null = unknown), target, due? },
//   activity: [{ time: "D.M HH:MM", text }],         // real recent events, newest first
//   tasks: [{ text, state: "todo" | "doing" | "done", owner?: member name | lead name | "Me" }],
//   routines?: [{                                      // scheduled tasks of EVERY bot in the team (lead + workers)
//     id (routine folder id, or a stable slug when the folder id is not visible),
//     owner (exact lead.name or member name), name (exact routine name), schedule (plain language),
//     state: "on" | "paused" | "unknown", lastRun?: "D.M HH:MM", lastResult?: "ok" | "fail",
//     next?: ISO time with offset, e.g. "2026-11-03T08:00:00+02:00" (drives the live countdown),
//     perWeek?: runs per week (usage warning when >= 5), note?: short note
//   }],                                                // [] = checked, no routines
//   unscanned?: [owner names]                          // bots whose older chat history was not fully checked
//   botUsage?: [{ owner, pct }]                        // share of this week's usage per bot (from USAGE.topBots)
// }
type Usage = { weeklyPct: number; reset: string; onDemandPct: number; period: string; byTeam: { label: string; pct: number }[]; topBots: { label: string; pct: number }[] };
// live data: filled from the server (Blob) on every render of the wrapper
let UPDATED = "";
let USAGE: Usage = { weeklyPct: 0, reset: "", onDemandPct: 0, period: "", byTeam: [], topBots: [] };

type TeamStatus = "active" | "partial" | "hold" | "frozen";
type Pending = { id: string; what: string; since: string };
type Member = { name: string; role: string };
type Goal = { label: string; current: number | null; target: number; due?: string };
type Activity = { time: string; text: string };
type Task = { text: string; state: "todo" | "doing" | "done"; owner?: string };
type Team = {
  id: string; name: string; status: TeamStatus; lead: Member; members: Member[];
  work: string; next?: string; lines: string[]; pending: Pending[]; usage?: string; goal?: Goal;
  activity: Activity[]; tasks: Task[];
  routines?: Routine[]; unscanned?: string[]; botUsage?: { owner: string; pct: number }[];
};
type Routine = { id: string; owner: string; name: string; schedule: string; state: "on" | "paused" | "unknown"; lastRun?: string; lastResult?: "ok" | "fail"; next?: string; perWeek?: number; note?: string };

let TEAMS: Team[] = [];
// AVATARS (optional): each bot's look in the Grok Bot app, keyed by bot name OR family name (the part before " - ").
//   { "Captain America": { color: "#ff263c", shape: "pentagon" }, "Grok Bot": { color: "#ffffff", shape: "circle", badge: "#299fff" } }
//   Inheritance: "Captain America" covers "Captain America - Team", "Captain America - Ryan" and any later
//   "Captain America - …"; an entry for one sibling ("Data Bot - Team") also covers the others ("Data Bot - Ryan").
//   Bots with no entry keep the default look (team colours, seed shapes). The server keeps AVATARS across pushes.
export type AvatarShape = "circle" | "squircle" | "triangle" | "pentagon" | "star";
export type Avatar = { color: string; shape?: AvatarShape; badge?: string };
let AVATARS: Record<string, Avatar> = {};
export type DataShape = { UPDATED: string; USAGE: Usage; TEAMS: Team[]; AVATARS?: Record<string, Avatar> };
// ===== END DATA =====

// ---- avatars: resolve a bot name to its Grok look (exact name → family → a sibling's entry) ----
const AV_SHAPES: AvatarShape[] = ["circle", "squircle", "triangle", "pentagon", "star"];
const okHex = (c: any) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim());
const familyOf = (n: string) => n.split(/\s+[-–—|]\s+/)[0].trim().toLowerCase();
function cleanAv(a: any): Avatar | null {
  if (!a || !okHex(a.color)) return null;
  return { color: a.color.trim().toLowerCase(), shape: AV_SHAPES.includes(a.shape) ? a.shape : undefined, badge: okHex(a.badge) ? a.badge.trim().toLowerCase() : undefined };
}
let avIdx: { src: any; exact: Map<string, Avatar>; fam: Map<string, Avatar> } | null = null;
function avatarFor(name: string | undefined | null): Avatar | null {
  if (!name) return null;
  if (!avIdx || avIdx.src !== AVATARS) {
    const exact = new Map<string, Avatar>(), fam = new Map<string, Avatar>(), sib = new Map<string, Avatar>();
    Object.keys(AVATARS || {}).forEach((k) => {
      const av = cleanAv((AVATARS as any)[k]); if (!av) return;
      const key = k.trim().toLowerCase(), f = familyOf(k);
      exact.set(key, av);
      if (f === key) fam.set(f, av); else if (!sib.has(f)) sib.set(f, av);
    });
    sib.forEach((av, f) => { if (!fam.has(f)) fam.set(f, av); });
    avIdx = { src: AVATARS, exact, fam };
  }
  const key = name.trim().toLowerCase();
  return avIdx.exact.get(key) || avIdx.fam.get(familyOf(name)) || null;
}
// a short string of every resolved avatar, so the 3D scene rebuilds when one changes
function avatarSig(team: Team): string {
  return [team.lead, ...team.members].map((m) => { const a = avatarFor(m.name); return a ? `${a.color}${a.shape || ""}${a.badge || ""}` : "-"; }).join(",");
}
// outline of a shape in unit space (x and y in −1…1, y up), as M/L/Q segments; shared by SVG and WebGL
type Seg = ["M" | "L", number, number] | ["Q", number, number, number, number];
function roundedPoly(pts: [number, number][], r: number): Seg[] {
  const n = pts.length, out: Seg[] = [];
  const cut = (a: [number, number], b: [number, number]) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, d = Math.min(r, L / 2); return [a[0] + (dx / L) * d, a[1] + (dy / L) * d] as [number, number]; };
  for (let i = 0; i < n; i++) {
    const v = pts[i], a = cut(v, pts[(i + n - 1) % n]), b = cut(v, pts[(i + 1) % n]);
    out.push(i === 0 ? ["M", a[0], a[1]] : ["L", a[0], a[1]]);
    out.push(["Q", v[0], v[1], b[0], b[1]]);
  }
  return out;
}
function shapeOutline(shape: AvatarShape): Seg[] {
  if (shape === "squircle") return roundedPoly([[-1, -1], [1, -1], [1, 1], [-1, 1]], 0.62);
  if (shape === "triangle") return roundedPoly([[-1.05, -1], [1.05, -1], [-0.05, 1.05]], 0.5);
  if (shape === "pentagon") return roundedPoly([[-1, -1], [1, -1], [1, 0.22], [0.08, 1.12], [-1, 0.22]], 0.36);
  if (shape === "star") { // six soft points
    const pts: Seg[] = [];
    for (let k = 0; k <= 72; k++) { const a = (k / 72) * Math.PI * 2 + Math.PI / 2; const r = 0.84 + 0.17 * Math.cos(6 * (a - Math.PI / 2)); pts.push([k ? "L" : "M", Math.cos(a) * r, Math.sin(a) * r]); }
    return pts;
  }
  const pts: Seg[] = []; // circle
  for (let k = 0; k <= 48; k++) { const a = (k / 48) * Math.PI * 2; pts.push([k ? "L" : "M", Math.cos(a), Math.sin(a)]); }
  return pts;
}
// Grok's shapes are drawn with a slight playful tilt
const SHAPE_TILT: Record<AvatarShape, number> = { circle: 0, squircle: -7, triangle: -9, pentagon: -10, star: 8 };
// eye height as a share of the body height (narrow tops need lower eyes)
const SHAPE_EYE: Record<AvatarShape, number> = { circle: 0.58, squircle: 0.6, triangle: 0.42, pentagon: 0.55, star: 0.56 };
// SVG path for a body of width w and height h standing on y = 0 (SVG y points down)
function shapePathSvg(shape: AvatarShape, w: number, h: number): string {
  const X = (x: number) => (x * w / 2).toFixed(2), Y = (y: number) => (-(y + 1) * h / 2).toFixed(2);
  return shapeOutline(shape).map((s) => s[0] === "Q" ? `Q ${X(s[1])} ${Y(s[2])} ${X(s[3])} ${Y(s[4])}` : `${s[0]} ${X(s[1])} ${Y(s[2])}`).join(" ") + " Z";
}

const STATUS_LABEL: Record<TeamStatus, string> = { active: "Active", partial: "Partly active", hold: "Waiting for you", frozen: "Frozen" };
const STATE_LABEL = { todo: "To do", doing: "In progress", done: "Done" };

const WW = 2400;
const WH = 1500;
const PLAZA = { x: 1340, y: 750 };
const ACTIVE_POS = [
  { x: 1960, y: 380 }, { x: 1340, y: 250 }, { x: 720, y: 380 },
  { x: 1960, y: 1120 }, { x: 1340, y: 1250 }, { x: 720, y: 1120 },
];
const FROZEN_POS = [{ x: 210, y: 420 }, { x: 210, y: 750 }, { x: 210, y: 1080 }];
// room spots: the 6 + 3 hand-placed spots first; a team beyond them gets a generated spot, so it always has its own room.
// extra active rooms grow in columns of 3 to the right of the campus, extra frozen rooms in columns of 3 to the left.
const roomSpot = (frozen: boolean, i: number): { x: number; y: number } => {
  const base = frozen ? FROZEN_POS : ACTIVE_POS;
  if (i < base.length) return base[i];
  const k = i - base.length, col = Math.floor(k / 3), row = k % 3;
  return frozen ? { x: 210 - 400 * (col + 1), y: 420 + 330 * row } : { x: 2620 + 620 * col, y: 300 + 450 * row };
};
const layoutRooms = (teams: { id: string; status: string }[]) => {
  const pos: Record<string, { x: number; y: number }> = {};
  let a = 0, f = 0;
  teams.forEach((x) => { pos[x.id] = x.status === "frozen" ? roomSpot(true, f++) : roomSpot(false, a++); });
  return pos;
};
// how far the generated rooms reach past the original campus box (3D units: x -11.6..10.2, z -6.6..7.2); 0 for the 6 + 3 layout,
// so the default view only changes when there are extra rooms. phone: frozen rooms stay out of the fit (as before).
const campusGrow = (teams: { id: string; status: string }[], pos: Record<string, { x: number; y: number }>, phone?: boolean) => {
  const g = { x0: 0, x1: 0, z0: 0, z1: 0 };
  let a = 0, f = 0;
  teams.forEach((tm) => {
    const fz = tm.status === "frozen"; const i = fz ? f++ : a++;
    if (i < (fz ? FROZEN_POS : ACTIVE_POS).length || (phone && fz)) return;
    const p = pos[tm.id]; if (!p) return;
    const c = { x: p.x / 100 - 12, z: p.y / 100 - 7.5 }; const hw = (fz ? 3.3 : 5.3) / 2 + 0.6, hd = (fz ? 2.4 : 3.5) / 2 + 0.6;
    g.x0 = Math.max(g.x0, -11.6 - (c.x - hw)); g.x1 = Math.max(g.x1, c.x + hw - 10.2);
    g.z0 = Math.max(g.z0, -6.6 - (c.z - hd)); g.z1 = Math.max(g.z1, c.z + hd - 7.2);
  });
  return g;
};
const POD = { w: 440, h: 280 };
const FPOD = { w: 280, h: 200 };
const TREES = [
  { x: 1000, y: 120 }, { x: 1680, y: 110 }, { x: 2250, y: 160 }, { x: 2300, y: 760 }, { x: 2250, y: 1360 },
  { x: 1680, y: 1420 }, { x: 1000, y: 1420 }, { x: 470, y: 760 }, { x: 1020, y: 640 }, { x: 1660, y: 880 },
  { x: 2100, y: 760 }, { x: 560, y: 160 }, { x: 560, y: 1360 }, { x: 1040, y: 900 },
];

// ---- data refresh: the web app fills RF (instant re-read of the latest data); on the canvas the button just re-reads the clock ----
type RefreshApi = { busy: boolean; at: number; result: "" | "new" | "same" | "error"; reqAt: number; polling: boolean; refresh: () => void; note?: string };
// demo only (components/DemoApp.tsx): a client-side simulation of the bot; null in the real app
type DemoApi = { snapshot: () => DataShape; send: (items: string[]) => void; refreshRound: () => void; subscribe: (fn: () => void) => () => void };
let DEMO: DemoApi | null = null;
// "3.11.2026, 08:06 (…)" → "08:06" today, or "2.11 08:06" for an older day
const dataStamp = (u: string) => {
  const m = u.match(/(\d{1,2})\.(\d{1,2})\.(\d{4}),\s*(\d{1,2}:\d{2})/);
  if (!m) return u;
  const today = new Date().toLocaleDateString("en-GB", { timeZone: TZ }).split("/").map(Number); // d/m/y
  return +m[1] === today[0] && +m[2] === today[1] ? m[4] : `${+m[1]}.${+m[2]} ${m[4]}`;
};
let RF: RefreshApi | null = null;
const ilTime = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const ease = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k * k * (3 - 2 * k));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function initials(name: string): string {
  const parts = name.replace(/[\"'·]/g, " ").replace("Team lead ", "").split(/[\s/]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[1][0];
}
function timeKey(s: string): number {
  const m = s.match(/(\d+)\.(\d+)(?:\s+(\d+):(\d+))?/);
  if (!m) return 0;
  return Number(m[2]) * 1e6 + Number(m[1]) * 1e4 + Number(m[3] || 0) * 100 + Number(m[4] || 0);
}
function qpt(p0: { x: number; y: number }, c: { x: number; y: number }, p1: { x: number; y: number }, k: number) {
  const a = (1 - k) * (1 - k), b = 2 * (1 - k) * k, d = k * k;
  return { x: a * p0.x + b * c.x + d * p1.x, y: a * p0.y + b * c.y + d * p1.y };
}
function ctrlFor(p: { x: number; y: number }) {
  const mx = (p.x + PLAZA.x) / 2, my = (p.y + PLAZA.y) / 2;
  const dx = p.x - PLAZA.x, dy = p.y - PLAZA.y;
  return { x: mx - dy * 0.18, y: my + dx * 0.12 };
}

function useTone(s: TeamStatus): string {
  const th = useGrokTheme();
  return s === "frozen" ? th.text.tertiary : s === "hold" ? th.text.warning : s === "partial" ? th.text.accent : th.text.success;
}

// ---------- scheduled tasks (routines) helpers ----------
const ROUT_STATE: Record<Routine["state"], string> = { on: "Active", paused: "Paused", unknown: "Unknown" };
const nowMs = () => Date.now();
function nextAt(r: Routine): number | null { if (!r.next) return null; const v = Date.parse(r.next); return isNaN(v) ? null : v; }
function countdown(ms: number): string {
  if (ms <= 0) return "Time passed, waiting for refresh";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `in ${d} d${h % 24 ? ` and ${h % 24} h` : ""}`;
  if (h >= 1) return `in ${h} h ${m % 60} min`;
  return `in ${Math.max(1, m)} min`;
}
function ilParts(ms: number): { hh: string; mm: string; d: string; m: string } {
  try {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric", hourCycle: "h23" } as any).formatToParts(new Date(ms));
    const g = (k: string) => (f.find((x) => x.type === k) || { value: "" }).value;
    return { hh: g("hour"), mm: g("minute"), d: g("day"), m: g("month") };
  } catch (e) {
    const d = new Date(ms);
    return { hh: String(d.getHours()).padStart(2, "0"), mm: String(d.getMinutes()).padStart(2, "0"), d: String(d.getDate()), m: String(d.getMonth() + 1) };
  }
}
function shortWhen(ms: number, now: number): string {
  const p = ilParts(ms);
  if (ms - now < 864e5 && ms > now) return `${p.hh}:${p.mm}`;
  return `${p.d}.${p.m}`;
}
function sinceAt(s: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const v = Date.parse(s); return isNaN(v) ? null : v; }
  const m = s.match(/(\d+)\.(\d+)(?:\s+(\d+):(\d+))?/);
  if (!m) return null;
  return new Date(2026, Number(m[2]) - 1, Number(m[1]), Number(m[3] || 0), Number(m[4] || 0)).getTime();
}
function teamAlerts(team: Team, now: number): string[] {
  const out: string[] = [];
  (team.routines || []).forEach((r) => { if (r.lastResult === "fail" && r.state !== "paused") out.push(`Failed: ${r.name}`); });
  team.pending.forEach((p) => { const s = sinceAt(p.since); if (s !== null && now - s > 864e5) out.push(`Waiting over 24 hours: ${p.what}`); });
  return out;
}
function sinceLabel(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  const v = Date.parse(s); if (isNaN(v)) return s;
  try { return new Date(v).toLocaleString("en-GB", { timeZone: TZ, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return s; }
}
const rBase = (team: Team, r: Routine) => `${team.name}: ${r.owner} / ${r.name} [${r.id}]`;
const ownersOf = (team: Team) => [team.lead, ...team.members];

// a small animated wall clock (svg, centered at 0,0)
function Clock(props: { r: number; t: number; mode: "on" | "paused" | "unknown" | "none"; fail?: boolean }) {
  const th = useGrokTheme();
  const { r, t, mode } = props;
  const run = mode === "on";
  const sec = run ? Math.floor(t) * 6 : 0;
  const min = run ? (t * 2) % 360 : mode === "paused" ? 300 : 0;
  const hr = run ? (t * 0.25) % 360 : mode === "paused" ? 60 : 0;
  const rim = mode === "on" ? (props.fail ? th.text.danger : th.text.success) : mode === "paused" ? th.text.warning : th.text.tertiary;
  const hand = (deg: number, len: number, w: number, c: string) => <line x1={0} y1={0} x2={len * Math.sin((deg * Math.PI) / 180)} y2={-len * Math.cos((deg * Math.PI) / 180)} stroke={c} strokeWidth={w} strokeLinecap="round" />;
  return (
    <g style={{ pointerEvents: "none" }}>
      <circle r={r} fill={th.bg.elevated} stroke={rim} strokeWidth={Math.max(2, r * 0.16)} strokeDasharray={mode === "unknown" ? `${r * 0.5} ${r * 0.35}` : undefined} opacity={mode === "none" ? 0.45 : 1} />
      {[0, 1, 2, 3].map((k) => <circle key={k} cx={r * 0.72 * Math.sin((k * Math.PI) / 2)} cy={-r * 0.72 * Math.cos((k * Math.PI) / 2)} r={Math.max(1, r * 0.07)} fill={th.text.tertiary} />)}
      {mode !== "none" && hand(hr, r * 0.45, Math.max(1.6, r * 0.12), th.text.primary)}
      {mode !== "none" && hand(min, r * 0.66, Math.max(1.2, r * 0.08), th.text.primary)}
      {run && hand(sec, r * 0.74, Math.max(0.8, r * 0.04), th.text.danger)}
      <circle r={Math.max(1.4, r * 0.1)} fill={th.text.primary} />
      {mode === "paused" && <g transform={`translate(${r * 0.75} ${-r * 0.75})`}><circle r={r * 0.42} fill={th.text.warning} /><rect x={-r * 0.18} y={-r * 0.2} width={r * 0.12} height={r * 0.4} fill={th.text.onColor} /><rect x={r * 0.06} y={-r * 0.2} width={r * 0.12} height={r * 0.4} fill={th.text.onColor} /></g>}
    </g>
  );
}

// small pill button used by routine / quick-command cards
function Pb(props: { label: string; color: string; bg: string; onClick: () => void; disabled?: boolean }) {
  return <button disabled={props.disabled} onClick={props.onClick} style={{ font: "inherit", fontSize: 14, fontWeight: 600, padding: "7px 13px", borderRadius: 999, border: `1.5px solid ${props.color}`, background: props.bg, color: props.color, cursor: props.disabled ? "default" : "pointer", opacity: props.disabled ? 0.5 : 1, whiteSpace: "nowrap" }}>{props.label}</button>;
}

// one routine with its control buttons; every button copies a message for the main bot
function RoutineCard(props: { team: Team; r: Routine; t: number; onSend: (msg: string) => void; compact?: boolean }) {
  const th = useGrokTheme();
  const { team, r, t } = props;
  const [editing, setEditing] = useState(false);
  const [txt, setTxt] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const now = nowMs();
  const nx = nextAt(r);
  const base = rBase(team, r);
  const send = (m: string) => { setSent(m); setEditing(false); props.onSend(m); };
  const lampC = r.state === "on" ? (r.lastResult === "fail" ? th.text.danger : th.text.success) : r.state === "paused" ? th.text.warning : th.text.tertiary;
  const row = (icon: string, label: string, val: any, c?: string) => (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 14.5, lineHeight: "22px" }}>
      <span style={{ width: 22, textAlign: "center" }}>{icon}</span>
      <span style={{ color: th.text.tertiary, minWidth: 74 }}>{label}</span>
      <span style={{ color: c || th.text.primary, fontWeight: 600 }}>{val}</span>
    </div>
  );
  return (
    <div style={{ background: th.bg.subtle, borderRadius: 18, padding: "12px 14px", border: `1px solid ${th.border.subtle}`, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <svg width={34} height={34} viewBox="-17 -17 34 34" style={{ flex: "0 0 34px" }}><Clock r={14} t={t} mode={r.state} fail={r.lastResult === "fail"} /></svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, lineHeight: "21px" }}>{r.name}</div>
          <div style={{ fontSize: 12.5, color: th.text.tertiary }}>{team.name} · {r.owner}</div>
        </div>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 700, color: lampC, background: th.bg.elevated, borderRadius: 999, padding: "3px 9px", whiteSpace: "nowrap" }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: lampC, opacity: r.state === "on" ? 0.55 + 0.45 * Math.sin(t * 4) : 1 }} />{ROUT_STATE[r.state]}
        </span>
      </div>
      {row("🗓", "When", r.schedule)}
      {row("⏭", "Next run", nx !== null && r.state === "on" ? countdown(nx - now) : r.state === "paused" ? "Paused" : "Unknown", nx !== null && r.state === "on" ? th.text.accent : th.text.tertiary)}
      {(r.lastRun || r.lastResult) && row("↩", "Last run", `${r.lastRun || ""}${r.lastRun && r.lastResult ? " · " : ""}${r.lastResult === "ok" ? "succeeded ✓" : r.lastResult === "fail" ? "failed ✕" : ""}`, r.lastResult === "fail" ? th.text.danger : th.text.success)}
      {!props.compact && r.note && <div style={{ fontSize: 13.5, lineHeight: "20px", color: th.text.secondary, background: th.bg.elevated, borderRadius: 12, padding: "7px 10px", marginTop: 6 }}>{r.note}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 }}>
        {r.state !== "paused" && <Pb label="⏸ Pause" color={th.text.warning} bg={th.fill.warningSubtle} onClick={() => send(`Pause task — ${base}`)} />}
        {r.state !== "on" && <Pb label="▶ Resume" color={th.text.successDeep} bg={th.fill.successSubtle} onClick={() => send(`Resume — ${base}`)} />}
        <Pb label="⚡ Run now" color={th.text.accent} bg={th.fill.accentSubtle} onClick={() => send(`Run now — ${base}`)} />
        <Pb label="✎ Change" color={th.text.primary} bg={th.bg.elevated} onClick={() => setEditing(!editing)} />
        <Pb label="🗑 Cancel" color={th.text.dangerDeep} bg={th.fill.dangerSubtle} onClick={() => send(`Cancel task — ${base}`)} />
      </div>
      {editing && (
        <div style={{ display: "flex", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
          <input value={txt} onChange={(e: any) => setTxt(e.target.value)} placeholder="What to change? (time, days, what to check)" dir="ltr" style={{ font: "inherit", fontSize: 14, flex: "1 1 200px", padding: "7px 10px", borderRadius: 10, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary }} />
          <Pb label="Copy" color={th.text.accent} bg={th.fill.accentSubtle} disabled={!txt.trim()} onClick={() => send(`Change task — ${base} — ${txt.trim()}`)} />
        </div>
      )}
      {sent && <div style={{ fontSize: 12, color: th.text.tertiary, background: th.bg.elevated, borderRadius: 8, padding: "6px 8px", marginTop: 8, userSelect: "all" }}>✓ In the bot tray: {sent}</div>}
    </div>
  );
}

// quick commands for one bot (lead or worker)
function QuickCmds(props: { team: Team; owner: Member; isLead: boolean; onSend: (msg: string) => void }) {
  const th = useGrokTheme();
  const { team, owner } = props;
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const mine = (team.routines || []).filter((r) => r.owner === owner.name && r.state === "on");
  return (
    <div style={{ background: th.fill.accentSubtle, borderRadius: 16, padding: "10px 12px", marginTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: th.text.secondary, marginBottom: 8 }}>Quick commands · go into the bot tray</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        <Pb label="❓ Status?" color={th.text.accent} bg={th.bg.elevated} onClick={() => props.onSend(`What's the status? — ${team.name}: ${owner.name}`)} />
        <Pb label={props.isLead ? "📝 Note to the lead" : "📝 Note to the lead about it"} color={th.text.primary} bg={th.bg.elevated} onClick={() => setOpen(!open)} />
        {mine.length > 0 && <Pb label={`⏸ Pause all its tasks (${mine.length})`} color={th.text.warning} bg={th.fill.warningSubtle} onClick={() => props.onSend(`Pause all tasks — ${team.name}: ${owner.name} [${mine.map((r) => r.id).join(", ")}]`)} />}
      </div>
      {open && (
        <div style={{ display: "flex", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
          <input value={note} onChange={(e: any) => setNote(e.target.value)} placeholder="What should I tell the team lead?" dir="ltr" style={{ font: "inherit", fontSize: 14, flex: "1 1 200px", padding: "7px 10px", borderRadius: 10, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary }} />
          <Pb label="Copy" color={th.text.accent} bg={th.bg.elevated} disabled={!note.trim()} onClick={() => { props.onSend(props.isLead ? `Note to the team lead — ${team.name}: ${note.trim()}` : `Note to the team lead — ${team.name}: about ${owner.name} — ${note.trim()}`); setOpen(false); setNote(""); }} />
        </div>
      )}
    </div>
  );
}

// ---------- character ----------
function Dude(props: { x: number; y: number; t: number; seed: number; color: string; label: string; s?: number; lead?: boolean; asleep?: boolean; typing?: boolean; walking?: boolean; alert?: boolean; name?: string }) {
  // flat "blob with two dots for eyes" character (Grok Bot style)
  const th = useGrokTheme();
  const { t, seed } = props;
  const s = (props.s || 1) * (props.lead ? 1.2 : 1);
  const bob = props.asleep ? Math.sin(t * 0.8 + seed) * 0.8 * s : props.walking ? -Math.abs(Math.sin(t * 10 + seed)) * 3 * s : Math.sin(t * 2.2 + seed) * 1.4 * s;
  const tap = (Math.sin(t * 16 + seed * 2) > 0 ? 1.5 : -1.5) * s;
  const step = Math.sin(t * 12 + seed) * 3 * s;
  const shape = Math.abs(seed) % 3;
  const av = avatarFor(props.name);
  const avShape = av && av.shape;
  const c = av ? av.color : props.color;
  const op = props.asleep ? 0.45 : 1;
  const blink = !props.asleep && ((t + seed * 0.7) % 4.2) < 0.12;
  const look = props.walking ? 1.2 : Math.sin(t * 0.7 + seed) * 1.2;
  const body = avShape
    ? <g opacity={op} transform={`translate(0 ${11 * s}) rotate(${SHAPE_TILT[avShape]} 0 ${-13 * s})`}><path d={shapePathSvg(avShape, 25 * s, 26 * s)} fill={c} />{av!.badge && <circle cx={9.5 * s} cy={-4 * s} r={4.4 * s} fill={av!.badge} stroke="#141414" strokeWidth={1.2 * s} />}</g>
    : shape === 0
    ? <rect x={-12 * s} y={-15 * s} width={24 * s} height={26 * s} rx={9 * s} fill={c} opacity={op} transform={`rotate(${seed % 2 ? -8 : 7} 0 ${-2 * s})`} />
    : shape === 1
      ? <g fill={c} opacity={op}><circle cx={-5 * s} cy={-6 * s} r={7.5 * s} /><circle cx={5 * s} cy={-7 * s} r={7.5 * s} /><circle cx={8 * s} cy={2 * s} r={7 * s} /><circle cx={-7 * s} cy={3 * s} r={7 * s} /><circle cx={0} cy={4 * s} r={8 * s} /></g>
      : <path d={`M ${-11 * s} ${-2 * s} C ${-12 * s} ${-12 * s} ${-2 * s} ${-16 * s} ${4 * s} ${-14 * s} C ${11 * s} ${-12 * s} ${12 * s} ${-5 * s} ${11 * s} ${2 * s} C ${10 * s} ${10 * s} ${3 * s} ${12 * s} ${-3 * s} ${11 * s} C ${-9 * s} ${10 * s} ${-10 * s} ${6 * s} ${-11 * s} ${-2 * s} Z`} fill={c} opacity={op} />;
  const eyeY = avShape ? (11 - 26 * SHAPE_EYE[avShape]) * s : -4 * s, ex = 4.6 * s;
  return (
    <g transform={`translate(${props.x} ${props.y + bob})`} style={{ pointerEvents: "none" }}>
      <ellipse cx={0} cy={16 * s} rx={12 * s} ry={3.5 * s} fill="#000" opacity={0.25} />
      {props.walking && <g><ellipse cx={-5 * s} cy={12 * s + step} rx={3 * s} ry={3.5 * s} fill={c} /><ellipse cx={5 * s} cy={12 * s - step} rx={3 * s} ry={3.5 * s} fill={c} /></g>}
      {body}
      {props.typing && !props.asleep && <g><circle cx={-9 * s} cy={11 * s + tap} r={3 * s} fill={c} /><circle cx={9 * s} cy={11 * s - tap} r={3 * s} fill={c} /></g>}
      {props.asleep
        ? <g stroke="#141414" strokeWidth={1.6 * s} strokeLinecap="round"><line x1={-ex - 2 * s} y1={eyeY} x2={-ex + 2 * s} y2={eyeY} /><line x1={ex - 2 * s} y1={eyeY} x2={ex + 2 * s} y2={eyeY} /></g>
        : <g fill="#141414"><ellipse cx={-ex + look} cy={eyeY} rx={2.3 * s} ry={blink ? 0.4 * s : 3 * s} /><ellipse cx={ex + look} cy={eyeY} rx={2.3 * s} ry={blink ? 0.4 * s : 3 * s} /></g>}
      {props.lead && !props.asleep && <path d={`M ${-6 * s} ${-17 * s} L ${-4 * s} ${-22 * s} L 0 ${-18.5 * s} L ${4 * s} ${-22 * s} L ${6 * s} ${-17 * s} Z`} fill={th.text.warning} />}
      {props.asleep && [0, 1, 2].map((k) => { const ph = (t * 0.5 + k / 3 + seed * 0.1) % 1; return <text key={k} x={(10 + ph * 12) * s} y={(-18 - ph * 22) * s} fontSize={(9 + k * 3) * s} fontWeight={600} fill={th.text.tertiary} opacity={1 - ph}>z</text>; })}
      {props.alert && !props.asleep && <g transform={`translate(0 ${-34 * s}) scale(${(1 + 0.12 * Math.sin(t * 5)) * Math.sqrt(s)})`}><circle r={8} fill={th.fill.accent} /><text y={4} textAnchor="middle" fontSize={12} fontWeight={700} fill={th.text.onColor}>!</text></g>}
    </g>
  );
}

function Tree({ x, y, s, t, i }: { x: number; y: number; s: number; t: number; i: number }) {
  const th = useGrokTheme();
  const g = th.dataviz.categorical[1];
  const sway = Math.sin(t * 0.8 + i) * 2;
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} style={{ pointerEvents: "none" }}>
      <ellipse cx={4} cy={26} rx={30} ry={8} fill={th.text.primary} opacity={0.08} />
      <circle cx={sway} cy={0} r={28} fill={g} opacity={0.35} />
      <circle cx={-10 + sway} cy={-8} r={18} fill={g} opacity={0.6} />
      <circle cx={12 + sway} cy={-4} r={16} fill={g} opacity={0.5} />
    </g>
  );
}

// ---------- a pod (building) in the world ----------
function Pod(props: { team: Team; idx: number; c: { x: number; y: number }; t: number; hot: boolean; onHot: (id: string | null) => void; onEnter: () => void; alerts?: string[] }) {
  const th = useGrokTheme();
  const { team, t, c } = props;
  const frozen = team.status === "frozen";
  const size = frozen ? FPOD : POD;
  const w = size.w, h = size.h;
  const cats = th.dataviz.categorical;
  const tone = useTone(team.status);
  const glass = th.dataviz.blueTint || th.border.strong;
  const sc = frozen ? 0.85 : 1.15;
  const leadY = frozen ? -25 : -38;
  const rowY = frozen ? 45 : 62;
  const n = team.members.length;
  const mx = (i: number) => -w / 2 + 50 + (i + 0.5) * ((w - 100) / n);
  const count = team.pending.length;
  const speakers = 1 + n;
  const sp = Math.floor((t + props.idx * 1.7) / 3.6) % speakers;
  const ph = ((t + props.idx * 1.7) % 3.6) / 3.6;
  const bo = ph < 0.12 ? ph / 0.12 : ph > 0.88 ? (1 - ph) / 0.12 : 1;
  let say = "";
  let sx = 0, sy = leadY;
  if (!frozen) {
    if (sp === 0) { say = team.lines.length ? team.lines[Math.floor(t / 10.8 + props.idx) % team.lines.length] : ""; }
    else { const m = team.members[sp - 1]; const tk = team.tasks.find((x) => x.owner === m.name && x.state === "doing"); say = tk ? tk.text : ""; sx = mx(sp - 1); sy = rowY; }
  }
  say = clip(say, 26);
  const bw = Math.min(300, say.length * 8.6 + 30);
  const evs = team.activity;
  const ep = (t + props.idx * 3) % 9;
  const ev = evs.length ? evs[Math.floor((t + props.idx * 3) / 9) % evs.length] : null;
  const evO = ep < 0.5 ? ep / 0.5 : ep > 5.5 ? Math.max(0, 1 - (ep - 5.5) / 0.6) : 1;
  const flick = 0.55 + 0.25 * Math.sin(t * 3 + props.idx);
  const alerts = props.alerts || [];
  const rts = team.routines || [];
  const rOn = rts.filter((r) => r.state === "on").length, rOff = rts.length - rOn;
  const rFail = rts.some((r) => r.lastResult === "fail" && r.state !== "paused");
  const uPct = team.usage ? parseFloat(team.usage) : null;
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <g data-pod="1" onClick={props.onEnter} onPointerEnter={() => props.onHot(team.id)} onPointerLeave={() => props.onHot(null)} style={{ cursor: "pointer" }}>
        <rect x={-w / 2 + 10} y={-h / 2 + 18} width={w} height={h} rx={70} fill={th.text.primary} opacity={0.08} />
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={70} fill={frozen ? th.bg.subtle : "url(#floor)"} />
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={70} fill="none" stroke={props.hot ? th.border.focus : glass} strokeWidth={props.hot ? 10 : 8} opacity={frozen ? 0.4 : 0.85} />
        <rect x={-w / 2 + 8} y={-h / 2 + 8} width={w - 16} height={h - 16} rx={62} fill="none" stroke={th.border.strong} strokeWidth={1.5} opacity={0.5} />
        <rect x={-34 * sc} y={leadY + 14 * sc} width={68 * sc * 1.4} height={26 * sc} transform={`translate(${-14 * sc} 0)`} rx={6} fill={th.fill.secondary} stroke={th.border.default} />
        <rect x={-18 * sc} y={leadY + 28 * sc} width={36 * sc} height={7 * sc} rx={2} fill={frozen ? th.text.tertiary : th.fill.accent} opacity={frozen ? 0.3 : flick} />
        {count > 0 && [0, 1, 2].slice(0, Math.min(3, count)).map((k) => <rect key={k} x={30 * sc - k} y={leadY + 16 * sc - k * 3} width={20} height={14} rx={2} fill={th.bg.elevated} stroke={th.text.warning} strokeWidth={1.4} />)}
        {team.members.map((m, i) => (
          <g key={m.name}>
            <rect x={mx(i) - 30 * sc} y={rowY + 13 * sc} width={60 * sc} height={22 * sc} rx={5} fill={th.fill.secondary} stroke={th.border.default} />
            <rect x={mx(i) - 13 * sc} y={rowY + 25 * sc} width={26 * sc} height={6 * sc} rx={2} fill={frozen ? th.text.tertiary : th.fill.accent} opacity={frozen ? 0.3 : flick} />
          </g>
        ))}
        <Dude x={0} y={leadY} t={t} seed={props.idx * 7 + 1} color={cats[props.idx % cats.length]} label={initials(team.lead.name)} name={team.lead.name} s={sc} lead asleep={frozen} typing alert={count > 0} />
        {team.members.map((m, i) => <Dude key={m.name} x={mx(i)} y={rowY} t={t} seed={props.idx * 7 + i + 2} color={cats[(props.idx + i + 1) % cats.length]} label={initials(m.name)} name={m.name} s={sc} asleep={frozen} typing />)}
        {frozen && <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={70} fill={th.kind === "dark" ? th.bg.base : th.text.primary} opacity={th.kind === "dark" ? 0.55 : 0.32} />}
        {rOn + rOff > 0 && (
          <g transform={`translate(0 ${h / 2 - 2})`}>
            <rect x={-46} y={-17} width={92} height={34} rx={17} fill={th.bg.elevated} stroke={rFail ? th.text.danger : th.border.strong} strokeWidth={2} />
            <g transform="translate(24 0)"><Clock r={11} t={frozen ? 0 : t + props.idx} mode={rOn ? "on" : "paused"} fail={rFail} /></g>
            <text x={2} y={6} textAnchor="middle" direction="ltr" fontSize={16} fontWeight={800} fill={th.text.primary}>{rOn + rOff}</text>
            <text x={-22} y={6} textAnchor="middle" fontSize={13} fill={th.text.tertiary}>⏰</text>
          </g>
        )}
      </g>
      {alerts.length > 0 && (
        <g transform={`translate(${w / 2 - 48} ${-h / 2 + 30})`} style={{ pointerEvents: "none" }}>
          <circle r={34 + 10 * Math.sin(t * 5)} fill={th.text.danger} opacity={0.12} />
          <path d={`M 0 0 L ${60 * Math.cos(t * 4)} ${60 * Math.sin(t * 4)} A 60 60 0 0 1 ${60 * Math.cos(t * 4 + 0.6)} ${60 * Math.sin(t * 4 + 0.6)} Z`} fill={th.text.danger} opacity={0.22} />
          <rect x={-13} y={-4} width={26} height={14} rx={3} fill={th.text.secondary} />
          <path d="M -11 -4 a 11 13 0 0 1 22 0 z" fill={th.text.danger} opacity={0.65 + 0.35 * Math.sin(t * 8)} />
          <circle cx={-3} cy={-10} r={3} fill={th.bg.elevated} opacity={0.7} />
        </g>
      )}
      {uPct !== null && (
        <g transform={`translate(${team.name.length * 7 + 54} ${-h / 2 - 22})`} style={{ pointerEvents: "none" }}>
          <rect x={0} y={-13} width={44} height={26} rx={6} fill={th.bg.elevated} stroke={uPct >= 15 ? th.text.warning : th.border.strong} strokeWidth={2} />
          <rect x={44} y={-5} width={4} height={10} rx={1} fill={uPct >= 15 ? th.text.warning : th.border.strong} />
          <rect x={4} y={-9} width={36 * Math.min(1, uPct / 50)} height={18} rx={3} fill={uPct >= 15 ? th.text.warning : th.text.success} opacity={frozen ? 0.4 : 0.7 + 0.3 * Math.sin(t * 2 + props.idx)} />
          <text x={22} y={5} textAnchor="middle" direction="ltr" fontSize={12} fontWeight={800} fill={th.text.primary}>{uPct}%</text>
          {uPct >= 15 && !frozen && <text x={58} y={6} fontSize={16} opacity={0.6 + 0.4 * Math.sin(t * 4)}>⚠️</text>}
        </g>
      )}
      <g transform={`translate(0 ${-h / 2 - 22})`} style={{ pointerEvents: "none" }}>
        <rect x={-(team.name.length * 7 + 40)} y={-20} width={(team.name.length * 7 + 40) * 2} height={40} rx={20} fill={th.bg.elevated} stroke={th.border.strong} strokeWidth={2} opacity={frozen ? 0.7 : 1} />
        <circle cx={team.name.length * 7 + 22} cy={0} r={7} fill={tone} opacity={frozen ? 0.4 : 0.6 + 0.4 * Math.sin(t * 3 + props.idx)} />
        <text x={0} y={7} textAnchor="middle" direction="ltr" fontSize={20} fontWeight={700} fill={frozen ? th.text.tertiary : th.text.primary}>{team.name}</text>
        {count > 0 && <g transform={`translate(${-(team.name.length * 7 + 40)} -16) scale(${1 + 0.12 * Math.sin(t * 4)})`}><circle r={15} fill={th.text.warning} /><text y={5} textAnchor="middle" fontSize={15} fontWeight={700} fill={th.text.onColor}>{count}</text></g>}
      </g>
      {!frozen && say && !props.hot && (
        <g opacity={bo} style={{ pointerEvents: "none" }} transform={`translate(${sx} ${sy - 40 * sc})`}>
          <rect x={-bw / 2} y={-36} width={bw} height={30} rx={15} fill={th.bg.elevated} stroke={th.border.strong} strokeWidth={1.5} />
          <path d="M -7 -6.5 L 0 4 L 7 -6.5 Z" fill={th.bg.elevated} stroke={th.border.strong} strokeWidth={1.5} />
          <rect x={-8} y={-8} width={16} height={3} fill={th.bg.elevated} />
          <text x={0} y={-16} textAnchor="middle" direction="ltr" fontSize={14} fill={th.text.primary}>{say}</text>
        </g>
      )}
      {ev && !props.hot && evO > 0.01 && (
        <g opacity={evO} transform={`translate(0 ${-h / 2 - 78 - ep * 4})`} style={{ pointerEvents: "none" }}>
          <foreignObject x={-190} y={-34} width={380} height={44}>
            <div dir="ltr" style={{ display: "flex", justifyContent: "center" }}>
              <span style={{ fontFamily: th.font.family, fontSize: 14, padding: "5px 12px", borderRadius: 999, background: th.fill.accentSubtle, color: th.text.primary, border: `1px solid ${th.border.focus}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 370 }}>
                <b style={{ color: th.text.accent }}>{ev.time.split(" ")[1] || ev.time}</b> · {ev.text}
              </span>
            </div>
          </foreignObject>
        </g>
      )}
      {props.hot && (
        <foreignObject x={-200} y={-h / 2 - 230 - (alerts.length ? 60 : 0)} width={400} height={200 + (alerts.length ? 60 : 0)} style={{ pointerEvents: "none" }}>
          <div dir="ltr" style={{ fontFamily: th.font.family, background: th.bg.elevated, border: `2px solid ${th.border.focus}`, borderRadius: 16, padding: "12px 14px", boxShadow: "0 10px 30px rgba(0,0,0,.18)", color: th.text.primary }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: tone, display: "inline-block" }} />
              <b style={{ fontSize: 17 }}>{team.name}</b>
              <span style={{ fontSize: 12, color: th.text.tertiary }}>{STATUS_LABEL[team.status]}</span>
            </div>
            <div style={{ fontSize: 14, lineHeight: "20px", color: th.text.secondary }}>{clip(team.work, 120)}</div>
            <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 13 }}>
              <span>📝 {team.tasks.filter((x) => x.state === "doing").length} In progress</span>
              <span style={{ color: th.text.warning, fontWeight: 600 }}>✉ {count} waiting for you</span>
              <span style={{ color: th.text.accent, marginInlineStart: "auto" }}>Click to enter →</span>
            </div>
            {alerts.slice(0, 2).map((a, i) => <div key={i} style={{ fontSize: 12.5, color: th.text.danger, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>🚨 {a}</div>)}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

// ---------- approvals ----------
type Decision = { kind: "approve" | "reject" | "question"; msg: string };
function ApprovalCard(props: { team: Team; item: Pending; i: number; decision?: Decision; onDecide: (kind: Decision["kind"], msg: string) => void }) {
  const th = useGrokTheme();
  const { team, item, decision } = props;
  const [asking, setAsking] = useState(false);
  const [q, setQ] = useState("");
  const base = `${team.name}: ${item.what} [${item.id}]`;
  const stamp = decision ? (decision.kind === "approve" ? { l: "Approved ✓", c: th.text.success } : decision.kind === "reject" ? { l: "Reject", c: th.text.danger } : { l: "Ask ?", c: th.text.accent }) : null;
  const btn = (label: string, color: string, bg: string, onClick: () => void) => (
    <button onClick={onClick} style={{ font: "inherit", fontSize: 14, fontWeight: 600, padding: "7px 14px", borderRadius: 999, border: `1px solid ${bg}`, background: bg, color, cursor: "pointer" }}>{label}</button>
  );
  return (
    <div style={{ position: "relative", background: th.bg.elevated, borderRadius: 6, padding: "22px 18px 14px", boxShadow: "0 6px 18px rgba(0,0,0,.12)", transform: `rotate(${props.i % 2 ? 0.8 : -0.8}deg)`, border: `1px solid ${th.border.subtle}` }}>
      <div style={{ position: "absolute", top: -8, insetInlineStart: "40%", width: 70, height: 18, background: th.fill.warningSubtle, opacity: 0.9, transform: "rotate(-3deg)", borderRadius: 3 }} />
      <div style={{ fontSize: 12, color: th.text.tertiary, marginBottom: 6 }}>{team.name} · since {sinceLabel(item.since)}</div>
      <div style={{ fontSize: 17, lineHeight: "25px", color: th.text.primary, fontWeight: 500, marginBottom: 12 }}>{item.what}</div>
      {!decision && !asking && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {btn("Approve", th.text.onColor, th.fill.accent, () => props.onDecide("approve", `Approved — ${base}`))}
          {btn("Reject", th.text.primary, th.fill.secondary, () => props.onDecide("reject", `Rejected — ${base}`))}
          {btn("Ask", th.text.primary, th.fill.secondary, () => setAsking(true))}
        </div>
      )}
      {!decision && asking && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={q} onChange={(e: any) => setQ(e.target.value)} placeholder="What's the question?" dir="ltr" style={{ font: "inherit", fontSize: 14, flex: "1 1 180px", padding: "7px 10px", borderRadius: 10, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary }} />
          {btn("Send question", th.text.onColor, th.fill.accent, () => props.onDecide("question", `Question — ${base} — ${q || "(no breakdown)"}`))}
          {btn("Cancel", th.text.primary, th.fill.secondary, () => setAsking(false))}
        </div>
      )}
      {stamp && decision && (
        <div>
          <div style={{ position: "absolute", top: 14, insetInlineEnd: 14, transform: "rotate(-12deg)", border: `3px solid ${stamp.c}`, color: stamp.c, fontWeight: 800, fontSize: 18, padding: "2px 10px", borderRadius: 8, opacity: 0.85 }}>{stamp.l}</div>
          <div style={{ fontSize: 12, color: th.text.tertiary, background: th.bg.subtle, borderRadius: 8, padding: "6px 8px", marginTop: 4, userSelect: "all" }}>{decision.msg}</div>
        </div>
      )}
    </div>
  );
}

// ---------- room interior ----------
function Ring({ goal, t }: { goal: Goal; t: number }) {
  const th = useGrokTheme();
  const r = 44, circ = 2 * Math.PI * r;
  const frac = goal.current !== null ? Math.min(1, goal.current / goal.target) : 0;
  return (
    <svg width={110} height={110} viewBox="-55 -55 110 110">
      <circle r={r} fill="none" stroke={th.fill.secondary} strokeWidth={10} strokeDasharray={goal.current === null ? "5 6" : undefined} />
      {goal.current !== null && <circle r={r} fill="none" stroke={th.text.success} strokeWidth={10} strokeLinecap="round" strokeDasharray={`${circ * frac * ease(t / 1.5)} ${circ}`} transform="rotate(-90)" />}
      <text y={8} textAnchor="middle" fontSize={22} fontWeight={700} fill={th.text.primary}>{goal.current === null ? "?" : goal.current}/{goal.target}</text>
    </svg>
  );
}

function OldListRoom(props: { team: Team; idx: number; t: number; onExit: () => void; decisions: Record<string, Decision>; onDecide: (team: Team, item: Pending, kind: Decision["kind"], msg: string) => void }) {
  const th = useGrokTheme();
  const { team, t } = props;
  const frozen = team.status === "frozen";
  const tone = useTone(team.status);
  const cats = th.dataviz.categorical;
  const usage = team.usage ? parseFloat(team.usage) : null;
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(true); }, []);
  const people = [team.lead, ...team.members];
  const colW = 1000 / people.length;
  const noteBg = { todo: th.fill.warningSubtle, doing: th.fill.accentSubtle, done: th.fill.successSubtle };
  const panel = (title: string, extra: any, body: any) => (
    <div style={{ background: th.bg.elevated, borderRadius: 20, padding: 16, border: `1px solid ${th.border.subtle}`, boxShadow: "0 4px 16px rgba(0,0,0,.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}><span style={{ fontSize: 18, fontWeight: 700 }}>{title}</span>{extra}</div>
      {body}
    </div>
  );
  return (
    <div dir="ltr" style={{ minHeight: "100%", padding: "16px clamp(10px, 3vw, 32px) 90px", background: frozen ? th.bg.subtle : th.bg.base, opacity: shown ? 1 : 0, transform: shown ? "scale(1)" : "scale(.96)", transition: "opacity 380ms ease, transform 380ms cubic-bezier(.2,.8,.2,1)", filter: frozen ? "brightness(.72)" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
        <button onClick={props.onExit} style={{ font: "inherit", fontSize: 15, fontWeight: 700, padding: "10px 18px", borderRadius: 999, border: `2px solid ${th.border.focus}`, background: th.fill.accentSubtle, color: th.text.accent, cursor: "pointer" }}>← Back to campus</button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 18, height: 18, borderRadius: 9, background: tone, boxShadow: frozen ? undefined : `0 0 ${12 + 6 * Math.sin(t * 3)}px ${tone}` }} />
          <span style={{ fontSize: 30, fontWeight: 800 }}>{team.name}</span>
          <span style={{ fontSize: 14, color: th.text.secondary, padding: "3px 10px", borderRadius: 999, background: th.fill.secondary }}>{STATUS_LABEL[team.status]}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginInlineStart: "auto" }} title="Team share of weekly usage">
          <svg width={74} height={30} viewBox="0 0 74 30"><rect x={1} y={3} width={64} height={24} rx={6} fill="none" stroke={th.text.secondary} strokeWidth={2} /><rect x={66} y={10} width={5} height={10} rx={2} fill={th.text.secondary} /><rect x={5} y={7} width={usage !== null ? 56 * Math.min(1, usage / 100) * ease(t / 1.2) : 0} height={16} rx={3} fill={th.text.success} /></svg>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{usage !== null ? `${usage}%` : "—"}</span>
          <span style={{ fontSize: 12, color: th.text.tertiary }}>of usage</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: team.goal ? "minmax(0,1fr) auto" : "1fr", gap: 14, alignItems: "stretch", marginBottom: 14 }}>
        <div style={{ background: th.bg.elevated, borderRadius: 20, border: `1px solid ${th.border.subtle}`, overflow: "hidden" }}>
          <svg viewBox="0 0 1000 200" width="100%" style={{ display: "block" }}>
            <rect width={1000} height={200} fill="url(#floorIn)" />
            {people.map((p, i) => {
              const x = colW * (i + 0.5);
              const isLead = i === 0;
              const tk = isLead ? null : team.tasks.find((k) => k.owner === p.name && k.state === "doing");
              const say = frozen ? "" : isLead ? (team.lines[Math.floor(t / 4) % Math.max(1, team.lines.length)] || "") : tk ? tk.text : "";
              const txt = clip(say, Math.max(10, Math.floor(colW / 9)));
              const bw = Math.min(colW - 12, txt.length * 8.4 + 24);
              return (
                <g key={p.name}>
                  <rect x={x - 60} y={140} width={120} height={34} rx={8} fill={th.fill.secondary} stroke={th.border.default} />
                  <rect x={x - 22} y={156} width={44} height={8} rx={2} fill={frozen ? th.text.tertiary : th.fill.accent} opacity={frozen ? 0.3 : 0.55 + 0.25 * Math.sin(t * 3 + i)} />
                  <Dude x={x} y={122} t={t} seed={props.idx * 7 + i + 1} color={cats[(props.idx + i) % cats.length]} label={initials(p.name)} name={p.name} s={1.5} lead={isLead} asleep={frozen} typing />
                  <text x={x} y={193} textAnchor="middle" direction="ltr" fontSize={13} fill={th.text.secondary}>{p.name}</text>
                  {txt && (
                    <g transform={`translate(${x} ${48 + Math.sin(t * 1.5 + i) * 2})`}>
                      <rect x={-bw / 2} y={-22} width={bw} height={30} rx={15} fill={isLead ? th.fill.warningSubtle : th.bg.elevated} stroke={th.border.strong} strokeWidth={1.2} />
                      <path d="M -6 7.5 L 0 16 L 6 7.5 Z" fill={isLead ? th.fill.warningSubtle : th.bg.elevated} stroke={th.border.strong} strokeWidth={1.2} />
                      <text x={0} y={-2} textAnchor="middle" direction="ltr" fontSize={13} fill={th.text.primary}>{txt}</text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        {team.goal && (
          <div style={{ background: th.bg.elevated, borderRadius: 20, border: `1px solid ${th.border.subtle}`, padding: "10px 18px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 150 }}>
            <Ring goal={team.goal} t={t} />
            <div style={{ fontSize: 14, fontWeight: 600, textAlign: "center" }}>{team.goal.label}</div>
            {team.goal.due && <div style={{ fontSize: 12, color: th.text.tertiary }}>by {team.goal.due}</div>}
            {team.goal.current === null && <div style={{ fontSize: 11, color: th.text.tertiary }}>Current number not known yet</div>}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
        {panel("Waiting for your approval", <span style={{ fontSize: 13, fontWeight: 700, color: th.text.onColor, background: th.text.warning, borderRadius: 999, padding: "1px 9px" }}>{team.pending.length}</span>, (
          team.pending.length === 0 ? <div style={{ fontSize: 15, color: th.text.tertiary, padding: "20px 0", textAlign: "center" }}>The tray is empty. Nothing is waiting for you.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 6 }}>
              {team.pending.map((p, i) => <ApprovalCard key={p.id} team={team} item={p} i={i} decision={props.decisions[p.id]} onDecide={(k, m) => props.onDecide(team, p, k, m)} />)}
            </div>
          )
        ))}
        {panel("Task wall", null, (
          team.tasks.length === 0 ? <div style={{ fontSize: 15, color: th.text.tertiary, padding: "20px 0", textAlign: "center" }}>{frozen ? "The team is frozen. No open tasks." : "No tasks recorded."}</div> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
              {(["todo", "doing", "done"] as const).map((st) => (
                <div key={st} style={{ background: th.bg.subtle, borderRadius: 14, padding: 8, minHeight: 120 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: th.text.secondary, textAlign: "center", marginBottom: 8 }}>{STATE_LABEL[st]} · {team.tasks.filter((k) => k.state === st).length}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {team.tasks.filter((k) => k.state === st).map((k, i) => (
                      <div key={i} style={{ background: noteBg[st], borderRadius: 4, padding: "10px 9px 8px", boxShadow: "0 3px 8px rgba(0,0,0,.10)", transform: `rotate(${((i * 37) % 5) - 2}deg) translateY(${st === "doing" ? Math.sin(t * 2 + i) * 1.5 : 0}px)`, fontSize: 13.5, lineHeight: "19px", color: th.text.primary, opacity: st === "done" ? 0.8 : 1 }}>
                        {st === "done" && <span style={{ color: th.text.success, fontWeight: 800 }}>✓ </span>}
                        <span style={{ textDecoration: st === "done" ? "line-through" : undefined, textDecorationColor: th.text.tertiary }}>{k.text}</span>
                        {k.owner && <div style={{ marginTop: 6, fontSize: 11, color: th.text.secondary, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 16, height: 16, borderRadius: 8, background: k.owner === "Me" ? th.text.warning : th.fill.secondary, color: k.owner === "Me" ? th.text.onColor : th.text.primary, fontSize: 8, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{initials(k.owner)}</span>{k.owner}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ))}
        {panel("What happened lately", null, (
          team.activity.length === 0 ? <div style={{ fontSize: 15, color: th.text.tertiary, padding: "20px 0", textAlign: "center" }}>Quiet here. zZ</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {team.activity.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 15, background: cats[(props.idx + i) % cats.length], opacity: 0.85 }} />
                  <div style={{ background: th.bg.subtle, borderRadius: "16px 16px 16px 4px", padding: "8px 12px", maxWidth: "85%" }}>
                    <div style={{ fontSize: 14.5, lineHeight: "21px" }}>{a.text}</div>
                    <div style={{ fontSize: 11, color: th.text.tertiary, marginTop: 2 }}>{a.time}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        ))}
        {(team.work || team.next) && panel("What they're working on and what's next", null, (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ background: th.fill.accentSubtle, borderRadius: 14, padding: "10px 14px", fontSize: 15, lineHeight: "23px" }}>{team.work}</div>
            {team.next && <div style={{ background: th.fill.warningSubtle, borderRadius: 14, padding: "10px 14px", fontSize: 15, lineHeight: "23px" }}><b>Next step: </b>{team.next}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- room interior: an illustrated room, each kind of data in its own corner ----------
type RoomLayout = {
  W: number; H: number; portrait: boolean;
  back: { x0: number; x1: number; y0: number; y1: number };
  tv: { x: number; y: number; w: number; h: number };
  win: { x: number; y: number; w: number; h: number };
  board: { x: number; y: number; w: number; h: number; per: number };
  shelf: { x: number; y: number; s: number };
  meter: { x: number; y: number; s: number };
  door: string; doorSign: { x: number; y: number };
  lamp: { x: number; y: number };
  desk: { x: number; y: number; w: number };
  cs: number;
  plants: { x: number; y: number; s: number }[];
  panel: { x: number; y: number; w: number; h: number };
};
const ROOM_LAND: RoomLayout = {
  W: 1600, H: 1000, portrait: false,
  back: { x0: 260, x1: 1340, y0: 60, y1: 480 },
  tv: { x: 296, y: 112, w: 330, h: 206 },
  win: { x: 664, y: 100, w: 280, h: 250 },
  board: { x: 982, y: 88, w: 340, h: 372, per: 1 },
  shelf: { x: 132, y: 300, s: 1 },
  meter: { x: 118, y: 610, s: 1 },
  door: "1408,250 1528,222 1528,832 1408,588", doorSign: { x: 1468, y: 196 },
  lamp: { x: 800, y: 440 },
  desk: { x: 800, y: 630, w: 330 },
  cs: 2.1,
  plants: [{ x: 70, y: 920, s: 2.2 }, { x: 316, y: 520, s: 1.1 }],
  panel: { x: 1000, y: 478, w: 380, h: 296 },
};
const ROOM_PORT: RoomLayout = {
  W: 1000, H: 1820, portrait: true,
  back: { x0: 150, x1: 850, y0: 100, y1: 650 },
  board: { x: 178, y: 140, w: 644, h: 262, per: 2 },
  tv: { x: 178, y: 420, w: 330, h: 196 },
  win: { x: 540, y: 420, w: 282, h: 196 },
  shelf: { x: 74, y: 560, s: 0.72 },
  meter: { x: 66, y: 900, s: 0.8 },
  door: "882,360 975,336 975,1250 882,860", doorSign: { x: 928, y: 310 },
  lamp: { x: 500, y: 690 },
  desk: { x: 500, y: 860, w: 300 },
  cs: 2.2,
  plants: [{ x: 60, y: 1420, s: 2.2 }, { x: 196, y: 690, s: 1 }, { x: 806, y: 690, s: 1 }],
  panel: { x: 110, y: 1468, w: 780, h: 316 },
};
function workerSpots(L: RoomLayout, n: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (!L.portrait) {
    for (let i = 0; i < n; i++) out.push({ x: L.W * 0.14 + (i + 0.5) * ((L.W * 0.72) / n), y: 900 });
  } else {
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / 2), j = i % 2, cnt = Math.min(2, n - r * 2);
      out.push({ x: L.W * 0.22 + (j + 0.5) * ((L.W * 0.56) / cnt), y: 1130 + r * 235 });
    }
  }
  return out;
}

type RoomPop = { kind: "inbox" | "task" | "news" | "goal" | "person" | "usage" | "work" | "routine" | "routines"; i?: number };

function Room(props: { team: Team; idx: number; t: number; onExit: () => void; decisions: Record<string, Decision>; onDecide: (team: Team, item: Pending, kind: Decision["kind"], msg: string) => void; onSend: (msg: string) => void }) {
  const th = useGrokTheme();
  const { team, t } = props;
  const frozen = team.status === "frozen";
  const tone = useTone(team.status);
  const cats = th.dataviz.categorical;
  const dark = th.kind === "dark";
  const usage = team.usage ? parseFloat(team.usage) : null;
  const t0 = useRef<number | null>(null);
  if (t0.current === null) t0.current = t;
  const since = t - (t0.current || 0);
  const [exitAt, setExitAt] = useState<number | null>(null);
  const fired = useRef(false);
  const [portrait, setPortrait] = useState(false);
  const [pop, setPop] = useState<RoomPop | null>(null);
  const [hov, setHov] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const w = globalThis as any;
    const check = () => { if (w.innerWidth && w.innerHeight) setPortrait(w.innerWidth < w.innerHeight * 0.95); };
    check();
    if (w.addEventListener) { w.addEventListener("resize", check); return () => w.removeEventListener("resize", check); }
    return undefined;
  }, []);
  useEffect(() => {
    if (exitAt !== null && !fired.current && t - exitAt > 0.42) { fired.current = true; props.onExit(); }
  }, [t, exitAt]);
  const leave = () => { if (exitAt === null) { setPop(null); setHov(null); setExitAt(t); } };

  const L = portrait ? ROOM_PORT : ROOM_LAND;
  const { W, H, back: b } = L;
  // door-open entry, door-close exit
  const open = exitAt !== null ? 1 - ease((t - exitAt) / 0.4) : ease((since - 0.1) / 0.85);
  const zoom = 1.1 - 0.1 * open;
  const pending = team.pending;
  const count = pending.length;
  const undecided = pending.filter((p) => !props.decisions[p.id]).length;
  const people = team.members;
  const spots = workerSpots(L, people.length);
  const lit = !frozen;
  const wallBack = th.bg.elevated, wallSide = th.fill.secondary;
  const glass = th.dataviz.blueTint || th.border.strong;
  const tipOn = (text: string, x: number, y: number) => () => setHov({ text, x, y });
  const tipOff = () => setHov(null);
  const hit = (text: string, x: number, y: number, onClick: () => void) => ({
    onPointerEnter: tipOn(text, x, y), onPointerLeave: tipOff,
    onClick: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); setHov(null); onClick(); },
    style: { cursor: "pointer" } as any,
  });

  // perspective floor grid
  const N = 10;
  const floorLines: any[] = [];
  for (let i = 0; i <= N; i++) floorLines.push(<line key={"v" + i} x1={b.x0 + (i * (b.x1 - b.x0)) / N} y1={b.y1} x2={(i * W) / N} y2={H} stroke={th.border.subtle} strokeWidth={1.4} />);
  for (let j = 1; j <= 7; j++) {
    const k = Math.pow(j / 8, 1.5), y = b.y1 + (H - b.y1) * k;
    floorLines.push(<line key={"h" + j} x1={lerp(b.x0, 0, k)} y1={y} x2={lerp(b.x1, W, k)} y2={y} stroke={th.border.subtle} strokeWidth={1.4} />);
  }

  // which character speaks now (lead + workers take turns)
  const speakers = 1 + people.length;
  const turn = Math.floor(t / 3.4) % speakers;
  const ph = (t % 3.4) / 3.4;
  const bubbleO = ph < 0.1 ? ph / 0.1 : ph > 0.9 ? (1 - ph) / 0.1 : 1;
  const sayFor = (i: number): string => {
    if (frozen) return "";
    if (i === 0) return team.lines.length ? team.lines[Math.floor(t / (3.4 * speakers)) % team.lines.length] : clip(team.work, 30);
    const m = people[i - 1];
    const tk = team.tasks.find((x) => x.owner === m.name && x.state === "doing") || team.tasks.find((x) => x.owner === m.name && x.state === "todo");
    return tk ? tk.text : "";
  };
  const bubble = (x: number, y: number, text: string, o: number, warm?: boolean) => {
    const s = clip(text, L.portrait ? 24 : 30);
    if (!s) return null;
    const fs = L.portrait ? 21 : 19;
    const bw = Math.min(L.portrait ? 470 : 420, s.length * fs * 0.52 + 40);
    return (
      <g opacity={o} transform={`translate(${x} ${y + Math.sin(t * 1.6) * 3})`} style={{ pointerEvents: "none" }}>
        <rect x={-bw / 2} y={-48} width={bw} height={42} rx={21} fill={warm ? th.fill.warningSubtle : th.bg.elevated} stroke={th.border.strong} strokeWidth={1.6} />
        <path d="M -9 -7 L 0 8 L 9 -7 Z" fill={warm ? th.fill.warningSubtle : th.bg.elevated} stroke={th.border.strong} strokeWidth={1.6} />
        <rect x={-10} y={-9} width={20} height={4} fill={warm ? th.fill.warningSubtle : th.bg.elevated} />
        <text x={0} y={-20} textAnchor="middle" direction="ltr" fontSize={fs} fill={th.text.primary}>{s}</text>
      </g>
    );
  };

  // ---- whiteboard with sticky notes ----
  const B = L.board;
  const colW = (B.w - 24) / 3;
  const noteFill = { todo: th.fill.warningSubtle, doing: th.fill.accentSubtle, done: th.fill.successSubtle };
  const noteW = (colW - 12 - (B.per - 1) * 8) / B.per, noteH = L.portrait ? 44 : 40;
  const maxRows = Math.max(1, Math.floor((B.h - 64) / (noteH + 7)));
  const board = (
    <g>
      <rect x={B.x + 6} y={B.y + 10} width={B.w} height={B.h} rx={10} fill={th.text.primary} opacity={0.08} />
      <rect x={B.x} y={B.y} width={B.w} height={B.h} rx={10} fill={th.bg.base} stroke={th.border.strong} strokeWidth={5} />
      <rect x={B.x + 30} y={B.y + B.h - 2} width={B.w - 60} height={10} rx={4} fill={th.border.strong} />
      {(["todo", "doing", "done"] as const).map((st, c) => {
        const cx0 = B.x + B.w - 12 - (c + 1) * colW;
        const list = team.tasks.map((k, i) => ({ k, i })).filter((x) => x.k.state === st);
        const cap = maxRows * B.per;
        const shown = list.length > cap ? list.slice(0, cap - 1) : list;
        return (
          <g key={st}>
            {c > 0 && <line x1={cx0 + colW + 2} y1={B.y + 14} x2={cx0 + colW + 2} y2={B.y + B.h - 14} stroke={th.border.default} strokeWidth={2} strokeDasharray="6 6" />}
            <text x={cx0 + colW / 2} y={B.y + 34} textAnchor="middle" direction="ltr" fontSize={L.portrait ? 20 : 17} fontWeight={700} fill={st === "todo" ? th.text.warning : st === "doing" ? th.text.accent : th.text.success}>{STATE_LABEL[st]} · {list.length}</text>
            {shown.map(({ k, i }, j) => {
              const r = Math.floor(j / B.per), q = j % B.per;
              const nx = cx0 + colW - 6 - (q + 1) * noteW - q * 8, ny = B.y + 50 + r * (noteH + 7);
              const rot = ((i * 37) % 7) - 3;
              const wig = st === "doing" && lit ? Math.sin(t * 2 + i) * 1.2 : 0;
              const chars = Math.max(5, Math.floor(noteW / (L.portrait ? 10 : 8.6)));
              return (
                <g key={i} transform={`rotate(${rot + wig} ${nx + noteW / 2} ${ny + noteH / 2})`} {...hit(k.text, nx + noteW / 2, ny, () => setPop({ kind: "task", i }))}>
                  <rect x={nx + 2} y={ny + 3} width={noteW} height={noteH} rx={3} fill={th.text.primary} opacity={0.1} />
                  <rect x={nx} y={ny} width={noteW} height={noteH} rx={3} fill={noteFill[st]} stroke={th.border.default} strokeWidth={1} />
                  <circle cx={nx + noteW / 2} cy={ny + 4} r={3.4} fill={cats[(i + 2) % cats.length]} />
                  <text x={nx + noteW - 8} y={ny + noteH / 2 + 7} textAnchor="end" direction="ltr" fontSize={L.portrait ? 17 : 14.5} fill={th.text.primary} opacity={st === "done" ? 0.6 : 1} textDecoration={st === "done" ? "line-through" : undefined}>{clip(k.text, chars)}</text>
                  {st === "done" && <text x={nx + 8} y={ny + noteH / 2 + 7} fontSize={17} fontWeight={800} fill={th.text.success}>✓</text>}
                </g>
              );
            })}
            {list.length > shown.length && (
              <g {...hit("All tasks", cx0 + colW / 2, B.y + B.h - 40, () => setPop({ kind: "task", i: list[shown.length].i }))}>
                <rect x={cx0 + colW / 2 - 34} y={B.y + B.h - 40} width={68} height={28} rx={14} fill={th.fill.secondary} />
                <text x={cx0 + colW / 2} y={B.y + B.h - 20} textAnchor="middle" fontSize={15} fontWeight={700} fill={th.text.secondary}>+{list.length - shown.length}</text>
              </g>
            )}
          </g>
        );
      })}
      {team.tasks.length === 0 && <text x={B.x + B.w / 2} y={B.y + B.h / 2 + 20} textAnchor="middle" direction="ltr" fontSize={22} fill={th.text.tertiary}>{frozen ? "The board is empty and dusty" : "No tasks on the board"}</text>}
    </g>
  );

  // ---- news screen ----
  const V = L.tv;
  const evs = team.activity;
  const evI = evs.length ? Math.floor(t / 4.2) % evs.length : -1;
  const ev = evI >= 0 ? evs[evI] : null;
  const evPh = (t % 4.2) / 4.2;
  const evO = evPh < 0.12 ? evPh / 0.12 : evPh > 0.9 ? (1 - evPh) / 0.1 : 1;
  const tv = (
    <g {...hit("What happened lately", V.x + V.w / 2, V.y, () => setPop({ kind: "news" }))}>
      <rect x={V.x + 6} y={V.y + 10} width={V.w} height={V.h} rx={16} fill={th.text.primary} opacity={0.1} />
      <rect x={V.x} y={V.y} width={V.w} height={V.h} rx={16} fill={th.text.secondary} />
      <rect x={V.x + 12} y={V.y + 12} width={V.w - 24} height={V.h - 24} rx={8} fill={lit && ev ? th.bg.base : th.text.tertiary} opacity={lit ? 1 : 0.6} />
      {lit && ev && (
        <g>
          <rect x={V.x + 12} y={V.y + 12} width={V.w - 24} height={34} rx={8} fill={th.fill.accentSubtle} />
          <circle cx={V.x + V.w - 34} cy={V.y + 29} r={6} fill={th.text.danger} opacity={0.5 + 0.5 * Math.sin(t * 5)} />
          <text x={V.x + V.w - 48} y={V.y + 35} textAnchor="end" direction="ltr" fontSize={16} fontWeight={800} fill={th.text.danger}>LIVE</text>
          <text x={V.x + 28} y={V.y + 35} textAnchor="start" direction="ltr" fontSize={15} fontWeight={700} fill={th.text.accent}>{ev.time}</text>
          <foreignObject x={V.x + 20} y={V.y + 54} width={V.w - 40} height={V.h - 100} opacity={evO}>
            <div dir="ltr" style={{ fontFamily: th.font.family, fontSize: L.portrait ? 21 : 19, lineHeight: L.portrait ? "28px" : "26px", color: th.text.primary, fontWeight: 600, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" } as any}>{ev.text}</div>
          </foreignObject>
          <rect x={V.x + 12} y={V.y + V.h - 42} width={V.w - 24} height={30} rx={0} fill={th.fill.secondary} opacity={0.7} />
          <g>
            {evs.map((_, k) => <circle key={k} cx={V.x + V.w / 2 + (k - (evs.length - 1) / 2) * 16} cy={V.y + V.h - 27} r={k === evI ? 5 : 3.4} fill={k === evI ? th.text.accent : th.text.tertiary} />)}
          </g>
        </g>
      )}
      {(!lit || !ev) && <text x={V.x + V.w / 2} y={V.y + V.h / 2 + 8} textAnchor="middle" direction="ltr" fontSize={20} fill={th.bg.elevated}>{frozen ? "Screen off" : "Quiet here"}</text>}
      <rect x={V.x + V.w / 2 - 30} y={V.y + V.h} width={60} height={12} fill={th.text.secondary} />
    </g>
  );

  // ---- window to the campus ----
  const Wn = L.win;
  const cloud = ((t * 12) % (Wn.w + 160)) - 80;
  const win = (
    <g style={{ pointerEvents: "none" }}>
      <defs><clipPath id="roomWin"><rect x={Wn.x} y={Wn.y} width={Wn.w} height={Wn.h} rx={12} /></clipPath></defs>
      <g clipPath="url(#roomWin)">
        <rect x={Wn.x} y={Wn.y} width={Wn.w} height={Wn.h} fill={glass} opacity={lit ? 0.55 : 0.2} />
        <rect x={Wn.x} y={Wn.y + Wn.h * 0.68} width={Wn.w} height={Wn.h * 0.32} fill={cats[1]} opacity={lit ? 0.35 : 0.15} />
        {[0.2, 0.52, 0.82].map((f, k) => <g key={k}><circle cx={Wn.x + Wn.w * f} cy={Wn.y + Wn.h * 0.66} r={26 - k * 4} fill={cats[1]} opacity={lit ? 0.6 : 0.25} /><circle cx={Wn.x + Wn.w * f + 14} cy={Wn.y + Wn.h * 0.62} r={16} fill={cats[1]} opacity={lit ? 0.45 : 0.2} /></g>)}
        <g transform={`translate(${Wn.x + cloud} ${Wn.y + Wn.h * 0.25})`} opacity={lit ? 0.9 : 0.3}><ellipse rx={34} ry={13} fill={th.bg.elevated} /><ellipse cx={22} cy={-8} rx={20} ry={12} fill={th.bg.elevated} /></g>
        {frozen && <circle cx={Wn.x + Wn.w * 0.8} cy={Wn.y + Wn.h * 0.22} r={18} fill={th.bg.elevated} opacity={0.6} />}
      </g>
      <rect x={Wn.x} y={Wn.y} width={Wn.w} height={Wn.h} rx={12} fill="none" stroke={th.border.strong} strokeWidth={8} />
      <line x1={Wn.x + Wn.w / 2} y1={Wn.y} x2={Wn.x + Wn.w / 2} y2={Wn.y + Wn.h} stroke={th.border.strong} strokeWidth={6} />
      <line x1={Wn.x} y1={Wn.y + Wn.h / 2} x2={Wn.x + Wn.w} y2={Wn.y + Wn.h / 2} stroke={th.border.strong} strokeWidth={6} />
      <rect x={Wn.x - 14} y={Wn.y + Wn.h} width={Wn.w + 28} height={12} rx={4} fill={th.border.strong} />
    </g>
  );
  // sun rays from the window onto the floor
  const rays = lit ? (
    <polygon points={`${Wn.x + 20},${Wn.y + Wn.h} ${Wn.x + Wn.w - 20},${Wn.y + Wn.h} ${Wn.x + Wn.w + 140},${b.y1 + (H - b.y1) * 0.55} ${Wn.x - 140},${b.y1 + (H - b.y1) * 0.55}`} fill={th.fill.warningSubtle} opacity={0.22 + 0.06 * Math.sin(t * 0.7)} style={{ pointerEvents: "none" }} />
  ) : null;

  // ---- trophy shelf / goal gauge (left wall) ----
  const S = L.shelf;
  const g = team.goal;
  const frac = g && g.current !== null ? Math.min(1, g.current / g.target) : 0;
  const R = 52;
  const arc = (f: number) => { const a = Math.PI * (1 - f); return `${R * Math.cos(a)} ${-R * Math.sin(a)}`; };
  const shelf = (
    <g transform={`translate(${S.x} ${S.y}) skewY(14) scale(${0.8 * S.s} ${S.s})`} {...hit(g ? g.label : "No goal set", S.x, S.y - 150 * S.s, () => setPop({ kind: "goal" }))}>
      <rect x={-96} y={-150} width={192} height={250} rx={14} fill={th.bg.elevated} stroke={th.border.default} strokeWidth={3} />
      {g ? (
        <g>
          <g transform="translate(0 -84)">
            <path d={`M ${-R} 0 A ${R} ${R} 0 0 1 ${R} 0`} fill="none" stroke={th.fill.secondary} strokeWidth={16} strokeLinecap="round" strokeDasharray={g.current === null ? "8 10" : undefined} />
            {g.current !== null && frac > 0 && <path d={`M ${-R} 0 A ${R} ${R} 0 0 1 ${arc(frac * ease(since / 1.6))}`} fill="none" stroke={th.text.success} strokeWidth={16} strokeLinecap="round" />}
            {g.current !== null && <line x1={0} y1={0} x2={(R - 18) * Math.cos(Math.PI * (1 - frac * ease(since / 1.6)))} y2={-(R - 18) * Math.sin(Math.PI * (1 - frac * ease(since / 1.6)))} stroke={th.text.primary} strokeWidth={4} strokeLinecap="round" />}
            <circle r={7} fill={th.text.primary} />
            <text y={50} textAnchor="middle" direction="ltr" fontSize={30} fontWeight={800} fill={th.text.primary}>{g.current === null ? "?" : g.current}/{g.target}</text>
          </g>
        </g>
      ) : (
        <text y={-40} textAnchor="middle" fontSize={20} fill={th.text.tertiary}>—</text>
      )}
      <rect x={-104} y={40} width={208} height={12} rx={4} fill={th.border.strong} />
      <g transform="translate(0 38)" opacity={g ? 1 : 0.35}>
        <path d="M -22 -54 h 44 v 12 a 22 22 0 0 1 -44 0 z" fill={g && frac >= 1 ? th.text.warning : th.fill.warningSubtle} stroke={th.text.warning} strokeWidth={3} />
        <path d="M -22 -48 h -10 a 10 10 0 0 0 10 14 M 22 -48 h 10 a 10 10 0 0 1 -10 14" fill="none" stroke={th.text.warning} strokeWidth={3} />
        <rect x={-5} y={-20} width={10} height={12} fill={th.text.warning} />
        <rect x={-16} y={-9} width={32} height={9} rx={2} fill={th.text.warning} />
      </g>
      {g && lit && [0, 1, 2].map((k) => { const p = (t * 0.6 + k / 3) % 1; return <circle key={k} cx={-30 + k * 30} cy={-10 - p * 40} r={3} fill={th.text.warning} opacity={1 - p} />; })}
      <text y={84} textAnchor="middle" fontSize={17} fontWeight={600} fill={th.text.secondary} direction="ltr">{g ? clip(g.label, 16) : "No goal"}</text>
    </g>
  );

  // ---- usage meter (left wall) ----
  const M = L.meter;
  const uf = usage !== null ? Math.min(1, usage / 100) : 0;
  const meter = (
    <g transform={`translate(${M.x} ${M.y}) skewY(14) scale(${0.8 * M.s} ${M.s})`} {...hit(`Usage: ${usage !== null ? usage + "%" : "—"}`, M.x, M.y - 110 * M.s, () => setPop({ kind: "usage" }))}>
      <rect x={-46} y={-104} width={92} height={196} rx={16} fill={th.bg.elevated} stroke={th.border.default} strokeWidth={3} />
      <rect x={-22} y={-90} width={44} height={140} rx={10} fill="none" stroke={th.text.secondary} strokeWidth={4} />
      <rect x={-10} y={-98} width={20} height={8} rx={2} fill={th.text.secondary} />
      <rect x={-15} y={43 - 126 * uf * ease(since / 1.2)} width={30} height={126 * uf * ease(since / 1.2)} rx={6} fill={th.text.success} opacity={lit ? 0.75 + 0.25 * Math.sin(t * 2) : 0.4} />
      <path d="M 4 -42 L -8 -14 L 2 -14 L -4 12 L 10 -20 L 0 -20 Z" fill={th.text.warning} opacity={lit ? 0.9 : 0.3} />
      <text y={80} textAnchor="middle" fontSize={22} fontWeight={800} fill={th.text.primary}>{usage !== null ? `${usage}%` : "—"}</text>
    </g>
  );

  // ---- exit door (right wall) ----
  const DS = L.doorSign;
  const door = (
    <g {...hit("Back to campus", DS.x, DS.y + 20, leave)}>
      <polygon points={L.door} fill={th.fill.accentSubtle} stroke={th.border.focus} strokeWidth={5} />
      <polygon points={L.door} fill={glass} opacity={0.25 + 0.1 * Math.sin(t * 2)} />
      {(() => { const q = L.door.split(" ").map((s) => s.split(",").map(Number)); const kx = q[0][0] + (q[1][0] - q[0][0]) * 0.18, ky = (q[0][1] + q[3][1]) / 2 + 20; return <circle cx={kx} cy={ky} r={8} fill={th.border.focus} />; })()}
      <g transform={`translate(${DS.x} ${DS.y})`}>
        <rect x={-58} y={-22} width={116} height={40} rx={12} fill={th.fill.accent} opacity={0.9} />
        <text x={0} y={6} textAnchor="middle" direction="ltr" fontSize={19} fontWeight={800} fill={th.text.onColor}>← Campus</text>
      </g>
    </g>
  );

  // ---- status lamp hanging over the lead desk ----
  const Lp = L.lamp, D = L.desk;
  const lamp = (
    <g style={{ pointerEvents: "none" }}>
      {lit && <polygon points={`${Lp.x - 40},${Lp.y} ${Lp.x + 40},${Lp.y} ${D.x + D.w / 2 + 30},${D.y + 10} ${D.x - D.w / 2 - 30},${D.y + 10}`} fill={tone} opacity={0.08 + 0.03 * Math.sin(t * 2)} />}
      <path d={`M ${Lp.x - 46} ${Lp.y} L ${Lp.x - 22} ${Lp.y - 34} L ${Lp.x + 22} ${Lp.y - 34} L ${Lp.x + 46} ${Lp.y} Z`} fill={th.text.secondary} />
      <ellipse cx={Lp.x} cy={Lp.y + 2} rx={20} ry={9} fill={lit ? tone : th.text.tertiary} opacity={lit ? 0.75 + 0.25 * Math.sin(t * 3) : 0.4} />
    </g>
  );

  // ---- lead desk with the approval inbox tray ----
  const lc = cats[props.idx % cats.length];
  const trayX = D.x - D.w / 2 + 58, trayY = D.y - 22;
  const pulse = 0.5 + 0.5 * Math.sin(t * 3.5);
  const leadDesk = (
    <g>
      <ellipse cx={D.x} cy={D.y + 70} rx={D.w * 0.95} ry={70} fill={cats[(props.idx + 3) % cats.length]} opacity={0.12} />
      {undecided > 0 && lit && <ellipse cx={D.x} cy={D.y + 46} rx={D.w * 0.66 + pulse * 16} ry={42 + pulse * 6} fill="none" stroke={th.text.warning} strokeWidth={4} opacity={0.35 + 0.35 * pulse} />}
      <g {...hit(team.lead.name, D.x, D.y - 120 * L.cs / 2.1, () => setPop({ kind: "person", i: 0 }))}>
        <Dude x={D.x} y={D.y - 62} t={t} seed={props.idx * 7 + 1} color={lc} label={initials(team.lead.name)} name={team.lead.name} s={L.cs} lead asleep={frozen} typing alert={undecided > 0} />
        <circle cx={D.x} cy={D.y - 74} r={34} fill="transparent" />
      </g>
      <polygon points={`${D.x - D.w / 2 + 26},${D.y - 44} ${D.x + D.w / 2 - 26},${D.y - 44} ${D.x + D.w / 2},${D.y} ${D.x - D.w / 2},${D.y}`} fill={th.bg.elevated} stroke={th.border.strong} strokeWidth={2.5} />
      <rect x={D.x - D.w / 2} y={D.y} width={D.w} height={54} rx={4} fill={th.fill.secondary} stroke={th.border.strong} strokeWidth={2.5} />
      <rect x={D.x - D.w / 2 + 14} y={D.y + 54} width={14} height={30} fill={th.border.strong} />
      <rect x={D.x + D.w / 2 - 28} y={D.y + 54} width={14} height={30} fill={th.border.strong} />
      <g {...hit("What they're working on", D.x + D.w / 2 - 70, D.y - 70, () => setPop({ kind: "work" }))}>
        <rect x={D.x + D.w / 2 - 110} y={D.y - 92} width={80} height={54} rx={6} fill={th.text.secondary} />
        <rect x={D.x + D.w / 2 - 104} y={D.y - 86} width={68} height={40} rx={3} fill={lit ? th.fill.accent : th.text.tertiary} opacity={lit ? 0.45 + 0.2 * Math.sin(t * 3) : 0.4} />
        <rect x={D.x + D.w / 2 - 74} y={D.y - 38} width={8} height={8} fill={th.text.secondary} />
      </g>
      <g {...hit(count ? `${undecided} waiting for your approval` : "The tray is empty", trayX, trayY - 40, () => setPop({ kind: "inbox" }))}>
        {undecided > 0 && lit && <ellipse cx={trayX} cy={trayY - 6} rx={60} ry={30} fill={th.fill.warningSubtle} opacity={0.5 + 0.4 * pulse} />}
        {pending.slice(0, 6).map((p, k) => {
          const done = !!props.decisions[p.id];
          return <rect key={p.id} x={trayX - 30 + ((k * 7) % 5) - 2} y={trayY - 12 - k * 6} width={60} height={20} rx={2} fill={th.bg.elevated} stroke={done ? th.text.success : th.text.warning} strokeWidth={2} transform={`rotate(${((k * 13) % 9) - 4} ${trayX} ${trayY - k * 6})`} />;
        })}
        <path d={`M ${trayX - 44} ${trayY - 8} L ${trayX + 44} ${trayY - 8} L ${trayX + 36} ${trayY + 12} L ${trayX - 36} ${trayY + 12} Z`} fill={th.text.warning} opacity={0.85} />
        {count > 0 && (
          <g transform={`translate(${trayX + 44} ${trayY - 30 - Math.min(6, count) * 6}) scale(${1 + (undecided ? 0.12 * Math.sin(t * 4) : 0)})`}>
            <circle r={18} fill={undecided ? th.text.warning : th.text.success} />
            <text y={7} textAnchor="middle" fontSize={20} fontWeight={800} fill={th.text.onColor}>{undecided || "✓"}</text>
          </g>
        )}
        <rect x={trayX - 50} y={trayY - 70} width={100} height={90} fill="transparent" />
      </g>
      <text x={D.x} y={D.y + 36} textAnchor="middle" direction="ltr" fontSize={L.portrait ? 22 : 19} fontWeight={700} fill={th.text.secondary} style={{ pointerEvents: "none" }}>{clip(team.lead.name, 22)}</text>
    </g>
  );

  // ---- worker desks ----
  const workers = people.map((m, i) => {
    const p = spots[i];
    const s = L.cs * 0.95;
    const dw = L.portrait ? 230 : Math.min(230, (L.W * 0.72) / Math.max(1, people.length) - 30);
    return (
      <g key={m.name}>
        <g {...hit(`${m.name} · ${m.role}`, p.x, p.y - 140, () => setPop({ kind: "person", i: i + 1 }))}>
          <Dude x={p.x} y={p.y - 52} t={t} seed={props.idx * 7 + i + 2} color={cats[(props.idx + i + 1) % cats.length]} label={initials(m.name)} name={m.name} s={s} asleep={frozen} typing />
          <circle cx={p.x} cy={p.y - 64} r={32} fill="transparent" />
          <polygon points={`${p.x - dw / 2 + 16},${p.y - 30} ${p.x + dw / 2 - 16},${p.y - 30} ${p.x + dw / 2},${p.y} ${p.x - dw / 2},${p.y}`} fill={th.bg.elevated} stroke={th.border.strong} strokeWidth={2} />
          <rect x={p.x - dw / 2} y={p.y} width={dw} height={42} rx={4} fill={th.fill.secondary} stroke={th.border.strong} strokeWidth={2} />
          <path d={`M ${p.x - 34} ${p.y - 8} L ${p.x + 34} ${p.y - 8} L ${p.x + 26} ${p.y - 40} L ${p.x - 26} ${p.y - 40} Z`} fill={th.text.secondary} opacity={0.9} />
          <rect x={p.x - 22} y={p.y - 36} width={44} height={22} rx={2} fill={lit ? th.fill.accent : th.text.tertiary} opacity={lit ? 0.45 + 0.25 * Math.sin(t * 3 + i) : 0.35} />
          <text x={p.x} y={p.y + 29} textAnchor="middle" direction="ltr" fontSize={L.portrait ? 21 : 18} fontWeight={600} fill={th.text.secondary}>{clip(m.name, 14)}</text>
        </g>
      </g>
    );
  });

  // ---- routines control panel: one row per bot, a ticking clock and a lamp per scheduled task ----
  const P = L.panel;
  const rts = team.routines || [];
  const owners = ownersOf(team);
  const now = nowMs();
  const failN = rts.filter((r) => r.lastResult === "fail" && r.state !== "paused").length;
  const hdrH = L.portrait ? 64 : 52;
  const rowH = Math.min(L.portrait ? 62 : 48, (P.h - hdrH - 14) / Math.max(1, owners.length));
  const pfs = L.portrait ? 23 : 15.5;
  const chipW = L.portrait ? 150 : 84, chipH = Math.min(rowH - 10, L.portrait ? 44 : 30);
  const maxChips = 2;
  const sweep = ((t * 0.22) % 1.4) - 0.2;
  const panel = (
    <g>
      <rect x={P.x + 8} y={P.y + 12} width={P.w} height={P.h} rx={18} fill={th.text.primary} opacity={0.1} />
      <rect x={P.x + 24} y={P.y + P.h - 4} width={16} height={22} fill={th.border.strong} />
      <rect x={P.x + P.w - 40} y={P.y + P.h - 4} width={16} height={22} fill={th.border.strong} />
      <rect x={P.x} y={P.y} width={P.w} height={P.h} rx={18} fill={th.text.secondary} />
      <rect x={P.x + 9} y={P.y + 9} width={P.w - 18} height={P.h - 18} rx={11} fill={th.bg.base} />
      <defs><clipPath id="panelClip"><rect x={P.x + 9} y={P.y + 9} width={P.w - 18} height={P.h - 18} rx={11} /></clipPath></defs>
      {lit && <rect x={P.x + 9 + sweep * (P.w - 18)} y={P.y + 9} width={40} height={P.h - 18} fill={th.fill.accentSubtle} opacity={0.5} clipPath="url(#panelClip)" style={{ pointerEvents: "none" }} />}
      <g {...hit("All scheduled tasks", P.x + P.w / 2, P.y, () => setPop({ kind: "routines" }))}>
        <rect x={P.x + 9} y={P.y + 9} width={P.w - 18} height={hdrH - 6} rx={11} fill={th.fill.secondary} />
        <text x={P.x + P.w - 26} y={P.y + hdrH / 2 + pfs * 0.42 + 3} textAnchor="end" direction="ltr" fontSize={pfs + 2} fontWeight={800} fill={th.text.primary}>⏰ Scheduled tasks · {rts.length}</text>
        {failN > 0 && (
          <g transform={`translate(${P.x + 34} ${P.y + hdrH / 2 + 3})`}>
            <circle r={13 + 5 * (0.5 + 0.5 * Math.sin(t * 6))} fill={th.text.danger} opacity={0.18} />
            <circle r={11} fill={th.text.danger} opacity={0.6 + 0.4 * Math.sin(t * 6)} />
            <text y={5} textAnchor="middle" fontSize={14} fontWeight={800} fill={th.text.onColor}>{failN}</text>
          </g>
        )}
      </g>
      {owners.map((o, k) => {
        const y = P.y + hdrH + 6 + k * rowH, cy = y + rowH / 2;
        const mine = rts.map((r, i) => ({ r, i })).filter((x) => x.r.owner === o.name);
        const mode: "on" | "paused" | "unknown" | "none" = mine.some((x) => x.r.state === "on") ? "on" : mine.some((x) => x.r.state === "paused") ? "paused" : mine.length ? "unknown" : "none";
        const uns = (team.unscanned || []).includes(o.name);
        const shown = mine.slice(0, mine.length > maxChips ? maxChips - 1 : maxChips);
        return (
          <g key={o.name}>
            {k % 2 === 1 && <rect x={P.x + 12} y={y} width={P.w - 24} height={rowH} rx={8} fill={th.bg.subtle} style={{ pointerEvents: "none" }} />}
            <g {...hit(`${o.name}: ${mine.length ? mine.length + " Tasks" : "No tasks"}`, P.x + P.w - 80, y, () => setPop({ kind: "person", i: k }))}>
              <rect x={P.x + P.w * 0.45} y={y} width={P.w * 0.55 - 12} height={rowH} fill="transparent" />
              <g transform={`translate(${P.x + P.w - 34} ${cy})`}><Clock r={rowH * 0.33} t={lit ? t + k * 7 : 0} mode={mode} fail={mine.some((x) => x.r.lastResult === "fail" && x.r.state === "on")} /></g>
              <text x={P.x + P.w - 34 - rowH * 0.33 - 10} y={cy + pfs * 0.36} textAnchor="end" direction="ltr" fontSize={pfs} fontWeight={k === 0 ? 800 : 600} fill={mode === "none" ? th.text.tertiary : th.text.primary}>{k === 0 ? "👑 " : ""}{clip(k === 0 ? o.name.replace("Team lead ", "") : o.name, L.portrait ? 14 : 11)}</text>
            </g>
            {mine.length === 0 && <text x={P.x + 22} y={cy + pfs * 0.34} textAnchor="start" direction="ltr" fontSize={pfs - 2} fill={th.text.tertiary} style={{ pointerEvents: "none" }}>{uns ? "Not fully checked" : "No tasks"}</text>}
            {shown.map(({ r, i }, j) => {
              const nx = nextAt(r);
              const cx = P.x + 16 + j * (chipW + 8);
              const fail = r.lastResult === "fail" && r.state !== "paused";
              const lampC = r.state === "on" ? (fail ? th.text.danger : th.text.success) : r.state === "paused" ? th.text.warning : th.text.tertiary;
              const label = r.state === "paused" ? "Paused" : r.state === "unknown" ? "Unknown" : nx !== null ? shortWhen(nx, now) : "Active";
              const left = nx !== null && r.state === "on" ? Math.max(0, Math.min(1, (nx - now) / (7 * 864e5))) : 0;
              return (
                <g key={r.id} {...hit(r.name, cx + chipW / 2, cy - chipH / 2, () => setPop({ kind: "routine", i }))}>
                  <rect x={cx} y={cy - chipH / 2} width={chipW} height={chipH} rx={chipH / 2} fill={th.bg.elevated} stroke={lampC} strokeWidth={2} />
                  {left > 0 && <rect x={cx + 4} y={cy + chipH / 2 - 6} width={(chipW - 8) * (1 - left)} height={3} rx={1.5} fill={th.text.accent} opacity={0.6} />}
                  <circle cx={cx + chipW - chipH / 2} cy={cy} r={chipH * 0.2} fill={lampC} opacity={lit && (r.state === "on" || fail) ? (fail ? 0.4 + 0.6 * (Math.sin(t * 7) > 0 ? 1 : 0) : 0.55 + 0.45 * Math.sin(t * 3 + i)) : 0.8} />
                  <text x={cx + chipW - chipH + 2} y={cy + pfs * 0.34} textAnchor="end" direction="ltr" fontSize={pfs - 1.5} fontWeight={700} fill={th.text.primary}>{label}</text>
                </g>
              );
            })}
            {mine.length > shown.length && (
              <g {...hit("more tasks", P.x + 16 + shown.length * (chipW + 8) + 24, cy - chipH / 2, () => setPop({ kind: "person", i: k }))}>
                <rect x={P.x + 16 + shown.length * (chipW + 8)} y={cy - chipH / 2} width={chipW * 0.6} height={chipH} rx={chipH / 2} fill={th.fill.secondary} />
                <text x={P.x + 16 + shown.length * (chipW + 8) + chipW * 0.3} y={cy + pfs * 0.34} textAnchor="middle" fontSize={pfs - 1} fontWeight={700} fill={th.text.secondary}>+{mine.length - shown.length}</text>
              </g>
            )}
          </g>
        );
      })}
      {owners.length === 0 && <text x={P.x + P.w / 2} y={P.y + P.h / 2 + 10} textAnchor="middle" direction="ltr" fontSize={pfs} fill={th.text.tertiary}>No bots in this team</text>}
    </g>
  );

  // ---- frozen: dust + cobwebs ----
  const dust = frozen ? (
    <g style={{ pointerEvents: "none" }}>
      <rect width={W} height={H} fill={dark ? th.bg.base : th.text.primary} opacity={dark ? 0.45 : 0.26} />
      {Array.from({ length: 34 }).map((_, k) => {
        const x = (k * 97) % W, y = ((k * 211 + t * (8 + (k % 5) * 3)) % H);
        return <circle key={k} cx={x + Math.sin(t * 0.5 + k) * 12} cy={y} r={1.5 + (k % 3)} fill={th.bg.elevated} opacity={0.35} />;
      })}
      {[{ x: 0, sx: 1 }, { x: W, sx: -1 }].map((c, k) => (
        <g key={k} transform={`translate(${c.x} 0) scale(${c.sx} 1)`} opacity={0.5}>
          {[60, 110, 160].map((r) => <path key={r} d={`M ${r} 0 Q ${r * 0.62} ${r * 0.62} 0 ${r}`} fill="none" stroke={th.bg.elevated} strokeWidth={1.5} />)}
          {[0, 1, 2, 3].map((a) => <line key={a} x1={0} y1={0} x2={170 * Math.cos((a * Math.PI) / 6)} y2={170 * Math.sin((a * Math.PI) / 6)} stroke={th.bg.elevated} strokeWidth={1.2} />)}
        </g>
      ))}
    </g>
  ) : null;

  // ---- popover content ----
  const card: any = { background: th.bg.elevated, borderRadius: 22, padding: "18px 18px 16px", boxShadow: "0 18px 50px rgba(0,0,0,.28)", border: `1px solid ${th.border.subtle}`, width: "min(560px, 94%)", maxHeight: "84%", overflowY: "auto", position: "relative", color: th.text.primary };
  const title = (s: string, icon: string, extra?: any) => <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, paddingInlineEnd: 34 }}><span style={{ fontSize: 24 }}>{icon}</span><b style={{ fontSize: 20 }}>{s}</b>{extra}</div>;
  const chip = (s: string, c: string, bg: string) => <span style={{ fontSize: 13, fontWeight: 700, color: c, background: bg, borderRadius: 999, padding: "3px 10px" }}>{s}</span>;
  let popBody: any = null;
  if (pop) {
    if (pop.kind === "inbox") {
      popBody = (
        <div>
          {title("Approvals tray", "📥", count ? chip(`${undecided} waiting`, th.text.onColor, th.text.warning) : null)}
          {count === 0 ? <div style={{ textAlign: "center", padding: "26px 0", color: th.text.tertiary, fontSize: 16 }}>The tray is empty. Nothing is waiting for you.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 18, paddingTop: 6 }}>
              {pending.map((p, i) => <ApprovalCard key={p.id} team={team} item={p} i={i} decision={props.decisions[p.id]} onDecide={(k, m) => props.onDecide(team, p, k, m)} />)}
            </div>
          )}
        </div>
      );
    } else if (pop.kind === "task" && pop.i !== undefined && team.tasks[pop.i]) {
      const k = team.tasks[pop.i];
      const same = team.tasks.map((x, i) => ({ x, i })).filter((o) => o.x.state === k.state);
      popBody = (
        <div>
          {title(STATE_LABEL[k.state], k.state === "done" ? "✅" : k.state === "doing" ? "🛠️" : "📌", chip(`${same.findIndex((o) => o.i === pop.i) + 1}/${same.length}`, th.text.secondary, th.fill.secondary))}
          <div style={{ background: noteFill[k.state], borderRadius: 6, padding: "22px 20px", fontSize: 19, lineHeight: "28px", boxShadow: "0 8px 20px rgba(0,0,0,.12)", transform: "rotate(-1deg)" }}>
            {k.text}
            {k.owner && <div style={{ marginTop: 12, fontSize: 14, color: th.text.secondary }}>👤 {k.owner}</div>}
          </div>
          {same.length > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
              {[["← Previous", -1], ["Next →", 1]].map(([l, d]) => {
                const cur = same.findIndex((o) => o.i === pop.i);
                const nx = same[(cur + (d as number) + same.length) % same.length].i;
                return <button key={l as string} onClick={() => setPop({ kind: "task", i: nx })} style={{ font: "inherit", fontSize: 14, padding: "7px 14px", borderRadius: 999, border: `1px solid ${th.border.default}`, background: th.bg.subtle, color: th.text.primary, cursor: "pointer" }}>{l}</button>;
              })}
            </div>
          )}
        </div>
      );
    } else if (pop.kind === "news") {
      popBody = (
        <div>
          {title("What happened lately", "📺")}
          {evs.length === 0 ? <div style={{ textAlign: "center", padding: "26px 0", color: th.text.tertiary, fontSize: 16 }}>Quiet here. zZ</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {evs.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ width: 12, height: 12, marginTop: 12, flex: "0 0 12px", borderRadius: 6, background: cats[(props.idx + i) % cats.length] }} />
                  <div style={{ background: th.bg.subtle, borderRadius: "18px 18px 18px 6px", padding: "9px 13px" }}>
                    <div style={{ fontSize: 15.5, lineHeight: "22px" }}>{a.text}</div>
                    <div style={{ fontSize: 12, color: th.text.tertiary, marginTop: 3 }}>{a.time}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    } else if (pop.kind === "goal") {
      popBody = (
        <div style={{ textAlign: "center" }}>
          {title("Goal shelf", "🏆")}
          {g ? (
            <div>
              <div dir="ltr" style={{ display: "flex", justifyContent: "center" }}><Ring goal={g} t={since} /></div>
              <div style={{ fontSize: 19, fontWeight: 700, marginTop: 8 }}>{g.label}</div>
              {g.due && <div style={{ fontSize: 14, color: th.text.secondary, marginTop: 4 }}>by {g.due}</div>}
              {g.current === null && <div style={{ fontSize: 13, color: th.text.tertiary, marginTop: 8 }}>Current number not known yet</div>}
            </div>
          ) : <div style={{ padding: "20px 0", color: th.text.tertiary, fontSize: 16 }}>This team has no goal set right now.</div>}
        </div>
      );
    } else if (pop.kind === "usage") {
      popBody = (
        <div>
          {title("Energy meter", "🔋")}
          <div style={{ fontSize: 34, fontWeight: 800, textAlign: "center" }}>{usage !== null ? `${usage}%` : "—"}</div>
          <div style={{ fontSize: 14, color: th.text.secondary, textAlign: "center", marginBottom: 14 }}>{usage !== null ? "The team's share of weekly usage" : "No usage data for this team"}</div>
          <div style={{ background: th.bg.subtle, borderRadius: 14, padding: "10px 14px", fontSize: 14, lineHeight: "22px" }}>
            Total weekly usage: <b>{USAGE.weeklyPct}%</b> · resets {USAGE.reset}
          </div>
          {(team.botUsage || []).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Who uses the most</div>
              {(team.botUsage || []).map((u, i) => (
                <div key={u.owner} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7, fontSize: 14 }}>
                  <span style={{ width: 70 }}>{u.owner}</span>
                  <div style={{ flex: 1, height: 12, borderRadius: 6, background: th.fill.secondary, overflow: "hidden" }}><div style={{ width: `${Math.min(100, u.pct * 5) * ease((since - i * 0.15) / 1)}%`, height: "100%", borderRadius: 6, background: u.pct >= 10 ? th.text.warning : th.text.success }} /></div>
                  <b dir="ltr" style={{ width: 40 }}>{u.pct}%</b>{u.pct >= 10 && <span title="Heavy">⚠️</span>}
                </div>
              ))}
            </div>
          )}
          {rts.filter((r) => (r.perWeek || 0) >= 5 && r.state === "on").map((r) => (
            <div key={r.id} style={{ marginTop: 10, background: th.fill.warningSubtle, borderRadius: 14, padding: "9px 12px", fontSize: 14, lineHeight: "21px" }}>
              ⚠️ <b>{r.name}</b> ({r.owner}) runs {r.perWeek} times a week
              <div style={{ marginTop: 6 }}><Pb label="⏸ Pause it" color={th.text.warning} bg={th.bg.elevated} onClick={() => props.onSend(`Pause task — ${rBase(team, r)}`)} /></div>
            </div>
          ))}
        </div>
      );
    } else if (pop.kind === "routine" && pop.i !== undefined && rts[pop.i]) {
      const r = rts[pop.i];
      popBody = (
        <div>
          {title("Scheduled task", "⏰", chip(`${pop.i + 1}/${rts.length}`, th.text.secondary, th.fill.secondary))}
          <RoutineCard key={r.id} team={team} r={r} t={t} onSend={props.onSend} />
          {rts.length > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
              {[["← Previous", -1], ["Next →", 1]].map(([l, d]) => (
                <button key={l as string} onClick={() => setPop({ kind: "routine", i: ((pop.i as number) + (d as number) + rts.length) % rts.length })} style={{ font: "inherit", fontSize: 14, padding: "7px 14px", borderRadius: 999, border: `1px solid ${th.border.default}`, background: th.bg.subtle, color: th.text.primary, cursor: "pointer" }}>{l}</button>
              ))}
            </div>
          )}
        </div>
      );
    } else if (pop.kind === "routines") {
      popBody = (
        <div>
          {title("Scheduled tasks", "⏰", chip(`${rts.length}`, th.text.secondary, th.fill.secondary))}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {owners.map((o, k) => {
              const mine = rts.filter((r) => r.owner === o.name);
              const uns = (team.unscanned || []).includes(o.name);
              return (
                <div key={o.name}>
                  <button onClick={() => setPop({ kind: "person", i: k })} style={{ font: "inherit", fontSize: 15, fontWeight: 700, background: "none", border: "none", padding: "0 0 6px", color: th.text.primary, cursor: "pointer" }}>{k === 0 ? "👑 " : "🧑‍💻 "}{o.name} <span style={{ color: th.text.tertiary, fontWeight: 500, fontSize: 13 }}>· {mine.length || "None"}{uns && !mine.length ? " (not fully checked)" : ""}</span></button>
                  {mine.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{mine.map((r) => <RoutineCard key={r.id} team={team} r={r} t={t} onSend={props.onSend} compact />)}</div>}
                </div>
              );
            })}
          </div>
        </div>
      );
    } else if (pop.kind === "work") {
      popBody = (
        <div>
          {title("What they're working on", "💻", chip(STATUS_LABEL[team.status], tone, th.fill.secondary))}
          <div style={{ background: th.fill.accentSubtle, borderRadius: 16, padding: "12px 15px", fontSize: 16, lineHeight: "25px" }}>{team.work}</div>
          {team.next && <div style={{ background: th.fill.warningSubtle, borderRadius: 16, padding: "12px 15px", fontSize: 16, lineHeight: "25px", marginTop: 10 }}><b>Next step: </b>{team.next}</div>}
        </div>
      );
    } else if (pop.kind === "person" && pop.i !== undefined) {
      const m = pop.i === 0 ? team.lead : people[pop.i - 1];
      if (m) {
        const mine = team.tasks.filter((k) => (pop.i === 0 ? !k.owner || k.owner === m.name : k.owner === m.name) && k.state !== "done");
        const myR = rts.filter((r) => r.owner === m.name);
        const u = (team.botUsage || []).find((x) => x.owner === m.name);
        popBody = (
          <div>
            {title(m.name, pop.i === 0 ? "👑" : "🧑‍💻")}
            <div style={{ fontSize: 15, color: th.text.secondary, marginBottom: 12 }}>{m.role}</div>
            {pop.i === 0 && team.lines.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>{team.lines.map((l, i) => <span key={i} style={{ background: th.fill.warningSubtle, borderRadius: 999, padding: "6px 12px", fontSize: 14 }}>{l}</span>)}</div>}
            {mine.length === 0 ? <div style={{ color: th.text.tertiary, fontSize: 15 }}>{frozen ? "Asleep. zZ" : "No open task under this name."}</div> : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {mine.map((k, i) => <div key={i} style={{ background: noteFill[k.state], borderRadius: 4, padding: "10px 12px", fontSize: 14.5, lineHeight: "21px", boxShadow: "0 4px 10px rgba(0,0,0,.1)", transform: `rotate(${(i % 3) - 1}deg)`, flex: "1 1 200px" }}><span style={{ fontSize: 11, fontWeight: 700, color: th.text.secondary }}>{STATE_LABEL[k.state]}</span><div>{k.text}</div></div>)}
              </div>
            )}
            <div style={{ fontSize: 14, fontWeight: 700, margin: "14px 0 8px" }}>⏰ Its scheduled tasks</div>
            {myR.length === 0 ? <div style={{ color: th.text.tertiary, fontSize: 14 }}>{(team.unscanned || []).includes(m.name) ? "None found. The older part of its chat was not fully checked." : "No scheduled tasks."}</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{myR.map((r) => <RoutineCard key={r.id} team={team} r={r} t={t} onSend={props.onSend} compact />)}</div>
            )}
            {u && <div style={{ fontSize: 13.5, marginTop: 10, color: u.pct >= 10 ? th.text.warning : th.text.secondary }}>{u.pct >= 10 ? "⚠️ " : "🔋 "}Uses {u.pct}% of weekly usage</div>}
            <QuickCmds key={m.name} team={team} owner={m} isLead={pop.i === 0} onSend={props.onSend} />
          </div>
        );
      }
    }
  }

  // hover tooltip (svg coords)
  const tip = hov ? (() => {
    const s = clip(hov.text, 40);
    const fs = L.portrait ? 22 : 18;
    const w = s.length * fs * 0.52 + 34;
    const x = Math.max(w / 2 + 8, Math.min(W - w / 2 - 8, hov.x));
    const y = Math.max(52, hov.y);
    return (
      <g transform={`translate(${x} ${y})`} style={{ pointerEvents: "none" }}>
        <rect x={-w / 2} y={-48} width={w} height={40} rx={20} fill={th.text.primary} opacity={0.92} />
        <text x={0} y={-21} textAnchor="middle" direction="ltr" fontSize={fs} fontWeight={600} fill={th.bg.base}>{s}</text>
      </g>
    );
  })() : null;

  return (
    <div dir="ltr" style={{ position: "relative", width: "100%", minHeight: 560, height: L.portrait ? "auto" : "max(560px, min(92vh, 64vw))", aspectRatio: L.portrait ? `${W} / ${H}` : undefined, background: th.bg.subtle, overflow: "hidden" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" width="100%" height="100%" style={{ position: "absolute", inset: 0, display: "block", userSelect: "none", transform: `scale(${zoom})`, transformOrigin: "50% 60%", opacity: 0.35 + 0.65 * Math.min(1, open * 1.6) }} onClick={() => { setPop(null); setHov(null); }}>
        <defs>
          <linearGradient id="roomBack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={wallBack} /><stop offset="1" stopColor={th.bg.subtle} /></linearGradient>
        </defs>
        {/* shell of the room */}
        <polygon points={`0,0 ${W},0 ${b.x1},${b.y0} ${b.x0},${b.y0}`} fill={th.bg.subtle} />
        <rect x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} fill="url(#roomBack)" />
        <polygon points={`0,0 ${b.x0},${b.y0} ${b.x0},${b.y1} 0,${H}`} fill={wallSide} />
        <polygon points={`${W},0 ${b.x1},${b.y0} ${b.x1},${b.y1} ${W},${H}`} fill={wallSide} />
        <polygon points={`${b.x0},${b.y1} ${b.x1},${b.y1} ${W},${H} 0,${H}`} fill={th.bg.base} />
        <g style={{ pointerEvents: "none" }}>{floorLines}</g>
        <polygon points={`${b.x0},${b.y1} ${b.x1},${b.y1} ${W},${H} 0,${H}`} fill={cats[1]} opacity={0.05} style={{ pointerEvents: "none" }} />
        <line x1={b.x0} y1={b.y1} x2={b.x1} y2={b.y1} stroke={th.border.strong} strokeWidth={3} />
        <line x1={b.x0} y1={b.y0} x2={b.x0} y2={b.y1} stroke={th.border.default} strokeWidth={2} />
        <line x1={b.x1} y1={b.y0} x2={b.x1} y2={b.y1} stroke={th.border.default} strokeWidth={2} />
        <rect x={b.x0} y={b.y1 - 14} width={b.x1 - b.x0} height={14} fill={th.border.default} opacity={0.5} />
        {/* ceiling lights */}
        {lit && [0.25, 0.75].map((f, k) => <ellipse key={k} cx={lerp(b.x0, b.x1, f)} cy={b.y0 / 2 + 4} rx={60} ry={8} fill={th.bg.elevated} opacity={0.9} />)}
        {/* team name plate on the back wall */}
        <g transform={`translate(${(b.x0 + b.x1) / 2} ${b.y0 - 2})`} style={{ pointerEvents: "none" }}>
          <rect x={-(team.name.length * 9 + 46)} y={-2} width={(team.name.length * 9 + 46) * 2} height={36} rx={10} fill={th.bg.elevated} stroke={th.border.strong} strokeWidth={2} />
          <circle cx={team.name.length * 9 + 26} cy={16} r={7} fill={tone} opacity={lit ? 0.6 + 0.4 * Math.sin(t * 3) : 0.4} />
          <text x={0} y={24} textAnchor="middle" direction="ltr" fontSize={22} fontWeight={800} fill={th.text.primary}>{team.name}</text>
        </g>
        <line x1={Lp.x} y1={0} x2={Lp.x} y2={Lp.y - 30} stroke={th.border.strong} strokeWidth={3} style={{ pointerEvents: "none" }} />
        {win}
        {rays}
        {tv}
        {board}
        {shelf}
        {meter}
        {panel}
        {door}
        {L.plants.map((p, i) => (
          <g key={i} style={{ pointerEvents: "none" }}>
            <Tree x={p.x} y={p.y - 30 * p.s} s={p.s * 0.9} t={lit ? t : 0} i={i} />
            <path d={`M ${p.x - 22 * p.s} ${p.y - 8 * p.s} L ${p.x + 22 * p.s} ${p.y - 8 * p.s} L ${p.x + 16 * p.s} ${p.y + 22 * p.s} L ${p.x - 16 * p.s} ${p.y + 22 * p.s} Z`} fill={th.fill.secondary} stroke={th.border.strong} strokeWidth={2} />
          </g>
        ))}
        {lamp}
        {leadDesk}
        {workers}
        {/* speech bubbles: one character at a time */}
        {lit && (() => {
          const txt = sayFor(turn);
          if (turn === 0) return bubble(D.x, D.y - 62 - 46 * L.cs, txt, bubbleO, true);
          const p = spots[turn - 1];
          return p ? bubble(p.x, p.y - 52 - 40 * L.cs, txt, bubbleO) : null;
        })()}
        {dust}
        {tip}
        {/* doors that slide open on entry */}
        {open < 0.999 && (
          <g style={{ pointerEvents: "none" }}>
            <rect x={-W * 0.5 * open} y={0} width={W / 2} height={H} fill={glass} opacity={0.92} />
            <rect x={W / 2 + W * 0.5 * open} y={0} width={W / 2} height={H} fill={glass} opacity={0.92} />
            <rect x={W / 2 - W * 0.5 * open - 10} y={0} width={10} height={H} fill={th.border.strong} />
            <rect x={W / 2 + W * 0.5 * open} y={0} width={10} height={H} fill={th.border.strong} />
          </g>
        )}
      </svg>

      <button onClick={leave} style={{ position: "absolute", top: 12, insetInlineEnd: 14, zIndex: 5, font: "inherit", fontSize: L.portrait ? 13 : 15, fontWeight: 700, padding: L.portrait ? "6px 11px" : "9px 16px", borderRadius: 999, border: `2px solid ${th.border.focus}`, background: th.bg.elevated, color: th.text.accent, cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,.12)" }}>← Campus</button>

      {pop && popBody && (
        <div onClick={() => setPop(null)} style={{ position: "absolute", inset: 0, zIndex: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.28)" }}>
          <div onClick={(e: any) => e.stopPropagation()} style={card}>
            <button onClick={() => setPop(null)} aria-label="Close" style={{ position: "absolute", top: 12, insetInlineEnd: 12, width: 34, height: 34, borderRadius: 17, border: `1px solid ${th.border.default}`, background: th.bg.subtle, color: th.text.primary, cursor: "pointer", font: "inherit", fontSize: 16 }}>✕</button>
            {popBody}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- root ----------
// ---------- homepage side panels: what's running now (left) / waiting for you (right) ----------
function ageLabel(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "1 hour" : h === 2 ? "2 hours" : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : d === 2 ? "2 days" : `${d} days`;
}
type WorkRow = { key: string; team: Team; idx: number; text: string; owner: string; kind: "task" | "routine"; at?: number };
type ApproveRowT = { team: Team; idx: number; item: Pending; at: number | null };
function ownerColor(team: Team, idx: number, owner: string, cats: readonly string[]): string {
  const i = team.members.findIndex((m) => m.name === owner);
  return i >= 0 ? cats[(idx + i + 1) % cats.length] : cats[idx % cats.length];
}
function TeamChip(props: { team: Team; idx: number; onClick?: () => void }) {
  const th = useGrokTheme();
  const c = th.dataviz.categorical[props.idx % th.dataviz.categorical.length];
  const st: any = { display: "inline-flex", alignItems: "center", gap: 5, font: "inherit", fontSize: 11, fontWeight: 700, padding: "1px 8px 1px 6px", borderRadius: 999, border: `1px solid ${c}`, background: th.bg.base, color: th.text.primary, cursor: props.onClick ? "pointer" : "inherit", whiteSpace: "nowrap", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" };
  const inner = [<span key="d" style={{ width: 8, height: 8, borderRadius: 4, background: c, flex: "none" }} />, props.team.name];
  return props.onClick ? <button onClick={props.onClick} title={`Open the room of ${props.team.name}`} style={st}>{inner}</button> : <span style={st}>{inner}</span>;
}
function WorkItem(props: { row: WorkRow; t: number; k: number; onEnter: () => void }) {
  const th = useGrokTheme();
  const { row, t } = props;
  const cats = th.dataviz.categorical;
  const c = ownerColor(row.team, row.idx, row.owner, cats);
  const now = nowMs();
  return (
    <button onClick={props.onEnter} style={{ display: "flex", gap: 8, alignItems: "flex-start", width: "100%", textAlign: "start", font: "inherit", cursor: "pointer", background: th.bg.elevated, border: `1px solid ${th.border.subtle}`, borderRadius: 16, padding: "8px 10px 9px", boxShadow: "0 3px 10px rgba(0,0,0,.07)", color: th.text.primary, position: "relative", overflow: "hidden" }}>
      <svg width={34} height={40} viewBox="-17 -24 34 44" style={{ flex: "none" }}>
        {row.kind === "routine" ? <g transform="translate(0 -2)"><Clock r={13} t={t} mode="on" /></g> : <Dude x={0} y={0} t={t} seed={props.k * 5 + row.idx} color={c} label={initials(row.owner)} name={row.owner} s={0.9} typing />}
      </svg>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <TeamChip team={row.team} idx={row.idx} />
          <span style={{ fontSize: 11, color: th.text.tertiary }}>{row.kind === "routine" && row.at && t > 0 ? `Runs in ${countdown(row.at - now)}` : row.owner}</span>
        </span>
        <span style={{ fontSize: 13, lineHeight: "18px" }}>{clip(row.text, 110)}</span>
      </span>
      <span style={{ position: "absolute", insetInlineStart: 0, insetInlineEnd: 0, bottom: 0, height: 3, background: `repeating-linear-gradient(90deg, ${c} 0 14px, transparent 14px 28px)`, backgroundPosition: `${(t * 30 + props.k * 7) % 28}px 0`, opacity: row.kind === "routine" ? 0.35 : 0.7 }} />
    </button>
  );
}
function ApproveItem(props: { row: ApproveRowT; t: number; k: number; decision?: Decision; onDecide: (kind: Decision["kind"], msg: string) => void; onSendNow: (msg: string) => void; onEnter: () => void }) {
  const th = useGrokTheme();
  const { row, t, decision } = props;
  const [asking, setAsking] = useState(false);
  const [q, setQ] = useState("");
  const base = `${row.team.name}: ${row.item.what} [${row.item.id}]`;
  const waited = row.at !== null ? nowMs() - row.at : null;
  const late = waited !== null && waited > 864e5;
  const stamp = decision ? (decision.kind === "approve" ? { l: "Approved ✓", c: th.text.success } : decision.kind === "reject" ? { l: "Reject", c: th.text.danger } : { l: "Ask ?", c: th.text.accent }) : null;
  const sb = (label: string, color: string, bg: string, onClick: () => void) => (
    <button onClick={onClick} style={{ font: "inherit", fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 999, border: `1px solid ${bg}`, background: bg, color, cursor: "pointer", whiteSpace: "nowrap" }}>{label}</button>
  );
  return (
    <div style={{ position: "relative", background: th.bg.elevated, borderRadius: 6, padding: "14px 12px 10px", boxShadow: "0 4px 12px rgba(0,0,0,.10)", border: `1px solid ${late && !decision ? th.text.danger : th.border.subtle}`, transform: `rotate(${props.k % 2 ? 0.5 : -0.5}deg)` }}>
      <div style={{ position: "absolute", top: -6, insetInlineStart: "38%", width: 50, height: 13, background: th.fill.warningSubtle, opacity: 0.95, transform: "rotate(-3deg)", borderRadius: 3 }} />
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 5 }}>
        <TeamChip team={row.team} idx={row.idx} onClick={props.onEnter} />
        {waited !== null && t > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: late ? th.fill.dangerSubtle : th.bg.subtle, color: late ? th.text.dangerDeep : th.text.tertiary, opacity: late && !decision ? 0.65 + 0.35 * Math.sin(t * 4 + props.k) : 1 }}>⏳ Waiting {ageLabel(waited)}</span>
        )}
      </div>
      <div style={{ fontSize: 13, lineHeight: "19px", color: th.text.primary, fontWeight: 500, marginBottom: decision ? 4 : 8 }}>{row.item.what}</div>
      {!decision && !asking && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {sb("Approve", th.text.onColor, th.fill.accent, () => props.onDecide("approve", `Approved — ${base}`))}
          {sb("Reject", th.text.primary, th.fill.secondary, () => props.onDecide("reject", `Rejected — ${base}`))}
          {sb("Ask", th.text.primary, th.fill.secondary, () => setAsking(true))}
        </div>
      )}
      {!decision && asking && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input value={q} onChange={(e: any) => setQ(e.target.value)} placeholder="What's the question?" dir="ltr" style={{ font: "inherit", fontSize: 13, flex: "1 1 140px", minWidth: 0, padding: "5px 8px", borderRadius: 10, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary }} />
          {sb("Send question", th.text.onColor, th.fill.accent, () => props.onDecide("question", `Question — ${base} — ${q || "(no breakdown)"}`))}
          {sb("Cancel", th.text.primary, th.fill.secondary, () => setAsking(false))}
        </div>
      )}
      {stamp && decision && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ transform: "rotate(-8deg)", border: `2.5px solid ${stamp.c}`, color: stamp.c, fontWeight: 800, fontSize: 13, padding: "0 8px", borderRadius: 6, opacity: 0.9 }}>{stamp.l}</span>
          {sb("📨 Send now", th.text.onColor, th.fill.accent, () => props.onSendNow(decision.msg))}
        </div>
      )}
    </div>
  );
}
function SideBoard(props: { kind: "work" | "approve"; count: number; t: number; collapsed?: boolean; onToggle?: () => void; inline?: boolean; children: any }) {
  const th = useGrokTheme();
  const { t } = props;
  const isW = props.kind === "work";
  const title = isW ? "In progress" : "Waiting for your approval";
  const tone = isW ? th.text.accent : th.text.warning;
  const icon = isW ? (
    <svg width={22} height={22} viewBox="-11 -11 22 22"><g transform={`rotate(${(t * 60) % 360})`}>{[0, 45, 90, 135].map((a) => <rect key={a} x={-1.8} y={-10} width={3.6} height={20} rx={1.2} fill={tone} transform={`rotate(${a})`} />)}<circle r={6} fill={tone} /><circle r={2.6} fill={th.bg.elevated} /></g></svg>
  ) : (
    <svg width={22} height={22} viewBox="0 0 20 20" style={{ transform: `scale(${1 + 0.08 * Math.sin(t * 4)})` }}><path d="M2 11 l3 -7 h10 l3 7 v6 h-16 z" fill="none" stroke={tone} strokeWidth={1.8} strokeLinejoin="round" /><path d="M2 11 h5 l1 2 h4 l1 -2 h5" fill="none" stroke={tone} strokeWidth={1.8} /></svg>
  );
  const badge = <span style={{ minWidth: 22, height: 22, borderRadius: 11, background: props.count ? tone : th.fill.secondary, color: props.count ? th.text.onColor : th.text.secondary, fontSize: 12, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 6px" }}>{props.count}</span>;
  const floor = `linear-gradient(${th.border.subtle} 1px, transparent 1px) 0 0 / 30px 30px, linear-gradient(90deg, ${th.border.subtle} 1px, transparent 1px) 0 0 / 30px 30px, ${th.bg.subtle}`;
  if (props.collapsed) {
    return (
      <button onClick={props.onToggle} title={`${title} (${props.count})`} style={{ width: 46, height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "14px 0", font: "inherit", cursor: "pointer", background: th.bg.elevated, border: "none", borderInlineStart: isW ? `1px solid ${th.border.default}` : "none", borderInlineEnd: isW ? "none" : `1px solid ${th.border.default}`, color: th.text.primary }}>
        {icon}{badge}
        <span style={{ writingMode: "vertical-rl", fontSize: 13, fontWeight: 700, color: th.text.secondary }}>{title}</span>
      </button>
    );
  }
  return (
    <div style={{ height: props.inline ? "auto" : "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", background: floor, borderInlineStart: !props.inline && isW ? `1px solid ${th.border.default}` : "none", borderInlineEnd: !props.inline && !isW ? `1px solid ${th.border.default}` : "none" }}>
      {!props.inline && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 10px", background: th.bg.elevated, borderBottom: `3px solid ${th.dataviz.blueTint || th.border.strong}` }}>
          {icon}<b style={{ fontSize: 15 }}>{title}</b>{badge}
          <button onClick={props.onToggle} aria-label="Collapse" title="Collapse" style={{ marginInlineStart: "auto", width: 28, height: 28, borderRadius: 14, border: `1px solid ${th.border.default}`, background: th.bg.subtle, color: th.text.secondary, cursor: "pointer", font: "inherit", fontSize: 13 }}>{isW ? "⟨" : "⟩"}</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: props.inline ? "visible" : "auto", padding: "12px 10px 16px", display: "flex", flexDirection: "column", gap: isW ? 8 : 14 }}>{props.children}</div>
    </div>
  );
}

// floating HUD windows over the campus (wide screens)
function FloatWin(props: { side: "left" | "right"; title: string; count: number; tone: string; glow?: boolean; t: number; collapsed: boolean; onToggle: () => void; maxH: string; children: any; top?: number; w?: number; compact?: boolean }) {
  const th = useGrokTheme();
  const { t } = props;
  const shown = t > 0.25;
  const pos: any = props.side === "left" ? { left: 14 } : { right: 14 };
  const glass: any = { background: `color-mix(in srgb, ${th.bg.elevated} 90%, transparent)`, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" };
  const border = props.glow ? `1.5px solid ${th.fill.accent}` : `1px solid ${th.border.default}`;
  const shadow = "0 8px 28px rgba(0,0,0,.22)";
  const head = (
    <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 600, letterSpacing: "0.02em", color: th.text.secondary, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: props.tone, opacity: 0.7 + 0.3 * Math.sin(t * 2) }} />
      {props.title} · <b style={{ color: props.count ? th.text.accent : th.text.tertiary, fontWeight: 700 }}>{props.count}</b>
    </span>
  );
  if (props.collapsed) {
    return (
      <button onClick={props.onToggle} title="Open" style={{ position: "absolute", top: props.top === undefined ? 70 : props.top, ...pos, zIndex: 5, ...glass, border, boxShadow: shadow, borderRadius: 999, padding: "8px 14px", cursor: "pointer", font: "inherit", opacity: shown ? 1 : 0, transition: "opacity 400ms" }}>{head}</button>
    );
  }
  return (
    <div style={{ position: "absolute", top: props.top === undefined ? 70 : props.top, ...pos, zIndex: 5, width: props.w ? props.w : "clamp(250px, 21vw, 320px)", maxHeight: props.maxH, display: "flex", flexDirection: "column", ...glass, border, boxShadow: shadow, borderRadius: props.compact ? 14 : 20, overflow: "hidden", opacity: shown ? 1 : 0, transform: shown ? "translateX(0)" : `translateX(${props.side === "left" ? -18 : 18}px)`, transition: "opacity 450ms, transform 450ms" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: props.compact ? "7px 9px 6px" : "12px 14px 10px", borderBottom: `1px solid ${th.border.weak}` }}>
        {head}
        <button onClick={props.onToggle} aria-label="Minimize" title="Minimize" style={{ marginInlineStart: "auto", width: 24, height: 24, borderRadius: 12, border: `1px solid ${th.border.default}`, background: th.fill.secondary, color: th.text.secondary, cursor: "pointer", font: "inherit", fontSize: 14, lineHeight: "20px", padding: 0 }}>–</button>
      </div>
      <div style={{ overflowY: "auto", padding: props.compact ? "0 9px 5px" : "2px 14px 8px", overscrollBehavior: "contain", fontSize: props.compact ? 11.5 : undefined }}>{props.children}</div>
    </div>
  );
}
function FloatWorkRow(props: { row: WorkRow; t: number; last: boolean; onEnter: () => void; compact?: boolean }) {
  const cp = !!props.compact;
  const th = useGrokTheme();
  const { row, t } = props;
  const c = th.dataviz.categorical[row.idx % th.dataviz.categorical.length];
  const when = row.kind === "routine" && row.at ? (t > 0 ? `in ${countdown(row.at - nowMs())}` : "") : "In progress";
  return (
    <button onClick={props.onEnter} style={{ display: "block", width: "100%", textAlign: "start", font: "inherit", background: "none", border: "none", borderBottom: props.last ? "none" : `1px solid ${th.border.weak}`, padding: cp ? "6px 0" : "10px 0", cursor: "pointer", color: th.text.primary }}>
      <span style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: c, flex: "none", opacity: row.kind === "task" ? 0.75 + 0.25 * Math.sin(t * 3 + row.idx) : 0.6 }} />
        <b style={{ fontSize: cp ? 11.5 : 13 }}>{row.team.name}</b>
        <span style={{ fontSize: 11, color: th.text.tertiary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>· {row.owner}{when ? ` · ${when}` : ""}</span>
      </span>
      <span style={{ display: "-webkit-box", WebkitLineClamp: cp ? 2 : 3, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: cp ? 11.5 : 13, lineHeight: cp ? "15px" : "19px", color: th.text.secondary, paddingInlineStart: 15 } as any}>{row.kind === "routine" ? "⏰ " : ""}{row.text}</span>
    </button>
  );
}
function FloatApproveRow(props: { row: ApproveRowT; t: number; last: boolean; decision?: Decision; onDecide: (kind: Decision["kind"], msg: string) => void; onSendNow: (msg: string) => void; onEnter: () => void; compact?: boolean }) {
  const cp = !!props.compact;
  const th = useGrokTheme();
  const { row, t, decision } = props;
  const [asking, setAsking] = useState(false);
  const [q, setQ] = useState("");
  const c = th.dataviz.categorical[row.idx % th.dataviz.categorical.length];
  const base = `${row.team.name}: ${row.item.what} [${row.item.id}]`;
  const waited = row.at !== null ? nowMs() - row.at : null;
  const late = waited !== null && waited > 864e5;
  const sb = (label: string, color: string, bg: string, onClick: () => void) => (
    <button onClick={onClick} style={{ font: "inherit", fontSize: cp ? 11 : 12, fontWeight: 600, padding: cp ? "3px 8px" : "3px 11px", borderRadius: 999, border: `1px solid ${bg}`, background: bg, color, cursor: "pointer", whiteSpace: "nowrap" }}>{label}</button>
  );
  const stamp = decision ? (decision.kind === "approve" ? { l: "Approved ✓", c: th.text.successDeep } : decision.kind === "reject" ? { l: "Reject", c: th.text.dangerDeep } : { l: "Question asked", c: th.text.accent }) : null;
  return (
    <div style={{ borderBottom: props.last ? "none" : `1px solid ${th.border.weak}`, padding: cp ? "6px 0" : "10px 0", opacity: decision ? 0.75 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
        <button onClick={props.onEnter} title={`Open the room of ${row.team.name}`} style={{ font: "inherit", fontSize: 12, fontWeight: 800, color: c, background: "none", border: "none", padding: 0, cursor: "pointer" }}>{row.team.name}</button>
        {waited !== null && t > 0 && <span style={{ fontSize: 11, fontWeight: late ? 700 : 500, color: late ? th.text.danger : th.text.tertiary, opacity: late && !decision ? 0.6 + 0.4 * Math.sin(t * 4 + row.idx) : 1, whiteSpace: "nowrap" }}>⏳ Waiting {ageLabel(waited)}</span>}
      </div>
      <div style={{ fontSize: cp ? 11.5 : 13, lineHeight: cp ? "15px" : "19px", color: th.text.primary, marginBottom: cp ? 4 : 7 }}>{row.item.what}</div>
      {!decision && !asking && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {sb("Approve", th.text.onColor, th.fill.accent, () => props.onDecide("approve", `Approved — ${base}`))}
          {sb("Reject", th.text.primary, th.fill.secondary, () => props.onDecide("reject", `Rejected — ${base}`))}
          {sb("Ask", th.text.primary, th.fill.secondary, () => setAsking(true))}
        </div>
      )}
      {!decision && asking && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input value={q} onChange={(e: any) => setQ(e.target.value)} placeholder="What's the question?" dir="ltr" style={{ font: "inherit", fontSize: 13, flex: "1 1 120px", minWidth: 0, padding: "4px 8px", borderRadius: 10, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary }} />
          {sb("Send", th.text.onColor, th.fill.accent, () => props.onDecide("question", `Question — ${base} — ${q || "(no breakdown)"}`))}
          {sb("Cancel", th.text.primary, th.fill.secondary, () => setAsking(false))}
        </div>
      )}
      {stamp && decision && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: stamp.c, border: `1.5px solid ${stamp.c}`, borderRadius: 6, padding: "0 7px", transform: "rotate(-4deg)" }}>{stamp.l}</span>
          {sb("📨 Send now", th.text.onColor, th.fill.accent, () => props.onSendNow(decision.msg))}
        </div>
      )}
    </div>
  );
}


// ===== 3D WORKSPACE: campus, rooms and agents in 3D (shared by the canvas and the web app) =====
// The canvas draws it with a light SVG 3D engine (IsoCampus). The web app swaps in a WebGL scene (SCENE3D)
// and falls back to IsoCampus when WebGL is missing.
const SCENE3D: any = Campus3D;
type ScenePick = { team: string; what?: RoomPop["kind"]; member?: number };
type SceneCmd = { n: number; kind: "in" | "out" | "home" | "left" | "right" | "tilt" };
type SceneView = { x: number; z: number; yaw: number };
type SceneProps = {
  t: number; teams: Team[]; pos: Record<string, { x: number; y: number }>; idxOf: Record<string, number>;
  alertsOf: Record<string, string[]>; openOf: Record<string, number>; freshOf: Record<string, number>;
  focus: string | null; dim: string | null; hot: string | null; padR: number; padB: number; fitBoxes?: { l: number; r: number; t: number; b: number }[];
  cmd: SceneCmd; view: { current: SceneView | null }; clockLines: string[]; soonN: number;
  onPick: (p: ScenePick) => void; onHot: (id: string | null) => void; onClock: () => void;
  tip: (p: ScenePick) => any; onFail?: () => void; palette?: any;
};
type Agent3 = { i: number; name: string; role: string; ci: number; x: number; z: number; state: "type" | "idle" | "sleep"; lead: boolean; alert: boolean; task: string };
type RoomGeo = { w: number; d: number; lead: { x: number; z: number }; seats: { x: number; z: number }[]; board: { x: number; w: number }; tv: { x: number; w: number } };
const W3 = (p: { x: number; y: number }) => ({ x: p.x / 100 - 12, z: p.y / 100 - 7.5 });
function roomGeo(team: Team): RoomGeo {
  const fz = team.status === "frozen";
  const w = fz ? 3.3 : 5.3, d = fz ? 2.4 : 3.5; // roomier pods
  const n = Math.max(1, team.members.length);
  const span = w - 0.9;
  return {
    w, d, lead: { x: 0, z: -d * 0.12 },
    seats: team.members.map((_, i) => ({ x: -span / 2 + (i + 0.5) * (span / n), z: d * 0.24 })),
    board: { x: w * 0.2, w: Math.min(1.8, w * 0.34) }, tv: { x: -w * 0.24, w: Math.min(1.2, w * 0.24) },
  };
}
function agentsOf(team: Team, idx: number, open: number): Agent3[] {
  const g = roomGeo(team);
  const fz = team.status === "frozen";
  const doing = (n: string) => team.tasks.find((k) => k.owner === n && k.state === "doing");
  const lt = doing(team.lead.name);
  const busy = team.tasks.some((k) => k.state === "doing");
  const out: Agent3[] = [{ i: -1, name: team.lead.name, role: team.lead.role, ci: idx % 6, x: g.lead.x - 0.1, z: g.lead.z - 0.34, state: fz ? "sleep" : lt || busy ? "type" : "idle", lead: true, alert: open > 0 && !fz, task: lt ? lt.text : clip(team.work, 70) }];
  team.members.forEach((m, i) => {
    const tk = doing(m.name);
    const s = g.seats[i];
    out.push({ i, name: m.name, role: m.role, ci: (idx + i + 1) % 6, x: s.x - 0.1, z: s.z - 0.34, state: fz ? "sleep" : tk ? "type" : "idle", lead: false, alert: false, task: tk ? tk.text : "" });
  });
  return out;
}
function hexMix(hex: string, f: number, to?: string): string {
  const p = (h: string) => { const s = h.replace("#", ""); const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s; return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; };
  try {
    const a = p(hex), b = p(to || "#000000");
    const c = a.map((x, i) => Math.round(x * f + b[i] * (1 - f)));
    if (c.some((x) => isNaN(x))) return hex;
    return "#" + c.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
  } catch (e) { return hex; }
}

// ---- the SVG 3D engine (orthographic camera, painter's sort, cutaway walls) ----
type IsoCam = { x: number; z: number; yaw: number; pitch: number; zm: number };
const isoHome = (_w: number, _h: number): IsoCam => ({ x: -0.7, z: 0.3, yaw: 0, pitch: 0.96, zm: 1 });
const ISO_HOME: IsoCam = isoHome(1200, 700);
function IsoCampus(props: SceneProps) {
  const th = useGrokTheme();
  const { t, teams } = props;
  const cats = th.dataviz.categorical;
  const box = useRef<any>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  const [cam, setCam] = useState<IsoCam>(ISO_HOME);
  const homed = useRef(false);
  const [anim, setAnim] = useState<{ from: IsoCam; to: IsoCam; t0: number } | null>(null);
  const [tipAt, setTipAt] = useState<{ p: ScenePick; x: number; y: number } | null>(null);
  const prev = useRef<IsoCam>(ISO_HOME);
  const ptr = useRef<Record<number, { x: number; y: number }>>({});
  const drag = useRef<{ x: number; y: number; cam: IsoCam; moved: boolean; rot: boolean; dist: number; ang: number } | null>(null);
  const lastCmd = useRef(props.cmd.n);
  const lastFocus = useRef<string | null>(null);

  useEffect(() => {
    const w = globalThis as any;
    const el = box.current;
    const on = () => { if (el && el.getBoundingClientRect) { const r = el.getBoundingClientRect(); if (r.width > 10 && r.height > 10) setSize({ w: r.width, h: r.height }); } };
    on();
    let ro: any = null;
    if (w.ResizeObserver && el) { ro = new w.ResizeObserver(on); ro.observe(el); }
    if (w.addEventListener) w.addEventListener("resize", on);
    return () => { if (ro) ro.disconnect(); if (w.removeEventListener) w.removeEventListener("resize", on); };
  }, []);

  const W = size.w, H = size.h;
  const grow = campusGrow(teams, props.pos, W < 640);
  const growKey = [grow.x0, grow.x1, grow.z0, grow.z1].map((n) => n.toFixed(2)).join(",");
  const homeAt = (w: number, h: number): IsoCam => { const b = isoHome(w, h); return { ...b, x: b.x + (grow.x1 - grow.x0) / 2, z: b.z + (grow.z1 - grow.z0) / 2 }; };
  useEffect(() => { if (!homed.current && size.w !== 1200) { homed.current = true; const hm = homeAt(size.w, size.h); setCam(hm); prev.current = hm; } }, [size.w, size.h]);
  // a team was added beyond the original spots: re-frame the whole campus (only when not inside a room)
  const lastGrow = useRef(growKey);
  useEffect(() => { if (growKey === lastGrow.current) return; lastGrow.current = growKey; const hm = homeAt(size.w, size.h); prev.current = hm; if (!props.focus) setCam(hm); }, [growKey]);
  const HOME = homeAt(W, H);
  // the free area the campus should fit in (between or below the HUD windows); pick the one that shows it biggest
  const boxes = props.fitBoxes && props.fitBoxes.length ? props.fitBoxes : [{ l: 0, r: 0, t: 0, b: 0 }];
  let fb = boxes[0];
  // zoom that fits the whole campus for the home angle (fixed, so rotating does not pump the zoom)
  const fitOf = (p: number) => {
    const cy = Math.cos(HOME.yaw), sy = Math.sin(HOME.yaw), sp = Math.sin(p), cp = Math.cos(p);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    const phoneW = W < 640;
    const xs = phoneW ? [-6.4 - grow.x0, 9.8 + grow.x1] : [-11.6 - grow.x0, 10.2 + grow.x1];
    const zs = [-6.6 - grow.z0, 7.2 + grow.z1];
    [[xs[0], zs[0]], [xs[1], zs[0]], [xs[1], zs[1]], [xs[0], zs[1]]].forEach(([x, z]) => [0, 1.3].forEach((yy) => {
      const dx = x - HOME.x, dz = z - HOME.z; const rx = dx * cy - dz * sy, rz = dx * sy + dz * cy; const py = rz * sp - yy * cp;
      x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }));
    const fw = W - props.padR - fb.l - fb.r, fh = H - props.padB - fb.t - fb.b - (phoneW ? 120 : 60);
    return Math.max(10, Math.min(fw / (x1 - x0 + 0.6), fh / (y1 - y0 + 0.6)));
  };
  if (boxes.length > 1) {
    const cand = W - boxes[0].l - boxes[0].r < W * 0.55 ? boxes.slice(1) : boxes;
    { let best = -1, bi = cand[0]; for (const bx of cand) { fb = bx; const z = fitOf(HOME.pitch); if (z > best) { best = z; bi = bx; } } fb = bi; }
  }
  const DUR = 0.9;
  let v: IsoCam = cam;
  if (anim) {
    const k = ease((t - anim.t0) / DUR);
    let dy = anim.to.yaw - anim.from.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    v = { x: lerp(anim.from.x, anim.to.x, k), z: lerp(anim.from.z, anim.to.z, k), yaw: anim.from.yaw + dy * k, pitch: lerp(anim.from.pitch, anim.to.pitch, k), zm: lerp(anim.from.zm, anim.to.zm, k) };
  }
  const animDone = !!anim && t - anim.t0 >= DUR;
  useEffect(() => { if (animDone && anim) { setCam(anim.to); setAnim(null); } }, [animDone]);
  const fly = (to: IsoCam) => setAnim({ from: v, to, t0: t });
  const roomCam = (id: string): IsoCam | null => {
    const tm = teams.find((x) => x.id === id); const p = props.pos[id];
    if (!tm || !p) return null;
    const g = roomGeo(tm); const c = W3(p); const pitch = 0.86;
    const need = Math.min((W - props.padR) / (g.w + 1.3), (H - props.padB) / ((g.d + 1.0) * Math.sin(pitch) + 1.5 * Math.cos(pitch) + 0.6));
    return { x: c.x, z: c.z + 0.05, yaw: v.yaw, pitch, zm: Math.max(1, need / fitOf(pitch)) };
  };
  useEffect(() => {
    if (props.focus === lastFocus.current) return;
    const was = lastFocus.current;
    lastFocus.current = props.focus;
    if (props.focus) { if (!was) prev.current = v; const to = roomCam(props.focus); if (to) fly(to); }
    else fly(prev.current);
  }, [props.focus]);
  useEffect(() => {
    if (props.cmd.n === lastCmd.current) return;
    lastCmd.current = props.cmd.n;
    const k = props.cmd.kind;
    if (k === "home") fly(HOME);
    else if (k === "in" || k === "out") setCam({ ...v, zm: Math.max(0.6, Math.min(7, v.zm * (k === "in" ? 1.3 : 1 / 1.3))) });
    else if (k === "left" || k === "right") fly({ ...v, yaw: v.yaw + (k === "left" ? -1 : 1) * Math.PI / 4 });
    else if (k === "tilt") fly({ ...v, pitch: v.pitch > 1.1 ? 0.7 : v.pitch + 0.3 });
  }, [props.cmd.n]);
  props.view.current = { x: v.x, z: v.z, yaw: v.yaw };

  // ---- projection ----
  const zoom = fitOf(v.pitch) * v.zm;
  const cY = Math.cos(v.yaw), sY = Math.sin(v.yaw), sP = Math.sin(v.pitch), cP = Math.cos(v.pitch);
  const ox = fb.l + (W - props.padR - fb.l - fb.r) / 2, oy = fb.t + (H - props.padB - fb.t - fb.b) / 2 + 0.25 * zoom;
  const P = (X: number, Y: number, Z: number): [number, number, number] => {
    const dx = X - v.x, dz = Z - v.z;
    const rx = dx * cY - dz * sY, rz = dx * sY + dz * cY;
    return [ox + rx * zoom, oy + (rz * sP - Y * cP) * zoom, rz * cP + Y * sP];
  };
  const pts = (a: [number, number, number][]) => a.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const facing = (nx: number, nz: number) => nx * sY + nz * cY;
  const lightF = (nx: number, nz: number) => 0.62 + 0.3 * Math.max(0, -nx * 0.64 - nz * 0.77) + 0.08 * Math.max(0, nx * 0.64 + nz * 0.77 > 0 ? 0 : 1);
  type Dr = { d: number; l: number; el: any };
  const N4: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const boxD = (key: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: string, o?: { top?: string; stroke?: string; sw?: number; op?: number; ev?: any; l?: number; d?: number }): Dr => {
    const c: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const faces: any[] = [];
    for (let k = 0; k < 4; k++) {
      const [nx, nz] = N4[k];
      if (facing(nx, nz) > 0.001) {
        const a = c[k], b = c[(k + 1) % 4];
        faces.push(<polygon key={k} points={pts([P(a[0], y0, a[1]), P(b[0], y0, b[1]), P(b[0], y1, b[1]), P(a[0], y1, a[1])])} fill={hexMix(col, lightF(nx, nz))} />);
      }
    }
    faces.push(<polygon key="t" points={pts(c.map((q) => P(q[0], y1, q[1])))} fill={o && o.top ? o.top : col} stroke={o && o.stroke ? o.stroke : undefined} strokeWidth={o && o.sw ? o.sw : undefined} strokeLinejoin="round" />);
    const ctr = P((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return { d: o && o.d !== undefined ? o.d : ctr[2], l: o && o.l !== undefined ? o.l : 2, el: <g key={key} opacity={o && o.op !== undefined ? o.op : undefined} {...(o && o.ev ? o.ev : {})}>{faces}</g> };
  };
  const moved = () => !!(drag.current && drag.current.moved);
  const evFor = (p: ScenePick) => ({
    onClick: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); if (!moved()) { setTipAt(null); props.onPick(p); } },
    onPointerEnter: (e: any) => { props.onHot(p.team); const r = box.current && box.current.getBoundingClientRect ? box.current.getBoundingClientRect() : { left: 0, top: 0 }; setTipAt({ p, x: e.clientX - r.left, y: e.clientY - r.top }); },
    onPointerLeave: () => { props.onHot(null); setTipAt(null); },
    style: { cursor: "pointer" },
  });

  // ---- scene ----
  const dr: Dr[] = [];
  const labels: any[] = [];
  const PL = W3(PLAZA);
  const ground = th.bg.base, road = th.bg.elevated, wallC = th.fill.secondary, deskC = th.border.strong, floorC = th.bg.elevated;
  // roads
  teams.forEach((tm) => {
    if (tm.status === "frozen") return;
    const p = props.pos[tm.id]; if (!p) return;
    const c = ctrlFor(p);
    const L: [number, number, number][] = [], R: [number, number, number][] = [], M: [number, number, number][] = [];
    for (let i = 0; i <= 16; i++) {
      const k = i / 16, q = W3(qpt(PLAZA, c, p, k)), q2 = W3(qpt(PLAZA, c, p, Math.min(1, k + 0.02)));
      let tx = q2.x - q.x, tz = q2.z - q.z; const n = Math.hypot(tx, tz) || 1; tx /= n; tz /= n;
      L.push(P(q.x - tz * 0.24, 0.005, q.z + tx * 0.24)); R.push(P(q.x + tz * 0.24, 0.005, q.z - tx * 0.24)); M.push(P(q.x, 0.01, q.z));
    }
    dr.push({ d: -999, l: 0, el: <g key={"rd" + tm.id}><polygon points={pts([...L, ...R.reverse()])} fill={road} stroke={th.border.subtle} strokeWidth={1} /><polyline points={pts(M)} fill="none" stroke={th.border.strong} strokeWidth={Math.max(1, zoom * 0.025)} strokeDasharray={`${zoom * 0.18} ${zoom * 0.22}`} strokeDashoffset={-t * zoom * 0.2} opacity={0.6} /></g> });
  });
  // plaza + clock tower
  {
    const ring: [number, number, number][] = [];
    for (let i = 0; i < 36; i++) { const a = (i / 36) * Math.PI * 2; ring.push(P(PL.x + Math.cos(a) * 1.5, 0.04, PL.z + Math.sin(a) * 1.5)); }
    dr.push({ d: -998, l: 0, el: <g key="plaza"><polygon points={pts(ring)} fill={th.bg.elevated} stroke={th.border.strong} strokeWidth={1.5} />{[0, 1, 2].map((k) => { const ph = (t * 0.3 + k / 3) % 1; const rr: [number, number, number][] = []; for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; rr.push(P(PL.x + Math.cos(a) * (0.4 + ph), 0.05, PL.z + Math.sin(a) * (0.4 + ph))); } return <polygon key={k} points={pts(rr)} fill="none" stroke={th.fill.accent} strokeWidth={1.5} opacity={0.45 * (1 - ph)} />; })}</g> });
    const tw = { onClick: (e: any) => { if (e && e.stopPropagation) e.stopPropagation(); if (!moved()) props.onClock(); }, style: { cursor: "pointer" } };
    dr.push(boxD("tw0", PL.x - 0.42, PL.x + 0.42, 0, 0.22, PL.z - 0.42, PL.z + 0.42, th.border.strong, { ev: tw }));
    dr.push(boxD("tw1", PL.x - 0.26, PL.x + 0.26, 0.22, 1.75, PL.z - 0.26, PL.z + 0.26, th.bg.elevated, { ev: tw, top: th.border.strong }));
    const apex = P(PL.x, 2.3, PL.z);
    const base = [[-0.32, -0.32], [0.32, -0.32], [0.32, 0.32], [-0.32, 0.32]].map((q) => P(PL.x + q[0], 1.75, PL.z + q[1]));
    const roofF: any[] = [];
    for (let k = 0; k < 4; k++) { const [nx, nz] = N4[k]; if (facing(nx, nz) > -0.2) roofF.push(<polygon key={k} points={pts([base[k], base[(k + 1) % 4], apex])} fill={hexMix(th.fill.accent, lightF(nx, nz))} />); }
    const cp0 = P(PL.x, 1.25, PL.z);
    const nowD = new Date(nowMs());
    const il = ilParts(nowD.getTime());
    const hr = ((Number(il.hh) % 12) + Number(il.mm) / 60) * 30, mn = Number(il.mm) * 6, sc = nowD.getSeconds() * 6;
    const cr = 0.2 * zoom;
    const hand = (deg: number, len: number, w: number, c: string) => <line x1={cp0[0]} y1={cp0[1]} x2={cp0[0] + len * Math.sin((deg * Math.PI) / 180)} y2={cp0[1] - len * Math.cos((deg * Math.PI) / 180)} stroke={c} strokeWidth={w} strokeLinecap="round" />;
    dr.push({ d: P(PL.x, 1.2, PL.z)[2] + 0.5, l: 2, el: <g key="tw2" {...tw}>{roofF}<circle cx={cp0[0]} cy={cp0[1]} r={cr} fill={th.bg.base} stroke={th.border.strong} strokeWidth={Math.max(1.5, cr * 0.12)} />{hand(hr, cr * 0.5, Math.max(1.5, cr * 0.1), th.text.primary)}{hand(mn, cr * 0.75, Math.max(1, cr * 0.07), th.text.primary)}{hand(sc, cr * 0.82, 1, th.text.danger)}{props.soonN > 0 && <g><circle cx={cp0[0] + cr * 1.2} cy={cp0[1] - cr * 1.4} r={Math.max(9, cr * 0.42)} fill={th.fill.accent} /><text x={cp0[0] + cr * 1.2} y={cp0[1] - cr * 1.4 + 4} textAnchor="middle" fontSize={Math.max(11, cr * 0.5)} fontWeight={800} fill={th.text.onColor}>{props.soonN}</text></g>}</g> });
    const lp = P(PL.x, 0, PL.z + 1.25);
    if (zoom > 44 && !props.focus) labels.push(
      <div key="clk" style={{ position: "absolute", left: lp[0], top: lp[1], transform: "translate(-50%, 0)", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, pointerEvents: "none" }}>
        {props.clockLines.slice(0, 3).map((s, k) => <span key={k} style={{ fontSize: 12, padding: "2px 9px", borderRadius: 999, background: th.bg.elevated, border: `1px solid ${k === 0 ? th.border.focus : th.border.subtle}`, color: th.text.primary, whiteSpace: "nowrap" }}>{s}</span>)}
      </div>
    );
  }
  // trees
  TREES.forEach((q, i) => {
    const w = W3(q); const b = P(w.x, 0, w.z); const tp = P(w.x, 0.75, w.z); const r = 0.36 * zoom; const sway = Math.sin(t * 0.8 + i) * 0.03 * zoom;
    dr.push({ d: b[2], l: 2, el: <g key={"tr" + i} style={{ pointerEvents: "none" }}><ellipse cx={b[0]} cy={b[1]} rx={r * 0.9} ry={r * 0.9 * sP * 0.55} fill="#000" opacity={0.3} /><rect x={b[0] - r * 0.1} y={tp[1]} width={r * 0.2} height={b[1] - tp[1]} fill={th.border.strong} /><circle cx={tp[0] + sway} cy={tp[1]} r={r} fill="url(#isoTree)" /><circle cx={tp[0] - r * 0.45 + sway} cy={tp[1] + r * 0.25} r={r * 0.62} fill="url(#isoTree)" /></g> });
  });
  // rooms
  teams.forEach((tm) => {
    const p = props.pos[tm.id]; if (!p) return;
    const idx = props.idxOf[tm.id] || 0;
    const c = W3(p); const g = roomGeo(tm);
    const fz = tm.status === "frozen";
    const dimmed = !!props.dim && props.dim !== tm.id;
    const op = dimmed ? 0.28 : 1;
    const hotR = props.hot === tm.id;
    const x0 = c.x - g.w / 2, x1 = c.x + g.w / 2, z0 = c.z - g.d / 2, z1 = c.z + g.d / 2;
    const ev = evFor({ team: tm.id });
    const open = props.openOf[tm.id] || 0;
    const alerts = props.alertsOf[tm.id] || [];
    const tone = fz ? th.text.tertiary : alerts.length ? th.text.danger : tm.status === "hold" ? th.text.warning : tm.status === "partial" ? th.text.accent : th.text.success;
    const fl = boxD("fl" + tm.id, x0, x1, 0, 0.1, z0, z1, fz ? th.bg.base : floorC, { l: 1, op, ev, top: fz ? hexMix(th.bg.elevated, 0.8) : floorC, stroke: hotR ? th.fill.accent : th.border.subtle, sw: hotR ? 3 : 1 });
    dr.push(fl);
    // floor tiles
    if (zoom > 30) {
      const ln: any[] = [];
      for (let i = 1; i < 6; i++) { const a = P(x0 + (g.w * i) / 6, 0.101, z0), b = P(x0 + (g.w * i) / 6, 0.101, z1); ln.push(<line key={"a" + i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={th.border.subtle} strokeWidth={1} />); }
      for (let i = 1; i < 4; i++) { const a = P(x0, 0.101, z0 + (g.d * i) / 4), b = P(x1, 0.101, z0 + (g.d * i) / 4); ln.push(<line key={"b" + i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={th.border.subtle} strokeWidth={1} />); }
      dr.push({ d: fl.d, l: 1.1, el: <g key={"tl" + tm.id} opacity={op} style={{ pointerEvents: "none" }}>{ln}</g> });
    }
    // fresh ring
    if ((props.freshOf[tm.id] || 0) > 0 && !dimmed) {
      const rr: [number, number, number][] = []; const ph = (t * 0.8) % 1;
      for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2; rr.push(P(c.x + Math.cos(a) * (g.w * 0.62 + ph * 0.4), 0.02, c.z + Math.sin(a) * (g.d * 0.68 + ph * 0.4))); }
      dr.push({ d: -997, l: 0, el: <polygon key={"fr" + tm.id} points={pts(rr)} fill="none" stroke={th.fill.accent} strokeWidth={2.5} opacity={0.8 * (1 - ph)} style={{ pointerEvents: "none" }} /> });
    }
    // walls: far walls tall, near walls low (dollhouse cutaway)
    const WT = 0.08;
    const walls: { k: number; x0: number; x1: number; z0: number; z1: number }[] = [
      { k: 0, x0, x1, z0, z1: z0 + WT }, { k: 1, x0: x1 - WT, x1, z0, z1 }, { k: 2, x0, x1, z0: z1 - WT, z1 }, { k: 3, x0, x1: x0 + WT, z0, z1 },
    ];
    walls.forEach((wl) => {
      const [nx, nz] = N4[wl.k];
      const far = facing(-nx, -nz) > 0;
      const hgt = far ? (fz ? 0.8 : 1.05) : 0.24;
      const corners = [P(wl.x0, 0, wl.z0), P(wl.x1, 0, wl.z1), P(wl.x0, 0, wl.z1), P(wl.x1, 0, wl.z0)].map((q) => q[2]);
      const dd = far ? Math.min(...corners) - 0.01 : Math.max(...corners) + 0.01;
      if (!far && wl.k === 2) {
        const gx0 = c.x - 0.42, gx1 = c.x + 0.42; // door gap
        dr.push(boxD("wa" + tm.id + wl.k, wl.x0, gx0, 0.1, hgt, wl.z0, wl.z1, wallC, { op, ev, d: dd, top: th.border.strong }));
        dr.push(boxD("wb" + tm.id + wl.k, gx1, wl.x1, 0.1, hgt, wl.z0, wl.z1, wallC, { op, ev, d: dd, top: th.border.strong }));
      } else dr.push(boxD("w" + tm.id + wl.k, wl.x0, wl.x1, 0.1, hgt, wl.z0, wl.z1, wallC, { op, ev, d: dd, top: th.border.strong }));
    });
    // back-wall board (tasks) and TV (news), drawn on the north wall when it is a far wall
    const northFar = facing(0, 1) > 0;
    if (northFar && !fz) {
      const bz = z0 + WT + 0.01;
      const bx = c.x + g.board.x, bw = g.board.w;
      const bq = [P(bx - bw / 2, 0.45, bz), P(bx + bw / 2, 0.45, bz), P(bx + bw / 2, 0.98, bz), P(bx - bw / 2, 0.98, bz)];
      const notes: any[] = [];
      const st = (["todo", "doing", "done"] as const);
      st.forEach((s, col) => {
        const list = tm.tasks.filter((k) => k.state === s).slice(0, 4);
        list.forEach((_, j) => {
          const nx0 = bx - bw / 2 + 0.06 + col * (bw - 0.12) / 3, ny = 0.9 - j * 0.11;
          const q = [P(nx0 + 0.02, ny - 0.08, bz + 0.005), P(nx0 + (bw - 0.12) / 3 - 0.03, ny - 0.08, bz + 0.005), P(nx0 + (bw - 0.12) / 3 - 0.03, ny, bz + 0.005), P(nx0 + 0.02, ny, bz + 0.005)];
          notes.push(<polygon key={s + j} points={pts(q)} fill={s === "todo" ? th.text.warning : s === "doing" ? th.fill.accent : th.text.success} opacity={s === "done" ? 0.55 : 0.9} />);
        });
      });
      dr.push({ d: P(bx, 0.7, bz)[2] + 0.001, l: 2, el: <g key={"bd" + tm.id} opacity={op} {...evFor({ team: tm.id, what: "task" })}><polygon points={pts(bq)} fill={th.bg.base} stroke={th.border.strong} strokeWidth={2} />{notes}</g> });
      const tx = c.x + g.tv.x, tw2 = g.tv.w;
      const tq = [P(tx - tw2 / 2, 0.5, bz), P(tx + tw2 / 2, 0.5, bz), P(tx + tw2 / 2, 0.92, bz), P(tx - tw2 / 2, 0.92, bz)];
      const lit = tm.activity.length > 0;
      const sl = [0, 1, 2].map((k) => { const y = 0.82 - k * 0.1; const wv = 0.3 + 0.6 * ((Math.sin(t * 1.3 + k * 2 + idx) + 1) / 2); return <line key={k} x1={P(tx - tw2 / 2 + 0.08, y, bz + 0.005)[0]} y1={P(tx - tw2 / 2 + 0.08, y, bz + 0.005)[1]} x2={P(tx - tw2 / 2 + 0.08 + (tw2 - 0.16) * wv, y, bz + 0.005)[0]} y2={P(tx - tw2 / 2 + 0.08 + (tw2 - 0.16) * wv, y, bz + 0.005)[1]} stroke={k === 0 ? th.text.accent : th.text.secondary} strokeWidth={Math.max(1.2, zoom * 0.025)} strokeLinecap="round" opacity={0.85} />; });
      dr.push({ d: P(tx, 0.7, bz)[2] + 0.001, l: 2, el: <g key={"tv" + tm.id} opacity={op} {...evFor({ team: tm.id, what: "news" })}><polygon points={pts(tq)} fill={lit ? hexMix(th.fill.accent, 0.22, th.bg.base) : th.bg.base} stroke={th.border.strong} strokeWidth={3} />{lit && sl}</g> });
    }
    // desks + monitors
    const desk = (key: string, x: number, z: number, wide: number, lead: boolean) => {
      dr.push(boxD("dk" + key, x - wide / 2, x + wide / 2, 0.1, 0.42, z - 0.2, z + 0.2, deskC, { op, ev, top: hexMix(deskC, 1.12, "#ffffff") }));
      dr.push(boxD("mn" + key, x + wide / 2 - 0.36, x + wide / 2 - 0.06, 0.42, 0.68, z - 0.03, z + 0.03, th.bg.base, { op, ev, top: th.border.strong }));
      const scr = [P(x + wide / 2 - 0.34, 0.45, z - 0.035), P(x + wide / 2 - 0.08, 0.45, z - 0.035), P(x + wide / 2 - 0.08, 0.66, z - 0.035), P(x + wide / 2 - 0.34, 0.66, z - 0.035)];
      if (facing(0, -1) > 0 && !fz) dr.push({ d: P(x, 0.55, z - 0.04)[2], l: 2, el: <polygon key={"sc" + key} points={pts(scr)} fill={cats[(idx + (lead ? 0 : 2)) % cats.length]} opacity={(0.5 + 0.3 * Math.sin(t * 3 + x)) * op} style={{ pointerEvents: "none" }} /> });
      if (lead && open > 0) for (let k = 0; k < Math.min(5, open); k++) dr.push(boxD("pp" + key + k, x - wide / 2 + 0.08, x - wide / 2 + 0.36, 0.42 + k * 0.035, 0.445 + k * 0.035, z - 0.08 + (k % 2) * 0.02, z + 0.12, k === Math.min(5, open) - 1 ? th.fill.accent : "#e8e8e8", { op, ev: evFor({ team: tm.id, what: "inbox" }) }));
    };
    desk(tm.id + "L", c.x + g.lead.x, c.z + g.lead.z, 1.15, true);
    g.seats.forEach((s, i) => desk(tm.id + "S" + i, c.x + s.x, c.z + s.z, Math.min(0.9, (g.w - 1) / Math.max(1, g.seats.length) - 0.12), false));
    // shelf with the goal trophy
    if (!fz) {
      const sx = x0 + 0.3, sz = z0 + 0.45;
      dr.push(boxD("sh" + tm.id, sx - 0.18, sx + 0.18, 0.1, 0.6, sz - 0.18, sz + 0.18, wallC, { op, ev: evFor({ team: tm.id, what: "goal" }), top: th.border.strong }));
      const tp = P(sx, 0.72, sz); const r = 0.09 * zoom;
      dr.push({ d: P(sx, 0.6, sz)[2] + 0.02, l: 2, el: <g key={"tp" + tm.id} opacity={op} style={{ pointerEvents: "none" }}><path d={`M ${tp[0] - r} ${tp[1] - r} h ${2 * r} q 0 ${r * 1.4} ${-r} ${r * 1.4} q ${-r} 0 ${-r} ${-r * 1.4} z`} fill={tm.goal && tm.goal.current !== null && tm.goal.current >= tm.goal.target ? th.text.warning : hexMix(th.text.warning, 0.7)} /><rect x={tp[0] - r * 0.25} y={tp[1] + r * 0.4} width={r * 0.5} height={r * 0.6} fill={th.text.warning} /></g> });
      // plant
      const px = x1 - 0.32, pz = z1 - 0.32;
      dr.push(boxD("pt" + tm.id, px - 0.12, px + 0.12, 0.1, 0.3, pz - 0.12, pz + 0.12, deskC, { op }));
      const pp = P(px, 0.48, pz);
      dr.push({ d: P(px, 0.3, pz)[2] + 0.05, l: 2, el: <g key={"pl" + tm.id} opacity={op} style={{ pointerEvents: "none" }}><circle cx={pp[0] + Math.sin(t + idx) * 0.01 * zoom} cy={pp[1]} r={0.2 * zoom} fill="url(#isoTree)" /></g> });
    }
    // status lamp on the far corner
    const lpz = northFar ? z0 + 0.05 : z1 - 0.05;
    const lamp = P(x1 - 0.12, (fz ? 0.8 : 1.05) + 0.12, lpz);
    dr.push({ d: lamp[2] + 0.3, l: 2, el: <g key={"lm" + tm.id} opacity={op} style={{ pointerEvents: "none" }}><circle cx={lamp[0]} cy={lamp[1]} r={Math.max(4, 0.1 * zoom) * (1.6 + 0.3 * Math.sin(t * 3 + idx))} fill={tone} opacity={fz ? 0.08 : 0.18} /><circle cx={lamp[0]} cy={lamp[1]} r={Math.max(3, 0.07 * zoom)} fill={tone} opacity={fz ? 0.4 : 0.95} /></g> });
    // agents
    const ags = agentsOf(tm, idx, open);
    ags.forEach((a, k) => {
      const ax = c.x + a.x, az = c.z + a.z;
      const b = P(ax, 0.1, az);
      dr.push({ d: b[2] + 0.02, l: 2, el: <IsoBlob key={"ag" + tm.id + k} x={b[0]} y={b[1]} s={zoom * 0.0185 * (a.lead ? 1.15 : 1)} t={t} seed={idx * 7 + k} ci={a.ci} color={cats[a.ci % cats.length]} name={a.name} state={a.state} lead={a.lead} alert={a.alert} op={op} ev={evFor({ team: tm.id, what: "person", member: a.i })} /> });
    });
    // sign above the room
    const sp = P(c.x, (fz ? 0.8 : 1.05) + 0.55, z0);
    const fresh = props.freshOf[tm.id] || 0;
    labels.push(
      <div key={"lb" + tm.id} onClick={() => props.onPick({ team: tm.id })} style={{ position: "absolute", left: sp[0], top: sp[1], transform: "translate(-50%, -100%)", display: "flex", alignItems: "center", gap: 6, padding: "4px 10px 4px 6px", borderRadius: 999, background: th.bg.elevated, border: `1px solid ${hotR ? th.fill.accent : th.border.default}`, color: fz ? th.text.tertiary : th.text.primary, fontSize: Math.max(11, Math.min(15, zoom * 0.3)), fontWeight: 700, whiteSpace: "nowrap", cursor: "pointer", opacity: dimmed ? 0.35 : 1, boxShadow: "0 4px 14px rgba(0,0,0,.25)", zIndex: 1 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: tone, opacity: fz ? 0.5 : 0.65 + 0.35 * Math.sin(t * 3 + idx) }} />
        {tm.name}
        {open > 0 && <span style={{ minWidth: 18, height: 18, borderRadius: 9, background: th.fill.accent, color: th.text.onColor, fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px", transform: `scale(${1 + 0.08 * Math.sin(t * 4 + idx)})` }}>{open}</span>}
        {alerts.length > 0 && <span title={alerts.join(" · ")} style={{ fontSize: 12, opacity: 0.6 + 0.4 * Math.sin(t * 6) }}>🚨</span>}
        {fresh > 0 && <span style={{ fontSize: 10, fontWeight: 800, color: th.text.accent }}>✦ {fresh} new</span>}
      </div>
    );
  });
  // walkers on the roads
  teams.filter((x) => x.status !== "frozen").forEach((x, i) => {
    const p = props.pos[x.id]; if (!p) return;
    const c = ctrlFor(p); const per = 24 + i * 2; const f = ((t + i * 5) % per) / per;
    let k = -1;
    if (f > 0.3 && f <= 0.48) k = 0.82 - ease((f - 0.3) / 0.18) * 0.62; else if (f > 0.48 && f <= 0.6) k = 0.2; else if (f > 0.6 && f <= 0.78) k = 0.2 + ease((f - 0.6) / 0.18) * 0.62;
    if (k < 0) return;
    const q = W3(qpt(PLAZA, c, p, k)); const b = P(q.x, 0.02, q.z);
    const ci = (i + 1) % 6;
    dr.push({ d: b[2] + 0.02, l: 2, el: <IsoBlob key={"wk" + x.id} x={b[0]} y={b[1]} s={zoom * 0.016} t={t} seed={i * 3} ci={ci} color={cats[ci % cats.length]} state="walk" op={props.dim && props.dim !== x.id ? 0.3 : 1} /> });
  });
  {
    const fw = P(-9.9, 0, -4.7);
    if (teams.some((x) => x.status === "frozen") && !props.focus) labels.push(<div key="fzl" style={{ position: "absolute", left: fw[0], top: fw[1], transform: "translate(-50%,-100%)", fontSize: 13, fontWeight: 700, color: th.text.tertiary, whiteSpace: "nowrap", pointerEvents: "none" }}>Frozen wing · lights off</div>);
  }
  dr.sort((a, b) => (a.l - b.l) || (a.d - b.d));

  // ---- input ----
  const onDown = (e: any) => {
    ptr.current[e.pointerId] = { x: e.clientX, y: e.clientY };
    const ids = Object.keys(ptr.current);
    let dist = 0, ang = 0;
    if (ids.length === 2) { const a = ptr.current[Number(ids[0])], b = ptr.current[Number(ids[1])]; dist = Math.hypot(a.x - b.x, a.y - b.y); ang = Math.atan2(b.y - a.y, b.x - a.x); }
    drag.current = { x: e.clientX, y: e.clientY, cam: v, moved: false, rot: e.button === 2 || e.shiftKey, dist, ang };
  };
  const onMove = (e: any) => {
    const d = drag.current;
    if (!d || anim || !(e.pointerId in ptr.current)) return;
    ptr.current[e.pointerId] = { x: e.clientX, y: e.clientY };
    const ids = Object.keys(ptr.current);
    if (ids.length >= 2 && d.dist > 0) {
      const a = ptr.current[Number(ids[0])], b = ptr.current[Number(ids[1])];
      const dd = Math.hypot(a.x - b.x, a.y - b.y), an = Math.atan2(b.y - a.y, b.x - a.x);
      d.moved = true;
      setCam({ ...d.cam, zm: Math.max(0.6, Math.min(7, d.cam.zm * (dd / d.dist))), yaw: d.cam.yaw - (an - d.ang) });
      return;
    }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    if (!d.moved) return;
    if (d.rot) { setCam({ ...d.cam, yaw: d.cam.yaw + dx * 0.008, pitch: Math.max(0.5, Math.min(1.35, d.cam.pitch - dy * 0.005)) }); return; }
    const z0 = fitOf(d.cam.pitch) * d.cam.zm;
    const rx = -dx / z0, rz = -dy / (z0 * Math.sin(d.cam.pitch));
    const cy0 = Math.cos(d.cam.yaw), sy0 = Math.sin(d.cam.yaw);
    setCam({ ...d.cam, x: Math.max(-13, Math.min(13, d.cam.x + rx * cy0 + rz * sy0)), z: Math.max(-8.5, Math.min(8.5, d.cam.z - rx * sy0 + rz * cy0)) });
  };
  const onUp = (e: any) => {
    delete ptr.current[e.pointerId];
    const d = drag.current;
    if (d && d.moved) { const w = globalThis as any; if (w.setTimeout) w.setTimeout(() => { drag.current = null; }, 0); else drag.current = null; } else drag.current = null;
  };
  const tipEl = tipAt && !moved() ? props.tip(tipAt.p) : null;
  return (
    <div ref={box} style={{ position: "absolute", inset: 0, overflow: "hidden", background: ground, touchAction: "none", userSelect: "none", cursor: drag.current && drag.current.moved ? "grabbing" : "grab" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onUp} onContextMenu={(e: any) => { if (e && e.preventDefault) e.preventDefault(); }}
      onWheel={(e: any) => { if (!anim) setCam({ ...v, zm: Math.max(0.6, Math.min(7, v.zm * Math.exp(-e.deltaY * 0.0012))) }); }}>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, display: "block" }}>
        <defs>
          <radialGradient id="isoTree" cx="35%" cy="30%" r="75%"><stop offset="0%" stopColor={hexMix(cats[1], 1, "#ffffff")} /><stop offset="55%" stopColor={hexMix(cats[1], 0.75)} /><stop offset="100%" stopColor={hexMix(cats[1], 0.4)} /></radialGradient>
          {cats.map((c: string, i: number) => <radialGradient key={i} id={"isoB" + i} cx="35%" cy="28%" r="80%"><stop offset="0%" stopColor={hexMix(c, 0.55, "#ffffff")} /><stop offset="45%" stopColor={c} /><stop offset="100%" stopColor={hexMix(c, 0.55)} /></radialGradient>)}
          <pattern id="isoDots" width={28} height={28} patternUnits="userSpaceOnUse"><circle cx={2} cy={2} r={1} fill={th.border.subtle} /></pattern>
        </defs>
        <rect width={W} height={H} fill="url(#isoDots)" />
        {dr.map((x) => x.el)}
      </svg>
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}><div style={{ pointerEvents: "auto" }}>{labels}</div></div>
      {tipEl && (
        <div style={{ position: "absolute", left: Math.min(Math.max(10, tipAt!.x - 150), W - 320), top: Math.max(10, tipAt!.y - 190), width: 300, pointerEvents: "none", zIndex: 4 }}>{tipEl}</div>
      )}
    </div>
  );
}

// a 3D-shaded blob character (billboard), anchored at its feet
function IsoBlob(props: { x: number; y: number; s: number; t: number; seed: number; ci: number; color: string; state: "type" | "idle" | "sleep" | "walk"; lead?: boolean; alert?: boolean; op?: number; ev?: any; name?: string }) {
  const th = useGrokTheme();
  const { s, t, seed } = props;
  const sleep = props.state === "sleep", walk = props.state === "walk", typing = props.state === "type";
  const bob = sleep ? Math.sin(t * 0.8 + seed) * 0.6 * s : walk ? -Math.abs(Math.sin(t * 10 + seed)) * 2.5 * s : Math.sin(t * 2.2 + seed) * 1.1 * s;
  const sq = sleep ? 0.86 : 1 + (typing ? 0.03 * Math.sin(t * 8 + seed) : 0);
  const blink = !sleep && ((t + seed * 0.7) % 4.2) < 0.12;
  const look = walk ? 1.4 : Math.sin(t * 0.7 + seed) * 1.6;
  const shape = Math.abs(seed) % 3;
  const av = avatarFor(props.name);
  const col = av ? av.color : props.color;
  const gid = av ? "avB" + av.color.slice(1) : "";
  const fill = av ? `url(#${gid})` : `url(#isoB${props.ci % 6})`;
  const H = 27 * sq;
  const avShape = av && av.shape;
  const body = avShape
    ? <path d={shapePathSvg(avShape, 26, H)} fill={fill} transform={`rotate(${SHAPE_TILT[avShape]} 0 ${-H / 2})`} />
    : shape === 0
    ? <ellipse cx={0} cy={-H / 2} rx={12.5} ry={H / 2} fill={fill} />
    : shape === 1
      ? <rect x={-12} y={-H} width={24} height={H} rx={10} fill={fill} />
      : <path d={`M -12 ${-H * 0.45} C -12 ${-H * 1.02} 12 ${-H * 1.08} 12.5 ${-H * 0.5} C 13 ${-H * 0.05} 7 0 0 0 C -8 0 -12 ${-H * 0.08} -12 ${-H * 0.45} Z`} fill={fill} />;
  const tap = Math.sin(t * 16 + seed * 2) > 0 ? 1.4 : -1.4;
  const ey = -H * (avShape ? SHAPE_EYE[avShape] : 0.62);
  return (
    <g transform={`translate(${props.x.toFixed(1)} ${(props.y + bob).toFixed(1)}) scale(${s.toFixed(3)})`} opacity={(props.op === undefined ? 1 : props.op) * (sleep ? 0.6 : 1)} {...(props.ev || { style: { pointerEvents: "none" } })}>
      {av && <defs><radialGradient id={gid} cx="35%" cy="28%" r="80%"><stop offset="0%" stopColor={hexMix(av.color, 0.55, "#ffffff")} /><stop offset="45%" stopColor={av.color} /><stop offset="100%" stopColor={hexMix(av.color, 0.55)} /></radialGradient></defs>}
      <ellipse cx={0} cy={0} rx={13} ry={4} fill="#000" opacity={0.35} />
      {walk && <g><ellipse cx={-5} cy={-1 + Math.sin(t * 12 + seed) * 2} rx={3.4} ry={3} fill={col} /><ellipse cx={5} cy={-1 - Math.sin(t * 12 + seed) * 2} rx={3.4} ry={3} fill={col} /></g>}
      {body}
      <ellipse cx={-4.5} cy={-H * 0.8} rx={4} ry={2.6} fill="#ffffff" opacity={0.28} />
      {av && av.badge && <circle cx={9.5} cy={-4.5} r={4.4} fill={av.badge} stroke="#141414" strokeWidth={1.3} />}
      {typing && <g><circle cx={-10} cy={-6 + tap} r={3} fill={col} /><circle cx={10} cy={-6 - tap} r={3} fill={col} /></g>}
      {sleep
        ? <g stroke="#141414" strokeWidth={1.7} strokeLinecap="round"><line x1={-7.5 + look * 0.3} y1={ey} x2={-3 + look * 0.3} y2={ey} /><line x1={3 + look * 0.3} y1={ey} x2={7.5 + look * 0.3} y2={ey} /></g>
        : <g fill="#141414"><ellipse cx={-4.6 + look} cy={ey} rx={2.3} ry={blink ? 0.4 : 3.1} /><ellipse cx={4.6 + look} cy={ey} rx={2.3} ry={blink ? 0.4 : 3.1} /><circle cx={-4 + look} cy={ey - 1.2} r={0.8} fill="#ffffff" opacity={blink ? 0 : 0.9} /><circle cx={5.2 + look} cy={ey - 1.2} r={0.8} fill="#ffffff" opacity={blink ? 0 : 0.9} /></g>}
      {props.lead && !sleep && <path d={`M -7 ${-H - 1} L -5 ${-H - 8} L -1.5 ${-H - 3.5} L 0 ${-H - 9} L 1.5 ${-H - 3.5} L 5 ${-H - 8} L 7 ${-H - 1} Z`} fill={th.text.warning} stroke={hexMix(th.text.warning, 0.7)} strokeWidth={0.8} />}
      {typing && !props.lead && <g transform={`translate(0 ${-H - 9})`} opacity={0.85}>{[0, 1, 2].map((k) => <circle key={k} cx={(k - 1) * 4} cy={-Math.max(0, Math.sin(t * 6 - k * 0.9)) * 2} r={1.4} fill={th.text.secondary} />)}</g>}
      {sleep && [0, 1, 2].map((k) => { const ph = (t * 0.5 + k / 3 + seed * 0.1) % 1; return <text key={k} x={9 + ph * 10} y={-H - ph * 18} fontSize={7 + k * 2.5} fontWeight={700} fill={th.text.tertiary} opacity={1 - ph}>z</text>; })}
      {props.alert && !sleep && <g transform={`translate(0 ${-H - 19}) scale(${1 + 0.12 * Math.sin(t * 5)})`}><circle r={7.5} fill={th.fill.accent} /><text y={3.8} textAnchor="middle" fontSize={11} fontWeight={800} fill={th.text.onColor}>!</text></g>}
    </g>
  );
}

// ---- room panel: everything about one team, next to the 3D room ----
type PanelTab = "inbox" | "task" | "person" | "routine" | "news" | "goal";
function RoomPanel(props: { team: Team; idx: number; t: number; tab: PanelTab; member: number | null; phone: boolean; open: boolean; decisions: Record<string, Decision>; fresh: Record<string, boolean>;
  onTab: (k: PanelTab) => void; onMember: (i: number | null) => void; onDecide: (team: Team, item: Pending, kind: Decision["kind"], msg: string) => void; onSend: (msg: string) => void; onSendNow: (msg: string) => void; onExit: () => void; onClassic: () => void; onToggle: () => void; style: any }) {
  const th = useGrokTheme();
  const { team, t, idx } = props;
  const cats = th.dataviz.categorical;
  const c = cats[idx % cats.length];
  const fz = team.status === "frozen";
  const open = team.pending.filter((p) => !props.decisions[p.id]).length;
  const tone = fz ? th.text.tertiary : team.status === "hold" ? th.text.warning : team.status === "partial" ? th.text.accent : th.text.success;
  const tabs: [PanelTab, string, number | null][] = [["inbox", "Approve", open], ["task", "Tasks", team.tasks.filter((k) => k.state !== "done").length], ["person", "Team", team.members.length + 1], ["routine", "Scheduled", (team.routines || []).length], ["news", "Activity", null], ["goal", "Goal", null]];
  const people = ownersOf(team);
  const doingOf = (n: string) => team.tasks.filter((k) => k.owner === n && k.state === "doing");
  const sec: any = { fontSize: 12, fontWeight: 700, color: th.text.tertiary, margin: "12px 0 6px" };
  let body: any = null;
  if (props.tab === "inbox") {
    const rows: ApproveRowT[] = team.pending.map((p) => ({ team, idx, item: p, at: sinceAt(p.since) }));
    body = rows.length ? rows.map((r, k) => <div key={r.item.id} style={{ boxShadow: props.fresh["p:" + r.item.id] ? `inset -3px 0 0 ${th.fill.accent}` : "none", paddingInlineStart: props.fresh["p:" + r.item.id] ? 8 : 0 }}><FloatApproveRow row={r} t={t} last={k === rows.length - 1} decision={props.decisions[r.item.id]} onDecide={(kd, m) => props.onDecide(team, r.item, kd, m)} onSendNow={props.onSendNow} onEnter={() => {}} /></div>) : <div style={{ padding: "18px 0", textAlign: "center", color: th.text.tertiary, fontSize: 14 }}>Nothing to approve in this room 🎉</div>;
  } else if (props.tab === "task") {
    body = (["doing", "todo", "done"] as const).map((st) => {
      const list = team.tasks.filter((k) => k.state === st);
      if (!list.length) return null;
      return (
        <div key={st}>
          <div style={{ ...sec, color: st === "todo" ? th.text.warning : st === "doing" ? th.text.accent : th.text.success }}>{STATE_LABEL[st]} · {list.length}</div>
          {list.map((k, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", marginBottom: 6, borderRadius: 14, background: th.bg.base, border: `1px solid ${props.fresh["k:" + team.id + ":" + k.text.slice(0, 40) + ":" + k.state] ? th.fill.accent : th.border.subtle}` }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, flex: "none", background: st === "todo" ? th.text.warning : st === "doing" ? th.fill.accent : th.text.success, opacity: st === "doing" ? 0.6 + 0.4 * Math.sin(t * 3 + i) : 1 }} />
              <span style={{ flex: 1, fontSize: 13.5, lineHeight: "19px", textDecoration: st === "done" ? "line-through" : "none", opacity: st === "done" ? 0.6 : 1 }}>{k.text}<span style={{ display: "block", fontSize: 11.5, color: th.text.tertiary }}>{k.owner || team.lead.name}</span></span>
              {st !== "done" && <button onClick={() => props.onSend(`What's the status? — ${team.name}: ${k.text}`)} title="Ask about the task" style={{ font: "inherit", fontSize: 11.5, padding: "3px 9px", borderRadius: 999, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer", whiteSpace: "nowrap" }}>Status?</button>}
            </div>
          ))}
        </div>
      );
    });
    if (!team.tasks.length) body = <div style={{ padding: "18px 0", textAlign: "center", color: th.text.tertiary, fontSize: 14 }}>No tasks on the board</div>;
  } else if (props.tab === "person") {
    body = people.map((m, j) => {
      const i = j - 1; const sel = props.member === i;
      const ci = j === 0 ? idx % 6 : (idx + i + 1) % 6;
      const dn = doingOf(m.name);
      const rts = (team.routines || []).filter((r) => r.owner === m.name);
      return (
        <div key={m.name} style={{ marginBottom: 8, borderRadius: 16, background: th.bg.base, border: `1px solid ${sel ? th.fill.accent : th.border.subtle}`, overflow: "hidden" }}>
          <button onClick={() => props.onMember(sel ? null : i)} style={{ display: "flex", gap: 10, alignItems: "center", width: "100%", textAlign: "start", font: "inherit", padding: "8px 10px", background: "none", border: "none", cursor: "pointer", color: th.text.primary }}>
            <svg width={34} height={38} viewBox="-17 -34 34 38" style={{ flex: "none" }}><defs>{cats.map((cc: string, q: number) => <radialGradient key={q} id={"isoB" + q} cx="35%" cy="28%" r="80%"><stop offset="0%" stopColor={hexMix(cc, 0.55, "#ffffff")} /><stop offset="45%" stopColor={cc} /><stop offset="100%" stopColor={hexMix(cc, 0.55)} /></radialGradient>)}</defs><IsoBlob x={0} y={0} s={1} t={t} seed={idx * 7 + j} ci={ci} color={cats[ci % cats.length]} name={m.name} state={fz ? "sleep" : dn.length ? "type" : "idle"} lead={j === 0} /></svg>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b style={{ fontSize: 14 }}>{m.name}</b>{j === 0 && <span style={{ fontSize: 11, color: th.text.warning }}> · team lead</span>}
              <span style={{ display: "block", fontSize: 12, color: th.text.tertiary }}>{m.role}</span>
              <span style={{ display: "block", fontSize: 12, color: dn.length ? th.text.accent : th.text.tertiary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fz ? "Asleep 💤" : dn.length ? `⌨ ${dn[0].text}` : "Free"}</span>
            </span>
            {rts.length > 0 && <span style={{ fontSize: 11.5, color: th.text.secondary, whiteSpace: "nowrap" }}>⏰ {rts.length}</span>}
          </button>
          {sel && <div style={{ padding: "0 10px 10px" }}><QuickCmds team={team} owner={m} isLead={j === 0} onSend={props.onSend} /></div>}
        </div>
      );
    });
  } else if (props.tab === "routine") {
    const rts = team.routines || [];
    body = rts.length ? rts.map((r) => <div key={r.id} style={{ marginBottom: 8 }}><RoutineCard team={team} r={r} t={t} onSend={props.onSend} compact /></div>) : <div style={{ padding: "18px 0", textAlign: "center", color: th.text.tertiary, fontSize: 14 }}>This team has no scheduled tasks</div>;
  } else if (props.tab === "news") {
    body = team.activity.length ? team.activity.map((a, i) => (
      <div key={i} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: `1px solid ${th.border.weak}` }}>
        <b dir="ltr" style={{ fontSize: 12, color: th.text.accent, whiteSpace: "nowrap", minWidth: 62 }}>{a.time}</b>
        <span style={{ fontSize: 13.5, lineHeight: "19px" }}>{props.fresh["a:" + team.id + ":" + a.time + ":" + a.text.slice(0, 40)] && <b style={{ color: th.text.accent }}>✦ </b>}{a.text}</span>
      </div>
    )) : <div style={{ padding: "18px 0", textAlign: "center", color: th.text.tertiary, fontSize: 14 }}>Quiet here</div>;
    body = <div>{body}<button onClick={() => OPEN_HISTORY && OPEN_HISTORY(team.id)} style={{ display: "block", width: "100%", marginTop: 10, font: "inherit", fontSize: 13.5, fontWeight: 600, padding: "8px 12px", borderRadius: 999, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary, cursor: "pointer" }}>🕘 Full history for {team.name}</button></div>;
  } else {
    body = (
      <div>
        {team.goal ? <div style={{ display: "flex", alignItems: "center", gap: 12, background: th.bg.base, borderRadius: 16, padding: 10 }}><Ring goal={team.goal} t={t} /><div><b style={{ fontSize: 15 }}>{team.goal.label}</b><div style={{ fontSize: 13, color: th.text.secondary }}>{team.goal.current === null ? "Current number unknown" : `${team.goal.current} of ${team.goal.target}`}{team.goal.due ? ` · by ${team.goal.due}` : ""}</div></div></div> : <div style={{ color: th.text.tertiary, fontSize: 14 }}>No goal set</div>}
        <div style={sec}>What they're working on</div><div style={{ fontSize: 13.5, lineHeight: "20px" }}>{team.work}</div>
        {team.next && <div><div style={sec}>Next step</div><div style={{ fontSize: 13.5, lineHeight: "20px" }}>{team.next}</div></div>}
        {team.usage && <div><div style={sec}>Usage this week</div><div style={{ fontSize: 13.5 }}>{team.usage} of weekly usage</div></div>}
      </div>
    );
  }
  return (
    <div dir="ltr" style={props.style}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: props.phone ? "8px 12px" : "12px 14px 8px" }} onClick={props.phone ? props.onToggle : undefined}>
        {props.phone && <span style={{ position: "absolute", top: 5, left: "50%", width: 36, height: 4, borderRadius: 2, background: th.border.strong, transform: "translateX(-50%)" }} />}
        <span style={{ width: 10, height: 10, borderRadius: 5, background: c, flex: "none" }} />
        <b style={{ fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{team.name}</b>
        <span style={{ fontSize: 12, color: tone, whiteSpace: "nowrap" }}>● {STATUS_LABEL[team.status]}</span>
        {props.phone && open > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: th.text.onColor, background: th.fill.accent, borderRadius: 999, padding: "1px 7px" }}>{open}</span>}
        <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
          <button onClick={(e: any) => { e.stopPropagation(); props.onClassic(); }} title="Walk into the 3D room (Enter)" style={{ font: "inherit", fontSize: 12.5, fontWeight: 700, padding: "4px 12px", borderRadius: 999, border: "none", background: th.fill.accent, color: th.text.onColor, cursor: "pointer", whiteSpace: "nowrap" }}>🚪 Enter the room</button>
          <button onClick={(e: any) => { e.stopPropagation(); props.onExit(); }} aria-label="Campus" title="Back to campus (Esc)" style={{ width: 28, height: 28, borderRadius: 14, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer", font: "inherit", fontSize: 14, padding: 0 }}>✕</button>
        </span>
      </div>
      {props.open && (
        <div style={{ display: "flex", gap: 6, padding: "0 12px 8px", overflowX: "auto", flex: "none" }}>
          {tabs.map(([k, l, n]) => (
            <button key={k} onClick={() => props.onTab(k)} style={{ font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "5px 11px", borderRadius: 999, border: "none", background: props.tab === k ? th.border.strong : th.fill.secondary, color: props.tab === k ? th.text.primary : th.text.secondary, cursor: "pointer", whiteSpace: "nowrap" }}>
              {l}{n !== null && n > 0 ? <b style={{ marginInlineStart: 5, color: k === "inbox" ? th.text.accent : th.text.primary }}>{n}</b> : null}
            </button>
          ))}
        </div>
      )}
      {props.open && <div style={{ overflowY: "auto", padding: "0 14px 14px", overscrollBehavior: "contain", flex: "1 1 auto", minHeight: 0 }}>{body}</div>}
    </div>
  );
}

// tooltip card for hovering a room or an agent in the 3D scene
function SceneTip(props: { team: Team; member?: number; what?: RoomPop["kind"]; alerts: string[]; open: number }) {
  const th = useGrokTheme();
  const { team } = props;
  const card: any = { background: th.bg.elevated, border: `1px solid ${th.border.strong}`, borderRadius: 16, padding: "10px 12px", boxShadow: "0 10px 30px rgba(0,0,0,.35)", color: th.text.primary, fontFamily: th.font.family };
  if (props.what === "person" && props.member !== undefined) {
    const m = props.member < 0 ? team.lead : team.members[props.member];
    if (!m) return null;
    const dn = team.tasks.filter((k) => k.owner === m.name && k.state === "doing");
    return (
      <div dir="ltr" style={card}>
        <b style={{ fontSize: 14 }}>{m.name}</b>{props.member < 0 && <span style={{ fontSize: 11, color: th.text.warning }}> · team lead</span>}
        <div style={{ fontSize: 12, color: th.text.tertiary }}>{team.name} · {m.role}</div>
        <div style={{ fontSize: 12.5, marginTop: 4, color: dn.length ? th.text.accent : th.text.secondary }}>{team.status === "frozen" ? "Asleep 💤" : dn.length ? `Working on: ${clip(dn[0].text, 70)}` : "Free right now"}</div>
        <div style={{ fontSize: 11.5, color: th.text.tertiary, marginTop: 4 }}>Click: quick commands</div>
      </div>
    );
  }
  const label = props.what === "task" ? "Task board" : props.what === "news" ? "Activity screen" : props.what === "goal" ? "Goal shelf" : props.what === "inbox" ? "Approvals pile" : null;
  return (
    <div dir="ltr" style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}><b style={{ fontSize: 15 }}>{team.name}</b><span style={{ fontSize: 11.5, color: th.text.tertiary }}>{STATUS_LABEL[team.status]}{label ? ` · ${label}` : ""}</span></div>
      <div style={{ fontSize: 12.5, lineHeight: "18px", color: th.text.secondary }}>{clip(team.work, 110)}</div>
      <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 12 }}>
        <span>⌨ {team.tasks.filter((x) => x.state === "doing").length} In progress</span>
        <span style={{ color: props.open ? th.text.accent : th.text.tertiary, fontWeight: 700 }}>⏳ {props.open} Approve</span>
        <span style={{ marginInlineStart: "auto", color: th.text.accent }}>Click to enter →</span>
      </div>
      {props.alerts.slice(0, 2).map((a, i) => <div key={i} style={{ fontSize: 12, color: th.text.danger, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>🚨 {a}</div>)}
    </div>
  );
}

// small top-down map: rooms, status, camera
function MiniMap(props: { teams: Team[]; pos: Record<string, { x: number; y: number }>; idxOf: Record<string, number>; openOf: Record<string, number>; freshOf: Record<string, number>; focus: string | null; dim: string | null; view: SceneView | null; t: number; onPick: (id: string) => void }) {
  const th = useGrokTheme();
  const cats = th.dataviz.categorical;
  const v = props.view;
  // the map covers every room (generated spots for extra teams included)
  let x0 = -20, y0 = -20, x1 = 2420, y1 = 1520;
  props.teams.forEach((tm) => { const p = props.pos[tm.id]; if (!p) return; const fz = tm.status === "frozen"; const w = fz ? 280 : 440, h = fz ? 200 : 280; x0 = Math.min(x0, p.x - w / 2 - 40); x1 = Math.max(x1, p.x + w / 2 + 40); y0 = Math.min(y0, p.y - h / 2 - 40); y1 = Math.max(y1, p.y + h / 2 + 40); });
  return (
    <svg viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} width={176} height={112} style={{ display: "block" }}>
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={90} fill={th.bg.base} />
      <circle cx={PLAZA.x} cy={PLAZA.y} r={150} fill={th.fill.secondary} />
      {props.teams.map((tm) => {
        const p = props.pos[tm.id]; if (!p) return null;
        const fz = tm.status === "frozen"; const w = fz ? 280 : 440, h = fz ? 200 : 280;
        const o = props.openOf[tm.id] || 0; const sel = props.focus === tm.id;
        const dimmed = !!props.dim && props.dim !== tm.id;
        return (
          <g key={tm.id} onClick={() => props.onPick(tm.id)} style={{ cursor: "pointer" }} opacity={dimmed ? 0.3 : 1}>
            <rect x={p.x - w / 2} y={p.y - h / 2} width={w} height={h} rx={50} fill={fz ? th.bg.elevated : th.border.strong} stroke={sel ? th.fill.accent : (props.freshOf[tm.id] || 0) > 0 ? th.text.accent : "none"} strokeWidth={sel ? 40 : 26} strokeDasharray={!sel && (props.freshOf[tm.id] || 0) > 0 ? "60 40" : undefined} />
            <circle cx={p.x} cy={p.y} r={60} fill={cats[(props.idxOf[tm.id] || 0) % cats.length]} opacity={fz ? 0.35 : 1} />
            {o > 0 && <g><circle cx={p.x + w / 2 - 40} cy={p.y - h / 2 + 40} r={95 + 10 * Math.sin(props.t * 4)} fill={th.fill.accent} /><text x={p.x + w / 2 - 40} y={p.y - h / 2 + 80} textAnchor="middle" fontSize={120} fontWeight={800} fill={th.text.onColor}>{o}</text></g>}
          </g>
        );
      })}
      {v && (() => { const x = (v.x + 12) * 100, y = (v.z + 7.5) * 100; return <g transform={`translate(${x} ${y}) rotate(${(v.yaw * 180) / Math.PI})`} style={{ pointerEvents: "none" }}><path d="M 0 -150 L 110 60 L -110 60 Z" fill={th.text.primary} opacity={0.18} /><circle r={45} fill={th.text.primary} /></g>; })()}
    </svg>
  );
}

// ---- inside the room: the classic room layout (TV, window and kanban on the back wall, goal and battery on the left wall,
// door on the right, the lead's desk in the middle, routines board on a stand, the team at their desks) — built in real CSS 3D ----
type InWall = 0 | 1 | 2 | 3 | 4;
const IN_WALLS: { k: InWall; icon: string; label: string }[] = [
  { k: 0, icon: "⏳", label: "Approvals" }, { k: 1, icon: "📝", label: "Tasks" }, { k: 2, icon: "⏰", label: "Scheduled" }, { k: 3, icon: "📺", label: "Activity and goal" }, { k: 4, icon: "🔋", label: "Usage" },
];
const IN_ORDER: InWall[] = [0, 1, 2, 3, 4];
const inStep = (w: InWall, d: number): InWall => { const p = IN_ORDER.indexOf(w); return IN_ORDER[(p + d + 5 * 4) % 5]; };
function Room3D(props: { team: Team; idx: number; t: number; vp: { w: number; h: number }; phone: boolean; wall: InWall; focus: boolean; member: number | null;
  decisions: Record<string, Decision>; fresh: Record<string, boolean>; prevName: string; nextName: string;
  onWall: (k: InWall) => void; onFocus: (f: boolean) => void; onMember: (i: number | null) => void; onPrev: () => void; onNext: () => void; onExit: () => void;
  onDecide: (team: Team, item: Pending, kind: Decision["kind"], msg: string) => void; onSend: (msg: string) => void; onSendNow: (msg: string) => void }) {
  const th = useGrokTheme();
  const { team, t, idx, phone } = props;
  const box = useRef<any>(null);
  const [vp, setVp] = useState({ w: props.vp.w, h: props.vp.h });
  useEffect(() => {
    const w = globalThis as any; const el = box.current;
    const on = () => { if (el && el.getBoundingClientRect) { const r = el.getBoundingClientRect(); if (r.width > 10 && r.height > 10) setVp({ w: r.width, h: r.height }); } };
    on();
    let ro: any = null;
    if (w.ResizeObserver && el) { ro = new w.ResizeObserver(on); ro.observe(el); }
    return () => { if (ro) ro.disconnect(); };
  }, []);
  const cats = th.dataviz.categorical;
  const tc = cats[idx % cats.length];
  const fz = team.status === "frozen";
  const open = team.pending.filter((p) => !props.decisions[p.id]).length;
  const usage = team.usage ? parseFloat(team.usage) : null;
  const topY = phone ? 104 : 58, botH = phone ? 92 : 62;

  // ---- enlarged boards (overlay): the full, readable lists with working buttons ----
  const board = (k2: InWall, title: string, icon: string, count: number | null, glow: string | null, body: any, wide: boolean, pw: number) => {
    const sel = props.wall === k2 && !phone && !props.focus;
    const zm = wide ? 1.12 : phone ? 1 : Math.max(1, Math.min(1.12, pw / 330));
    return (
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", borderRadius: phone ? 18 : 16, background: th.bg.elevated, border: `1.5px solid ${glow || (sel ? hexMix(th.fill.accent, 0.6, th.border.strong) : th.border.strong)}`, boxShadow: glow ? `0 0 ${14 + 8 * Math.sin(t * 2.4)}px ${glow}55, inset 0 0 30px ${glow}14` : "0 10px 30px rgba(0,0,0,.35)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: phone ? "11px 13px 8px" : "10px 12px 8px", borderBottom: `1px solid ${th.border.weak}`, flex: "none" }}>
          <span style={{ fontSize: wide ? 24 : 18 }}>{icon}</span>
          <b style={{ fontSize: wide ? 22 : phone ? 18 : 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</b>
          {count !== null && <span style={{ fontSize: wide ? 16 : 13.5, fontWeight: 800, color: glow ? th.text.onColor : th.text.primary, background: glow || th.fill.secondary, borderRadius: 999, padding: "0 9px" }}>{count}</span>}
          {!phone && !wide && <button onClick={(e: any) => { e.stopPropagation(); props.onWall(k2); props.onFocus(true); }} title="Expand" aria-label="Expand" style={{ marginInlineStart: "auto", font: "inherit", fontSize: 13, width: 28, height: 26, borderRadius: 8, border: "none", background: th.fill.secondary, color: th.text.secondary, cursor: "pointer", flex: "none" }}>⤢</button>}
        </div>
        <div onWheel={(e: any) => { if (e && e.stopPropagation) e.stopPropagation(); }} onPointerDown={(e: any) => { if (!phone && e && e.stopPropagation) e.stopPropagation(); }} style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: phone ? "4px 13px 14px" : "4px 12px 12px", overscrollBehavior: "contain", zoom: zm, scrollbarWidth: "thin" } as any}>{body}</div>
      </div>
    );
  };
  const empty = (s: string) => <div style={{ padding: "22px 0", textAlign: "center", color: th.text.tertiary, fontSize: 14.5 }}>{s}</div>;
  const rows: ApproveRowT[] = team.pending.map((p) => ({ team, idx, item: p, at: sinceAt(p.since) }));
  const colC = { todo: th.text.warning, doing: th.fill.accent, done: th.text.success } as const;
  const now = nowMs();
  const rts = (team.routines || []).slice().sort((a, b) => (nextAt(a) || 9e15) - (nextAt(b) || 9e15));
  const nx = rts.find((r) => r.state === "on" && (nextAt(r) || 0) > now);
  const content = (k2: InWall, wide: boolean, pw: number) => {
    const roomy = wide || pw >= 520;
    if (k2 === 0) return board(0, "Waiting for your approval", "⏳", open, open ? th.fill.accent : null, rows.length ? (
      <div style={{ display: "grid", gridTemplateColumns: roomy ? "repeat(auto-fill, minmax(320px, 1fr))" : "1fr", columnGap: 18 }}>
        {rows.map((r) => <div key={r.item.id} style={{ boxShadow: props.fresh["p:" + r.item.id] ? `inset -3px 0 0 ${th.fill.accent}` : "none", paddingInlineStart: props.fresh["p:" + r.item.id] ? 8 : 0 }}><FloatApproveRow row={r} t={t} last={false} decision={props.decisions[r.item.id]} onDecide={(kd, m) => props.onDecide(team, r.item, kd, m)} onSendNow={props.onSendNow} onEnter={() => {}} /></div>)}
      </div>
    ) : empty("Nothing to approve in this room 🎉"), wide, pw);
    if (k2 === 1) return board(1, "Task board", "📝", team.tasks.filter((x) => x.state !== "done").length, null, team.tasks.length ? (
      <div style={{ display: "grid", gridTemplateColumns: roomy ? "repeat(3, minmax(0, 1fr))" : "1fr", gap: roomy ? 14 : 8, alignItems: "start", paddingTop: 6 }}>
        {(["doing", "todo", "done"] as const).map((st) => {
          const list = team.tasks.filter((x) => x.state === st);
          if (!roomy && !list.length) return null;
          return (
            <div key={st} style={{ background: th.bg.base, borderRadius: 12, padding: 8, borderTop: `3px solid ${colC[st]}` }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: colC[st], marginBottom: 6 }}>{STATE_LABEL[st]} · {list.length}</div>
              {list.map((x, i) => (
                <div key={i} style={{ background: hexMix(colC[st], 0.16, th.bg.elevated), border: `1px solid ${props.fresh["k:" + team.id + ":" + x.text.slice(0, 40) + ":" + x.state] ? th.fill.accent : hexMix(colC[st], 0.35, th.bg.elevated)}`, borderRadius: 10, padding: "6px 9px", marginBottom: 6 }}>
                  <div style={{ fontSize: 13.5, lineHeight: "19px", textDecoration: st === "done" ? "line-through" : "none", opacity: st === "done" ? 0.72 : 1 }}>{x.text}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                    <span style={{ fontSize: 12, color: th.text.tertiary }}>{x.owner || team.lead.name}</span>
                    {st !== "done" && <button onClick={() => props.onSend(`What's the status? — ${team.name}: ${x.text}`)} style={{ marginInlineStart: "auto", font: "inherit", fontSize: 11.5, padding: "1px 9px", borderRadius: 999, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer" }}>Status?</button>}
                  </div>
                </div>
              ))}
              {!list.length && <div style={{ fontSize: 12.5, color: th.text.tertiary }}>—</div>}
            </div>
          );
        })}
      </div>
    ) : empty("No tasks on the board"), wide, pw);
    if (k2 === 2) return board(2, "Scheduled tasks", "⏰", rts.length, null, (
      <div style={{ display: "flex", flexDirection: wide ? "row" : "column", gap: 10, paddingTop: 6 }}>
        <div style={{ flex: "none", display: "flex", flexDirection: wide ? "column" : "row", alignItems: "center", gap: 10, width: wide ? 220 : "auto", background: th.bg.base, borderRadius: 12, padding: 8 }}>
          <svg width={wide ? 160 : 64} height={wide ? 160 : 64} viewBox="-13 -13 26 26" style={{ flex: "none" }}><Clock r={12} t={t} mode={rts.some((r) => r.state === "on") ? "on" : rts.length ? "paused" : "none"} fail={rts.some((r) => r.lastResult === "fail" && r.state !== "paused")} /></svg>
          {nx ? <div style={{ textAlign: wide ? "center" : "start", minWidth: 0 }}><div style={{ fontSize: 12, color: th.text.tertiary }}>Next run</div><b style={{ fontSize: 14 }}>{nx.name}</b><div style={{ fontSize: 18, fontWeight: 800, color: th.text.accent }}>{t > 0 ? countdown((nextAt(nx) as number) - now) : ""}</div></div> : <div style={{ fontSize: 13, color: th.text.tertiary }}>No upcoming run</div>}
        </div>
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "grid", gridTemplateColumns: wide ? "repeat(auto-fill, minmax(300px, 1fr))" : "1fr", gap: 8, alignContent: "start" }}>
          {rts.length ? rts.map((r) => <RoutineCard key={r.id} team={team} r={r} t={t} onSend={props.onSend} compact />) : empty("This team has no scheduled tasks")}
        </div>
      </div>
    ), wide, pw);
    if (k2 === 4) return board(4, "Team usage", "🔋", null, null, (
      <div style={{ paddingTop: 8, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, background: th.bg.base, borderRadius: 14, padding: 12 }}>
          <b style={{ fontSize: 30, color: usage !== null && usage >= 80 ? th.text.danger : th.text.success }}>{team.usage || "—"}</b>
          <span style={{ fontSize: 13.5, color: th.text.secondary }}>of weekly usage goes to this team</span>
        </div>
        {(team.botUsage || []).map((u) => (
          <div key={u.owner} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
            <span style={{ minWidth: 120 }}>{u.owner}</span>
            <div style={{ flex: "1 1 auto", height: 8, borderRadius: 4, background: th.fill.secondary, overflow: "hidden" }}><div style={{ width: `${Math.min(100, u.pct)}%`, height: "100%", background: th.fill.accent }} /></div>
            <b dir="ltr" style={{ minWidth: 44 }}>{u.pct}%</b>
          </div>
        ))}
        {!team.usage && !(team.botUsage || []).length && empty("No usage data for this team")}
      </div>
    ), wide, pw);
    return board(3, "Activity and goal", "📺", null, null, (
      <div style={{ display: "flex", flexDirection: wide ? "row" : "column", gap: 10, paddingTop: 6 }}>
        <div style={{ flex: wide ? "0 0 320px" : "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {team.goal ? (
            <div style={{ background: `linear-gradient(160deg, ${hexMix(th.text.warning, 0.22, th.bg.base)}, ${th.bg.base})`, border: `1px solid ${hexMix(th.text.warning, 0.5, th.bg.base)}`, borderRadius: 14, padding: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: "none", zoom: wide ? 1 : 0.72 } as any}><Ring goal={team.goal} t={t} /></div>
              <div style={{ minWidth: 0 }}><div style={{ fontSize: 12, color: th.text.warning, fontWeight: 700 }}>🏆 Goal</div><b style={{ fontSize: 14 }}>{team.goal.label}</b><div style={{ fontSize: 12.5, color: th.text.secondary }}>{team.goal.current === null ? "Current number unknown" : `${team.goal.current} of ${team.goal.target}`}{team.goal.due ? ` · by ${team.goal.due}` : ""}</div></div>
            </div>
          ) : <div style={{ background: th.bg.base, borderRadius: 14, padding: 10, fontSize: 13.5, color: th.text.tertiary }}>🏆 No goal set</div>}
          <div style={{ background: th.bg.base, borderRadius: 14, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: th.text.tertiary, marginBottom: 3 }}>What they're working on</div>
            <div style={{ fontSize: 13.5, lineHeight: "19px" }}>{team.work}</div>
            {team.next && <div style={{ fontSize: 12, fontWeight: 700, color: th.text.tertiary, margin: "8px 0 3px" }}>Next step</div>}
            {team.next && <div style={{ fontSize: 13.5, lineHeight: "19px" }}>{team.next}</div>}
          </div>
        </div>
        <div style={{ flex: "1 1 auto", minWidth: 0, background: "#0d0d0d", border: `5px solid ${th.border.strong}`, borderRadius: 14, padding: "6px 10px", boxShadow: `inset 0 0 30px ${tc}22` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: th.text.danger, marginBottom: 2 }}><span style={{ width: 8, height: 8, borderRadius: 4, background: th.text.danger, opacity: 0.5 + 0.5 * Math.sin(t * 5) }} />Live from the room<button onClick={(e: any) => { e.stopPropagation(); if (OPEN_HISTORY) OPEN_HISTORY(team.id); }} style={{ marginInlineStart: "auto", font: "inherit", fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 999, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer" }}>🕘 Full history</button></div>
          {team.activity.length ? team.activity.map((a, i) => (
            <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: `1px solid ${th.border.weak}` }}>
              <b dir="ltr" style={{ fontSize: 12, color: th.text.accent, whiteSpace: "nowrap", minWidth: 54 }}>{a.time}</b>
              <span style={{ fontSize: 13.5, lineHeight: "19px" }}>{props.fresh["a:" + team.id + ":" + a.time + ":" + a.text.slice(0, 40)] && <b style={{ color: th.text.accent }}>✦ </b>}{a.text}</span>
            </div>
          )) : empty("Quiet here")}
        </div>
      </div>
    ), wide, pw);
  };


  // ---- room geometry (world px; floor y = 0, up is −y, the back wall at z = −D/2, you stand at the front) ----
  const portrait = vp.w < vp.h * 0.95;
  const G = portrait ? { W: 640, H: 560, D: 1000 } : { W: 1080, H: 420, D: 900 };
  const W2 = G.W / 2, D2 = G.D / 2, HH = G.H;
  const base = portrait ? { pitch: -36, R: 3000 } : { pitch: -23, R: 2700 };
  const T = { x: 0, y: portrait ? -150 : -170, z: 0 };
  // camera: entry fly-in + drag to look around
  const [orbit, setOrbit] = useState({ yaw: 0, pitch: 0 });
  const ent = useRef<{ id: string; t0: number }>({ id: "", t0: 0 });
  if (ent.current.id !== team.id) ent.current = { id: team.id, t0: t };
  const ek = ease(Math.min(1, Math.max(0, (t - ent.current.t0) / 1.1)));
  const yaw = orbit.yaw + (1 - ek) * -10;
  const pitch = base.pitch + orbit.pitch + (1 - ek) * -20;
  const R = base.R * (1 + 0.45 * (1 - ek));
  const proj = (x: number, y: number, z: number, yw: number, pt: number, rr: number) => {
    const qx = x - T.x, qy = y - T.y, qz = z - T.z;
    const a = -yw * Math.PI / 180, b = pt * Math.PI / 180;
    const x1 = qx * Math.cos(a) + qz * Math.sin(a), z1 = -qx * Math.sin(a) + qz * Math.cos(a);
    const y2 = qy * Math.cos(b) - z1 * Math.sin(b), z2 = qy * Math.sin(b) + z1 * Math.cos(b);
    const d = rr - z2;
    return { x: x1 / d, y: y2 / d };
  };
  // fit the default view to the screen (focal length P), the same way the 2D room was fitted
  const availW = vp.w - (phone ? 8 : 24), availH = vp.h - topY - botH;
  // side walls splay 30° outward (120° to the back wall), hinged at the back corners
  const SP = 30, spR = SP * Math.PI / 180, Lw = G.D / Math.cos(spR), ofs = G.D * Math.tan(spR);
  const wallAt = (s: number, f: number) => ({ x: s * (W2 + f * Math.sin(spR)), z: -D2 + f * Math.cos(spR) });
  const fv = portrait ? 300 : 430; // keep the wall-mounted items (up to this far from the back corner) in view
  const wl = wallAt(-1, fv), wr = wallAt(1, fv);
  const fitPts = [[-W2, 0, D2], [W2, 0, D2], [-W2, -HH, -D2], [W2, -HH, -D2], [-W2, 0, -D2], [W2, 0, -D2], [wl.x, 0, wl.z], [wl.x, -HH, wl.z], [wr.x, 0, wr.z], [wr.x, -HH, wr.z]].map((p) => proj(p[0], p[1], p[2], 0, base.pitch, base.R));
  const fx0 = Math.min(...fitPts.map((p) => p.x)), fx1 = Math.max(...fitPts.map((p) => p.x));
  const fy0 = Math.min(...fitPts.map((p) => p.y)), fy1 = Math.max(...fitPts.map((p) => p.y));
  const P = Math.min(availW * (portrait ? 1.06 : 1.02) / (fx1 - fx0), availH / (fy1 - fy0));
  const ox = vp.w / 2 - ((fx0 + fx1) / 2) * P, oy = topY + availH / 2 - ((fy0 + fy1) / 2) * P;

  // ---- 3D primitives ----
  const S3: any = { position: "absolute", left: 0, top: 0, width: 0, height: 0, transformStyle: "preserve-3d" };
  const at = (x: number, y: number, z: number) => `translate3d(${x}px, ${y}px, ${z}px)`;
  const bill = `rotateY(${yaw}deg) rotateX(${-pitch}deg)`;
  const face = (w: number, h: number, tr: string, style: any, children?: any) => (
    <div style={{ position: "absolute", left: -w / 2, top: -h / 2, width: w, height: h, transform: tr, boxSizing: "border-box", ...style }}>{children}</div>
  );
  // a solid block standing on y (its base), centred on x/z; front face can carry content
  const block = (k: string, x: number, y: number, z: number, w: number, h: number, d: number, c: { top: string; front: string; side: string }, front?: any, extra?: any) => (
    <div key={k} style={{ ...S3, transform: at(x, y, z) }}>
      {face(w, d, `translateY(${-h}px) rotateX(90deg)`, { background: c.top })}
      {face(d, h, `translate3d(${-w / 2}px, ${-h / 2}px, 0) rotateY(-90deg)`, { background: c.side })}
      {face(d, h, `translate3d(${w / 2}px, ${-h / 2}px, 0) rotateY(90deg)`, { background: c.side })}
      {face(w, h, `translate3d(0, ${-h / 2}px, ${d / 2}px)`, { background: c.front, display: "flex", alignItems: "center", justifyContent: "center" }, front)}
      {extra}
    </div>
  );
  const billboard = (k: string, x: number, y: number, z: number, w: number, h: number, children: any, onClick?: () => void, title?: string) => (
    <div key={k} style={{ ...S3, transform: at(x, y, z) + " " + bill }}>
      <div onClick={onClick} title={title} style={{ position: "absolute", left: -w / 2, top: -h, width: w, height: h, cursor: onClick ? "pointer" : "default", pointerEvents: onClick ? "auto" : "none" }}>{children}</div>
    </div>
  );
  const dragged = useRef(false);
  const go = (k: InWall) => () => { if (dragged.current) return; props.onWall(k); props.onFocus(true); };
  const [hv, setHv] = useState<string | null>(null);
  const hover = (k: string) => ({ onMouseEnter: () => setHv(k), onMouseLeave: () => setHv((v) => (v === k ? null : v)) });
  const glowIf = (k: string, c: string) => (hv === k ? `0 0 0 3px ${c}, 0 0 28px ${c}88` : "0 8px 22px rgba(0,0,0,.45)");
  const wood = { top: "#2b2b2d", front: "#232325", side: "#1c1c1e" };

  // ---- back wall: TV (live activity), window, kanban board, the team's sign ----
  const feed = team.activity;
  const cur = feed.length ? feed[Math.floor(t / 4.5) % feed.length] : null;
  const L = portrait
    ? { tv: { x: 30, y: 300, w: 280, h: 180 }, win: { x: 330, y: 300, w: 280, h: 180 }, board: { x: 30, y: 60, w: 580, h: 220 } }
    : { tv: { x: 36, y: 52, w: 330, h: 206 }, win: { x: 404, y: 40, w: 280, h: 250 }, board: { x: 722, y: 28, w: 340, h: 372 } };
  const tv = (
    <div onClick={go(3)} {...hover("tv")} title="Activity and goal" style={{ position: "absolute", left: L.tv.x, top: L.tv.y, width: L.tv.w, height: L.tv.h, transform: "translateZ(14px)", background: "#3a3a3c", borderRadius: 16, padding: 10, boxSizing: "border-box", cursor: "pointer", boxShadow: glowIf("tv", tc) }}>
      <div style={{ width: "100%", height: "100%", background: "#0d0d0d", borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: hexMix(tc, 0.25, "#0d0d0d") }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: th.text.danger, opacity: 0.5 + 0.5 * Math.sin(t * 5) }} /><b style={{ fontSize: 15, color: th.text.danger }}>LIVE</b>
          <b dir="ltr" style={{ marginInlineStart: "auto", fontSize: 14, color: th.text.accent }}>{cur ? cur.time : ""}</b>
        </div>
        <div style={{ flex: "1 1 auto", padding: "8px 12px", fontSize: portrait ? 17 : 19, lineHeight: portrait ? "23px" : "26px", fontWeight: 600, color: th.text.primary, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" } as any}>{cur ? cur.text : "Quiet here"}</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: 6 }}>{feed.slice(0, 8).map((_, i) => <span key={i} style={{ width: 7, height: 7, borderRadius: 4, background: cur === feed[i] ? th.fill.accent : "#555" }} />)}</div>
      </div>
    </div>
  );
  const win = (
    <div style={{ position: "absolute", left: L.win.x, top: L.win.y, width: L.win.w, height: L.win.h, transform: "translateZ(4px)", borderRadius: 12, border: "8px solid #3a3a3c", boxSizing: "border-box", overflow: "hidden", background: `linear-gradient(180deg, #1a2333 0%, #22324a 60%, #1d3b2c 61%, #183022 100%)` }}>
      <div style={{ position: "absolute", left: "12%", top: "16%", width: 40, height: 14, borderRadius: 8, background: "#3a4659", boxShadow: "20px -6px 0 #3a4659" }} />
      {[0.2, 0.52, 0.8].map((f, i) => <div key={i} style={{ position: "absolute", left: `${f * 100 - 9}%`, bottom: "12%", width: 46 - i * 6, height: 46 - i * 6, borderRadius: "50%", background: "#2ecc71", opacity: 0.55, boxShadow: "14px -8px 0 -6px #2ecc7199" }} />)}
      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 6, marginLeft: -3, background: "#3a3a3c" }} />
      <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 6, marginTop: -3, background: "#3a3a3c" }} />
    </div>
  );
  const kb = (
    <div onClick={go(1)} {...hover("kb")} title="Task board" style={{ position: "absolute", left: L.board.x, top: L.board.y, width: L.board.w, height: L.board.h, transform: "translateZ(10px)", background: "#1b1b1d", border: "5px solid #3a3a3c", borderRadius: 10, boxSizing: "border-box", padding: "8px 6px", display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 4, cursor: "pointer", boxShadow: glowIf("kb", tc) }}>
      {(["todo", "doing", "done"] as const).map((st) => {
        const list = team.tasks.filter((x) => x.state === st);
        const max = portrait ? 3 : 6;
        return (
          <div key={st} style={{ minWidth: 0, borderInlineStart: st === "todo" ? "none" : "2px dashed #333", paddingInline: 4 }}>
            <div style={{ textAlign: "center", fontSize: 16, fontWeight: 800, color: colC[st], marginBottom: 6 }}>{STATE_LABEL[st]} · {list.length}</div>
            {list.slice(0, max).map((x, i) => (
              <div key={i} style={{ background: hexMix(colC[st], 0.22, "#1b1b1d"), border: `1px solid ${hexMix(colC[st], 0.45, "#1b1b1d")}`, borderRadius: 4, padding: "5px 6px", marginBottom: 6, fontSize: 14, lineHeight: "17px", color: th.text.primary, transform: `rotate(${((i * 37 + st.length) % 5 - 2) * 0.7}deg)`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: st === "done" ? "line-through" : "none", opacity: st === "done" ? 0.7 : 1 }}>{x.text}</div>
            ))}
            {list.length > max && <div style={{ textAlign: "center", fontSize: 13, color: th.text.tertiary }}>+{list.length - max}</div>}
          </div>
        );
      })}
    </div>
  );
  const sign = (
    <div style={{ position: "absolute", left: "50%", top: 6, transform: "translateX(-50%) translateZ(6px)", padding: "4px 26px", borderRadius: 10, background: "#262628", border: "2px solid #3a3a3c", display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
      <b style={{ fontSize: 22, color: th.text.primary }}>{team.name}</b><span style={{ width: 12, height: 12, borderRadius: 6, background: fz ? "#555" : th.text.success, boxShadow: fz ? "none" : `0 0 10px ${th.text.success}` }} />
    </div>
  );
  const backWall = face(G.W, HH, at(0, -HH / 2, -D2), { background: "linear-gradient(180deg, #232325, #1d1d1f)", transformStyle: "preserve-3d", borderBottom: "14px solid #2c2c2e" }, <>{sign}{tv}{win}{kb}</>);

  // ---- left wall: goal plaque + usage battery; right wall: the door back to the campus ----
  const g = team.goal;
  const gFrac = g && g.current !== null ? Math.min(1, g.current / g.target) : 0;
  const plaque = (
    <div onClick={go(3)} {...hover("goal")} title="Goal" style={{ position: "absolute", left: Lw - 50 - 200, top: portrait ? 60 : 50, width: 200, height: 230, transform: "translateZ(2px)", background: "#202022", border: "6px solid #3a3a3c", outline: "2px solid #2a2a2c", borderRadius: 12, boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer", boxShadow: glowIf("goal", th.text.warning) }}>
      <svg width={84} height={50} viewBox="-44 -44 88 50"><path d="M -36 0 A 36 36 0 0 1 36 0" fill="none" stroke="#333" strokeWidth={9} strokeLinecap="round" /><path d="M -36 0 A 36 36 0 0 1 36 0" fill="none" stroke={th.text.warning} strokeWidth={9} strokeLinecap="round" strokeDasharray={`${113 * gFrac} 200`} /><circle cx={0} cy={-6} r={6} fill="#fff" /></svg>
      <b style={{ fontSize: 30, color: th.text.primary }}>{g ? `${g.current === null ? "?" : g.current}/${g.target}` : "—"}</b>
      <span style={{ fontSize: 30 }}>🏆</span>
      <span style={{ fontSize: 17, fontWeight: 600, color: th.text.secondary, textAlign: "center", padding: "0 8px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", maxWidth: 180 }}>{g ? g.label : "No goal"}</span>
    </div>
  );
  const bat = (
    <div onClick={go(4)} {...hover("bat")} title="Usage" style={{ position: "absolute", left: portrait ? Lw - 100 - 100 : Lw - 300 - 100, top: portrait ? 330 : 80, width: 100, height: 180, transform: "translateZ(2px)", background: "#202022", border: "6px solid #3a3a3c", outline: "2px solid #2a2a2c", borderRadius: 10, boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer", boxShadow: glowIf("bat", th.text.success) }}>
      <div style={{ width: 40, height: 100, border: "4px solid #9a9a9a", borderRadius: 6, position: "relative", boxSizing: "border-box" }}>
        <div style={{ position: "absolute", left: 3, right: 3, bottom: 3, height: `${usage === null ? 0 : Math.min(100, usage) * 0.9}%`, background: usage !== null && usage >= 80 ? th.text.danger : th.text.success, borderRadius: 2 }} />
        <div style={{ position: "absolute", top: -8, left: 12, width: 8, height: 5, background: "#9a9a9a", borderRadius: 2 }} />
      </div>
      <b dir="ltr" style={{ fontSize: 20, color: th.text.primary }}>{team.usage || "—"}</b>
    </div>
  );
  const leftWall = face(Lw, HH, `translate3d(${-W2 - ofs / 2}px, ${-HH / 2}px, 0) rotateY(${90 - SP}deg)`, { background: "linear-gradient(90deg, #1c1c1e, #19191b)", transformStyle: "preserve-3d", borderBottom: "14px solid #2a2a2c" }, <>{plaque}{bat}</>);
  const dH = Math.min(330, HH * 0.74), dW = 210;
  const door = (
    <div onClick={() => { if (!dragged.current) props.onExit(); }} {...hover("door")} title="Exit to campus (Esc)" style={{ position: "absolute", left: 80, bottom: 0, width: dW, height: dH, transform: "translateZ(2px)", border: `8px solid ${hv === "door" ? th.fill.accent : "#3a3a3c"}`, borderBottom: "none", borderRadius: "8px 8px 0 0", background: hv === "door" ? hexMix(th.fill.accent, 0.3, "#242022") : "#2a2326", boxSizing: "border-box", cursor: "pointer", boxShadow: glowIf("door", th.fill.accent), padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ flex: "1 1 0", border: "3px solid #3a3236", borderRadius: 6 }} />
      <div style={{ flex: "1.4 1 0", border: "3px solid #3a3236", borderRadius: 6 }} />
      <span style={{ position: "absolute", right: 16, top: "52%", width: 26, height: 10, borderRadius: 5, background: th.fill.accent, boxShadow: `0 0 8px ${th.fill.accent}` }} />
      <div style={{ position: "absolute", left: "50%", top: -60, transform: "translateX(-50%)", padding: "5px 18px", borderRadius: 10, background: th.fill.accent, color: "#fff", fontSize: 24, fontWeight: 800, whiteSpace: "nowrap" }}>← Campus</div>
    </div>
  );
  const rightWall = face(Lw, HH, `translate3d(${W2 + ofs / 2}px, ${-HH / 2}px, 0) rotateY(${-(90 - SP)}deg)`, { background: "linear-gradient(270deg, #1c1c1e, #19191b)", transformStyle: "preserve-3d", borderBottom: "14px solid #2a2a2c" }, door);
  const floor = face(G.W + 2 * ofs, G.D, "rotateX(90deg)", { clipPath: `polygon(${ofs}px 0, ${ofs + G.W}px 0, 100% 100%, 0 100%)`, background: `repeating-linear-gradient(0deg, transparent 0 89px, #262628 89px 91px), repeating-linear-gradient(90deg, transparent 0 89px, #262628 89px 91px), ${hexMix(tc, 0.05, "#151517")}` });
  const ceiling = face(G.W, G.D, `translateY(${-HH}px) rotateX(-90deg)`, { background: "#121214" }, <>
    <div style={{ position: "absolute", left: "22%", top: "35%", width: 120, height: 16, borderRadius: 8, background: "#2a2a2c" }} />
    <div style={{ position: "absolute", right: "22%", top: "35%", width: 120, height: 16, borderRadius: 8, background: "#2a2a2c" }} />
  </>);

  // ---- the lead's desk in the middle: inbox tray (approvals), monitor, lamp above, rug below ----
  const zl = portrait ? -G.D * 0.18 : -G.D * 0.1;
  const ldW = portrait ? 300 : 330, ldH = 92, ldD = 120;
  const blob = (k: string, x: number, y: number, z: number, j: number, ci: number, lead: boolean, alert: boolean, st: "type" | "idle" | "sleep", sc: number, onClick: () => void, name?: string) =>
    billboard(k, x, y, z, 120 * sc, 150 * sc, (
      <svg width={120 * sc} height={150 * sc} viewBox="-60 -140 120 150" style={{ overflow: "visible" }}>
        <g transform="scale(2.4)"><IsoBlob x={0} y={-4} s={1} t={t} seed={idx * 7 + j} ci={ci} color={cats[ci % cats.length]} state={st} lead={lead} alert={alert} name={name} /></g>
      </svg>
    ), () => { if (!dragged.current) onClick(); });
  const people = ownersOf(team);
  const doingOf = (n: string) => team.tasks.find((x) => x.state === "doing" && x.owner === n);
  const leadDn = doingOf(team.lead.name);
  const lines = team.lines && team.lines.length ? team.lines : [team.work];
  const say = lines[Math.floor(t / 5) % lines.length] || "";
  const sel = props.member !== null ? people[props.member + 1] : null;
  const trayX = -ldW * 0.3, monX = ldW * 0.28;
  const leadDesk = block("lead", 0, 0, zl, ldW, ldH, ldD, wood,
    <span style={{ fontSize: 19, fontWeight: 700, color: th.text.secondary, whiteSpace: "nowrap" }}>{team.lead.name}</span>);
  const tray = (
    <div key="tray" style={{ ...S3, transform: at(trayX, -ldH, zl + 10) }}>
      {block("trayb", 0, 0, 0, 82, 16, 56, { top: "#f5a62355", front: th.text.warning, side: "#b97a14" })}
      {block("paper1", -2, -16, 0, 64, 5, 44, { top: "#efefef", front: "#d6d6d6", side: "#cfcfcf" })}
      {open > 0 && block("paper2", 3, -21, -2, 64, 5, 44, { top: "#ffffff", front: "#e0e0e0", side: "#d0d0d0" })}
    </div>
  );
  const trayBadge = billboard("trayBadge", trayX, -ldH - 34, zl + 10, 150, 64, (
    <div onClick={go(0)} {...hover("tray")} style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
      <span style={{ minWidth: 40, height: 40, borderRadius: 20, background: open ? th.fill.accent : "#3a3a3c", color: "#fff", fontSize: 22, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: open ? `0 0 ${12 + 8 * Math.sin(t * 3)}px ${th.fill.accent}` : "none", transform: hv === "tray" ? "scale(1.12)" : "none" }}>{open}</span>
      {hv === "tray" && <span style={{ fontSize: 14, fontWeight: 700, color: th.text.primary, background: "rgba(20,20,20,.9)", padding: "3px 8px", borderRadius: 8, whiteSpace: "nowrap" }}>Waiting for your approval</span>}
    </div>
  ), go(0), "Waiting for your approval");
  const monitor = (k: string, x: number, y: number, z: number, w: number, h: number, ci: number, on: boolean) => (
    <div key={k} style={{ ...S3, transform: at(x, y, z) }}>
      {block(k + "s", 0, 0, 0, 10, 12, 10, { top: "#3a3a3c", front: "#333", side: "#2a2a2a" })}
      {block(k + "m", 0, -12, 0, w, h, 6, { top: "#3a3a3c", front: "#2c2c2e", side: "#2a2a2a" },
        <div style={{ width: w - 8, height: h - 8, borderRadius: 3, background: cats[ci % cats.length], opacity: on ? 0.55 + 0.2 * Math.sin(t * 3 + x) : 0.2 }} />)}
    </div>
  );
  const rug = face(portrait ? 520 : 640, portrait ? 300 : 260, at(0, -1, zl + 30) + " rotateX(90deg)", { borderRadius: "50%", background: `radial-gradient(ellipse, ${hexMix(tc, 0.3, "#151517")} 0%, ${hexMix(tc, 0.12, "#151517")} 55%, transparent 72%)`, border: `4px solid ${hexMix(th.text.warning, 0.45, "#151517")}` });
  const lampY = -ldH - 185;
  const lamp = (
    <div key="lamp" style={{ ...S3, transform: at(0, 0, zl) }}>
      {face(4, HH + lampY, at(0, (-HH + lampY) / 2, 0) + ` rotateY(${yaw}deg)`, { background: "#3a3a3c" })}
      {block("shade", 0, lampY + 30, 0, 70, 30, 70, { top: "#3a3a3c", front: "#2f2f31", side: "#28282a" })}
      {face(64, 64, at(0, lampY + 31, 0) + " rotateX(90deg)", { borderRadius: "50%", background: "radial-gradient(circle, #ffd27a, #f5a62300 70%)", opacity: fz ? 0.2 : 0.9 })}
      {face(520, 300, at(0, -2, 20) + " rotateX(90deg)", { borderRadius: "50%", background: "radial-gradient(ellipse, #f5a62322, transparent 70%)", opacity: fz ? 0.2 : 1 })}
    </div>
  );
  const bubble = portrait ? null : billboard("say", portrait ? 0 : -ldW * 0.62, portrait ? -ldH - 150 : -20, portrait ? zl - 60 : zl + ldD * 0.9, 380, 60, (
    <div style={{ position: "absolute", left: "50%", bottom: 8, transform: "translateX(-50%)", maxWidth: 370, padding: "6px 14px", borderRadius: 18, background: "#262628", border: "1.5px solid #3a3a3c", fontSize: 17, color: th.text.primary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{leadDn ? `⌨ ${leadDn.text}` : say}</div>
  ));

  // ---- routines board on a stand ----
  const st = portrait ? { x: 0, z: G.D * 0.45, w: 600, h: 150, rot: 0, lift: 4 } : { x: G.W * 0.35, z: G.D * 0.06, w: 340, h: 230, rot: -14, lift: 16 };
  const rtRows = rts.slice(0, portrait ? 2 : 5);
  const fmtNext = (r: Routine) => { const n = nextAt(r); if (!n) return r.state === "paused" ? "Paused" : "—"; const d = new Date(n); return `${d.getDate()}.${d.getMonth() + 1}`; };
  const stand = (
    <div key="stand" style={{ ...S3, transform: at(st.x, 0, st.z) + ` rotateY(${st.rot}deg)` }}>
      {block("p1", -st.w * 0.36, 0, 0, 12, st.lift + 4, 12, { top: "#3a3a3c", front: "#3a3a3c", side: "#2c2c2e" })}
      {block("p2", st.w * 0.36, 0, 0, 12, st.lift + 4, 12, { top: "#3a3a3c", front: "#3a3a3c", side: "#2c2c2e" })}
      {block("bd", 0, -st.lift, 0, st.w, st.h, 14, { top: "#3a3a3c", front: "#3a3a3c", side: "#2c2c2e" },
        <div onClick={go(2)} {...hover("rt")} style={{ width: st.w - 12, height: st.h - 12, background: "#1b1b1d", borderRadius: 8, overflow: "hidden", cursor: "pointer", boxShadow: glowIf("rt", tc), display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #2c2c2e" }}>
            <span style={{ fontSize: 18 }}>⏰</span><b style={{ fontSize: 18, color: th.text.primary }}>Scheduled tasks · {rts.length}</b>
            {rts.some((r) => r.lastResult === "fail") && <span style={{ marginInlineStart: "auto", fontSize: 13, fontWeight: 800, color: "#fff", background: th.text.danger, borderRadius: 10, padding: "0 8px" }}>!</span>}
          </div>
          {rtRows.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid #222" }}>
              <svg width={24} height={24} viewBox="-13 -13 26 26" style={{ flex: "none" }}><Clock r={11} t={t} mode={r.state} fail={r.lastResult === "fail" && r.state !== "paused"} /></svg>
              <span style={{ fontSize: 16, fontWeight: 700, color: r.state === "on" ? th.text.primary : th.text.tertiary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto" }}>{r.name}</span>
              <span dir="ltr" style={{ fontSize: 14, fontWeight: 700, padding: "1px 9px", borderRadius: 10, border: `2px solid ${r.lastResult === "fail" ? th.text.danger : r.state === "on" ? th.text.success : "#444"}`, color: th.text.primary, whiteSpace: "nowrap" }}>{fmtNext(r)}</span>
            </div>
          ))}
          {!rts.length && <div style={{ padding: 16, fontSize: 15, color: th.text.tertiary }}>No scheduled tasks</div>}
          {rts.length > rtRows.length && <div style={{ padding: "4px 12px", fontSize: 13, color: th.text.tertiary }}>+{rts.length - rtRows.length} more</div>}
        </div>)}
    </div>
  );

  // ---- the team at their desks, in front of the lead ----
  const mem = team.members;
  const spots = mem.map((_, i) => {
    if (!portrait) { const span = G.W * 0.96; return { x: -span / 2 + (i + 0.5) * (span / Math.max(1, mem.length)), z: G.D * 0.32 }; }
    const r = Math.floor(i / 2), j = i % 2, cnt = Math.min(2, mem.length - r * 2);
    return { x: cnt === 1 ? 0 : (j === 0 ? 1 : -1) * G.W * 0.24, z: G.D * 0.0 + r * G.D * 0.18 };
  });
  const mdW = portrait ? 230 : Math.min(230, (G.W * 0.96) / Math.max(1, mem.length) - 34), mdH = 74, mdD = 84;
  const desks = mem.map((m, i) => {
    const s = spots[i];
    const ci = (idx + i + 1) % 6;
    const dn = doingOf(m.name);
    const on = props.member === i;
    return (
      <div key={"m" + i} style={S3}>
        {block("md" + i, s.x, 0, s.z, mdW, mdH, mdD, wood,
          <div onClick={() => { if (!dragged.current) props.onMember(on ? null : i); }} style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><span style={{ fontSize: 18, fontWeight: 700, color: on ? th.text.accent : th.text.secondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: mdW - 12 }}>{m.name}</span></div>)}
        {monitor("mm" + i, s.x + mdW * 0.26, -mdH, s.z + 4, 58, 36, ci, !!dn && !fz)}
        {blob("mb" + i, s.x, -mdH + 6, s.z - mdD * 0.62, i + 1, ci, false, false, fz ? "sleep" : dn ? "type" : "idle", 0.85, () => props.onMember(on ? null : i), m.name)}
      </div>
    );
  });
  const plant = (k: string, x: number, z: number, s: number) => billboard(k, x, 0, z, 120 * s, 150 * s, (
    <svg width={120 * s} height={150 * s} viewBox="-60 -150 120 150"><ellipse cx={0} cy={-2} rx={40} ry={8} fill="rgba(0,0,0,.4)" /><path d="M -30 -46 L 30 -46 L 22 0 L -22 0 Z" fill="#2c2c2e" stroke="#3a3a3c" strokeWidth={2} /><circle cx={-14} cy={-80} r={26} fill="#2ecc71" opacity={0.75} /><circle cx={16} cy={-86} r={24} fill="#27b863" opacity={0.85} /><circle cx={0} cy={-104} r={22} fill="#34d17a" opacity={0.8} /></svg>
  ));

  // ---- input: drag to look around (both axes), double-click to reset ----
  const drag = useRef<{ x: number; y: number; o: { yaw: number; pitch: number } } | null>(null);
  const onDown = (e: any) => { dragged.current = false; drag.current = { x: e.clientX, y: e.clientY, o: orbit }; };
  const onMove = (e: any) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!dragged.current && Math.hypot(dx, dy) > 7) dragged.current = true;
    if (dragged.current) setOrbit({ yaw: Math.max(-30, Math.min(30, d.o.yaw + dx * 0.12)), pitch: Math.max(-14, Math.min(10, d.o.pitch - dy * 0.08)) });
  };
  const onUp = () => { drag.current = null; };

  // ---- zoomed board ----
  const zr = useRef<{ on: boolean; t0: number }>({ on: false, t0: 0 });
  if (zr.current.on !== props.focus) zr.current = { on: props.focus, t0: t };
  const zk = ease(Math.min(1, Math.max(0, (t - zr.current.t0) / 0.3)));
  const zOp = props.focus ? zk : 1 - zk;
  const zw = Math.min(1180, vp.w - (phone ? 16 : 80)), zh = vp.h - topY - botH - 16;
  const navBtn: any = { font: "inherit", fontSize: 13, fontWeight: 600, padding: phone ? "8px 10px" : "8px 14px", borderRadius: 999, border: `1px solid ${th.border.default}`, background: th.bg.elevated, color: th.text.primary, cursor: "pointer", whiteSpace: "nowrap", boxShadow: "0 6px 18px rgba(0,0,0,.3)" };
  const leadBlob = blob("lb", 0, -ldH + 4, zl - ldD * 0.68, 0, idx % 6, true, open > 0 && !fz, fz ? "sleep" : leadDn || team.tasks.some((x) => x.state === "doing") ? "type" : "idle", 1.05, () => props.onMember(props.member === -1 ? null : -1), team.lead.name);
  return (
    <div ref={box} dir="ltr" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onUp} onDoubleClick={() => setOrbit({ yaw: 0, pitch: 0 })}
      style={{ position: "absolute", inset: 0, overflow: "hidden", background: `radial-gradient(ellipse at 50% 40%, #1b1b1d, ${th.bg.base} 75%)`, touchAction: "pan-y", userSelect: dragged.current ? "none" : "auto", zIndex: 4, perspective: P, perspectiveOrigin: `${ox}px ${oy}px` } as any}>
      <svg width={0} height={0} style={{ position: "absolute" }}><defs>{cats.map((c: string, i: number) => <radialGradient key={i} id={"isoB" + i} cx="35%" cy="28%" r="80%"><stop offset="0%" stopColor={hexMix(c, 0.55, "#ffffff")} /><stop offset="45%" stopColor={c} /><stop offset="100%" stopColor={hexMix(c, 0.55)} /></radialGradient>)}</defs></svg>
      <div style={{ ...S3, left: ox, top: oy, transform: `translateZ(${P - R}px) rotateX(${pitch}deg) rotateY(${-yaw}deg) ${at(-T.x, -T.y, -T.z)}` }}>
        {floor}{backWall}{leftWall}{rightWall}
        {rug}{lamp}
        {plant("pl1", -W2 + 60, -D2 + 70, 0.75)}
        {plant("pl2", -W2 - 60, D2 - 90, 1.5)}
        {leadBlob}{leadDesk}{tray}{monitor("lm", monX, -ldH, zl + 8, 90, 58, idx % 6, !fz)}{trayBadge}{bubble}
        {stand}
        {desks}
      </div>

      {/* zoomed board */}
      {zOp > 0.01 && (
        <div onClick={() => props.onFocus(false)} onPointerDown={(e: any) => e.stopPropagation()} style={{ position: "absolute", inset: 0, zIndex: 7, background: `rgba(10,10,10,${0.6 * zOp})`, pointerEvents: props.focus ? "auto" : "none" }}>
          <div onClick={(e: any) => e.stopPropagation()} style={{ position: "absolute", left: (vp.w - zw) / 2, top: topY + 6, width: zw, height: zh, opacity: zOp, transform: `scale(${0.9 + 0.1 * zOp})`, color: th.text.primary }}>
            {content(props.wall, true, zw)}
          </div>
        </div>
      )}

      {/* top: exit + where am I */}
      <div style={{ position: "absolute", top: phone ? 58 : 10, left: phone ? 10 : 14, zIndex: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={props.onExit} title="Exit to campus (Esc)" style={navBtn}>🚪 Exit to campus</button>
        {props.focus && <button onClick={() => props.onFocus(false)} title="Back to the room (Esc)" style={navBtn}>↩ Room</button>}
        {!props.focus && (orbit.yaw !== 0 || orbit.pitch !== 0) && <button onClick={() => setOrbit({ yaw: 0, pitch: 0 })} title="Normal view" style={navBtn}>⟲</button>}
      </div>
      {!phone && (
        <div style={{ position: "absolute", top: 12, right: 16, zIndex: 8, display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 999, background: th.bg.elevated, border: `1px solid ${th.border.default}` }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: tc }} /><b style={{ fontSize: 15 }}>{team.name}</b><span style={{ fontSize: 12, color: th.text.tertiary }}>{STATUS_LABEL[team.status]}</span>
        </div>
      )}

      {/* bottom: rooms + boards */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: phone ? 10 : 12, zIndex: 8, display: "flex", justifyContent: "center", alignItems: "center", gap: phone ? 6 : 10, padding: "0 10px", flexWrap: phone ? "wrap" : "nowrap" }}>
        <button onClick={props.onPrev} title="Previous room (↑ / PageUp)" style={{ ...navBtn, maxWidth: phone ? 120 : 200, overflow: "hidden", textOverflow: "ellipsis" }}>← {props.prevName}</button>
        <div style={{ display: "flex", gap: 2, padding: 4, borderRadius: 999, background: th.bg.elevated, border: `1px solid ${th.border.default}`, boxShadow: "0 6px 18px rgba(0,0,0,.3)", order: phone ? -1 : 0, width: phone ? "100%" : "auto", justifyContent: "center", boxSizing: "border-box", overflowX: "auto" }}>
          {IN_ORDER.map((k2) => {
            const w = IN_WALLS[k2];
            const on = props.wall === w.k && props.focus;
            const n = w.k === 0 ? open : 0;
            return (
              <button key={w.k} onClick={() => { if (props.focus && props.wall === w.k) props.onFocus(false); else { props.onWall(w.k); props.onFocus(true); } }} title={w.label} style={{ font: "inherit", fontSize: phone ? 12 : 13, fontWeight: 600, padding: phone ? "6px 7px" : "6px 12px", borderRadius: 999, border: "none", background: on ? th.border.strong : "transparent", color: on ? th.text.primary : th.text.secondary, cursor: "pointer", whiteSpace: "nowrap" }}>
                {w.icon} {w.label}{n > 0 && <b style={{ marginInlineStart: 5, color: th.text.accent }}>{n}</b>}
              </button>
            );
          })}
        </div>
        <button onClick={props.onNext} title="Next room (↓ / PageDown)" style={{ ...navBtn, maxWidth: phone ? 120 : 200, overflow: "hidden", textOverflow: "ellipsis" }}>{props.nextName} →</button>
      </div>

      {/* quick commands for the clicked person */}
      {sel && (
        <div onPointerDown={(e: any) => e.stopPropagation()} style={{ position: "absolute", left: "50%", bottom: botH + 14, transform: "translateX(-50%)", width: "min(440px, calc(100% - 24px))", zIndex: 9, background: th.bg.elevated, border: `1px solid ${th.border.strong}`, borderRadius: 20, padding: "12px 14px", boxShadow: "0 18px 50px rgba(0,0,0,.45)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <b style={{ fontSize: 15 }}>{props.member === -1 ? "👑 " : ""}{sel.name}</b><span style={{ fontSize: 12, color: th.text.tertiary }}>{sel.role}</span>
            <button onClick={() => props.onMember(null)} aria-label="Close" style={{ marginInlineStart: "auto", width: 28, height: 28, borderRadius: 14, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer", font: "inherit" }}>✕</button>
          </div>
          <QuickCmds team={team} owner={sel} isLead={props.member === -1} onSend={props.onSend} />
        </div>
      )}
    </div>
  );
}

// ---- history: every bot event and every request you sent, kept past each refresh ----
// The real app archives each data push in the private Blob (/api/history). The page merges that archive
// with the events in the current data, so nothing is lost even before the first archived push.
type HistEntry = { k: string; kind: "event" | "sent"; team: string; teamName: string; time: string; text: string; at: number };
let OPEN_HISTORY: ((team?: string) => void) | null = null;
const DAY = 864e5;
// wall-clock time in TZ as a UTC-based number (only for ordering and day groups)
function wallOf(ms: number): number {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
    const g = (k: string) => Number((p.find((x) => x.type === k) || { value: "0" }).value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
  } catch (e) { return ms; }
}
// "D.M HH:MM", "D.M.YYYY, HH:MM" or ISO → wall time; the year comes from `ref` (when the event was seen)
function wallOfStamp(s: string, ref: number): number | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const v = Date.parse(s); return isNaN(v) ? null : wallOf(v); }
  const m = s.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?,?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const r = wallOf(ref);
  let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date(r).getUTCFullYear();
  let w = Date.UTC(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  if (!m[3] && w > r + 2 * DAY) w = Date.UTC(y - 1, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  return w;
}
const hhmm = (w: number) => new Date(w).toISOString().slice(11, 16);
function dayLabel(w: number, todayW: number): string {
  const d0 = Math.floor(todayW / DAY), d = Math.floor(w / DAY);
  const name = new Date(w).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  return d === d0 ? `Today · ${name}` : d === d0 - 1 ? `Yesterday · ${name}` : name;
}
// a sent line looks like "Approved — Finance: …"; find the team it was about
function sentTeam(text: string): Team | undefined {
  const i = text.indexOf(" — ");
  if (i < 0) return undefined;
  const rest = text.slice(i + 3);
  return TEAMS.find((tm) => rest.startsWith(tm.name + ":"));
}

function HistoryPanel(props: { open: boolean; onClose: () => void; startTeam: string | null; server: HistEntry[]; local: HistEntry[]; loading: boolean; idxOf: Record<string, number>; fresh: Record<string, boolean>; onEnter: (team: string) => void; phone: boolean }) {
  const th = useGrokTheme();
  const cats = th.dataviz.categorical;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string>("all"); // "all" | "you" | team id
  const [shown, setShown] = useState(150);
  const inputRef = useRef<any>(null);
  useEffect(() => {
    // closed: give the keyboard back to the page shortcuts
    if (!props.open) { try { if (inputRef.current) inputRef.current.blur(); } catch (e) {} return; }
    setSel(props.startTeam || "all"); setShown(150); setQ("");
    const id = setTimeout(() => { try { if (!props.phone && inputRef.current) inputRef.current.focus(); } catch (e) {} }, 260);
    return () => clearTimeout(id);
  }, [props.open, props.startTeam]);

  const now = nowMs();
  const todayW = wallOf(now);
  type Row = HistEntry & { w: number | null; color: string; label: string };
  const byKey: Record<string, Row> = {};
  const add = (e: HistEntry) => {
    if (byKey[e.k]) return;
    const tm = e.kind === "sent" ? sentTeam(e.text) : TEAMS.find((x) => x.id === e.team);
    const team = tm ? tm.id : e.team;
    byKey[e.k] = {
      ...e, team,
      w: e.kind === "sent" ? wallOf(e.at) : wallOfStamp(e.time, e.at),
      color: tm ? cats[(props.idxOf[tm.id] || 0) % cats.length] : th.text.tertiary,
      label: e.kind === "sent" ? (tm ? `You → ${tm.name}` : "You → main bot") : (tm ? tm.name : e.teamName || e.team),
    };
  };
  // current data first (it has the live team names), then the archive, then what this tab sent (demo)
  TEAMS.forEach((tm) => tm.activity.forEach((a) => add({ k: `a:${tm.id}:${a.time}:${a.text}`, kind: "event", team: tm.id, teamName: tm.name, time: a.time, text: a.text, at: now })));
  props.server.forEach(add);
  props.local.forEach(add);
  const all = Object.values(byKey).sort((a, b) => (b.w ?? -1) - (a.w ?? -1) || b.at - a.at);
  const counts: Record<string, number> = {};
  all.forEach((r) => { const c = r.kind === "sent" ? "you" : r.team; counts[c] = (counts[c] || 0) + 1; });
  const ql = q.trim().toLowerCase();
  const rows = all.filter((r) => (sel === "all" || (sel === "you" ? r.kind === "sent" : r.kind === "event" && r.team === sel)) && (!ql || (r.text + " " + r.label).toLowerCase().includes(ql)));
  const page = rows.slice(0, shown);
  const oldest = all.length ? all[all.length - 1].w : null;

  const chip = (id: string, label: string, n: number, color?: string) => (
    <button key={id} onClick={() => { setSel(id); setShown(150); }} style={{ display: "flex", alignItems: "center", gap: 6, flex: "none", font: "inherit", fontSize: 13, fontWeight: 600, padding: "6px 11px", borderRadius: 999, cursor: "pointer", border: `1px solid ${sel === id ? th.fill.accent : th.border.default}`, background: sel === id ? th.fill.accentSubtle : th.bg.base, color: th.text.primary, whiteSpace: "nowrap" }}>
      {color && <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />}{label}<span style={{ color: th.text.tertiary, fontWeight: 500 }}>{n}</span>
    </button>
  );
  let lastDay = "";
  return (
    <div role="dialog" aria-label="History" aria-hidden={!props.open} style={{ position: "absolute", top: props.phone ? 8 : 64, bottom: props.phone ? 8 : 14, insetInlineEnd: props.phone ? 8 : 14, width: props.phone ? "calc(100% - 16px)" : "min(520px, calc(100% - 28px))", zIndex: 11, display: "flex", flexDirection: "column", background: th.bg.elevated, border: `1px solid ${th.border.strong}`, borderRadius: 20, boxShadow: "0 18px 50px rgba(0,0,0,.55)", overflow: "hidden", opacity: props.open ? 1 : 0, transform: props.open ? "translateX(0)" : "translateX(24px)", pointerEvents: props.open ? "auto" : "none", visibility: props.open ? "visible" : "hidden", transition: "opacity 220ms, transform 220ms, visibility 220ms" }}>
      <div style={{ padding: "14px 14px 10px", borderBottom: `1px solid ${th.border.weak}`, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <b style={{ fontSize: 18 }}>History</b>
          <span style={{ fontSize: 13, color: th.text.tertiary }}>{all.length} {all.length === 1 ? "entry" : "entries"}{oldest !== null ? ` · since ${new Date(oldest).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" })}` : ""}{props.loading ? " · loading…" : ""}</span>
          <button onClick={props.onClose} aria-label="Close history" title="Close (Esc)" style={{ marginInlineStart: "auto", width: 32, height: 32, borderRadius: 16, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer", font: "inherit", fontSize: 15 }}>✕</button>
        </div>
        <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setShown(150); }} placeholder="Search what the bots did or what you sent…" style={{ font: "inherit", fontSize: 14, padding: "9px 12px", borderRadius: 12, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary, outline: "none" }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 96, overflowY: "auto" }}>
          {chip("all", "All", all.length)}
          {(counts.you || 0) > 0 && chip("you", "Sent by you", counts.you, th.fill.accent)}
          {TEAMS.filter((tm) => counts[tm.id]).map((tm) => chip(tm.id, tm.name, counts[tm.id], cats[(props.idxOf[tm.id] || 0) % cats.length]))}
        </div>
      </div>
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 14px 14px" }}>
        {page.length === 0 && <div style={{ padding: "40px 0", textAlign: "center", color: th.text.tertiary, fontSize: 14 }}>{ql ? "Nothing matches your search" : "No history yet"}</div>}
        {page.map((r) => {
          const day = r.w === null ? "Earlier" : dayLabel(r.w, todayW);
          const head = day !== lastDay ? <div style={{ position: "sticky", top: 0, zIndex: 1, background: th.bg.elevated, padding: "12px 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: th.text.secondary, textTransform: "uppercase" }}>{day}</div> : null;
          lastDay = day;
          const isNew = props.fresh["a:" + r.team + ":" + r.time + ":" + r.text.slice(0, 40)];
          const sent = r.kind === "sent";
          return (
            <div key={r.k}>
              {head}
              <button onClick={() => { if (TEAMS.some((x) => x.id === r.team)) props.onEnter(r.team); }} title={sent ? "" : "Open this team's room"} style={{ display: "flex", gap: 10, width: "100%", textAlign: "start", font: "inherit", color: th.text.primary, cursor: "pointer", padding: "9px 10px", marginBottom: 6, borderRadius: 14, border: `1px solid ${isNew ? th.fill.accent : th.border.subtle}`, background: sent ? th.fill.accentSubtle : th.bg.base }}>
                <span style={{ width: 4, flex: "none", alignSelf: "stretch", borderRadius: 2, background: r.color }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5 }}>
                    <b style={{ color: sent ? th.text.accent : r.color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sent ? "✉ " : ""}{r.label}</b>
                    {isNew && <b style={{ color: th.text.accent }}>✦ new</b>}
                    <span dir="ltr" style={{ marginInlineStart: "auto", color: th.text.tertiary, whiteSpace: "nowrap" }}>{r.w === null ? r.time : hhmm(r.w)}</span>
                  </span>
                  <span style={{ display: "block", fontSize: 14.5, lineHeight: "21px", marginTop: 2, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.text}</span>
                </span>
              </button>
            </div>
          );
        })}
        {rows.length > shown && <div style={{ textAlign: "center", padding: "6px 0 4px" }}><button onClick={() => setShown(shown + 150)} style={{ font: "inherit", fontSize: 13.5, fontWeight: 600, padding: "8px 16px", borderRadius: 999, border: `1px solid ${th.border.default}`, background: th.bg.base, color: th.text.primary, cursor: "pointer" }}>Show older ({rows.length - shown} more)</button></div>}
      </div>
    </div>
  );
}

// ---- the control center (3D workspace + HUD) ----
type SearchHit ={ key: string; icon: string; label: string; sub: string; team: string; what?: PanelTab; member?: number };
function ControlCenterInner() {
  const th = useGrokTheme();
  const cats = th.dataviz.categorical;
  const [t, setT] = useState(0);
  const [room, setRoom] = useState<string | null>(null);
  const [classic, setClassic] = useState(false); // true = inside the room (3D interior)
  const [inWall, setInWall] = useState<InWall>(0);
  const [inFocus, setInFocus] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const [feedOpen, setFeedOpen] = useState(false); // the History panel
  const [histTeam, setHistTeam] = useState<string | null>(null);
  const [hist, setHist] = useState<HistEntry[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [sentLocal, setSentLocal] = useState<HistEntry[]>([]); // demo only: the real app reads sent requests from /api/history
  const loadHistory = async () => {
    if (DEMO) return;
    setHistLoading(true);
    try {
      const r = await fetch("/api/history?ts=" + Date.now(), { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.entries)) setHist(j.entries); }
    } catch (e) {}
    setHistLoading(false);
  };
  useEffect(() => {
    if (!feedOpen) return;
    loadHistory();
    const id = setInterval(loadHistory, 120000);
    return () => clearInterval(id);
  }, [feedOpen]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean; t0: number; kind?: "tray" | "batch" | "queued" | "sent" | "failed" | "wait"; err?: string } | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const lastSend = useRef(0);
  const loaded = useRef(false);
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem("trayQueue") || "[]"); if (Array.isArray(v)) setQueue(v.filter((x) => typeof x === "string")); } catch (e) {} loaded.current = true; }, []);
  useEffect(() => { if (loaded.current) { try { localStorage.setItem("trayQueue", JSON.stringify(queue)); } catch (e) {} } }, [queue]);
  const [drawer, setDrawer] = useState<null | "tray" | "clock" | "usage">(null);
  const [openR, setOpenR] = useState<string | null>(null);
  const [vp, setVp] = useState({ w: 1400, h: 860 });
  const [colW, setColW] = useState(false); // left "work" window minimized
  const [colA, setColA] = useState(false); // right "approve" window minimized
  const [sheet, setSheet] = useState<null | "approve" | "work">(null); // phone bottom sheet
  const [pTab, setPTab] = useState<PanelTab>("inbox");
  const [pMember, setPMember] = useState<number | null>(null);
  const [pOpen, setPOpen] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);
  const [search, setSearch] = useState<{ q: string; sel: number } | null>(null);
  const [help, setHelp] = useState(false);
  const [rfLocal, setRfLocal] = useState(0);
  const [newsOpen, setNewsOpen] = useState(false);
  const [seen, setSeen] = useState<Record<string, boolean> | null>(null);
  const [cmd, setCmd] = useState<SceneCmd>({ n: 0, kind: "home" });
  const [glFail, setGlFail] = useState(false);
  const [mapOpen, setMapOpen] = useState(true);
  const viewRef = useRef<SceneView | null>(null);
  const bump = useRef<{ n: number; t0: number }>({ n: -1, t0: -10 });
  useEffect(() => {
    const w = globalThis as any;
    if (!w.addEventListener) return;
    const on = () => setVp({ w: w.innerWidth || 1400, h: w.innerHeight || 860 });
    on();
    if ((w.innerHeight || 860) < 700) setMapOpen(false);
    w.addEventListener("resize", on);
    return () => w.removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    const w = globalThis as any;
    if (!w.requestAnimationFrame) return;
    let id = 0, last = 0;
    const loop = (ts: number) => { if (ts - last > 33) { last = ts; setT(ts / 1000); } id = w.requestAnimationFrame(loop); };
    id = w.requestAnimationFrame(loop);
    return () => w.cancelAnimationFrame(id);
  }, []);

  const phone = vp.w < 640;
  const narrow = phone;
  const active = TEAMS.filter((x) => x.status !== "frozen");
  const frozen = TEAMS.filter((x) => x.status === "frozen");
  const pos = layoutRooms(TEAMS);
  const totalPending = TEAMS.reduce((a, x) => a + x.pending.length, 0);
  const decided = TEAMS.reduce((a, x) => a + x.pending.filter((p) => decisions[p.id]).length, 0);
  const feedAll = TEAMS.flatMap((tm) => tm.activity.map((a) => ({ ...a, team: tm }))).sort((a, b) => timeKey(b.time) - timeKey(a.time));
  const feed = filter ? feedAll.filter((a) => a.team.id === filter) : feedAll;
  const tick = feed.length ? feed[Math.floor(t / 4.5) % feed.length] : null;
  const tickPh = (t % 4.5) / 4.5;
  const tickO = tickPh < 0.1 ? tickPh / 0.1 : tickPh > 0.9 ? (1 - tickPh) / 0.1 : 1;

  // ---- what changed since the last visit ----
  const keysOf = (tm: Team) => [
    ...tm.pending.map((p) => ({ k: "p:" + p.id, label: p.what, icon: "⏳", what: "inbox" as PanelTab })),
    ...tm.activity.map((a) => ({ k: "a:" + tm.id + ":" + a.time + ":" + a.text.slice(0, 40), label: a.text, icon: "📰", what: "news" as PanelTab })),
    ...tm.tasks.map((k) => ({ k: "k:" + tm.id + ":" + k.text.slice(0, 40) + ":" + k.state, label: `${STATE_LABEL[k.state]}: ${k.text}`, icon: k.state === "done" ? "✓" : "📝", what: "task" as PanelTab })),
  ];
  const allKeys = TEAMS.flatMap((tm) => keysOf(tm).map((x) => ({ ...x, team: tm })));
  const keySig = allKeys.map((x) => x.k).join("|");
  useEffect(() => {
    let prevSeen: Record<string, boolean> | null = null;
    try { const s = (globalThis as any).localStorage && (globalThis as any).localStorage.getItem("ccSeen"); if (s) { const arr = JSON.parse(s); if (Array.isArray(arr)) { prevSeen = {}; arr.forEach((k: any) => { if (typeof k === "string") prevSeen![k] = true; }); } } } catch (e) {}
    setSeen(prevSeen || {});
    if (!prevSeen) { try { (globalThis as any).localStorage.setItem("ccSeen", JSON.stringify(allKeys.map((x) => x.k))); } catch (e) {} }
  }, []);
  const firstVisit = useRef(true);
  useEffect(() => {
    if (seen === null) return;
    // the next visit compares against everything shown now
    try { const ls = (globalThis as any).localStorage; const cur = JSON.parse(ls.getItem("ccSeen") || "[]"); const set: Record<string, boolean> = {}; (Array.isArray(cur) ? cur : []).forEach((k: any) => { set[k] = true; }); allKeys.forEach((x) => { set[x.k] = true; }); ls.setItem("ccSeen", JSON.stringify(Object.keys(set).filter((k) => allKeys.some((x) => x.k === k)))); } catch (e) {}
    firstVisit.current = false;
  }, [keySig, seen === null]);
  const freshList = seen && Object.keys(seen).length ? allKeys.filter((x) => !seen[x.k]) : [];
  const freshMap: Record<string, boolean> = {};
  freshList.forEach((x) => { freshMap[x.k] = true; });
  const freshOf: Record<string, number> = {};
  freshList.forEach((x) => { freshOf[x.team.id] = (freshOf[x.team.id] || 0) + 1; });
  const markSeen = () => { const s: Record<string, boolean> = {}; allKeys.forEach((x) => { s[x.k] = true; }); setSeen(s); setNewsOpen(false); };

  const enter = (id: string, what?: PanelTab, member?: number) => {
    setHot(null); setFeedOpen(false); setInboxOpen(false); setDrawer(null); setSearch(null); setNewsOpen(false); setSheet(null);
    const tm = TEAMS.find((x) => x.id === id);
    const open = tm ? tm.pending.filter((p) => !decisions[p.id]).length : 0;
    setPTab(what || (open ? "inbox" : "person"));
    setPMember(member === undefined ? null : member);
    setPOpen(true);
    setClassic(false);
    setInFocus(false);
    setRoom(id);
  };
  const goInside = () => { setClassic(true); setInWall(0); setInFocus(false); setPMember(null); };
  const goRoom = (id: string) => { enter(id); setClassic(true); setInWall(0); setPMember(null); };
  const roomStep = (d: number) => { const i = TEAMS.findIndex((x) => x.id === room); const n = TEAMS.length; const nt = TEAMS[((i < 0 ? 0 : i) + d + n) % n]; if (nt) goRoom(nt.id); };
  const exit = () => { setClassic(false); setRoom(null); };
  const copyText = (msg: string, kind: "tray" | "batch" | "failed" | undefined, err?: string) => {
    const nav = (globalThis as any).navigator;
    const show = (ok: boolean) => setToast({ msg, ok, t0: t, kind, err });
    try {
      if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(msg).then(() => show(true), () => show(false));
      else show(false);
    } catch (e) { show(false); }
  };
  const enqueue = (msg: string) => setQueue((q) => (q.includes(msg) ? q : [...q, msg]));
  const decide = (team: Team, item: Pending, kind: Decision["kind"], msg: string) => {
    setDecisions({ ...decisions, [item.id]: { kind, msg } });
    enqueue(msg);
    setToast({ msg, ok: true, t0: t, kind: "queued" });
  };
  const send = (msg: string) => { enqueue(msg); setToast({ msg, ok: true, t0: t, kind: "queued" }); };
  const sendNow = (m: string) => { enqueue(m); postItems([m]); };
  const fmt = (items: string[]) => `Bot, ${items.length} requests from the page:\n` + items.map((m, i) => `${i + 1}. ${m}`).join("\n");
  const batch = () => { if (queue.length) copyText(fmt(queue), "batch"); };
  // live sending to the main bot through the server (/api/send); falls back to the clipboard
  const postItems = async (items: string[]) => {
    if (!items.length || sending) return;
    const wait = 5000 - (Date.now() - lastSend.current);
    if (wait > 0) { setToast({ msg: `You can send again in ${Math.ceil(wait / 1000)} seconds`, ok: true, t0: t, kind: "wait" }); return; }
    lastSend.current = Date.now();
    setSending(true);
    if (DEMO) {
      // demo: nothing leaves the browser; the simulation plays the team's follow-up
      await new Promise((r) => setTimeout(r, 650));
      DEMO.send(items);
      const at0 = Date.now();
      setSentLocal((l) => [...items.map((m, i) => ({ k: `s:${at0}:${i}`, kind: "sent" as const, team: "", teamName: "", time: "", text: m, at: at0 })), ...l]);
      setQueue((q) => q.filter((x) => !items.includes(x)));
      setToast({ msg: fmt(items), ok: true, t0: t, kind: "sent" });
      setSending(false);
      return;
    }
    let err = "";
    try {
      const r = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
      if (r.status === 401) { return; }
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setQueue((q) => q.filter((x) => !items.includes(x)));
        if (feedOpen) loadHistory();
        setToast({ msg: fmt(items), ok: true, t0: t, kind: "sent" });
        setSending(false);
        return;
      }
      err = j.error || `Error ${r.status}`;
    } catch (e) { err = "No connection to the server"; }
    setSending(false);
    copyText(fmt(items), "failed", err);
  };
  const openHistory = (team?: string | null) => { setHistTeam(team || null); setFeedOpen(true); setInboxOpen(false); setDrawer(null); setSearch(null); setNewsOpen(false); };
  OPEN_HISTORY = openHistory;
  const openDrawer = (d: "tray" | "clock" | "usage") => { setDrawer(drawer === d ? null : d); setFeedOpen(false); setInboxOpen(false); setSearch(null); setNewsOpen(false); };
  const now = nowMs();
  const allR = TEAMS.flatMap((tm) => (tm.routines || []).map((r) => ({ r, team: tm, at: nextAt(r) })));
  const upcoming = allR.filter((x) => x.r.state === "on" && x.at !== null && (x.at as number) > now).sort((a, b) => (a.at as number) - (b.at as number));
  const soon = upcoming.filter((x) => (x.at as number) - now < 12 * 36e5);
  const rest = allR.filter((x) => !upcoming.includes(x));
  const alertsOf: Record<string, string[]> = {};
  TEAMS.forEach((tm) => { alertsOf[tm.id] = teamAlerts(tm, now); });
  const alertN = TEAMS.reduce((a, tm) => a + (alertsOf[tm.id].length ? 1 : 0), 0);
  const heavyR = allR.filter((x) => (x.r.perWeek || 0) >= 5 && x.r.state === "on");
  const idxOf: Record<string, number> = {};
  active.forEach((x, i) => { idxOf[x.id] = i; });
  frozen.forEach((x, j) => { idxOf[x.id] = j + 6; });
  const openOf: Record<string, number> = {};
  TEAMS.forEach((tm) => { openOf[tm.id] = tm.pending.filter((p) => !decisions[p.id]).length; });
  const inF = (tm: Team) => !filter || tm.id === filter;
  const workRows: WorkRow[] = [
    ...active.filter(inF).flatMap((tm) => tm.tasks.filter((k) => k.state === "doing").map((k, j) => ({ key: `${tm.id}-t${j}`, team: tm, idx: idxOf[tm.id], text: k.text, owner: k.owner || tm.lead.name, kind: "task" as const }))),
    ...upcoming.filter((x) => (x.at as number) - now < 3 * 36e5 && x.team.status !== "frozen" && inF(x.team)).map((x) => ({ key: `${x.team.id}-r${x.r.id}`, team: x.team, idx: idxOf[x.team.id], text: x.r.name, owner: x.r.owner, kind: "routine" as const, at: x.at as number })),
  ];
  const approveRows: ApproveRowT[] = TEAMS.filter(inF).flatMap((tm) => tm.pending.map((p) => ({ team: tm, idx: idxOf[tm.id], item: p, at: sinceAt(p.since) })))
    .sort((a, b) => (a.at === null ? 1 : b.at === null ? -1 : a.at - b.at));
  const approveOpenN = approveRows.filter((r) => !decisions[r.item.id]).length;
  const openTotal = totalPending - decided;
  if (bump.current.n !== openTotal) { if (bump.current.n >= 0) bump.current.t0 = t; bump.current.n = openTotal; }
  const bumpK = Math.max(0, 1 - (t - bump.current.t0) / 0.7);
  const bumpS = 1 + 0.35 * bumpK * Math.abs(Math.sin(bumpK * 9));
  const campusH = "100dvh";

  // ---- responsive geometry ----
  const tallHud = vp.h > vp.w * 0.9;
  const compactHud = vp.w < 1600 || tallHud;
  const winR = Math.round(Math.min(290, Math.max(204, vp.w * (compactHud ? 0.21 : 0.2))));
  const winL = Math.round(Math.min(250, Math.max(168, vp.w * (compactHud ? 0.18 : 0.17))));
  const wide = vp.w - winL - winR - 56 >= 460;
  const winTop = wide ? 12 : 104;
  const roomTeam = room ? TEAMS.find((x) => x.id === room) || null : null;
  const panelW = Math.round(Math.min(420, Math.max(320, vp.w * 0.3)));
  const sheetH = Math.round(vp.h * 0.56);
  const padR = roomTeam && !phone && !classic ? panelW + 28 : 0;
  const padB = phone ? (roomTeam ? (pOpen ? sheetH : 64) : 70) : 0;
  const mapH = mapOpen && !phone ? 124 : 0;
  const leftMaxN = Math.max(140, Math.min(vp.h - winTop - 126 - mapH, tallHud ? vp.h * 0.32 : compactHud ? vp.h * 0.42 : vp.h * 0.6));
  const rightMaxN = Math.max(170, Math.min(vp.h - winTop - 80, tallHud ? vp.h * 0.36 : compactHud ? vp.h * 0.5 : vp.h * 0.65));
  const leftMax = `${Math.round(leftMaxN)}px`;
  const rightMax = `${Math.round(rightMaxN)}px`;
  // where the campus may sit in the default view: between the two HUD windows, or (tall screens) below them
  const topFree = wide ? 64 : 108;
  const fitBoxes = roomTeam ? undefined : phone ? [{ l: 4, r: 4, t: 100, b: 64 }] : [
    { l: Math.max(colW ? 0 : winL, mapOpen ? 230 : 0) + 24, r: colA ? 0 : winR + 24, t: topFree, b: 64 },
    { l: mapOpen ? 254 : 0, r: 0, t: Math.max(topFree, winTop + Math.max(colW ? 44 : leftMaxN, colA ? 44 : rightMaxN) + 10), b: 116 },
    { l: 0, r: 0, t: Math.max(topFree, winTop + Math.max(colW ? 44 : leftMaxN, colA ? 44 : rightMaxN) + 10), b: mapOpen ? 250 : 116 },
  ];

  // ---- search ----
  const hits: SearchHit[] = [];
  if (search && search.q.trim()) {
    const q = search.q.trim().toLowerCase();
    const has = (s: string) => s.toLowerCase().includes(q);
    TEAMS.forEach((tm) => {
      if (has(tm.name) || has(tm.work)) hits.push({ key: "t" + tm.id, icon: "🏠", label: tm.name, sub: clip(tm.work, 70), team: tm.id });
      ownersOf(tm).forEach((m, j) => { if (has(m.name) || has(m.role)) hits.push({ key: "m" + tm.id + j, icon: j === 0 ? "👑" : "🙂", label: m.name, sub: `${tm.name} · ${m.role}`, team: tm.id, what: "person", member: j - 1 }); });
      tm.pending.forEach((p) => { if (has(p.what)) hits.push({ key: "p" + p.id, icon: "⏳", label: clip(p.what, 80), sub: `${tm.name} · awaiting approval`, team: tm.id, what: "inbox" }); });
      tm.tasks.forEach((k, i) => { if (has(k.text) || has(k.owner || "")) hits.push({ key: "k" + tm.id + i, icon: "📝", label: clip(k.text, 80), sub: `${tm.name} · ${STATE_LABEL[k.state]} · ${k.owner || tm.lead.name}`, team: tm.id, what: "task" }); });
      (tm.routines || []).forEach((r) => { if (has(r.name) || has(r.owner)) hits.push({ key: "r" + tm.id + r.id, icon: "⏰", label: r.name, sub: `${tm.name} · ${r.owner} · ${r.schedule}`, team: tm.id, what: "routine" }); });
      tm.activity.forEach((a, i) => { if (has(a.text)) hits.push({ key: "a" + tm.id + i, icon: "📰", label: clip(a.text, 80), sub: `${tm.name} · ${a.time}`, team: tm.id, what: "news" }); });
    });
  }
  const shown = hits.slice(0, 40);
  const pickHit = (h: SearchHit) => { if (h.member !== undefined) enter(h.team, "person", h.member); else enter(h.team, h.what); };

  // ---- keyboard ----
  const keyRef = useRef<(e: any) => void>(() => {});
  keyRef.current = (e: any) => {
    const tg = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : "";
    const typing = tg === "input" || tg === "textarea" || (e.target && e.target.isContentEditable);
    if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setSearch(search ? null : { q: "", sel: 0 }); return; }
    if (e.key === "Escape") {
      if (search) setSearch(null); else if (help) setHelp(false); else if (newsOpen) setNewsOpen(false); else if (drawer) setDrawer(null); else if (feedOpen || inboxOpen) { setFeedOpen(false); setInboxOpen(false); } else if (sheet) setSheet(null); else if (classic && pMember !== null) setPMember(null); else if (classic && inFocus) setInFocus(false); else if (room) exit(); else if (filter) setFilter(null);
      return;
    }
    if (search && !typing) return;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (room && classic) {
      if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); setInWall(inStep(inWall, k === "ArrowLeft" ? 1 : -1)); setInFocus(true); return; }
      if (k === "Enter" && !inFocus) { setInFocus(true); return; }
      if (k === "ArrowUp" || k === "PageUp" || k === "[") { e.preventDefault(); roomStep(-1); return; }
      if (k === "ArrowDown" || k === "PageDown" || k === "]") { e.preventDefault(); roomStep(1); return; }
      if (k >= "1" && k <= "9") { const tm = TEAMS[Number(k) - 1]; if (tm) goRoom(tm.id); return; }
      if (k === "0" || k === "h" || k === "H") { exit(); return; }
    }
    if (room && !classic && (k === "Enter" || k === "i" || k === "I")) { goInside(); return; }
    if (k === "/") { e.preventDefault(); setSearch({ q: "", sel: 0 }); }
    else if (k === "?") setHelp(!help);
    else if (k >= "1" && k <= "9") { const tm = TEAMS[Number(k) - 1]; if (tm) enter(tm.id); }
    else if (k === "]" || k === "[") roomStep(k === "]" ? 1 : -1);
    else if (k === "0" || k === "h" || k === "H") { if (room) exit(); else setCmd({ n: cmd.n + 1, kind: "home" }); }
    else if (k === "+" || k === "=") setCmd({ n: cmd.n + 1, kind: "in" });
    else if (k === "-" || k === "_") setCmd({ n: cmd.n + 1, kind: "out" });
    else if (k === "q" || k === "Q" || k === "ArrowLeft") setCmd({ n: cmd.n + 1, kind: "left" });
    else if (k === "e" || k === "E" || k === "ArrowRight") setCmd({ n: cmd.n + 1, kind: "right" });
    else if (k === "t" || k === "T") setCmd({ n: cmd.n + 1, kind: "tilt" });
    else if (k === "a" || k === "A") { if (phone) setSheet(sheet === "approve" ? null : "approve"); else setColA(!colA); }
    else if (k === "w" || k === "W") { if (phone) setSheet(sheet === "work" ? null : "work"); else setColW(!colW); }
    else if (k === "n" || k === "N") setNewsOpen(!newsOpen);
    else if (k === "m" || k === "M") openDrawer("tray");
    else if (k === "f" || k === "F") { if (feedOpen) setFeedOpen(false); else openHistory(room || filter); }
  };
  useEffect(() => {
    const w = globalThis as any;
    if (!w.addEventListener) return;
    const h = (e: any) => keyRef.current(e);
    w.addEventListener("keydown", h);
    return () => w.removeEventListener("keydown", h);
  }, []);

  const glassBtn = (label: any, onClick: () => void, title?: string, on?: boolean) => (
    <button title={title} aria-label={title} onClick={onClick} style={{ font: "inherit", fontSize: 16, fontWeight: 700, width: 36, height: 36, borderRadius: 18, border: `1px solid ${on ? th.fill.accent : th.border.default}`, background: th.bg.elevated, color: th.text.primary, cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,.18)", padding: 0 }}>{label}</button>
  );
  const pill: any = { display: "flex", alignItems: "center", gap: 14, padding: "6px 14px", borderRadius: 999, background: th.bg.elevated, border: `1px solid ${th.border.default}`, boxShadow: "0 6px 20px rgba(0,0,0,.14)" };
  const left = 100 - USAGE.weeklyPct;
  const toastVisible = toast && t - toast.t0 < (toast.kind === "failed" ? 14 : 7);
  const Scene: any = SCENE3D && !glFail ? SCENE3D : IsoCampus;
  const sceneTip = (p: ScenePick) => { const tm = TEAMS.find((x) => x.id === p.team); return tm ? <SceneTip team={tm} member={p.member} what={p.what} alerts={alertsOf[tm.id] || []} open={openOf[tm.id] || 0} /> : null; };
  const clockLines = (soon.length ? soon : upcoming).slice(0, 3).map((x) => `${shortWhen(x.at as number, now)} · ${x.team.name} · ${x.r.owner}`);
  const fresh3 = freshList.length;
  const glass: any = { background: `color-mix(in srgb, ${th.bg.elevated} 92%, transparent)`, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: `1px solid ${th.border.default}`, boxShadow: "0 8px 28px rgba(0,0,0,.28)" };
  const freshWrap = (k: string, el: any, key: string) => <div key={key} style={{ position: "relative" }}>{freshMap[k] && <span title="New since your last visit" style={{ position: "absolute", top: 14, insetInlineEnd: -9, width: 6, height: 6, borderRadius: 3, background: th.fill.accent }} />}{el}</div>;
  const approveFloat = approveRows.length ? approveRows.map((r, k) => freshWrap("p:" + r.item.id, <FloatApproveRow row={r} t={t} compact={compactHud} last={k === approveRows.length - 1} decision={decisions[r.item.id]} onDecide={(kd, m) => decide(r.team, r.item, kd, m)} onSendNow={sendNow} onEnter={() => enter(r.team.id, "inbox")} />, r.item.id)) : <div style={{ padding: "14px 0", fontSize: 13, color: th.text.tertiary }}>{filter ? "Nothing to approve in this team" : "Nothing to approve right now 🎉"}</div>;
  const workFloat = workRows.length ? workRows.map((r, k) => <FloatWorkRow key={r.key} row={r} t={t} compact={compactHud} last={k === workRows.length - 1} onEnter={() => enter(r.team.id, r.kind === "routine" ? "routine" : "task")} />) : <div style={{ padding: "14px 0", fontSize: 13, color: th.text.tertiary }}>No tasks in progress right now</div>;
  const chip = (id: string | null, label: string, color: string | null, n: number) => {
    const sel = filter === id;
    return (
      <button key={id || "all"} onClick={() => setFilter(sel ? null : id)} style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "5px 11px", borderRadius: 999, border: `1px solid ${sel ? th.fill.accent : th.border.default}`, background: sel ? th.border.strong : th.bg.elevated, color: th.text.primary, cursor: "pointer", whiteSpace: "nowrap", flex: "none", boxShadow: "0 3px 10px rgba(0,0,0,.2)" }}>
        {color && <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />}{label}{n > 0 && <b style={{ color: th.text.accent }}>{n}</b>}
      </button>
    );
  };

  return (
    <div dir="ltr" style={{ width: "100%", fontFamily: th.font.family, color: th.text.primary, background: th.bg.subtle }}>
    <div style={{ display: "flex", alignItems: "stretch", width: "100%" }}>
    <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0, background: th.bg.subtle, overflow: "hidden", height: campusH, minHeight: 420 }}>
      {!(roomTeam && classic) && (
        <Scene t={t} teams={TEAMS} pos={pos} idxOf={idxOf} alertsOf={alertsOf} openOf={openOf} freshOf={freshOf} focus={room} dim={filter} hot={hot} padR={padR} padB={padB} fitBoxes={fitBoxes}
          cmd={cmd} view={viewRef} clockLines={clockLines} soonN={soon.length} onPick={(p: ScenePick) => enter(p.team, p.what === "person" ? "person" : (p.what as PanelTab | undefined), p.member)} onHot={setHot} onClock={() => openDrawer("clock")} tip={sceneTip} onFail={() => setGlFail(true)} />
      )}

      {/* floating HUD windows: visual right = waiting on you, visual left = in progress */}
      {!roomTeam && !phone && (
        <FloatWin side="right" title="Waiting for your approval" count={approveOpenN} tone={th.text.warning} glow t={t} collapsed={colA} onToggle={() => setColA(!colA)} maxH={rightMax} top={winTop} w={winR} compact={compactHud}>{approveFloat}</FloatWin>
      )}
      {!roomTeam && !phone && (
        <FloatWin side="left" title="In progress" count={workRows.length} tone={th.text.accent} t={t} collapsed={colW} onToggle={() => setColW(!colW)} maxH={leftMax} top={winTop} w={winL} compact={compactHud}>{workFloat}</FloatWin>
      )}

      {/* room: 3D close-up + panel (or the classic illustrated room) */}
      {roomTeam && classic && (() => {
        const i = TEAMS.indexOf(roomTeam); const n = TEAMS.length;
        return <Room3D team={roomTeam} idx={idxOf[roomTeam.id] || 0} t={t} vp={vp} phone={phone} wall={inWall} focus={inFocus} member={pMember} decisions={decisions} fresh={freshMap}
          prevName={TEAMS[(i - 1 + n) % n].name} nextName={TEAMS[(i + 1) % n].name} onWall={setInWall} onFocus={setInFocus} onMember={setPMember} onPrev={() => roomStep(-1)} onNext={() => roomStep(1)} onExit={exit}
          onDecide={decide} onSend={send} onSendNow={sendNow} />;
      })()}
      {roomTeam && !classic && (
        <RoomPanel team={roomTeam} idx={idxOf[roomTeam.id] || 0} t={t} tab={pTab} member={pMember} phone={phone} open={!phone || pOpen} decisions={decisions} fresh={freshMap}
          onTab={(k) => { setPTab(k); setPOpen(true); }} onMember={setPMember} onDecide={decide} onSend={send} onSendNow={sendNow} onExit={exit} onClassic={goInside} onToggle={() => setPOpen(!pOpen)}
          style={phone
            ? { position: "absolute", left: 0, right: 0, bottom: 0, height: pOpen ? sheetH : 56, zIndex: 6, display: "flex", flexDirection: "column", ...glass, borderRadius: "20px 20px 0 0", transition: "height 300ms" }
            : { position: "absolute", top: winTop, right: 14, bottom: 14, width: panelW, zIndex: 6, display: "flex", flexDirection: "column", ...glass, borderRadius: 20, opacity: t > 0 ? 1 : 0 }} />
      )}
      {roomTeam && !classic && !phone && (
        <button onClick={exit} title="Back to campus (Esc)" style={{ position: "absolute", top: winTop, left: 14, zIndex: 6, font: "inherit", fontSize: 14, fontWeight: 600, padding: "8px 14px", borderRadius: 999, ...glass, color: th.text.primary, cursor: "pointer" }}>← Campus</button>
      )}

      {/* team quick filters */}
      {!roomTeam && (
        <div style={{ position: "absolute", top: phone ? 56 : 58, left: phone || !wide ? 10 : winL + 28, right: phone || !wide ? 10 : winR + 28, zIndex: 5, display: "flex", gap: 6, overflowX: "auto", justifyContent: phone || !wide ? "flex-start" : "safe center", padding: "2px 2px 6px", scrollbarWidth: "none" } as any}>
          {chip(null, "All teams", null, 0)}
          {TEAMS.map((tm) => chip(tm.id, tm.name, tm.status === "frozen" ? th.text.tertiary : cats[(idxOf[tm.id] || 0) % cats.length], openOf[tm.id] || 0))}
        </div>
      )}

      {/* HUD */}
      <div style={{ position: "absolute", top: 12, insetInlineStart: "50%", transform: "translateX(-50%)", zIndex: 6, ...pill, gap: phone ? 12 : 16, padding: phone ? "5px 12px" : "6px 14px", maxWidth: "calc(100vw - 20px)", boxSizing: "border-box" }}>
        <button onClick={() => { setInboxOpen(!inboxOpen); setFeedOpen(false); setDrawer(null); }} title="waiting for your approval" style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: th.text.accent }}>
          <svg width={22} height={22} viewBox="0 0 20 20" style={{ transform: `scale(${(1 + 0.08 * Math.sin(t * 4)) * bumpS})` }}><path d="M2 11 l3 -7 h10 l3 7 v6 h-16 z" fill="none" stroke={th.text.accent} strokeWidth={1.8} strokeLinejoin="round" /><path d="M2 11 h5 l1 2 h4 l1 -2 h5" fill="none" stroke={th.text.accent} strokeWidth={1.8} /></svg>
          <b style={{ fontSize: 17, display: "inline-block", transform: `scale(${bumpS})` }}>{openTotal}</b>
        </button>
        <button onClick={() => openDrawer("tray")} title="Bot tray (M)" style={{ position: "relative", display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: queue.length ? th.text.accent : th.text.secondary }}>
          <svg width={22} height={22} viewBox="-12 -12 24 24"><path d="M -10 -2 h 20 v 10 h -20 z" fill="none" stroke="currentColor" strokeWidth={1.8} /><path d="M -10 -2 l 10 6 l 10 -6" fill="none" stroke="currentColor" strokeWidth={1.8} />{queue.slice(0, 3).map((_, k) => <rect key={k} x={-7 + k} y={-9 - k * 2.5 + Math.sin(t * 4 + k) * 0.6} width={14} height={7} rx={1} fill={th.bg.elevated} stroke="currentColor" strokeWidth={1.2} />)}</svg>
          <b style={{ fontSize: 15 }}>{queue.length}</b>
        </button>
        <button onClick={() => openDrawer("usage")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: th.text.primary }} title={`Weekly usage · resets ${USAGE.reset} · on-demand ${USAGE.onDemandPct}%`}>
          <svg width={34} height={18} viewBox="0 0 46 22"><rect x={1} y={2} width={40} height={18} rx={4} fill="none" stroke={th.text.secondary} strokeWidth={2} /><rect x={42} y={7} width={3} height={8} rx={1} fill={th.text.secondary} /><rect x={4} y={5} width={34 * (left / 100)} height={12} rx={2} fill={th.text.success} opacity={0.7 + 0.3 * Math.sin(t * 2)} /></svg>
          <b style={{ fontSize: 14 }}>{USAGE.weeklyPct}%</b>
        </button>
        <button onClick={() => openDrawer("clock")} title={alertN ? "Scheduled tasks · some failed" : "Scheduled tasks"} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: alertN ? th.text.danger : th.text.primary }}>
          <svg width={22} height={22} viewBox="-11 -11 22 22"><Clock r={9} t={t} mode="on" fail={alertN > 0} /></svg>
          <b style={{ fontSize: 14 }}>{upcoming.length}</b>
        </button>
        {fresh3 > 0 && (
          <button onClick={() => { setNewsOpen(!newsOpen); setSearch(null); }} title="What changed since your last visit (N)" style={{ display: "flex", alignItems: "center", gap: 4, background: th.fill.accent, border: "none", borderRadius: 999, padding: "3px 9px", cursor: "pointer", font: "inherit", fontSize: 12.5, fontWeight: 700, color: th.text.onColor, transform: `scale(${1 + 0.04 * Math.sin(t * 3)})` }}>✦ {fresh3}{phone ? "" : " new"}</button>
        )}
        <button onClick={() => { if (feedOpen) setFeedOpen(false); else openHistory(room || filter); }} title="History: everything the bots did and what you sent (F)" style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: feedOpen ? th.text.accent : th.text.secondary }}>
          <svg width={19} height={19} viewBox="0 0 20 20"><path d="M3.2 10 a6.8 6.8 0 1 0 2 -4.8" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" /><path d="M2.6 2.8 v3.4 h3.4" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" /><path d="M10 6.2 v4 l2.6 1.6" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" /></svg>
          {!phone && <b style={{ fontSize: 13.5 }}>History</b>}
        </button>
        <button onClick={() => setSearch(search ? null : { q: "", sel: 0 })} title="Search (/ or Ctrl+K)" style={{ display: "flex", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", color: th.text.secondary }}>
          <svg width={18} height={18} viewBox="0 0 20 20"><circle cx={8.5} cy={8.5} r={6} fill="none" stroke="currentColor" strokeWidth={2} /><line x1={13} y1={13} x2={18} y2={18} stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
        </button>
        {(() => {
          const rf = RF;
          const busyNow = rf ? rf.busy : rfLocal > 0 && Date.now() - rfLocal < 700;
          const spin = busyNow || (!!rf && rf.polling);
          const lastAt = rf ? rf.at : rfLocal;
          const res = rf && !busyNow && rf.at && Date.now() - rf.at < (rf.result === "new" ? 8000 : 4000) ? rf.result : "";
          const coolMs = rf && rf.reqAt ? 5 * 60000 - (Date.now() - rf.reqAt) : 0;
          const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
          const lbl = busyNow ? "Refreshing…" : rf && rf.note ? rf.note : res === "new" ? "✓ New data loaded" : coolMs > 0 ? `Refresh request sent${rf && rf.polling ? " · waiting for data" : ""} · again in ${mmss(coolMs)}` : res === "same" ? "✓ No new data" : res === "error" ? "Loading failed" : lastAt ? `Updated ${ilTime(lastAt)}` : "Refresh";
          const tip = rf ? "Refresh: reloads the saved data right away and asks the bot to update it from the team chats (at most once every 5 minutes)" : `Refresh: reloads the view (${UPDATED})`;
          return (
            <button onClick={() => (rf ? rf.refresh() : setRfLocal(Date.now()))} title={tip} aria-label="Refresh data" style={{ display: "flex", alignItems: "center", gap: 5, background: spin ? th.fill.secondary : "none", border: "none", borderRadius: 999, padding: spin ? "2px 8px" : 0, cursor: "pointer", font: "inherit", fontSize: 12, color: spin ? th.text.primary : th.text.tertiary, whiteSpace: "nowrap" }}>
              <span style={{ display: "inline-block", fontSize: 16, lineHeight: "16px", color: spin ? th.text.accent : th.text.secondary, transform: spin ? `rotate(${(t * 360) % 360}deg)` : "none" }}>⟳</span>
              {!phone && <span style={{ color: res === "new" ? th.text.success : res === "error" ? th.text.danger : undefined, fontWeight: res ? 700 : 400 }}>{lbl}</span>}
              {!phone && <span style={{ color: th.text.tertiary }}>· data from {dataStamp(UPDATED)}</span>}
            </button>
          );
        })()}
        {!phone && <button onClick={() => setHelp(!help)} title="Keyboard shortcuts (?)" style={{ width: 22, height: 22, borderRadius: 11, border: "none", background: th.fill.secondary, color: th.text.secondary, cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 700, padding: 0 }}>?</button>}
      </div>

      {/* map controls + minimap */}
      {!(roomTeam && classic) && (
        <div style={{ position: "absolute", bottom: phone ? padB + 10 : 70, left: 14, zIndex: 5, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
          {mapOpen && !phone && !roomTeam && <div style={{ ...glass, borderRadius: 16, padding: 4 }}><MiniMap teams={TEAMS} pos={pos} idxOf={idxOf} openOf={openOf} freshOf={freshOf} focus={room} dim={filter} view={viewRef.current} t={t} onPick={(id) => enter(id)} /></div>}
          <div style={{ display: "flex", gap: 6 }}>
            {glassBtn("+", () => setCmd({ n: cmd.n + 1, kind: "in" }), "Zoom in (+)")}
            {glassBtn("−", () => setCmd({ n: cmd.n + 1, kind: "out" }), "Zoom out (-)")}
            {glassBtn("⟲", () => setCmd({ n: cmd.n + 1, kind: "left" }), "Rotate (Q)")}
            {glassBtn("⟳", () => setCmd({ n: cmd.n + 1, kind: "right" }), "Rotate (E)")}
            {glassBtn("⌂", () => { if (room) exit(); else setCmd({ n: cmd.n + 1, kind: "home" }); }, "Center (H)")}
            {!phone && glassBtn("🗺", () => setMapOpen(!mapOpen), "Minimap", mapOpen)}
          </div>
        </div>
      )}

      {/* live ticker */}
      {tick && !roomTeam && !(phone && sheet) && (
        <div style={{ position: "absolute", bottom: phone ? 70 : 14, left: phone ? 10 : 14, right: phone ? 10 : 14, display: "flex", justifyContent: "center", zIndex: 6, pointerEvents: "none" }}>
          <div style={{ ...pill, pointerEvents: "auto", width: "min(700px, 100%)", maxWidth: "min(700px, 100%)", height: phone ? 50 : 54, gap: 10, paddingInlineEnd: 6, boxSizing: "border-box", borderRadius: 22, flex: "0 0 auto" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: th.text.danger }}><span style={{ width: 8, height: 8, borderRadius: 4, background: th.text.danger, opacity: 0.5 + 0.5 * Math.sin(t * 5) }} />LIVE</span>
            <button onClick={() => enter(tick.team.id, "news")} style={{ opacity: tickO, transform: `translateY(${(1 - tickO) * 6}px)`, background: "none", border: "none", padding: 0, font: "inherit", fontSize: phone ? 13 : 14, lineHeight: phone ? "17px" : "19px", color: th.text.primary, cursor: "pointer", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", minWidth: 0, flex: "1 1 0", textAlign: "start", alignSelf: "center", maxHeight: phone ? 34 : 38 } as any}>
              <b>{tick.team.name}</b> <span style={{ color: th.text.tertiary }}>{tick.time}</span> · {tick.text}
            </button>
            <button onClick={() => { if (feedOpen) setFeedOpen(false); else openHistory(filter); }} title="Everything the bots did and what you sent (F)" style={{ font: "inherit", fontSize: 13, fontWeight: 600, padding: "6px 12px", borderRadius: 999, border: `1px solid ${th.border.default}`, background: feedOpen ? th.fill.accentSubtle : th.bg.subtle, color: th.text.primary, cursor: "pointer", whiteSpace: "nowrap" }}>History</button>
          </div>
        </div>
      )}

      {/* phone: bottom tabs + sheet for the two lists */}
      {phone && !roomTeam && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 7, display: "flex", flexDirection: "column", ...(sheet ? { ...glass, borderRadius: "20px 20px 0 0", height: sheetH } : {}), transition: "height 300ms" }}>
          <div style={{ display: "flex", gap: 8, padding: "10px 10px 10px" }}>
            {(["approve", "work"] as const).map((k) => (
              <button key={k} onClick={() => setSheet(sheet === k ? null : k)} style={{ flex: 1, font: "inherit", fontSize: 14, fontWeight: 700, padding: "10px 8px", borderRadius: 999, border: `1px solid ${sheet === k ? th.fill.accent : th.border.default}`, background: sheet === k ? th.border.strong : th.bg.elevated, color: th.text.primary, cursor: "pointer", boxShadow: "0 6px 18px rgba(0,0,0,.3)" }}>
                {k === "approve" ? "⏳ Awaiting approval" : "⚙️ In progress"} <b style={{ color: th.text.accent }}>{k === "approve" ? approveOpenN : workRows.length}</b>
              </button>
            ))}
          </div>
          {sheet && <div style={{ overflowY: "auto", padding: "0 14px 16px", flex: "1 1 auto", minHeight: 0, overscrollBehavior: "contain" }}>{sheet === "approve" ? approveFloat : workFloat}</div>}
        </div>
      )}

      {/* what's new since the last visit */}
      {newsOpen && (
        <div style={{ position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)", width: "min(520px, calc(100% - 24px))", maxHeight: "min(70%, 560px)", zIndex: 9, display: "flex", flexDirection: "column", ...glass, borderRadius: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 8px" }}>
            <b style={{ fontSize: 15 }}>✦ What changed since your last visit · {fresh3}</b>
            <button onClick={markSeen} style={{ marginInlineStart: "auto", font: "inherit", fontSize: 12.5, padding: "5px 11px", borderRadius: 999, border: "none", background: th.fill.accent, color: th.text.onColor, cursor: "pointer" }}>Mark all as read</button>
            <button onClick={() => setNewsOpen(false)} aria-label="Close" style={{ width: 28, height: 28, borderRadius: 14, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer", font: "inherit" }}>✕</button>
          </div>
          <div style={{ overflowY: "auto", padding: "0 14px 12px" }}>
            {freshList.map((x) => (
              <button key={x.k} onClick={() => enter(x.team.id, x.what)} style={{ display: "flex", gap: 8, width: "100%", textAlign: "start", font: "inherit", fontSize: 13, lineHeight: "19px", padding: "8px 0", background: "none", border: "none", borderBottom: `1px solid ${th.border.weak}`, color: th.text.primary, cursor: "pointer" }}>
                <span>{x.icon}</span><span style={{ flex: 1 }}><b style={{ color: cats[(idxOf[x.team.id] || 0) % cats.length] }}>{x.team.name}</b> · {clip(x.label, 120)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* search */}
      {search && (
        <div style={{ position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)", width: "min(560px, calc(100% - 24px))", zIndex: 10, ...glass, borderRadius: 20, overflow: "hidden" }}>
          <input autoFocus value={search.q} onChange={(e: any) => setSearch({ q: e.target.value, sel: 0 })} placeholder="Search a team, bot, task, approval, run…" dir="ltr"
            onKeyDown={(e: any) => { if (e.key === "ArrowDown") { e.preventDefault(); setSearch({ q: search.q, sel: Math.min(shown.length - 1, search.sel + 1) }); } else if (e.key === "ArrowUp") { e.preventDefault(); setSearch({ q: search.q, sel: Math.max(0, search.sel - 1) }); } else if (e.key === "Enter" && shown[search.sel]) pickHit(shown[search.sel]); else if (e.key === "Escape") setSearch(null); }}
            style={{ width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 16, padding: "14px 16px", border: "none", borderBottom: `1px solid ${th.border.default}`, background: "transparent", color: th.text.primary, outline: "none" }} />
          <div style={{ maxHeight: "min(52vh, 440px)", overflowY: "auto" }}>
            {search.q.trim() && !shown.length && <div style={{ padding: 16, color: th.text.tertiary, fontSize: 14 }}>Nothing found</div>}
            {!search.q.trim() && <div style={{ padding: "12px 16px", color: th.text.tertiary, fontSize: 13, lineHeight: "20px" }}>Search all teams. Enter opens the room. 1–9 jumps to a team, Esc closes.</div>}
            {shown.map((h, i) => (
              <button key={h.key} onClick={() => pickHit(h)} onMouseEnter={() => setSearch({ q: search.q, sel: i })} style={{ display: "flex", gap: 10, alignItems: "center", width: "100%", textAlign: "start", font: "inherit", padding: "9px 16px", border: "none", background: i === search.sel ? th.border.strong : "transparent", color: th.text.primary, cursor: "pointer" }}>
                <span style={{ fontSize: 16 }}>{h.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.label}</span><span style={{ display: "block", fontSize: 12, color: th.text.tertiary }}>{h.sub}</span></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* keyboard help */}
      {help && (
        <div onClick={() => setHelp(false)} style={{ position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)", width: "min(460px, calc(100% - 24px))", zIndex: 10, ...glass, borderRadius: 20, padding: "14px 18px" }}>
          <b style={{ fontSize: 15 }}>Keyboard shortcuts</b>
          {[["/ or Ctrl+K", "Search"], ["1–9", "Open a team's room"], ["] / [", "Next / previous team (all teams, also past 9)"], ["Esc", "Close / back to campus"], ["A / W", "Approvals window / In-progress window"], ["N", "What's new since your last visit"], ["M", "Bot tray"], ["F", "History (all bot events and what you sent)"], ["+ / −", "Zoom"], ["Q / E", "Rotate the camera"], ["T", "Tilt the camera"], ["H", "Back to the overview"], ["Enter", "Enter the room (from the room view)"], ["← →", "In a room: switch boards"], ["Drag in a room", "look around · double-click: normal view"], ["↑ ↓", "In a room: previous / next room"], ["Drag", "pan · right/Shift+drag: rotate · wheel: zoom"]].map(([k, d]) => (
            <div key={k} style={{ display: "flex", gap: 10, fontSize: 13, padding: "5px 0", borderBottom: `1px solid ${th.border.weak}` }}><b dir="ltr" style={{ minWidth: 92, color: th.text.accent }}>{k}</b><span>{d}</span></div>
          ))}
        </div>
      )}

      {/* history panel (was the small "Full feed" drawer) */}
      <HistoryPanel open={feedOpen} onClose={() => setFeedOpen(false)} startTeam={histTeam} server={hist} local={sentLocal} loading={histLoading} idxOf={idxOf} fresh={freshMap} onEnter={(id) => enter(id, "news")} phone={phone} />

      {/* inbox drawer: all papers */}
      <div style={{ position: "absolute", top: 64, insetInlineStart: 14, insetInlineEnd: 14, maxHeight: "calc(100% - 150px)", overflowY: "auto", zIndex: 8, padding: "8px 6px 16px", opacity: inboxOpen ? 1 : 0, transform: inboxOpen ? "translateY(0)" : "translateY(-16px)", pointerEvents: inboxOpen ? "auto" : "none", transition: "opacity 250ms, transform 250ms" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 16 }}>
          {TEAMS.flatMap((tm) => tm.pending.map((p, i) => <ApprovalCard key={p.id} team={tm} item={p} i={i} decision={decisions[p.id]} onDecide={(k, m) => decide(tm, p, k, m)} />))}
        </div>
        <div style={{ textAlign: "center", marginTop: 12 }}><button onClick={() => setInboxOpen(false)} style={{ font: "inherit", fontSize: 14, padding: "8px 18px", borderRadius: 999, border: `1px solid ${th.border.default}`, background: th.bg.elevated, color: th.text.primary, cursor: "pointer" }}>Close</button></div>
      </div>

      {/* drawers: the main bot tray, clock tower schedule, usage */}
      <div style={{ position: "absolute", top: 60, insetInlineStart: 14, width: "min(460px, calc(100% - 28px))", boxSizing: "border-box", maxHeight: "calc(100% - 140px)", overflowY: "auto", zIndex: 8, opacity: drawer ? 1 : 0, transform: drawer ? "translateY(0)" : "translateY(-14px)", pointerEvents: drawer ? "auto" : "none", transition: "opacity 250ms, transform 250ms", background: th.bg.elevated, borderRadius: 22, border: `1px solid ${th.border.subtle}`, boxShadow: "0 18px 50px rgba(0,0,0,.25)", padding: drawer ? "14px 14px 16px" : 0 }}>
        {drawer && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 22 }}>{drawer === "tray" ? "📨" : drawer === "clock" ? "🕰️" : "🔋"}</span>
            <b style={{ fontSize: 18 }}>{drawer === "tray" ? "Bot tray" : drawer === "clock" ? "Clock tower" : "Who uses credits"}</b>
            <button onClick={() => setDrawer(null)} aria-label="Close" style={{ marginInlineStart: "auto", width: 32, height: 32, borderRadius: 16, border: `1px solid ${th.border.default}`, background: th.bg.subtle, color: th.text.primary, cursor: "pointer", font: "inherit" }}>✕</button>
          </div>
        )}
        {drawer === "tray" && (
          <div>
            {queue.length === 0 ? <div style={{ textAlign: "center", color: th.text.tertiary, padding: "18px 0", fontSize: 15 }}>Empty. Every button on the page adds a request here.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {queue.map((m, i) => (
                  <div key={m} style={{ display: "flex", gap: 8, alignItems: "flex-start", background: th.bg.subtle, borderRadius: 14, padding: "8px 10px", fontSize: 14, lineHeight: "20px" }}>
                    <b style={{ color: th.text.accent }}>{i + 1}.</b><span style={{ flex: 1 }}>{m}</span>
                    <button onClick={() => postItems([m])} disabled={sending} title="Send just this" style={{ border: "none", borderRadius: 999, background: th.fill.accent, color: th.text.onColor, cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 700, padding: "2px 9px", whiteSpace: "nowrap" }}>Send</button>
                    <button onClick={() => setQueue(queue.filter((x) => x !== m))} aria-label="Remove" style={{ border: "none", background: "none", color: th.text.tertiary, cursor: "pointer", font: "inherit", fontSize: 14 }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <Pb label={sending ? "Sending…" : `📨 Send to bot (${queue.length})`} color={th.text.onColor} bg={th.fill.accent} disabled={!queue.length || sending} onClick={() => postItems(queue)} />
              <Pb label="📋 Copy all" color={th.text.primary} bg={th.fill.secondary} disabled={!queue.length} onClick={batch} />
              <Pb label="Clear" color={th.text.secondary} bg={th.bg.subtle} disabled={!queue.length} onClick={() => setQueue([])} />
            </div>
          </div>
        )}
        {drawer === "clock" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 13, marginBottom: 4 }}>
              {[["Activity", allR.filter((x) => x.r.state === "on").length, th.text.success], ["paused", allR.filter((x) => x.r.state === "paused").length, th.text.warning], ["Unknown", allR.filter((x) => x.r.state === "unknown").length, th.text.tertiary], ["Failed recently", allR.filter((x) => x.r.lastResult === "fail").length, th.text.danger]].map(([l, n, c]) => (
                <span key={l as string} style={{ background: th.bg.subtle, borderRadius: 999, padding: "4px 10px", color: c as string, fontWeight: 700 }}>{n} {l}</span>
              ))}
            </div>
            {[...upcoming, ...rest].map((x) => {
              const key = x.team.id + "/" + x.r.id;
              const isOpen = openR === key;
              const fail = x.r.lastResult === "fail" && x.r.state !== "paused";
              const c = x.r.state === "on" ? (fail ? th.text.danger : th.text.success) : x.r.state === "paused" ? th.text.warning : th.text.tertiary;
              return (
                <div key={key}>
                  <button onClick={() => setOpenR(isOpen ? null : key)} style={{ width: "100%", textAlign: "start", font: "inherit", display: "flex", alignItems: "center", gap: 10, background: soon.includes(x) ? th.fill.accentSubtle : th.bg.subtle, border: `1px solid ${isOpen ? th.border.focus : th.border.subtle}`, borderRadius: 14, padding: "8px 10px", cursor: "pointer", color: th.text.primary }}>
                    <svg width={26} height={26} viewBox="-13 -13 26 26" style={{ flex: "0 0 26px" }}><Clock r={11} t={t} mode={x.r.state} fail={fail} /></svg>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.r.name}</span>
                      <span style={{ display: "block", fontSize: 12.5, color: th.text.tertiary }}>{x.team.name} · {x.r.owner} · {x.r.schedule}</span>
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: c, whiteSpace: "nowrap" }}>{t > 0 && x.at !== null && x.r.state === "on" && (x.at as number) > now ? countdown((x.at as number) - now) : ROUT_STATE[x.r.state]}</span>
                  </button>
                  {isOpen && <div style={{ marginTop: 6 }}><RoutineCard team={x.team} r={x.r} t={t} onSend={send} /></div>}
                </div>
              );
            })}
            <div style={{ fontSize: 12.5, color: th.text.tertiary, lineHeight: "18px", marginTop: 4 }}>
              No scheduled tasks: {TEAMS.filter((tm) => !(tm.routines || []).length).map((tm) => tm.name).join(", ") || "—"}
            </div>
          </div>
        )}
        {drawer === "usage" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: th.bg.subtle, borderRadius: 14, padding: "10px 12px", fontSize: 14 }}>
              <b style={{ fontSize: 26 }}>{USAGE.weeklyPct}%</b><span>of the week used · resets {USAGE.reset}</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, margin: "12px 0 6px" }}>By team</div>
            {USAGE.byTeam.map((u) => (
              <div key={u.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13.5 }}>
                <span style={{ width: 120, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.label}</span>
                <div style={{ flex: 1, height: 12, borderRadius: 6, background: th.fill.secondary, overflow: "hidden" }}><div style={{ width: `${u.pct}%`, height: "100%", borderRadius: 6, background: u.pct >= 25 ? th.text.warning : th.text.success, transition: "width 600ms" }} /></div>
                <b dir="ltr" style={{ width: 38 }}>{u.pct}%</b>
              </div>
            ))}
            <div style={{ fontSize: 14, fontWeight: 700, margin: "12px 0 6px" }}>Heaviest bots</div>
            {USAGE.topBots.map((u) => (
              <div key={u.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13.5 }}>
                <span style={{ width: 160, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.pct >= 10 ? "⚠️ " : ""}{u.label}</span>
                <div style={{ flex: 1, height: 10, borderRadius: 5, background: th.fill.secondary, overflow: "hidden" }}><div style={{ width: `${u.pct * 5}%`, height: "100%", borderRadius: 5, background: u.pct >= 10 ? th.text.warning : th.text.success, opacity: 0.75 + 0.25 * Math.sin(t * 3) }} /></div>
                <b dir="ltr" style={{ width: 38 }}>{u.pct}%</b>
              </div>
            ))}
            {heavyR.length > 0 && <div style={{ fontSize: 14, fontWeight: 700, margin: "12px 0 6px" }}>Tasks that run a lot</div>}
            {heavyR.map((x) => (
              <div key={x.r.id} style={{ background: th.fill.warningSubtle, borderRadius: 14, padding: "8px 11px", fontSize: 13.5, lineHeight: "20px", marginBottom: 7, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ flex: "1 1 200px" }}>⚠️ <b>{x.r.name}</b> · {x.team.name} / {x.r.owner} · {x.r.perWeek} times a week</span>
                <Pb label="⏸ Pause" color={th.text.warning} bg={th.bg.elevated} onClick={() => send(`Pause task — ${rBase(x.team, x.r)}`)} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* toast */}
      {toastVisible && toast && (
        <div style={{ position: "fixed", bottom: 76, left: "50%", transform: "translateX(-50%)", zIndex: 9, width: "max-content", maxWidth: "min(560px, 92vw)", background: th.bg.elevated, color: th.text.primary, border: `1px solid ${toast.kind === "sent" ? th.text.success : toast.kind === "failed" ? th.text.danger : th.border.default}`, borderRadius: 20, padding: "10px 16px", boxShadow: "0 10px 30px rgba(0,0,0,.25)", fontSize: 14, lineHeight: "20px" }} dir="ltr">
          <div style={{ fontWeight: 700, marginBottom: 2, color: toast.kind === "sent" ? th.text.success : toast.kind === "failed" ? th.text.danger : th.text.primary }}>{toast.kind === "queued" ? "Added to the bot tray" : toast.kind === "sent" ? "Sent to the bot ✓" : toast.kind === "wait" ? "One moment…" : toast.kind === "failed" ? `Sending failed${toast.err ? ` (${toast.err})` : ""}. ${toast.ok ? "Message copied — paste it to the bot:" : "Copy the message and paste it to the bot:"}` : toast.ok ? "Copied — paste it to the bot" : "Copy the message and paste it in your chat with the bot:"}</div>
          <div style={{ userSelect: "all", opacity: 0.9, whiteSpace: "pre-line", maxHeight: 140, overflowY: "auto" }}>{toast.msg}</div>
          {toast.kind === "sent" && DEMO && <div style={{ marginTop: 4, fontSize: 12.5, color: th.text.secondary }}>Watch History: the team picks it up in a few seconds.</div>}
          {toast.kind === "queued" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button onClick={() => postItems([toast.msg])} disabled={sending} style={{ font: "inherit", fontSize: 13, fontWeight: 700, padding: "5px 12px", borderRadius: 999, border: "none", background: th.fill.accent, color: th.text.onColor, cursor: "pointer" }}>{sending ? "Sending…" : "📨 Send now"}</button>
              <button onClick={() => { setDrawer("tray"); setFeedOpen(false); setInboxOpen(false); }} style={{ font: "inherit", fontSize: 13, padding: "5px 12px", borderRadius: 999, border: "none", background: th.fill.secondary, color: th.text.primary, cursor: "pointer" }}>Tray ({queue.length})</button>
            </div>
          )}
        </div>
      )}
    </div>
    </div>
    </div>
  );
}

// ---------- app wrapper: live data from the server ----------
export default function ControlCenter(props: { initial: DataShape; demo?: DemoApi }) {
  const demo = props.demo || null;
  const [data, setData] = useState<DataShape>(() => (demo ? demo.snapshot() : props.initial));
  // render in the browser only: times, countdowns and the time zone depend on the viewer's clock (avoids hydration mismatches)
  const [mounted, setMounted] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [result, setResult] = useState<"" | "new" | "same" | "error">("");
  const [reqAt, setReqAt] = useState(0);
  const [pollUntil, setPollUntil] = useState(0);
  const stampAtReq = useRef("");
  const busyRef = useRef(false);
  const cur = useRef(JSON.stringify(props.initial));
  // fetch the latest data from the server (Blob)
  const load = async (): Promise<"new" | "same" | "error"> => {
    if (demo) { const j = demo.snapshot(); const txt = JSON.stringify(j); const changed = txt !== cur.current; cur.current = txt; setData(j); setAt(Date.now()); return changed ? "new" : "same"; }
    try {
      const r = await fetch("/api/data?ts=" + Date.now(), { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
      if (r.status === 401) { return "error"; }
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.TEAMS)) {
          const txt = JSON.stringify(j);
          const changed = txt !== cur.current;
          cur.current = txt; setData(j); setAt(Date.now());
          return changed ? "new" : "same";
        }
      }
    } catch (e) {}
    return "error";
  };
  useEffect(() => {
    setMounted(true);
    setAt(Date.now());
    if (demo) {
      setData(demo.snapshot());
      const off = demo.subscribe(() => { const j = demo.snapshot(); cur.current = JSON.stringify(j); setData(j); });
      const id = setInterval(load, 60000);
      return () => { off(); clearInterval(id); };
    }
    try { const v = Number(localStorage.getItem("ccRefreshReq") || 0); if (v > Date.now() - 5 * 60000) setReqAt(v); } catch (e) {}
    // normal background polling: every 60 seconds and whenever the tab comes back
    const id = setInterval(load, 60000);
    const vis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", vis); };
  }, []);
  // after a refresh request: poll every 20 seconds for up to 6 minutes, stop when the data's own timestamp changes
  useEffect(() => {
    if (!pollUntil || demo) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/data?ts=" + Date.now(), { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          if (j && Array.isArray(j.TEAMS)) {
            cur.current = JSON.stringify(j); setData(j); setAt(Date.now());
            if (j.UPDATED !== stampAtReq.current) { setPollUntil(0); setResult("new"); return; }
          }
        }
      } catch (e) {}
      if (Date.now() > pollUntil) setPollUntil(0);
    }, 20000);
    return () => clearInterval(id);
  }, [pollUntil]);
  const remember = (v: number) => { setReqAt(v); try { localStorage.setItem("ccRefreshReq", String(v)); } catch (e) {} };
  // the ⟳ button: (1) re-read the latest data right away; (2) at most once per 5 minutes, ask the main bot to refresh it from the team chats
  const refresh = async () => {
    if (busyRef.current) return;
    if (demo) {
      // demo: the same states as the real flow (request sent -> the bot reads the chats -> new data), all simulated
      if (pollUntil) return;
      busyRef.current = true; setBusy(true);
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await pause(700); await load(); setAt(Date.now());
      busyRef.current = false; setBusy(false);
      setReqAt(Date.now()); setPollUntil(Date.now() + 6 * 60000);
      await pause(2200); setNote("The bot is reading the team chats…");
      await pause(3600); setNote("Updating the page…");
      await pause(1400);
      demo.refreshRound(); await load(); setAt(Date.now());
      setNote(""); setPollUntil(0); setReqAt(0); setResult("new");
      return;
    }
    busyRef.current = true; setBusy(true);
    const t0 = Date.now();
    const res = await load();
    setResult(res);
    setAt(Date.now());
    if (Date.now() - reqAt >= 5 * 60000) {
      try {
        const r = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "refresh" }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { remember(Number(j.at) || Date.now()); stampAtReq.current = data.UPDATED; setPollUntil(Date.now() + 6 * 60000); }
        else if (j.limited) remember(Number(j.at) || Date.now() - (5 * 60000 - (Number(j.waitMs) || 0)));
      } catch (e) {}
    }
    const left = 600 - (Date.now() - t0);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    busyRef.current = false; setBusy(false);
  };
  UPDATED = data.UPDATED; USAGE = data.USAGE; TEAMS = data.TEAMS; AVATARS = data.AVATARS && typeof data.AVATARS === "object" ? data.AVATARS : {};
  RF = { busy, at, result, reqAt, polling: pollUntil > 0, refresh, note };
  DEMO = demo;
  if (!mounted) return <div style={{ height: "100dvh", background: "#141414" }} />;
  return <ControlCenterInner />;
}

// shared with the WebGL scene
export { roomGeo, agentsOf, W3, ctrlFor, qpt, PLAZA, TREES, hexMix, campusGrow, avatarFor, avatarSig, shapeOutline, SHAPE_TILT, SHAPE_EYE };
