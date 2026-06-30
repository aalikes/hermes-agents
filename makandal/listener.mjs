import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const XAPP = process.env.SLACK_XAPP_TOKEN || "";
const XOXB = process.env.SLACK_XOXB_TOKEN || "";
const SLACK_API = "https://slack.com/api";
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "U0BE36F0ZE1";

const recentEvents = new Set();
function isDuplicate(channel, user, ts) {
  const key = `${channel}:${user}:${ts}`;
  if (recentEvents.has(key)) return true;
  recentEvents.add(key);
  setTimeout(() => recentEvents.delete(key), 5000);
  return false;
}

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
  if (text.includes(`<@${BOT_USER_ID}>`)) return true;
  return false;
}

function cleanText(text) {
  return text.replace(new RegExp(`<@${BOT_USER_ID}>\\s*`, "g"), "").trim();
}

async function connect() {
  const url = await getWebSocketUrl();
  console.log(`[makandal] Connecting to Slack Socket Mode...`);
  const ws = new WebSocket(url);
  let pingInterval;

  ws.onopen = () => {
    console.log("[makandal] Connected. Makandal watches the network.");
    pingInterval = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log(`[makandal] recv type=${msg.type}`);

      if (msg.type === "hello") {
        console.log(`[makandal] Hello, connections: ${msg.num_connections}`);
        return;
      }

      if (msg.type === "disconnect") {
        console.log(`[makandal] Disconnect: ${msg.reason}. Reconnecting...`);
        clearInterval(pingInterval);
        ws.close();
        setTimeout(connect, 1000);
        return;
      }

      // Slash commands arrive as top-level "slash_commands" envelope
      if (msg.type === "slash_commands" && msg.payload) {
        const cmd = msg.payload;
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id, type: "ack" }));
        await handleCommand(cmd.command, cmd.channel_id || cmd.channel, cmd.user_id || cmd.user, cmd.text || "", cmd.response_url);
        return;
      }

      if (msg.type === "events_api" && msg.payload?.event) {
        const evt = msg.payload.event;
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id, type: "ack" }));

        if (evt.user === BOT_USER_ID) return;
        if (evt.subtype === "message_changed" || evt.subtype === "message_deleted") return;

        const text = evt.text || "";

        if (evt.type === "message" && isActiveThread(evt) && text.trim()) {
          console.log(`[makandal] THREAD: ${evt.channel} thread_ts=${evt.thread_ts || evt.ts} user=${evt.user} text="${text.substring(0, 60)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        if (evt.type === "app_mention") {
          if (isDuplicate(evt.channel, evt.user, evt.ts)) return;
          console.log(`[makandal] MENTION (app_mention): ${evt.channel} user=${evt.user} text="${text.substring(0, 80)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        if (evt.type === "message" && isMentioned(text)) {
          if (isDuplicate(evt.channel, evt.user, evt.ts)) return;
          console.log(`[makandal] MENTION (message): ${evt.channel} user=${evt.user} text="${text.substring(0, 80)}"`);
          await handle(evt.channel, evt.user, cleanText(text), evt.ts);
          return;
        }

        const subtype = evt.subtype || "";
        console.log(`[makandal] ${evt.type}${subtype ? "/" + subtype : ""} channel=${evt.channel} user=${evt.user}`);
      }
    } catch (e) {
      console.error("[makandal] Error:", e.message);
    }
  };

  ws.onerror = (err) => console.error("[makandal] WS error:", err.message || err);

  ws.onclose = (event) => {
    console.log(`[makandal] Closed (${event.code}). Reconnect in 5s...`);
    clearInterval(pingInterval);
    setTimeout(connect, 5000);
  };
}

// ── Knowledge ─────────────────────────────────────────

