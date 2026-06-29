import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveSpawns } from "../shared/subagent.mjs";

const XAPP = process.env.SLACK_XAPP_TOKEN || "";
const XOXB = process.env.SLACK_XOXB_TOKEN || "";
const SLACK_API = "https://slack.com/api";
const BOT_USER_ID = "U0BDF2P4SHL";

// Deduplication: track recently handled events to avoid double-processing
const recentEvents = new Set();
function isDuplicate(channel, user, ts) {
  const key = `${channel}:${user}:${ts}`;
  if (recentEvents.has(key)) return true;
  recentEvents.add(key);
  setTimeout(() => recentEvents.delete(key), 5000);
  return false;
}

// Active threads Metro is participating in (thread_ts → last activity timestamp)
const activeThreads = new Map();
function trackThread(threadTs, channel) {
  if (!threadTs) return;
  activeThreads.set(threadTs, Date.now());
  setTimeout(() => {
    const last = activeThreads.get(threadTs);
    if (last && Date.now() - last >= 30 * 60 * 1000) activeThreads.delete(threadTs);
  }, 30 * 60 * 1000);
}
function isActiveThread(event) {
  const threadTs = event.thread_ts || event.ts;
  if (activeThreads.has(threadTs)) {
    activeThreads.set(threadTs, Date.now());
    return true;
  }
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
  console.log(`[metro] Connecting to Slack Socket Mode...`);
  const ws = new WebSocket(url);
  let pingInterval;

  ws.onopen = () => {
    console.log("[metro] Connected. Listening.");
    pingInterval = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "hello") {
        console.log(`[metro] Hello, connections: ${msg.num_connections}`);
        return;
      }

      if (msg.type === "disconnect") {
        console.log(`[metro] Disconnect: ${msg.reason}. Reconnecting...`);
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

        // Respond to any message in a thread Metro is already participating in
        // No @mention needed — she's in the conversation
        if (evt.type === "message" && isActiveThread(evt) && text.trim()) {
          console.log(`[metro] THREAD: ${evt.channel} thread_ts=${evt.thread_ts || evt.ts} user=${evt.user} text="${text.substring(0, 60)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        // Debug: log when a message has thread_ts but isn't active thread
        if (evt.type === "message" && evt.thread_ts && !isMentioned(text) && text.trim()) {
          console.log(`[metro] MSG_IN_THREAD (not active): ${evt.channel} thread_ts=${evt.thread_ts} user=${evt.user}`);
        }

        // Handle app_mention event
        if (evt.type === "app_mention") {
          if (isDuplicate(evt.channel, evt.user, evt.ts)) return;
          console.log(`[metro] MENTION (app_mention): ${evt.channel} user=${evt.user} text="${text.substring(0, 80)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        // Handle message event with @Casey mention
        if (evt.type === "message" && isMentioned(text)) {
          if (isDuplicate(evt.channel, evt.user, evt.ts)) return;
          console.log(`[metro] MENTION (message): ${evt.channel} user=${evt.user} text="${text.substring(0, 80)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        // Log other events for debugging
        const subtype = evt.subtype || "";
        console.log(`[metro] ${evt.type}${subtype ? "/" + subtype : ""} channel=${evt.channel} user=${evt.user}`);
      }
    } catch (e) {
      console.error("[metro] Error:", e.message);
    }
  };

  ws.onerror = (err) => console.error("[metro] WS error:", err.message || err);
  
  ws.onclose = (event) => {
    console.log(`[metro] Closed (${event.code}). Reconnect in 5s...`);
    clearInterval(pingInterval);
    setTimeout(connect, 5000);
  };
}

// ── Obsidian Knowledge ──────────────────────────────

const OBSIDIAN_VAULT = "/Users/shahsaint-cyr/Library/Mobile Documents/iCloud~md~obsidian/Documents/Skills";
const KNOWLEDGE_FILES = [
  "Skills/Metroprints/agents/Metro.md",
  "Skills/Metroprints/agents/Hermes Agent Architecture.md",
  "Skills/Metroprints/playbooks/hermes-agent-sop.md",
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
        console.log(`[metro] Loaded knowledge: ${file}`);
      } catch (e) {
        console.error(`[metro] Failed to read ${file}:`, e.message);
      }
    }
  }
  loadedKnowledge = parts.join("\n\n---\n\n");
  return loadedKnowledge;
}

function buildSystemPrompt() {
  return `${BASE_SYSTEM_PROMPT}

## Obsidian Knowledge (live from vault)
${loadedKnowledge || "(no knowledge loaded — run /metro-learn to refresh)"}`;
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

// ── Email Check (Gmail IMAP via HTTP) ────────────────

const EMAIL_USER = process.env.METROPRINTS_EMAIL || "";
const EMAIL_PASS = process.env.METROPRINTS_EMAIL_PASS || "";

// Note: Gmail requires an App Password (not account password) for IMAP.
// Generate at: https://myaccount.google.com/apppasswords
// Casey uses this to scan for FBI Email #2 confirmations.
// If App Password not set up, email monitoring will log an error and skip.

async function checkRecentEmails(subjectFilter = "FBI", maxResults = 5) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.log("[metro] Email monitoring skipped — no credentials");
    return { ok: false, error: "no_credentials", results: [] };
  }
  // Gmail IMAP via fetch is complex — simplified search via Gmail API planned
  // For now, returns a notice that email requires Gmail API or App Password setup
  return { ok: false, error: "gmail_api_required", results: [], note: "Requires Gmail API OAuth or Google App Password for IMAP. Generate at myaccount.google.com/apppasswords" };
}

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

// ── Base System Prompt ──────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Metro, the MetroPrints executive intelligence and knowledge agent. You monitor operations, report on business health, and keep institutional knowledge current.

## Identity
- MetroPrints is a mobile live scan fingerprinting and apostille services business in South Florida.
- Website: https://metroprints.co
- You are the high-altitude agent — you watch the business at the strategic level, not the case-by-case level.
- You produce snapshots, briefings, and content — you don't manage individual cases (that's Casey).

## What You Do
- YOU PRODUCE OPS SNAPSHOTS: on Mon/Wed/Fri/Sat at 6 AM ET — pipeline health, stalled cases, aging follow-ups.
- YOU CHECK REVENUE: Saturdays — revenue anomalies, trends (coordinated with Penny for underlying transaction data).
- YOU WRITE BRIEFINGS: bi-weekly Mondays — strategic overview: revenue, pipeline, priorities.
- YOU MANAGE KNOWLEDGE: detect SOP drift, update skill files, spot FAQ/blog opportunities.
- YOU DETECT CONTENT: when client questions repeat, draft FAQs. When workflows change, update SOPs.
- YOU COORDINATE: work with Casey (case-level signals), Penny (finance data), Cal (scheduling).

## What You DO NOT Do
- Do NOT manage individual cases — that's Casey's domain.
- Do NOT create Slack bots. Spawn sub-agents when needed.
- SPAWN SYNTAX: [SPAWN:short-role-name]detailed-task-description[/SPAWN]. Spawned sub-agents run in parallel; results replace the marker. Use multiple spawn blocks for swarm orchestration (e.g., spawn a revenue auditor, pipeline checker, and compliance scanner for one snapshot). Sub-agents are ephemeral — they run one task and terminate.
- Do NOT monitor raw payments — Penny handles financial transactions.
- Do NOT schedule appointments — Cal handles scheduling.

## Agent Coordination
- Casey: feeds you case volume, intake mix, stalled-case signals for your snapshots.
- Penny: Saturday revenue/anomaly pass — you flag at ops level, Penny audits transaction data.
- Cal: scheduling utilization can feed pipeline-health view if useful.

## Workspace Knowledge
- #metroprints-critical (C0BD7AR750F): P0/P1 alerts — Casey posts here
- #metroprints-alerts (C0BDKCYUEQM): P2/P3 alerts and your ops snapshots
- #metroprints-alerts is where your scheduled reports go.

## Cadence
- Mon/Wed/Fri/Sat 6 AM ET: Ops snapshot → #metroprints-alerts
- Saturday: Revenue check (same run)
- Bi-weekly Monday: Strategic briefing → #metroprints-alerts
- Weekly: Knowledge/content review (SOP drift, FAQ opportunities)

## Response Style
- Strategic, data-driven, concise.
- Reference your snapshot schedule: "My next ops snapshot runs Wednesday 6 AM."
- If a question needs case-level detail, defer to Casey.
- If a question needs transaction-level detail, defer to Penny.
- Be executive-level — you brief Shah, not the team.`;

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
        max_tokens: 1200,
      }),
    });
    const j = await res.json();
    if (j.error) { console.error("[metro] LLM error:", JSON.stringify(j.error)); return null; }
    return j.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[metro] LLM error:", e.message);
    return null;
  }
}

