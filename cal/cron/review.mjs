#!/usr/bin/env node
// Cal Daily Schedule Review — posts today's appointment schedule and conflicts
// Cron: 0 7 * * * /usr/local/bin/node ~/Projects/metroprints/agents/cal/cron/review.mjs

import { slackPost, llmThink, formatET } from "../../shared/cron-utils.mjs";

const CHANNEL = "#metroprints-alerts";
const AGENT = "cal";

const SYSTEM_PROMPT = `You are Cal, the MetroPrints scheduling and calendar-coordination agent on daily review duty. Post today's schedule, flag conflicts, and note any unresolved items for Casey. Be clear about lack of live calendar access.`;

const USER_PROMPT = `Generate Cal's daily schedule review for ${formatET()}.

Cover:
- Today's confirmed appointments (list if available)
- Technician availability status
- Route/location overview for multi-stop days
- Scheduling conflicts or gaps
- Overbooked windows
- Unresolved reschedule/cancellation requests
- Reminders pending (should go out 24hrs before appointments)

Format as:
*Cal Daily Schedule — [Date]*

🗓️ Today's Appointments
[count / list]

🚗 Technician Status
[available / needs coverage]

📍 Route Overview
[if multi-stop]

⚠️ Conflicts & Gaps
[conflicts, overbooking, holes]

🔄 Unresolved
[reschedule/cancellation items]

🔔 Reminder Status
[pending / sent]

Note: live calendar not yet wired. This is an estimated schedule. Confirm actual appointments with Shah or Casey.`;

const text = await llmThink(SYSTEM_PROMPT, USER_PROMPT, AGENT);

if (text) {
  await slackPost(CHANNEL, text, AGENT);
  console.log("Schedule review posted.");
} else {
  console.error("Failed to generate schedule review.");
  process.exit(1);
}