const OBSIDIAN_VAULT = "/Users/shahsaint-cyr/Library/Mobile Documents/iCloud~md~obsidian/Documents/Skills";
const KNOWLEDGE_FILES = [
  "Skills/Haitian Community Cares/README.md",
  "Skills/Haitian Community Cares/Context/strategy.md",
  "Skills/Haitian Community Cares/Context/operator.md",
  "Skills/Haitian Community Cares/playbooks/runbooks.md",
  "Skills/Haitian Community Cares/playbooks/decision-framework.md",
  "Skills/Haitian Community Cares/programs/catalog-overview.md",
  "Skills/Haitian Community Cares/teams/okr-tracker.md",
  "Skills/Haitian Community Cares/skills/INDEX.md",
];

let loadedKnowledge = "";

function loadKnowledge() {
  const parts = [];
  for (const file of KNOWLEDGE_FILES) {
    const path = join(OBSIDIAN_VAULT, file);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        parts.push(`### ${file.replace(/^Skills\/Haitian Community Cares\//, "").replace(".md", "")}\n${content.substring(0, 3000)}`);
        console.log(`[makandal] Loaded knowledge: ${file}`);
      } catch (e) {
        console.error(`[makandal] Failed to read ${file}:`, e.message);
      }
    }
  }
  loadedKnowledge = parts.join("\n\n---\n\n");
  return loadedKnowledge;
}

function buildSystemPrompt() {
  return `${BASE_SYSTEM_PROMPT}

## Vault Knowledge (live from Obsidian)
${loadedKnowledge || "(no knowledge loaded — run /makandal-learn to refresh)"}`;
}

// ── Notion ────────────────────────────────────────────

const NOTION_KEY = process.env.NOTION_API_KEY || "";
const NOTION_VERSION = "2022-06-28";

