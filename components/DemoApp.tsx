"use client";
// Demo wrapper: invented data generated in the browser (viewer's time zone) plus the client-side simulation.
import { useState } from "react";
import ControlCenter from "./ControlCenter";
import { createDemoSim } from "../lib/demo-sim";
import { demoChats } from "../lib/demo-chats";
const EMPTY = { UPDATED: "", USAGE: { weeklyPct: 0, reset: "", onDemandPct: 0, period: "", byTeam: [], topBots: [] }, TEAMS: [] };
export default function DemoApp() {
  const [sim] = useState(() => { const t0 = Math.floor(Date.now() / 3600000) * 3600000; /* stable within the hour, so reloads don't look like new messages */ return Object.assign(createDemoSim(), { chats: () => demoChats(t0) }); });
  return <ControlCenter initial={EMPTY as any} demo={sim} />;
}
