import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveSpawns } from "../shared/subagent.mjs";

const XAPP = process.env.SLACK_XAPP_TOKEN || "";
const XOXB = process.env.SLACK_XOXB_TOKEN || "";
const SLACK_API = "https://slack.com/api";
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";

// Deduplication: track recently handled events to avoid double-processing
// app_mention + message events both fire for @mentions in channels
const recentEvents = new Set();
function isDuplicate(channel, user, ts) {
  const key = `${channel}:${user}:${ts}`;
  if (recentEvents.has(key)) return true;
  recentEvents.add(key);
  setTimeout(() => recentEvents.delete(key), 5000);
  return false;
}

// Active threads Casey is participating in (thread_ts → last activity timestamp)
// Messages in these threads don't need @mention — Casey is already in the conversation
const activeThreads = new Map();
function trackThread(threadTs, channel) {
  if (!threadTs) return;
  activeThreads.set(threadTs, Date.now());
  // Auto-expire after 30 minutes of inactivity
  setTimeout(() => {
    const last = activeThreads.get(threadTs);
    if (last && Date.now() - last >= 30 * 60 * 1000) activeThreads.delete(threadTs);
  }, 30 * 60 * 1000);
}
function isActiveThread(event) {
  const threadTs = event.thread_ts || event.ts;
  if (activeThreads.has(threadTs)) {
    activeThreads.set(threadTs, Date.now()); // extend activity
    return true;
  }
  // Also check if any tracked thread is a prefix of the event's thread_ts
  // (Slack sometimes uses slightly different ts formats)
  for (const [key] of activeThreads) {
    if (threadTs.startsWith(key) || key.startsWith(threadTs)) {
      activeThreads.set(key, Date.now());
      return true;
    }
  }
  return false;
}

async function slack(method, body, token = XOXB) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getWebSocketUrl() {
  const res = await slack("apps.connections.open", {}, XAPP);
  if (!res.ok) throw new Error(`apps.connections.open failed: ${res.error}`);
  return res.url;
}

function isMentioned(text) {
  // app_mention strips the bot ID, but message events keep the <@U...> format
  if (text.includes(`<@${BOT_USER_ID}>`)) return true;
  return false;
}

function cleanText(text) {
  return text.replace(new RegExp(`<@${BOT_USER_ID}>\\s*`, "g"), "").trim();
}

