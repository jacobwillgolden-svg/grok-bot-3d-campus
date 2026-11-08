// Demo only (removed by assemble.sh): invented chat history in the shape /api/chats returns.
// In the real app the main bot uploads the real conversations with push-messages.sh.
type Rx = { emoji: string; by: string[] };
type Msg = { id: string; at: string; from: string; role: "user" | "bot" | "system"; text: string; reactions?: Rx[] };
export type DemoChat = { id: string; name: string; kind: "group" | "direct"; team?: string; bot?: string; participants?: string[]; channel?: boolean; purpose?: string; pending?: boolean; messages: Msg[] };
type Chat = DemoChat;

const MIN = 60000, H = 60 * MIN, DAY = 24 * H;
// a script line: [minutes before now, speaker, role, text, reactions?]
type Line = [number, string, "user" | "bot", string, Rx[]?];
function chat(now: number, id: string, name: string, kind: "group" | "direct", extra: Partial<Chat>, lines: Line[]): Chat {
  return { id, name, kind, ...extra, messages: lines.map(([m, from, role, text, reactions], i) => ({ id: `${id}-${i}`, at: new Date(now - m * MIN).toISOString(), from, role, text, ...(reactions ? { reactions } : {}) })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
}

export function demoChats(now = Date.now()): Chat[] {
  const d = DAY / MIN, h = H / MIN;
  return [
    chat(now, "g-marketing", "Marketing", "group", { team: "marketing", participants: ["You", "Nova", "Echo", "Pixel", "Scout", "Mailer"] }, [
      [2 * d + 3 * h, "You", "user", "Kick-off for the launch: goal is 1,000 newsletter sign-ups by the end of the month. Nova, can you split the work?"],
      [2 * d + 3 * h - 4, "Nova", "bot", "On it. Plan:\n• Echo: 3 launch posts (LinkedIn, X, Instagram)\n• Pixel: hero banner in two versions\n• Scout: list of 20 communities to post in\n• Mailer: launch email, version A and B\nI'll report back every morning at 09:00.", [{ emoji: "👍", by: ["You"] }, { emoji: "🚀", by: ["Echo", "Pixel"] }]],
      [2 * d + 2 * h, "Echo", "bot", "First drafts of the 3 posts are in the shared folder. Tone is friendly, one call to action each."],
      [d + 5 * h, "You", "user", "Posts look good. Make the LinkedIn one shorter, max 4 lines."],
      [d + 5 * h - 6, "Echo", "bot", "Done, the LinkedIn post is now 4 lines. The other two are unchanged."],
      [d + 2 * h, "Pixel", "bot", "Uploaded 4 versions of the hero banner: 2 dark, 2 light. My pick is dark #2, it reads best on mobile."],
      [d + 2 * h - 10, "You", "user", "Agree, dark #2.", [{ emoji: "✅", by: ["Pixel"] }]],
      [9 * h, "Scout", "bot", "Found 6 relevant communities so far (2 subreddits, 3 Slack groups, 1 forum). Rules checked: all allow one launch post."],
      [6 * h, "Nova", "bot", "Morning summary: newsletter at 612/1000. Waiting on you for 3 items: launch email (B), next week's calendar, and the creator collaboration.", [{ emoji: "👀", by: ["You"] }]],
      [3 * h, "Mailer", "bot", "Launch email version B is ready: shorter subject line, single button. A/B test on 10% first, then the winner to everyone. Approve?"],
      [2 * h + 40, "You", "user", "What was the open rate on the last email?"],
      [2 * h + 38, "Mailer", "bot", "41% opens, 6.2% clicks on the last newsletter (sent to 1,180 people). Version B's shorter subject usually adds 3–5 points.", [{ emoji: "🔥", by: ["You", "Nova"] }]],
    ]),
    chat(now, "dm-nova", "Nova", "direct", { team: "marketing", bot: "Nova", participants: ["You", "Nova"] }, [
      [3 * d, "You", "user", "Nova, what's our budget for paid promotion this month?"],
      [3 * d - 2, "Nova", "bot", "€400 left of €600. I'd hold it until the launch email goes out, then boost the best-performing post."],
      [5 * h, "You", "user", "Can you prepare a one-page launch summary for Friday?"],
      [5 * h - 3, "Nova", "bot", "Yes. It will cover sign-ups vs goal, best post, email results and next steps. Draft by Thursday 16:00."],
    ]),
    chat(now, "g-product", "Product", "group", { team: "product", participants: ["You", "Atlas", "Forge", "Lens", "Draft"] }, [
      [d + 7 * h, "Atlas", "bot", "Release 2.4 status: Google sign-in merged, dark mode about 60%, settings docs in progress."],
      [d + 6 * h, "You", "user", "Is dark mode realistic for 2.4?"],
      [d + 6 * h - 5, "Atlas", "bot", "It needs 2 more days. Options: ship 2.4 on time without it, or slip 2.4 by 2 days. I've put it in your approvals."],
      [8 * h, "Lens", "bot", "Nightly tests: 42 of 45 passed. The 3 failures are all in the new sign-in flow, Forge is looking at it."],
      [5 * h, "Forge", "bot", "Fixed: the sign-in bug was a redirect URL mismatch. Lens, can you re-run?"],
      [4 * h + 30, "Lens", "bot", "Re-run done: 45 of 45 passed. ✓", [{ emoji: "🎉", by: ["Atlas", "Forge", "You"] }]],
    ]),
    chat(now, "dm-forge", "Forge", "direct", { team: "product", bot: "Forge", participants: ["You", "Forge"] }, [
      [2 * d, "You", "user", "Forge, how long would offline mode take?"],
      [2 * d - 4, "Forge", "bot", "Roughly 2 weeks for read-only offline (cache the last 7 days), 4+ weeks if edits must sync. I'd start read-only."],
    ]),
    chat(now, "g-sales", "Sales", "group", { team: "sales", participants: ["You", "Vega", "Hunter", "Pitch", "Closer"] }, [
      [2 * d + 4 * h, "Vega", "bot", "Pipeline: 18 open deals, 4 demos this week. The 25-seat deal needs a 15% discount to close this month."],
      [2 * d + 3 * h, "You", "user", "15% is fine if they sign annual."],
      [d + 8 * h, "Hunter", "bot", "Added 12 new leads from logistics companies (50–200 employees). All have a named ops manager."],
      [d + 3 * h, "Pitch", "bot", "Custom deck for tomorrow's demo is ready: 9 slides, their logo, two case studies from logistics."],
      [3 * h, "Closer", "bot", "Follow-up reminders are paused until the new post-demo email template is approved."],
    ]),
    chat(now, "g-support", "Support", "group", { team: "support", participants: ["You", "Harbor", "Relay", "Index"] }, [
      [d + 2 * h, "Harbor", "bot", "Yesterday: 23 tickets, 21 closed, average first reply 14 minutes. Satisfaction 4.7/5."],
      [6 * h, "Relay", "bot", "Closed 5 tickets this morning. One customer asks for a refund for an unused month, it's in your approvals."],
      [5 * h, "Index", "bot", "Wrote 4 new FAQ answers based on this week's most common questions. Ready to publish when you approve."],
      [4 * h, "You", "user", "Refund is OK, it's a long-time customer. Index, I'll look at the FAQ tonight.", [{ emoji: "👍", by: ["Harbor", "Relay"] }]],
    ]),
    chat(now, "g-research", "Research", "group", { team: "research", participants: ["You", "Orbit", "Probe", "Chart"] }, [
      [d + 4 * h, "Probe", "bot", "Finished 12 user interviews. Top themes: onboarding is too long, people want templates, export to PDF."],
      [7 * h, "Chart", "bot", "Comparison table of 5 competitors is done. We're the only one without templates; two charge extra for PDF export."],
      [3 * h, "Orbit", "bot", "Summary of the 12 interviews is ready to read. I've listed 8 possible improvements, please pick the top 3."],
    ]),
    chat(now, "g-finance", "Finance", "group", { team: "finance", participants: ["You", "Ledger", "Tally", "Forecast"] }, [
      [4 * d, "Tally", "bot", "This month's expense report: 14 invoices, 2 exceptions (a duplicate software charge and a missing receipt)."],
      [4 * d - 10, "Ledger", "bot", "Report is in your approvals. Nothing else is blocked."],
      [d, "Forecast", "bot", "Cash-flow forecast updated: runway unchanged at 19 months."],
    ]),
  ];
}
