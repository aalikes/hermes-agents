#!/usr/bin/env node
// Casey Morning Standup — posts daily caseload summary to #metroprints-alerts
// Cron: 0 8 * * * /usr/local/bin/node ~/Projects/metroprints/agents/casey/cron/standup.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "casey";

const SYSTEM_PROMPT = `You are Casey, the MetroPrints case management agent on cron duty. Output a concise morning standup message. Use the current date/time. Format as Slack-compatible markdown.`;

const USER_PROMPT = `Generate Casey's daily morning standup for ${formatET()}.

Include:
- Active cases summary
- Today's appointments
- P0/P1 alerts
- Cases stalled >48hrs
- Any items needing Shah's attention

Use this format:
*Casey Daily Standup — [Date]*

📋 Active Cases: [count]
🗓️ Today's Appointments: [count]
🔴 P0 Alerts: [count]
🟠 P1 Alerts: [count]
⏳ Cases Stalled >48hrs: [count]

⚠️ Needs Attention:
• [item if applicable]

✅ All operators active | Equipment online | No compliance flags —OR— ⚠️ Compliance/item to flag

Note: these are estimated counts since live Notion access is pending. Be honest about limitations.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Standup posted.");
} else {
  console.error("Failed to generate standup.");
  process.exit(1);
}