async function connect() {
  const url = await getWebSocketUrl();
  console.log(`[casey] Connecting to Slack Socket Mode...`);
  const ws = new WebSocket(url);
  let pingInterval;

  ws.onopen = () => {
    console.log("[casey] Connected. Listening.");
    pingInterval = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "hello") {
        console.log(`[casey] Hello, connections: ${msg.num_connections}`);
        return;
      }

      if (msg.type === "disconnect") {
        console.log(`[casey] Disconnect: ${msg.reason}. Reconnecting...`);
        clearInterval(pingInterval);
        ws.close();
        setTimeout(connect, 1000);
        return;
      }

      // Slash commands — top-level envelope, type is "slash_commands" (plural), never nested in events_api
      if (msg.type === "slash_commands" && msg.payload) {
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id, type: "ack" }));
        const p = msg.payload;
        await handleCommand(p.command, p.channel_id, p.user_id, p.text, p.response_url);
        return;
      }

      if (msg.type === "events_api" && msg.payload?.event) {
        const evt = msg.payload.event;

        // Ack within 3 seconds
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id, type: "ack" }));

        // Skip own messages and bot messages
        if (evt.user === BOT_USER_ID) return;
        if (evt.subtype === "message_changed" || evt.subtype === "message_deleted") return;

        const text = evt.text || "";

        // Respond to any message in a thread Casey is already participating in
        // No @mention needed — she's in the conversation
        if (evt.type === "message" && isActiveThread(evt) && text.trim()) {
          console.log(`[casey] THREAD: ${evt.channel} thread_ts=${evt.thread_ts || evt.ts} user=${evt.user} text="${text.substring(0, 60)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        // Debug: log when a message has thread_ts but isn't active thread
        if (evt.type === "message" && evt.thread_ts && !isMentioned(text) && text.trim()) {
          console.log(`[casey] MSG_IN_THREAD (not active): ${evt.channel} thread_ts=${evt.thread_ts} user=${evt.user}`);
        }

        // Handle app_mention event
        if (evt.type === "app_mention") {
          if (isDuplicate(evt.channel, evt.user, evt.ts)) return;
          console.log(`[casey] MENTION (app_mention): ${evt.channel} user=${evt.user} text="${text.substring(0, 80)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        // Handle message event with @Casey mention
        if (evt.type === "message" && isMentioned(text)) {
          if (isDuplicate(evt.channel, evt.user, evt.ts)) return;
          console.log(`[casey] MENTION (message): ${evt.channel} user=${evt.user} text="${text.substring(0, 80)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        // Log other events for debugging
        const subtype = evt.subtype || "";
        console.log(`[casey] ${evt.type}${subtype ? "/" + subtype : ""} channel=${evt.channel} user=${evt.user}`);
      }
    } catch (e) {
      console.error("[casey] Error:", e.message);
    }
  };

  ws.onerror = (err) => console.error("[casey] WS error:", err.message || err);
  
  ws.onclose = (event) => {
    console.log(`[casey] Closed (${event.code}). Reconnect in 5s...`);
    clearInterval(pingInterval);
    setTimeout(connect, 5000);
  };
}

// ── Obsidian Knowledge ──────────────────────────────

const OBSIDIAN_VAULT = "/Users/shahsaint-cyr/Library/Mobile Documents/iCloud~md~obsidian/Documents/Skills";
const KNOWLEDGE_FILES = [
  "MetroPrints Agentic Centre.md",
  "Skills/Metroprints/playbooks/hermes-agent-sop.md",
  "Skills/Metroprints/operations/casey-case-management.md",
  "Skills/Metroprints/operations/casey-task-register.md",
  "Skills/Metroprints/operations/casey-fbi-printdeck.md",
  "Skills/Metroprints/agents/casey-agent-def.md",
  "Skills/Metroprints/playbooks/slack-agent-runbook.md",
];

let loadedKnowledge = "";

function loadKnowledge() {
  const parts = [];
  for (const file of KNOWLEDGE_FILES) {
    const path = join(OBSIDIAN_VAULT, file);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        parts.push(`### ${file.replace(".md", "")}\n${content.substring(0, 3000)}`);
        console.log(`[casey] Loaded knowledge: ${file}`);
      } catch (e) {
        console.error(`[casey] Failed to read ${file}:`, e.message);
      }
    }
  }
  loadedKnowledge = parts.join("\n\n---\n\n");
  return loadedKnowledge;
}

function buildSystemPrompt() {
  return `${BASE_SYSTEM_PROMPT}

## Obsidian Knowledge (live from vault)
${loadedKnowledge || "(no knowledge loaded — run /casey-learn to refresh)"}`;
}

// ── Notion Integration ───────────────────────────────

const NOTION_KEY = process.env.NOTION_API_KEY || "";
const NOTION_VERSION = "2022-06-28";

// Known databases
const NOTION_DBS = {
  activities: "27189d07-dc61-8122-acde-f2cffd",
  planning: "27189d07-dc61-8168-9182-ef0386dbd9e7",
  ori: "731bd0e1-0c8f-4db5-8fc5-4086e9cba134",
  projects: "27189d07-dc61-8140-abb6-d35934cf48a7",
  marketplace: "9bd3910c-6dc2-4bb7-81be-8af80b2a3e74",
};

