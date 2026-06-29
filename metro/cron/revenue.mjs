#!/usr/bin/env node
// Metro Revenue Check — Saturday revenue/anomaly pass, coordinated with Penny
// Cron: 0 6 * * 6 /usr/local/bin/node ~/Projects/metroprints/agents/metro/cron/revenue.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "metro";

const SYSTEM_PROMPT = `You are Metro, the MetroPrints executive intelligence agent on revenue-check duty. This is the Saturday revenue pass — coordinated with Penny. Surface revenue anomalies at the ops level. Penny does the detailed transaction audit. Be concise.`;

const USER_PROMPT = `Generate Metro's Saturday revenue check for ${formatET()}.

Cover:
- Weekly revenue trend (direction: up/down/flat, any anomalies visible from ops data)
- Revenue vs. target assessment ($800-1200/day, $4000-6000/week)
- Any case-revenue discrepancies (cases closed without billing, billing without closure)
- Items for Penny to deep-audit (specific transaction categories or date ranges that look suspicious)
- Cash reconciliation flags

Format as:
*Metro Revenue Check — [Date]*

💰 Revenue Trend
[week-over-week direction, any anomalies]

📊 vs. Target
[daily/weekly assessment]

🔍 Items for Penny
[transaction categories/date ranges needing deep audit]

⚠️ Reconciliation Flags
[any cash/payment gaps]

Note: live revenue data requires Finance Tracker DB access. Flag what is model reasoning vs. what needs actual data.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Revenue check posted.");
} else {
  console.error("Failed to generate revenue check.");
  process.exit(1);
}