const NOTION_DBS = {
  activities: "27189d07-dc61-8122-acde-f2cffd",       // THC - Activities
  people: "27189d07-dc61-8190-b83f-f2cffd",            // THC - People (placeholder — verify)
  finance: "27189d07-dc61-81a8-9c37-f2cffd",           // THC - Finance Tracker (placeholder — verify)
  planning: "27189d07-dc61-8168-9182-ef0386dbd9e7",    // THC - Planning
  projects: "27189d07-dc61-8140-abb6-d35934cf48a7",    // THC - Projects
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

async function notionQueryDB(dbId, filter = {}) {
  return notion("POST", `/databases/${dbId}/query`, {
    page_size: 20,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    ...(Object.keys(filter).length ? { filter } : {})
  });
}

// ── DeepSeek LLM ──────────────────────────────────────

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

const BASE_SYSTEM_PROMPT = `You are Makandal — Operations Intelligence for The Haitian Community (THC). Named after François Makandal, the maroon leader who organized intelligence networks across Saint-Domingue, you connect dots across THC's operations, anticipate friction before it becomes crisis, and keep the platform running with precision.

## Identity
- **The Haitian Community** (THC) is a platform co-founded by Samuel Jean and Shah Saint-Cyr, building a hub for Haitian culture.
- **Canonical domain**: haitiancommunitycares.com
- **Social handle**: @empowerhaitians on all platforms
- **Brand voice**: Warm, proud, empowering, bilingual (EN + Kreyòl)
- **Headquarters**: 2125 Biscayne Blvd, Miami

## Platform Pillars
- **Directory** — 100+ Haitian business listings nationwide (target: 500)
- **Workforce** — Career Readiness, Security Guard, Life Skills, Career Path, Pwogram karye (target: 200 participants, 80% completion)
- **Culture** — Book Club, Podcast (weekly), Workshops (quarterly), Blog (weekly spotlights)
- **Community** — Memberships (Bronze/Silver/Gold), Events, Slack, Newsletter (target: 5,000 members, 50K followers)
- **Academy** — 6 planned courses launching 2026

## Departments
- **Operations** — Fulfillment workflows, quality standards, playbook execution
- **Community** — Member engagement, events, support (4h response SLA)
- **Content** — Blog, social media, podcast production
- **Partnerships** — Sponsorships ($1K-$10K tiers), partner outreach
- **Sales** — Listing tiers (Free/$19/$99), pricing
- **Engineering** — WordPress + Listeo, Phase 3 workforce build in progress
- **Guide** — Brand identity, voice/tone

## Your Role
You are the operations intelligence layer across this entire organization. You:
1. **Monitor Slack** — Scan channels for operational signals, unanswered questions, membership activity, event coordination
2. **Track OKRs** — 5,000 members, 500 listings, 200 program participants, $50K sponsorship, 5 academy courses
3. **Execute Playbooks** — R1 (Member Onboarding), R2 (Business Listing), R3 (Program Enrollment), R4 (Sponsorship Fulfillment), R5 (Newsletter)
4. **Surface Intelligence** — Anomalies, bottlenecks, engagement gaps, compliance deadlines

## OKR Tracking (2026)
| Objective | Key Results |
|---|---|
| Scale Community Reach | 5,000 members / 500 listings / 50K followers |
| Expand Workforce Impact | 200 participants / 80% completion / 50% placement |
| Build Sustainable Revenue | $50K sponsorship / $20K program fees / 5% conversion |

## Alert Thresholds
- 🔴 Activities stuck >14 days
- 🔴 Member not contacted >30 days
- 🔴 Finance Tracker stale >7 days
- 🟡 Compliance items due within 14 days
- 🟡 Sponsor deliverables past due
- 🟡 Blog gap >7 days
- 🔵 Membership signups flat >14 days

## Playbooks (from runbooks.md)
- R1: New Member → welcome email → Notion profile → newsletter → assign tier → log
- R2: New Listing → verify → approve in WP → notify → social rotation → log
- R3: Program Enrollment → verify → payment → confirmation → cohort → orient → log
- R4: Sponsorship → invoice → assets → deliver benefits → report → log
- R5: Newsletter → curate → design → review → send → track → log

## Cultural Context
- Key cities: Miami, New Orleans, New York, Boston, Atlanta, Orlando, Chicago
- Key dates: Haitian Flag Day (May 18), Independence Day (Jan 1), Heritage Month (May), Kanaval
- Language: Kreyòl and French where appropriate. You are bilingual-friendly.
- Values: Kombit (collective work), entrepreneurship, cultural pride, diaspora connection

## Response Style
- Be direct and concise. Lead with insight, not preamble.
- Use tables for data, bullet points for steps, severity indicators (🔴🟡🔵) for issues.
- When analyzing: what the data says → what it means for THC → recommended action.
- If you don't know something, say so. Never fabricate numbers.
- You can respond in Kreyòl or English depending on the conversation.`;

async function think(messages) {
  if (!DEEPSEEK_KEY) return null;
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${DEEPSEEK_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });
    const j = await res.json();
    if (j.error) { console.error("[makandal] LLM error:", JSON.stringify(j.error)); return null; }
    return j.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[makandal] LLM error:", e.message);
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
        text = text.replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "@Makandal");
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
      { role: "system", content: "Summarize this conversation in 2-3 sentences. Preserve: names, decisions, action items, key topics." },
      { role: "user", content: toSummarize.map(m => `[${m.role}]: ${m.content}`).join("\n") },
    ]);
    if (summary) {
      console.log(`[makandal] Context folded: ${toSummarize.length} msgs → summary`);
      return [{ role: "system", content: `[Earlier conversation: ${summary}]` }, ...recent];
    }
  } catch (e) {
    console.error("[makandal] Context fold failed:", e.message);
  }
  return messages;
}

// ── Handle ────────────────────────────────────────────