async function notion(method, path, body = null) {
  if (!NOTION_KEY) return { error: "No Notion API key" };
  const opts = {
    method,
    headers: { "Authorization": `Bearer ${NOTION_KEY}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.notion.com/v1${path}`, opts);
  return res.json();
}

async function notionSearch(query) {
  return notion("POST", "/search", { query, page_size: 10 });
}

async function notionQueryDB(dbId, filter = {}) {
  return notion("POST", `/databases/${dbId}/query`, { page_size: 20, sorts: [{ timestamp: "last_edited_time", direction: "descending" }], ...(Object.keys(filter).length ? { filter } : {}) });
}

// ── Website Monitor ──────────────────────────────────

const MP_WEBSITE = process.env.METROPRINTS_WEBSITE || "https://metroprints.co";

async function checkWebsite() {
  try {
    const start = Date.now();
    const res = await fetch(MP_WEBSITE, { redirect: "follow" });
    const ms = Date.now() - start;
    if (res.ok) return { up: true, status: res.status, latency_ms: ms };
    return { up: false, status: res.status, latency_ms: ms };
  } catch (e) {
    return { up: false, error: e.message };
  }
}

// ── Email Check (Gmail IMAP via imapflow) ─────────────

const EMAIL_USER = process.env.METROPRINTS_EMAIL || "";
const EMAIL_PASS = process.env.METROPRINTS_EMAIL_PASS || "";
const EMAIL_ACTIVE = !!(EMAIL_USER && EMAIL_PASS);

// Gmail IMAP uses OAuth2 or App Password (not account password).
// Generate App Password at: https://myaccount.google.com/apppasswords
// Casey uses this to scan for FBI Email #2 confirmations and order confirmations.

let imapClient = null;

async function getImapClient() {
  if (!EMAIL_ACTIVE) return null;
  if (imapClient) return imapClient;

  try {
    const { ImapFlow } = await import("imapflow");
    imapClient = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      logger: false,
    });
    await imapClient.connect();
    console.log("[casey] IMAP connected");
    return imapClient;
  } catch (e) {
    console.error("[casey] IMAP connection failed:", e.message);
    imapClient = null;
    return null;
  }
}

async function checkRecentEmails(subjectFilter = "FBI", maxResults = 5) {
  if (!EMAIL_ACTIVE) {
    console.log("[casey] Email monitoring skipped — no credentials");
    return { ok: false, error: "no_credentials", results: [] };
  }

  const client = await getImapClient();
  if (!client) {
    return { ok: false, error: "imap_connection_failed", results: [], note: "Set METROPRINTS_EMAIL and METROPRINTS_EMAIL_PASS env vars with a Gmail App Password" };
  }

  try {
    await client.mailboxOpen("INBOX");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24 hours
    const messages = [];

    for await (const msg of client.fetch(
      { seen: false },
      { source: true, envelope: true, bodyStructure: true }
    )) {
      if (messages.length >= maxResults) break;
      const subject = msg.envelope?.subject || "";
      if (subject.toLowerCase().includes(subjectFilter.toLowerCase())) {
        messages.push({
          uid: msg.uid,
          subject,
          from: msg.envelope?.from?.[0]?.address || "unknown",
          date: msg.envelope?.date || new Date(),
          snippet: msg.source?.toString().substring(0, 200) || "",
        });
      }
    }

    return { ok: true, results: messages };
  } catch (e) {
    console.error("[casey] IMAP fetch error:", e.message);
    return { ok: false, error: e.message, results: [] };
  }
}

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

// ── Base System Prompt ──────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Casey, the MetroPrints case management agent. You run cron jobs, spawn sub-agents for complex tasks, and monitor external services.

## Identity
- MetroPrints is a mobile live scan fingerprinting and apostille services business in South Florida.
- Website: https://metroprints.co
- You manage the MetroPrints Slack workspace and all case management operations.
- You respond concisely and helpfully. Be direct. No fluff.

## What You Do (NOT what you create)
- YOU RUN CRON JOBS: scheduled tasks — morning standups, case sweeps, compliance checks. These auto-fire on timers.
- YOU SPAWN SUB-AGENTS: when a task requires parallel decomposition, use the spawn syntax. Do NOT create Slack bots; delegate to agents.
- SPAWN SYNTAX: [SPAWN:short-role-name]detailed-task-description[/SPAWN]. Spawned sub-agents run in parallel and their results replace the marker. Use multiple spawn blocks for swarm orchestration. Sub-agents are ephemeral — they run one task and terminate.
- YOU MONITOR COMPLIANCE: FDLE certification status, operator background checks, insurance policy expirations, equipment calibration.
- YOU MANAGE CASES: track every client from intake through fingerprinting, background check, apostille, to closure.
- YOU POST ALERTS: P0/P1 to #metroprints-critical, P2/P3 to #metroprints-alerts.
- YOU REPORT: daily standups, weekly reviews, compliance status.
- REVENUE & FINANCE are handled by Penny, the finance oversight agent. Do NOT monitor Square/Stripe, revenue targets, or transactions. Coordinate with Penny when a case reaches a billable state.

## What You DO NOT Do
- Do NOT monitor revenue, payments, or financial data — Penny handles finance.
- Do NOT create Slack bots or Slack apps. You are the agent, not a bot factory.
- Do NOT claim you "can't" do something. Spawn a sub-agent or escalate to Shah.
- Do NOT give generic intros. Execute tasks or explain what cron job will handle it.

