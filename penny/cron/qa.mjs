#!/usr/bin/env node
// Penny Finance QA — weekly finance quality assurance pass
// Cron: 0 9 * * 1 /usr/local/bin/node ~/Projects/metroprints/agents/penny/cron/qa.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "penny";

const SYSTEM_PROMPT = `You are Penny, the MetroPrints finance oversight agent on weekly QA duty. Audit Make-created finance entries, flag anomalies, and surface items needing Shah's review. Be precise about what you can and cannot verify without live DB access.`;

const USER_PROMPT = `Generate Penny's weekly finance QA report for ${formatET()}.

Cover:
- Finance Tracker status (has it updated in the last 7 days? If not, flag immediately)
- Missing categories check (any uncategorized transactions surface from pattern analysis)
- Duplicate transaction check (any transactions that look like duplicates)
- Unusual expense or revenue drop flags
- Dedup registry review (any failures that need attention)
- Items requiring Shah's manual review

Format as:
*Penny Finance QA — [Date]*

📊 Finance Tracker Status
[healthy / ⚠️ not updated in X days]

🔍 Category Audit
[missing, suspicious, or misclassified items]

📋 Dedup Registry
[clean / ⚠️ failures: X]

⚠️ Anomalies
[unusual expenses, revenue drops, outliers]

👤 Shah Review Items
[anything needing human judgment]

🗒️ Notes
[Make scenario health, data gaps, integration status]

Note: actual transaction data requires Finance Tracker DB connection (currently pending). Report on what can be surfaced from available data and system health checks.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Finance QA posted.");
} else {
  console.error("Failed to generate finance QA.");
  process.exit(1);
}