async function handle(channel, user, text, thread) {
  try {
    let userName = "there";
    try {
      const u = await slack("users.info", { user });
      if (u.ok && u.user?.real_name) userName = u.user.real_name;
    } catch (e) {
      console.error(`[makandal] users.info error:`, e.message);
    }

    console.log(`[makandal] Handling "${text.substring(0, 60)}" from ${userName}`);

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
      reply = llmReply;
      console.log(`[makandal] LLM reply for ${userName}`);
    } else {
      reply = `Hey ${userName.split(" ")[0]}! Mwen se Makandal — Operations Intelligence for The Haitian Community. Ask me about OKRs, pipelines, membership, or run a sweep. Try /makandal-help.`;
      console.log(`[makandal] Fallback reply (no LLM)`);
    }

    await slack("chat.postMessage", { channel, text: reply, thread_ts: thread });
    trackThread(thread, channel);
    console.log(`[makandal] Replied in ${channel} | tracked thread=${thread}`);
  } catch (e) {
    console.error("[makandal] handle error:", e.message);
    try {
      await slack("chat.postMessage", { channel, text: "Sorry, something went wrong. Try again?", thread_ts: thread });
      trackThread(thread, channel);
    } catch {}
  }
}

// ── Slash Commands ────────────────────────────────────

async function handleCommand(command, channel, user, text, responseUrl) {
  try {
    console.log(`[makandal] COMMAND ${command} from ${user}: "${text}"`);

    let userName = "there";
    try {
      const u = await slack("users.info", { user });
      if (u.ok && u.user?.real_name) userName = u.user.real_name;
    } catch {}

    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: "One moment..." }),
    });

    let finalText;

    switch (command) {
      case "/makandal-sweep":
        finalText = await runSweep();
        break;
      case "/makandal-okr":
        finalText = showOKR();
        break;
      case "/makandal-snapshot":
        finalText = await workspaceSnapshot();
        break;
      case "/makandal-channels":
        finalText = await listChannels();
        break;
      case "/makandal-members":
        finalText = await listMembers();
        break;
      case "/makandal-learn":
        const learned = loadKnowledge();
        finalText = learned
          ? `Loaded knowledge from Obsidian:\n${KNOWLEDGE_FILES.map(f => `• ${f}`).join("\n")}`
          : "No Obsidian knowledge files found. Check the vault path.";
        break;
      case "/makandal-help":
        finalText = showHelp();
        break;
      default:
        // /makandal — LLM-powered general query
        const messages = [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: `[${userName} invoked /makandal${text ? ` with: "${text}"` : ""}]: Respond helpfully and concisely as Makandal.` },
        ];
        finalText = await think(messages) || `Bonjou ${userName.split(" ")[0]}! How can I help? Try /makandal-help.`;
    }

    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: finalText || "Done.", replace_original: true, response_type: "in_channel" }),
    });
    console.log(`[makandal] Command ${command} completed for ${userName}`);
  } catch (e) {
    console.error("[makandal] handleCommand error:", e.message);
    try {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Sorry, something went wrong.", replace_original: true }),
      });
    } catch {}
  }
}

// ── Command Implementations ───────────────────────────

