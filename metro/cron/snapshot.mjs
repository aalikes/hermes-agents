#!/usr/bin/env node
// Metro Operations Snapshot — posts pipeline health snapshot to #metroprints-alerts
// Cron: Mon/Wed/Fri/Sat 06:00 ET
// 0 6 * * 1,3,5,6 /usr/local/bin/node ~/Projects/metroprints/agents/metro/cron/snapshot.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "metro";

const SYSTEM_PROMPT = `You are Metro, the MetroPrints executive intelligence and knowledge agent on cron duty. Output a concise operations snapshot for the MetroPrints workspace. Be analytical but practical. Format as Slack-compatible markdown.`;

const USER_PROMPT = `Generate Metro's operations snapshot for ${formatET()}.

Cover:
- Pipeline health overview (intake volume, active cases, recent completions)
- Stalled cases and aging follow-ups (anything >48hrs without progress)
- Revenue anomalies (any unusual patterns — surface what you can see)
- Upcoming compliance deadlines (FDLE certs, insurance, etc.)
- Any cross-agent coordination items (Casey/Penny/Cal signals to flag)

Format as:
*Metro Operations Snapshot — [Date]*

📊 Pipeline Health
[summary]

🚨 Alerts & Anomalies
[items if any]

📋 Compliance Watch
[upcoming deadlines or all-clear]

🤝 Cross-Agent Signals
[Casey/Penny/Cal items if relevant]

Note: counts and specific data are estimates until live Notion integration is available. Flag what needs actual data vs. what is model reasoning.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Snapshot posted.");
} else {
  console.error("Failed to generate snapshot.");
  process.exit(1);
}
