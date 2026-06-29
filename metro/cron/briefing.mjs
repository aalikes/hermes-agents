#!/usr/bin/env node
// Metro Strategic Briefing — bi-weekly Monday briefing (revenue, pipeline, priorities)
// Cron: 0 6 * * 1 (every Monday) — listener auto-skips odd weeks
// 0 6 * * 1 /usr/local/bin/node ~/Projects/metroprints/agents/metro/cron/briefing.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "metro";

// Bi-weekly check: only run on even weeks (week 2, 4, etc. of the month)
function isBiweeklyWeek() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const dayOfMonth = now.getDate();
  const weekOfMonth = Math.ceil((dayOfMonth + startOfMonth.getDay()) / 7);
  return weekOfMonth % 2 === 0;
}

if (!isBiweeklyWeek()) {
  console.log("Skipping — not a bi-weekly briefing week.");
  process.exit(0);
}

const SYSTEM_PROMPT = `You are Metro, the MetroPrints executive intelligence agent generating a strategic briefing. This is the bi-weekly high-altitude view for Shah. Be strategic, forward-looking, and actionable. Format as Slack-compatible markdown.`;

const USER_PROMPT = `Generate Metro's bi-weekly strategic briefing for ${formatET()}.

Cover:
- Revenue overview (2-week trend, notable changes, forecast)
- Pipeline health (intake velocity, conversion rate, pipeline depth — estimate what you can)
- Compliance & risk (any upcoming deadlines, regulatory changes, exposure areas)
- Strategic priorities for the next 2 weeks (what Metro, Casey, Penny, and Cal should focus on)
- Open decisions Shah needs to make (anything blocked, anything needing direction)
- Intern workload summary (capacity, assignments, any concerns)

Format as:
*Metro Strategic Briefing — [Date Range]*

📈 Revenue & Pipeline
[2-week overview]

🛡️ Compliance & Risk
[deadlines, exposure, all-clear if applicable]

🎯 Next-2-Week Priorities
[by agent: Metro/Casey/Penny/Cal]

⚡ Decisions Needed
[Shah action items]

👥 Intern Status
[workload, assignments, flags]

Note: data estimates until live integrations are connected. Flag what needs Shah's actual input vs. model synthesis.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Briefing posted.");
} else {
  console.error("Failed to generate briefing.");
  process.exit(1);
}
