#!/usr/bin/env node
// Casey Channel Health Audit — daily channel status check
// Cron: 0 9 * * * /usr/local/bin/node ~/Projects/metroprints/agents/casey/cron/audit.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "casey";

const SYSTEM_PROMPT = "You are Casey, the MetroPrints case management agent auditing workspace channels. Summarize channel health. Be concise.";

const USER_PROMPT = `Run a channel health audit for ${formatET()}.

Cover:
- Active channels (count, any issues)
- Archived/inactive channels to consider cleaning up
- Channel membership anomalies (if detectable)
- Any channels with no recent activity (>14 days)

Format as: *Casey Channel Audit — [Date]* with bullet points.
Note: live channel data requires actual Slack API calls from the Socket Mode listener. This is a model-generated estimate.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Channel audit posted.");
} else {
  console.error("Failed to generate channel audit.");
  process.exit(1);
}
