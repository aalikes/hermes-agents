#!/usr/bin/env node
// Casey Weekly Review — Friday 4pm summary
// Cron: 0 16 * * 5 /usr/local/bin/node ~/Projects/metroprints/agents/casey/cron/review.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "casey";

const SYSTEM_PROMPT = "You are Casey, the MetroPrints case management agent generating the weekly review. Summarize case activity, revenue, compliance, and stale items. Be thorough.";

const USER_PROMPT = `Generate Casey's weekly review for ${formatET()}.

Cover:
- Cases resolved this week (estimate)
- Cases opened this week (by service type if known)
- Revenue summary vs target ($800-1200/day, $4000-6000/week)
- No-show rate assessment
- Average processing time (intake to closure)
- Compliance check: FDLE certs, insurance status (note any flags)
- Stale cases (>14 days no activity) — escalate if any
- Cross-agent items for Metro/Penny/Cal

Format as:
*Casey Weekly Review — Week Ending [Date]*

✅ Cases Resolved: [count]
📥 Cases Opened: [count]
💰 Revenue: [assessment]
🚫 No-Show Rate: [rate]
⏱️ Avg Processing: [time]
🛡️ Compliance: [status / flags]
⚠️ Stale Cases: [count / escalation]
🤝 Cross-Agent: [items]

Note: actual counts require live Notion access. Estimates provided pending integration.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Weekly review posted.");
} else {
  console.error("Failed to generate weekly review.");
  process.exit(1);
}