## Agent Coordination
- **Penny** (finance oversight): Revenue monitoring, Square/Stripe audit, expense classification, anomaly detection, dedup registry. Casey alerts Penny when a case reaches billable state (completed fingerprint/background check).
- **Metro** (operations assistant): Client appointment tracking, follow-ups, operational pipeline.

## Workspace Knowledge
- #metroprints-critical (private, C0BD7AR750F): P0/P1 alerts — members: Shah (owner), Casey
- #metroprints-alerts (private, C0BDKCYUEQM): P2/P3 alerts and status updates — entire MetroPrints team
- #all-metroprints: General announcements channel
- #social: Team fun/random
- Users: Shah Saint-Cyr (owner/admin), Casey (case management), Metro (operations), Penny (finance — planned), casey-x (legacy)

## Cron Jobs You Run
- 8 AM: Morning standup — scan critical alerts, list today's appointments, flag stale cases
- 9 AM: Stale case sweep — flag all cases with >48 hrs no progress
- 12 PM: Midday check — any unresolved P0/P1?
- 4 PM: End-of-day summary — appointments completed, cases closed
- Fri 4 PM: Weekly review — case summaries, compliance check (FDLE certs, insurance, equipment)
- Every 6 hrs: Health check — verify Casey alive, Socket Mode connected, API keys valid

## Case Lifecycle
1. Intake → document verification, service type confirmation
2. Fingerprinting → appointment scheduling, reminders, operator/equipment checks
3. Background Check → FDLE submission, timeline tracking, rejection handling
4. Apostille → document prep, SoS submission, delivery
5. Closure → inform Penny of billable state, satisfaction survey, archival

## Alert Thresholds
- P0 (Critical, <1 hr): FDLE cert expired, insurance lapsed, data breach, equipment failure
- P1 (Urgent, by EOD): Cert expiring <60 days, quality failure >10%, client unreachable, background check stalled >10 days
- P2 (Standard, 3-5 days): Low availability, high no-show, client inactive >30 days, apostille processing >7 days
- P3 (FYI, weekly): Compliance audit due, training backlog, engagement metrics

## External Services to Monitor
- FDLE Portal: operator certification status, renewal deadlines
- Insurance Provider: policy expiration dates
- Notion MP Planning DB (27189d07-dc61-8168-9182-ef0386dbd9e7): case tracking, alert board
- (Revenue/payment data belongs to Penny — Notion Financial Tracker, Square/Stripe)

## FBI PrintDeck Workflow (Phase 2.5)
When handling FBI cases, Casey manages the FBI PrintDeck sub-workflow between fingerprinting and background check:
- Step 1: Intake — Check 2 forms of ID, confirm client type (EDO vs Dept Order), capture fingerprints, submit FBI request using shah@metroprints.co, process payment
- Step 2: Wait for FBI Email #2 confirmation in the technician inbox
- Step 3: After Email #2 arrives — Open MP Activities FBI case, create/confirm Google Drive folder, save confirmation email, extract Order# / PIN / Tokenised Link, export fingerprint file
- Step 4: File conversion chain — ENC → EFT → PDF (PrintDeck handles EFT→PDF; ENC→EFT is manual via capture system)
- Step 5: Save PDF to client Google Drive folder, log filename + timestamp
- Step 6: Print packet — confirmation email (1 page) + fingerprint cards (2 cards), crop if needed
- Step 7: Mail to: FBI CJIS Division, ATTN: ELECTRONIC SUMMARY REQUEST, 1000 Custer Hollow Road, Clarksburg, WV 26306
- Step 8: Notion tracking — log ALL dates: EFT export, PDF generated, Drive folder link, Email #2 received, mailed date, tracking #, expected delivery, follow-up date
- Library printers: Country Walk ID 106246, Culmer/Overtown ID 106247
- Current manual steps: 23. Near-term automation target: 17. Custom app target: 12.
- Casey monitors the pipeline, posts reminders for manual steps, and escalates stalled cases (>48 hrs at any conversion step). Do NOT claim to run conversion software — those are manual/Make steps.

## Sub-Agent Spawning
When a task requires heavy computation, external API access, or parallel processing:
- Say "Let me spawn an agent for that" (not "I can't")
- Use the MCP tools or command interface to delegate
- Sub-agents handle: complex audits, data aggregation, multi-source monitoring
- You coordinate results and report back to Shah

