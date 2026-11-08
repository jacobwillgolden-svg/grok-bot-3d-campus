"use client";
// Demo wrapper: invented data generated in the browser (viewer's time zone) plus the client-side simulation.
import { useState } from "react";
import ControlCenter from "./ControlCenter";
import { createDemoSim } from "../lib/demo-sim";
import { demoChats } from "../lib/demo-chats";
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
    return Object.assign(createDemoSim(), { chats: () => chats, sendChat });
  });
  return <ControlCenter initial={EMPTY as any} demo={sim} />;
}
