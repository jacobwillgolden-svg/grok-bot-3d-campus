"use client";
// Demo wrapper: invented data generated in the browser (viewer's time zone) plus the client-side simulation.
import { useState } from "react";
import ControlCenter from "./ControlCenter";
import { createDemoSim } from "../lib/demo-sim";
import { demoChats, type DemoChat } from "../lib/demo-chats";
const EMPTY = { UPDATED: "", USAGE: { weeklyPct: 0, reset: "", onDemandPct: 0, period: "", byTeam: [], topBots: [] }, TEAMS: [] };
export default function DemoApp() {
  const [sim] = useState(() => {
    const t0 = Math.floor(Date.now() / 3600000) * 3600000; /* stable within the hour, so reloads don't look like new messages */
    const chats = demoChats(t0);
    // demo: a message from the Chats panel lands in the chat and the bot "answers" a few seconds later
    const sendChat = (id: string, from: string, text: string) => {
      const c = chats.find((x) => x.id === id); if (!c) return;
      const now = Date.now();
      c.messages.push({ id: "cc-" + now, at: new Date(now).toISOString(), from, role: "user", text });
      const who = c.kind === "direct" ? c.bot || c.name : (c.participants || []).find((p) => p !== "You") || c.name;
      setTimeout(() => { c.messages.push({ id: "r-" + Date.now(), at: new Date().toISOString(), from: who, role: "bot", text: `Got it, ${from}. (Demo reply: in your real app, ${who} answers here once your Grok Bot passes the message on.)` }); }, 2500);
    };
    // demo: a reaction "reaches Grok" at once
    const react = (id: string, msg: string, emoji: string, by: string, op: "add" | "remove") => {
      const m = chats.find((x) => x.id === id)?.messages.find((x) => x.id === msg); if (!m) return;
      const rs = (m.reactions || []).map((r) => ({ emoji: r.emoji, by: r.by.filter((b) => b !== by) }));
      if (op === "add") { const r = rs.find((x) => x.emoji === emoji); if (r) r.by.push(by); else rs.push({ emoji, by: [by] }); }
      m.reactions = rs.filter((r) => r.by.length);
    };
    // demo: a new channel shows "setting up", then the Grok Bot "creates it in Grok" and a bot says hello
    const createChannel = (name: string, purpose: string, members: string[], from: string) => {
      const id = `chan:${name}-demo${chats.length}`, now = Date.now();
      const c: DemoChat = { id, name, kind: "group", channel: true, purpose: purpose || undefined, pending: true, participants: [from, ...members],
        messages: [{ id: id + "-created", at: new Date(now).toISOString(), from: "Control center", role: "system", text: `${from} created #${name} with ${members.join(", ")}. Your Grok Bot is setting it up in Grok…` }] };
      chats.push(c);
      setTimeout(() => {
        c.pending = false;
        c.messages.push({ id: id + "-ready", at: new Date().toISOString(), from: "Grok Bot", role: "system", text: `Grok Bot created #${name} in Grok and joined it.` });
        c.messages.push({ id: id + "-hi", at: new Date(Date.now() + 1000).toISOString(), from: members[0], role: "bot", text: `Hi ${from}! Ready to work in #${name}.${purpose ? " Goal noted: " + purpose : ""}`, reactions: [{ emoji: "👋", by: members.slice(1, 3) }].filter((r) => r.by.length) });
      }, 2500);
      return id;
    };
    return Object.assign(createDemoSim(), { chats: () => chats, sendChat, react, createChannel });
  });
  return <ControlCenter initial={EMPTY as any} demo={sim} />;
}