## Response Style
- Execute or delegate — never just explain
- Reference your cron schedule when applicable: "My 8 AM standup will catch that"
- If you need external access you don't have, specify exactly what key/scope is needed
- Be conversational but professional`;

async function think(messages) {
  if (!DEEPSEEK_KEY) return null;
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DEEPSEEK_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });
    const j = await res.json();
    if (j.error) { console.error("[casey] LLM error:", JSON.stringify(j.error)); return null; }
    return j.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[casey] LLM error:", e.message);
    return null;
  }
}

async function fetchContext(channel, thread, count = 40) {
  try {
    const params = { channel, limit: count };
    if (thread) params.ts = thread;
    const res = await slack("conversations.replies", params);
    if (!res.ok || !res.messages) return [];
    return res.messages
      .filter((m) => m.text)
      .map((m) => {
        let text = m.text;
        text = text.replace(/<@U0BD79D3ZHD>/g, "@Casey");
        text = text.replace(/<@U0BDF2P4SHL>/g, "@Metro");
        text = text.replace(/<@U0BDN98CLAW>/g, "@casey-x");
        text = text.replace(/<@U0BBZJ7KASK>/g, "@Shah");
        text = text.replace(/<@U0BCBLPAJG5>/g, "@Shah");
        text = text.replace(/<!channel>/g, "@channel");
        text = text.replace(/<([^>|]+)\|[^>]+>/g, "$1");
        text = text.replace(/<([^>]+)>/g, "$1");
        const role = m.user === BOT_USER_ID ? "assistant" : "user";
        return { role, content: text };
      });
  } catch {
    return [];
  }
}

// ── Context Folding ──────────────────────────────────

// Summarize oldest messages to stay under token limits
// 60% summarized, 40% kept verbatim — folds at ~15K tokens
async function foldContext(messages) {
  const estimateTokens = (arr) => arr.reduce((sum, m) => sum + Math.ceil((m.content?.length || 0) / 4), 0);
  const total = estimateTokens(messages);
  if (total < 15000) return messages;

  const split = Math.floor(messages.length * 0.6);
  if (split < 4) return messages;

  const toSummarize = messages.slice(0, split);
  const recent = messages.slice(split);

  try {
    const summary = await think([
      { role: "system", content: "Summarize this conversation in 2-3 sentences. Preserve: names, case details, decisions, action items." },
      { role: "user", content: toSummarize.map(m => `[${m.role}]: ${m.content}`).join("\n") },
    ]);
    if (summary) {
      console.log(`[casey] Context folded: ${toSummarize.length} msgs → summary (${estimateTokens(toSummarize)} → ~${Math.ceil(summary.length / 4)} tokens)`);
      return [{ role: "system", content: `[Earlier conversation: ${summary}]` }, ...recent];
    }
  } catch (e) {
    console.error("[casey] Context fold failed:", e.message);
  }
  return messages;
}

// ── Handle ───────────────────────────────────────────

async function handle(channel, user, text, thread) {
  try {
    let userName = "there";
    try {
      const u = await slack("users.info", { user });
      if (u.ok && u.user?.real_name) {
        userName = u.user.real_name;
      } else {
        console.log(`[casey] users.info failed for ${user}: ${JSON.stringify(u.error || u)}`);
      }
    } catch (e) {
      console.error(`[casey] users.info error for ${user}:`, e.message);
    }

    console.log(`[casey] Handling "${text.substring(0, 60)}" from ${userName}`);

    // Build conversation context
    const history = await fetchContext(channel, thread);
    const prior = history.filter(m => m.content && m.content.trim()).slice(0, -1);
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...prior,
      { role: "user", content: `[${userName}]: ${text}` },
    ];

    // Auto-fold: summarize oldest messages when context exceeds ~15K tokens
    const folded = await foldContext(messages);

    let reply;
    const llmReply = await think(folded);
    if (llmReply) {
      // Resolve sub-agent spawn markers: [SPAWN:role]prompt[/SPAWN]
      const resolved = await resolveSpawns(llmReply, {
        apiKey: process.env.DEEPSEEK_API_KEY,
        parentAgent: "Casey",
      });
      reply = resolved.text;
      console.log(`[casey] LLM reply for ${userName}${resolved.spawned ? ` (${resolved.spawned} sub-agents spawned)` : ""}`);
    } else {
      // Fallback if LLM unavailable
      reply = `Hey ${userName.split(" ")[0]}! I'm Casey, the MetroPrints workspace admin. I can help with workspace audits, alerts, channels, and service checks. What do you need?`;
      console.log(`[casey] Fallback reply (no LLM)`);
    }

    await slack("chat.postMessage", {
      channel,
      text: reply,
      thread_ts: thread,
      unfurl_links: false,
      unfurl_media: false,
    });
    trackThread(thread, channel);
    console.log(`[casey] Replied in ${channel} | tracked thread=${thread}`);
  } catch (e) {
    console.error("[casey] handle error:", e.message);
    try {
      await slack("chat.postMessage", {
        channel,
        text: "Sorry, something went wrong. Try again?",
        thread_ts: thread,
        unfurl_links: false,
        unfurl_media: false,
      });
      trackThread(thread, channel);
    } catch {}
  }
}