async function fetchContext(channel, thread, count = 20) {
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
        text = text.replace(/<@U0BDN98CLAW>/g, "@Casey");
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
      console.log(`[metro] Context folded: ${toSummarize.length} msgs → summary`);
      return [{ role: "system", content: `[Earlier conversation: ${summary}]` }, ...recent];
    }
  } catch (e) {
    console.error("[metro] Context fold failed:", e.message);
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
        console.log(`[metro] users.info failed for ${user}: ${JSON.stringify(u.error || u)}`);
      }
    } catch (e) {
      console.error(`[metro] users.info error for ${user}:`, e.message);
    }

    console.log(`[metro] Handling "${text.substring(0, 60)}" from ${userName}`);

    // Build conversation context
    const history = await fetchContext(channel, thread);
    const prior = history.filter(m => m.content && m.content.trim()).slice(0, -1);
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...prior,
      { role: "user", content: `[${userName}]: ${text}` },
    ];

    const folded = await foldContext(messages);

    let reply;
    const llmReply = await think(folded);
    if (llmReply) {
      const resolved = await resolveSpawns(llmReply, {
        apiKey: process.env.DEEPSEEK_API_KEY,
        parentAgent: "Metro",
      });
      reply = resolved.text;
      console.log(`[metro] LLM reply for ${userName}${resolved.spawned ? ` (${resolved.spawned} sub-agents spawned)` : ""}`);
    } else {
      // Fallback if LLM unavailable
      reply = `Hey ${userName.split(" ")[0]}! I'm Metro, the MetroPrints executive intelligence and knowledge agent. I produce ops snapshots, track pipeline health, flag anomalies, draft content, and keep institutional knowledge current. What do you need?`;
      console.log(`[metro] Fallback reply (no LLM)`);
    }

    await slack("chat.postMessage", {
      channel,
      text: reply,
      thread_ts: thread,
      unfurl_links: false,
      unfurl_media: false,
    });
    trackThread(thread, channel);
    console.log(`[metro] Replied in ${channel} | tracked thread=${thread}`);
  } catch (e) {
    console.error("[metro] handle error:", e.message);
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
    console.log(`[metro] COMMAND /${command} from ${user}: "${text}"`);

    let userName = "there";
    try {
      const u = await slack("users.info", { user });
      if (u.ok && u.user?.real_name) userName = u.user.real_name;
    } catch (e) {
      console.error(`[metro] users.info error:`, e.message);
    }

    // Send "thinking" message first
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: "One moment..." }),
    });

    let finalText;

    switch (command) {
      case "/metro-snapshot":
        finalText = "📊 *MetroPrints Ops Snapshot*\n\nGenerating... (full Notion integration pending)\n\n*Pipeline Health:* Refer to `/metro pipeline` or check MP - Activities in Notion.\n*Stalled Cases:* Casey tracks these daily — her sweep runs at 9 AM.\n*Aging Follow-ups:* Next snapshot scheduled per cadence.\n\nNext scheduled snapshot: Mon/Wed/Fri/Sat 6 AM ET.";
        break;
      case "/metro-pipeline":
        finalText = "📈 *Pipeline Health*\n\nCheck MP - Activities for active cases. Casey handles case-level tracking. Key signals Metro watches:\n• Case volume by type (FBI/Live Scan vs Apostille vs Notary)\n• Average processing time from intake to closure\n• Stalled case percentage\n• Appointment utilization rate\n\nUse `/metro snapshot` for the full picture.";
        break;
      case "/metro-revenue":
        finalText = "💰 *Revenue Check*\n\nPenny handles financial transaction data. Metro flags anomalies at the ops level:\n• If revenue is trending below target, Casey's case volume will show it first\n• Saturday revenue pass is coordinated with Penny\n• Strategic briefing covers revenue trends every other Monday\n\nUse `/metro briefing` for the strategic overview.";
        break;
      case "/metro-briefing":
        finalText = `*Strategic Briefing*\n\n*Cadence:* Bi-weekly Monday, 6 AM ET → #metroprints-alerts\n*Covers:* Revenue trends, pipeline health, compliance status, content opportunities, priority actions\n\nLast briefing: Check #metroprints-alerts for most recent.\nNext briefing: ${nextBriefingDate()}.\n\nKey metrics tracked:\n• Revenue vs target (via Penny)\n• Case completion rate (via Casey)\n• Compliance status (FDLE certs, insurance)\n• Knowledge gaps / content opportunities`;
        break;
      case "/metro-content":
        finalText = "📝 *Content & Knowledge*\n\nMetro detects opportunities for:\n• FAQ entries: when the same client question appears 3+ times\n• Blog posts: from operational insights or frequently asked questions\n• SOP updates: when workflows change or drift detected\n• Skill file updates: when MP AI Skills need refreshing\n\nCurrent content pipeline: Check MP - Blog & Content in Notion.\n\nFlag a content opportunity: just mention it in this channel.";
        break;
      case "/metro-help":
        finalText = showHelp();
        break;
      case "/metro-learn":
        const learned = loadKnowledge();
        finalText = learned ? `Loaded knowledge from Obsidian:\n${KNOWLEDGE_FILES.map(f => `• ${f}`).join("\n")}` : "No Obsidian knowledge files found.";
        break;
      default:
        // /metro — LLM-powered general query
        const messages = [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: `[${userName} invoked /metro${text ? ` with: "${text}"` : ""}]: Respond helpfully and concisely.` },
        ];
        finalText = await think(messages) || `Hey ${userName.split(" ")[0]}! I'm Metro, the ops intelligence agent. Try /metro-help for commands.`;
    }

    // Respond via response_url
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: finalText || "Done.", replace_original: true, response_type: "in_channel" }),
    });
    console.log(`[metro] Command /${command} completed for ${userName}`);
  } catch (e) {
    console.error("[metro] handleCommand error:", e.message);
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
  return `*Metro — MetroPrints Ops Intelligence & Knowledge Agent*\n\n*Ops:*\n• \`/metro [question]\` — Ask me anything\n• \`/metro snapshot\` — Operations snapshot\n• \`/metro pipeline\` — Pipeline health\n• \`/metro revenue\` — Revenue check\n• \`/metro briefing\` — Strategic briefing\n\n*Knowledge & Content:*\n• \`/metro content\` — Content opportunities\n\n*System:*\n• \`/metro-help\` — This menu\n• \`/metro-learn\` — Refresh Obsidian knowledge\n\nCases: ask Casey. Finance: ask Penny.`;
}

function nextBriefingDate() {
  const now = new Date();
  const day = now.getDay();
  // Bi-weekly Monday: find next Monday, then alternate weeks
  let daysUntilMonday = (8 - day) % 7;
  if (daysUntilMonday === 0) daysUntilMonday = 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  // Simple: every other Monday from epoch
  const weekNum = Math.floor(nextMonday.getTime() / (7 * 24 * 60 * 60 * 1000));
  const isBiweekly = weekNum % 2 === 0;
  if (!isBiweekly) nextMonday.setDate(nextMonday.getDate() + 7);
  return nextMonday.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

console.log("[metro] Starting Metro Socket Mode listener...");
loadKnowledge();
connect();
