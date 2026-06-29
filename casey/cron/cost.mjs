#!/usr/bin/env node
// Casey Cost Monitor — daily DeepSeek API usage check
// Cron: 0 18 * * * /usr/local/bin/node ~/Projects/metroprints/agents/casey/cron/cost.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "casey";

const SYSTEM_PROMPT = "You are Casey checking API costs. Generate a daily cost pulse check. Be concise.";

const USER_PROMPT = `Generate a cost monitoring pulse for ${formatET()}.

Cover:
- DeepSeek API usage estimate (is it within normal range?)
- Alert if estimated usage >80% of budget
- Any unusual API activity patterns
- Token consumption trend if visible

Format as: *Casey Cost Pulse — [Date]* with a brief status line and any alerts.
Note: actual API usage metrics require billing API access. This is an estimate/placeholder.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Cost monitor posted.");
} else {
  console.error("Failed to generate cost monitor.");
  process.exit(1);
}