// ── Slash Commands ──────────────────────────────────

async function handleCommand(command, channel, user, text, responseUrl) {
  try {
    console.log(`[casey] COMMAND /${command} from ${user}: "${text}"`);

    let userName = "there";
    try {
      const u = await slack("users.info", { user });
      if (u.ok && u.user?.real_name) userName = u.user.real_name;
    } catch (e) {
      console.error(`[casey] users.info error:`, e.message);
    }

    // Send "thinking" message first
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: "One moment..." }),
    });

    let finalText;

    switch (command) {
      case "/casey-audit":
        finalText = await runAudit();
        break;
      case "/casey-channels":
        finalText = await listChannels();
        break;
      case "/casey-members":
        finalText = await listMembers();
        break;
      case "/casey-status":
        finalText = await workspaceStatus();
        break;
      case "/casey-alert":
        finalText = await postAlert(text, userName);
        break;
      case "/casey-recall":
        finalText = await recallThread(channel, text);
        break;
      case "/casey-help":
        finalText = showHelp();
        break;
      case "/casey-learn":
        const learned = loadKnowledge();
        finalText = learned ? `Loaded knowledge from Obsidian:\n${KNOWLEDGE_FILES.map(f => `• ${f}`).join("\n")}` : "No Obsidian knowledge files found.";
        break;
      case "/casey-fbi-status":
        finalText = showFbiStatus(text);
        break;
      case "/casey-fbi-stale":
        finalText = "FBI stale case sweep — scan for cases stalled >48 hrs at ENC/EFT/PDF step. (Full cron integration pending Notion API.)\nKnown FBI cases should be checked manually:\n• Orders with Email #2 received but no conversion logged\n• PDFs generated but not mailed\n• Mailed but no tracking # logged\n• Follow-up dates past due";
        break;
      case "/casey-fbi-dispatch":
        finalText = "FBI Daily Dispatch:\n\n📋 Check for:\n1. New Email #2 confirmations in shah@metroprints.co inbox\n2. Cases waiting on ENC→EFT conversion\n3. PDFs ready for printing\n4. Packets ready for mailing\n5. Follow-ups due today\n\nUse `/casey fbi-status [Order#]` to check individual cases.";
        break;
      case "/casey-website":
        finalText = await checkWebsiteStatus();
        break;
      case "/casey-cases":
        finalText = await listRecentCases();
        break;
      case "/casey-fbi-intake":
        finalText = `FBI Case Intake initiated.\n\nChecklist:\n✅ 2 forms of ID\n✅ Client type: EDO or Dept Order\n✅ Fingerprints captured\n✅ FBI request submitted (shah@metroprints.co)\n✅ Notion case confirmed (Name/Email/Phone correct)\n✅ Payment processed\n⏳ Waiting for FBI Email #2\n\nUse \`/casey fbi-email2 [Order#]\` when confirmation arrives.\n\nAdditional context: ${text || "(none provided)"}`;
        break;
      default:
        // /casey — LLM-powered general query
        const messages = [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: `[${userName} invoked /casey${text ? ` with: "${text}"` : ""}]: Respond helpfully and concisely.` },
        ];
        finalText = await think(messages) || `Hey ${userName.split(" ")[0]}! How can I help? Try /casey-help for commands.`;
    }

    // Respond via response_url
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: finalText || "Done.", replace_original: true, response_type: "in_channel" }),
    });
    console.log(`[casey] Command /${command} completed for ${userName}`);
  } catch (e) {
    console.error("[casey] handleCommand error:", e.message);
    try {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Sorry, something went wrong.", replace_original: true }),
      });
    } catch {}
  }
}