async function runSweep() {
  try {
    const [chList, usrList, ugList, unreads] = await Promise.all([
      slack("conversations.list", { types: "public_channel,private_channel", limit: 200 }),
      slack("users.list", { limit: 100 }),
      slack("usergroups.list", { include_users: true, include_count: true }),
      slack("conversations.list", { types: "public_channel,private_channel", limit: 200 }).then(async (res) => {
        // Check unreads for each channel (sample: top 5 by members)
        const top = (res.channels || []).sort((a, b) => (b.num_members || 0) - (a.num_members || 0)).slice(0, 5);
        const results = [];
        for (const ch of top) {
          try {
            const ur = await slack("conversations.history", { channel: ch.id, limit: 3 });
            if (ur.ok && ur.messages?.length) {
              results.push({ channel: ch.name || ch.id, latest: ur.messages[0] });
            }
          } catch {}
        }
        return results;
      }),
    ]);

    const channels = (chList.channels || []).sort((a, b) => (b.num_members || 0) - (a.num_members || 0));
    const humans = (usrList.members || []).filter(u => !u.is_bot && u.id !== "USLACKBOT" && !u.deleted).length;
    const bots = (usrList.members || []).filter(u => u.is_bot && u.id !== "USLACKBOT").length;
    const groups = (ugList.usergroups || []);

    let output = `*Makandal Intelligence Sweep*\n\n`;
    output += `*Channels (${channels.length}):*\n`;
    for (const ch of channels.slice(0, 8)) {
      const type = ch.is_private ? "🔒" : "#";
      const archived = ch.is_archived ? " [ARCHIVED]" : "";
      const purpose = ch.purpose?.value ? ` — _${ch.purpose.value.substring(0, 50)}_` : "";
      output += `${type} *${ch.name}* (${ch.num_members || 0} members)${archived}${purpose}\n`;
    }
    if (channels.length > 8) output += `_...and ${channels.length - 8} more_\n`;

    output += `\n*Members:* ${humans} humans, ${bots} bots\n`;

    if (groups.length) {
      output += `\n*User Groups:*\n`;
      groups.forEach(g => output += `  @${g.handle} — ${g.user_count || 0} users\n`);
    }

    output += `\n*Recent Activity (top channels):*\n`;
    for (const r of unreads) {
      const ts = new Date(parseFloat(r.latest.ts) * 1000).toLocaleString("en-US", { timeZone: "America/New_York" });
      output += `  #${r.channel}: ${r.latest.text?.substring(0, 80) || "(no text)"} — ${ts}\n`;
    }

    return output;
  } catch (e) {
    return `Sweep failed: ${e.message}`;
  }
}

function showOKR() {
  return `*THC 2026 OKR Dashboard*

| Objective | Key Results | Status |
|---|---|---|
| Scale Community Reach | 5,000 members / 500 listings / 50K followers | 🟡 Tracking |
| Expand Workforce Impact | 200 participants / 80% completion / 50% placement | 🟡 Per-cohort |
| Build Sustainable Revenue | $50K sponsorship / $20K program fees / 5% conversion | 🟡 Monthly |

*Priority Actions:*
• Scale workforce enrollment 2x
• Reach 500+ business listings
• Launch online academy (5+ courses)
• Grow newsletter to 10K+ subscribers

*Alert Thresholds:*
🔴 Activities stuck >14 days | Member contact gap >30 days | Finance stale >7 days
🟡 Compliance due <14 days | Sponsor deliverables past due | Blog gap >7 days
🔵 Membership signups flat >14 days

Use \`/makandal-sweep\` for a real-time workspace scan.`;
}

async function workspaceSnapshot() {
  try {
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

    return `*THC Operational Snapshot* _(as of ${now} ET)_

• ${active} active channels, ${archived} archived
• ${humans} humans, ${bots} bots
• Makandal: ✅ online, listening
• Socket Mode: ✅ connected
• LLM: DeepSeek (deepseek-chat)
• Vault: The Haitian Community Cares

Use \`/makandal-sweep\` for full intelligence sweep.`;
  } catch (e) {
    return `Snapshot failed: ${e.message}`;
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

function showHelp() {
  return `*Makandal — THC Operations Intelligence*

*General:*
• \`/makandal [question]\` — Ask me anything
• \`/makandal-sweep\` — Full workspace intelligence sweep
• \`/makandal-okr\` — 2026 OKR dashboard
• \`/makandal-snapshot\` — Operational health snapshot
• \`/makandal-channels\` — List all channels
• \`/makandal-members\` — List all members

*System:*
• \`/makandal-help\` — This menu
• \`/makandal-learn\` — Refresh knowledge from Obsidian

*Playbooks:* R1 (Member Onboarding) | R2 (Business Listing) | R3 (Program Enrollment) | R4 (Sponsorship Fulfillment) | R5 (Newsletter)

_Nou la pou ede w. What do you need?_`;
}

console.log("[makandal] Starting Makandal Socket Mode listener...");
loadKnowledge();
connect();