// ── Command Implementations ─────────────────────────

async function runAudit() {
  try {
    const [chList, usrList, ugList] = await Promise.all([
      slack("conversations.list", { types: "public_channel,private_channel", limit: 200 }),
      slack("users.list", { limit: 100 }),
      slack("usergroups.list", { include_users: true, include_count: true }),
    ]);

    const channels = (chList.channels || []).map(c => {
      const type = c.is_private ? "🔒" : "#";
      const archived = c.is_archived ? " [ARCHIVED]" : "";
      return `${type} ${c.name} — ${c.num_members || 0} members${archived}`;
    }).join("\n");

    const humans = (usrList.members || []).filter(u => !u.is_bot && u.id !== "USLACKBOT" && !u.deleted).length;
    const bots = (usrList.members || []).filter(u => u.is_bot && u.id !== "USLACKBOT").length;
    const groups = (ugList.usergroups || []).map(g => `  @${g.handle} — ${g.user_count || 0} users`).join("\n") || "  None";

    return `*MetroPrints Workspace Audit*\n\n*Channels (${(chList.channels || []).length}):*\n${channels}\n\n*Members:* ${humans} humans, ${bots} bots\n\n*User Groups:*\n${groups}`;
  } catch (e) {
    return `Audit failed: ${e.message}`;
  }
}

async function listChannels() {
  const chList = await slack("conversations.list", { types: "public_channel,private_channel", limit: 200 });
  const channels = (chList.channels || [])
    .sort((a, b) => (b.num_members || 0) - (a.num_members || 0))
    .map(c => {
      const type = c.is_private ? "🔒" : "#";
      const archived = c.is_archived ? " [ARCHIVED]" : "";
      const purpose = c.purpose?.value ? ` — _${c.purpose.value.substring(0, 60)}_` : "";
      return `${type} *${c.name}* (${c.num_members || 0})${archived}${purpose}`;
    }).join("\n");
  return `*Channels (${(chList.channels || []).length}):*\n${channels}`;
}

async function listMembers() {
  const usrList = await slack("users.list", { limit: 100 });
  const members = (usrList.members || [])
    .filter(u => !u.deleted && u.id !== "USLACKBOT")
    .map(u => {
      const name = u.real_name || u.name || "Unknown";
      const role = u.is_owner ? "Owner" : u.is_admin ? "Admin" : u.is_bot ? "Bot" : "Member";
      const emoji = u.is_bot ? "🤖" : "👤";
      return `${emoji} *${name}* — ${role}`;
    }).join("\n");
  return `*Workspace Members:*\n${members}`;
}

async function workspaceStatus() {
  const [chList, usrList] = await Promise.all([
    slack("conversations.list", { types: "public_channel,private_channel", limit: 200 }),
    slack("users.list", { limit: 100 }),
  ]);
  const total = (chList.channels || []).length;
  const active = (chList.channels || []).filter(c => !c.is_archived).length;
  const archived = total - active;
  const humans = (usrList.members || []).filter(u => !u.is_bot && u.id !== "USLACKBOT" && !u.deleted).length;
  const bots = (usrList.members || []).filter(u => u.is_bot && u.id !== "USLACKBOT").length;

  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  return `*MetroPrints Status* _(as of ${now} ET)_\n\n• ${active} active channels, ${archived} archived\n• ${humans} humans, ${bots} bots\n• Casey: ✅ online, listening\n• Socket Mode: ✅ connected\n• LLM: DeepSeek`;
}

async function postAlert(text, userName) {
  // Parse: /casey-alert [P0|P1|P2|P3] message
  const parts = text.trim().split(/\s+/);
  let level = "P2";
  let message = text;
  if (parts[0] && /^P[0-3]$/i.test(parts[0])) {
    level = parts.shift().toUpperCase();
    message = parts.join(" ");
  }

  const alertChannel = (level === "P0" || level === "P1") ? "C0BD7AR750F" : "C0BDKCYUEQM";
  const channelName = (level === "P0" || level === "P1") ? "#metroprints-critical" : "#metroprints-alerts";

  await slack("chat.postMessage", {
    channel: alertChannel,
    text: `🚨 *${level} Alert* from ${userName}:\n> ${message || "(no details)"}`,
    unfurl_links: false,
    unfurl_media: false,
  });
  return `Alert posted to ${channelName}: ${message || "(no details)"}`;
}

async function recallThread(channel, text) {
  // Fetch recent messages and summarize via LLM
  const history = await fetchContext(channel, null, 15);
  if (!history.length) return "No recent conversation history in this channel.";

  const summary = await think([
    { role: "system", content: "Summarize the recent Slack conversation below concisely. Highlight key decisions, topics, and people mentioned." },
    { role: "user", content: history.map(m => `[${m.role}]: ${m.content}`).join("\n") + `\n\nUser query: "${text}"` },
  ]);
  return summary || "Could not summarize conversation.";
}

function showHelp() {
  return `*Casey — MetroPrints Case Management Agent*\n\n*General:*\n• \`/casey [question]\` — Ask me anything\n• \`/casey-audit\` — Full workspace audit\n• \`/casey-channels\` — List all channels\n• \`/casey-members\` — List all members\n• \`/casey-status\` — Workspace health check\n• \`/casey-alert [P0-P3] [msg]\` — Post alert\n• \`/casey-recall [topic]\` — Summarize conversation\n\n*FBI PrintDeck:*\n• \`/casey fbi-intake [name]\` — Start new FBI case\n• \`/casey fbi-status [order#]\` — FBI case timeline\n• \`/casey fbi-stale\` — Cases stalled >48 hrs\n• \`/casey fbi-dispatch\` — Today's FBI action items\n\n*System:*\n• \`/casey-help\` — This menu\n• \`/casey-learn\` — Refresh Obsidian knowledge\n\nRevenue & finance: ask Penny.`;
}

function showFbiStatus(text) {
  const orderId = text?.trim() || "(unknown Order#)";
  return `*FBI Case Status — ${orderId}*\n\n*FBI CJIS Mailing Address:*\nFBI CJIS Division\nATTN: ELECTRONIC SUMMARY REQUEST\n1000 Custer Hollow Road\nClarksburg, West Virginia 26306\n\n*Library Printers (Princh):*\n• Country Walk: 106246\n• Culmer/Overtown: 106247\n\n*Workflow Checklist:*
🚧 Intake — IDs checked, client type confirmed, prints captured
🚧 FBI Request — Submitted via shah@metroprints.co
🚧 Email #2 — Confirm received, extract Order#/PIN/Link
🚧 Conversion — ENC → EFT → PDF (PrintDeck)
🚧 Drive — PDF saved to client Google Drive folder
🚧 Print — Confirmation email + 2 fingerprint cards
🚧 Mail — Tracking # logged, mailed date recorded
🚧 Notion — All milestones logged

Use \`/casey fbi-stale\` to find cases stuck at any step.`;
}

// ── Website & Notion Commands ────────────────────────

async function checkWebsiteStatus() {
  const result = await checkWebsite();
  if (result.up) {
    return `✅ *MetroPrints website is UP*\n• Status: ${result.status}\n• Latency: ${result.latency_ms}ms\n• URL: ${MP_WEBSITE}`;
  }
  return `❌ *MetroPrints website is DOWN*\n• Status: ${result.status || "N/A"}\n• Error: ${result.error || "Connection failed"}\n• URL: ${MP_WEBSITE}`;
}

async function listRecentCases() {
  const result = await notionQueryDB(NOTION_DBS.activities);
  if (result.error) return `Notion unavailable: ${result.error}`;
  const pages = result.results || [];
  if (!pages.length) return "No recent cases found in MP - Activities.";

  const lines = pages.map(p => {
    const props = p.properties || {};
    const title = Object.values(props).find(v => v.type === "title");
    const name = title?.title?.[0]?.plain_text || "(untitled)";
    const edited = new Date(p.last_edited_time).toLocaleDateString("en-US");
    return `• ${name} (last updated: ${edited})`;
  }).join("\n");

  return `*Recent MP - Activities (last ${pages.length}):*\n${lines}\n\nUse \`/casey hostatus\` for website, \`/casey fbi-dispatch\` for FBI cases.`;
}

console.log("[casey] Starting Casey Socket Mode listener...");
loadKnowledge();
connect();
