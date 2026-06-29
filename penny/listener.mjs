import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const XAPP = process.env.SLACK_XAPP_TOKEN;
const XOXB = process.env.SLACK_XOXB_TOKEN;
const SLACK_API = "https://slack.com/api";
const BOT_USER_ID = "U0BDVLQNWCC";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const MP_WEBSITE = process.env.METROPRINTS_WEBSITE || "https://metroprints.co";

const OBSIDIAN_VAULT = "/Users/shahsaint-cyr/Library/Mobile Documents/iCloud~md~obsidian/Documents/Skills";
const KNOWLEDGE_FILES = [
  "Skills/Metroprints/agents/Penny.md",
  "Skills/Metroprints/agents/Hermes Agent Architecture.md",
  "Skills/Metroprints/playbooks/hermes-agent-sop.md",
];

const NOTION_DBS = {
  activities: "27189d07-dc61-8122-acde-f2cffd",
  planning: "27189d07-dc61-8168-9182-ef0386dbd9e7",
  ori: "731bd0e1-0c8f-4db5-8fc5-4086e9cba134",
  projects: "27189d07-dc61-8140-abb6-d35934cf48a7",
  marketplace: "9bd3910c-6dc2-4bb7-81be-8af80b2a3e74",
  finance: "e3f5a9cf-2e0e-4c7d-90b1-8672c61b20e7",
  transactions: "36389d07-dc61-8160-8a02-e9f966e9a39d",
  budgets: "36389d07-dc61-816a-af99-eb57bd0b7d9f",
};

let loadedKnowledge = "";

function loadKnowledge() {
  let combined = "";
  for (const rel of KNOWLEDGE_FILES) {
    try {
      const full = `${OBSIDIAN_VAULT}/${rel}`;
      combined += `\n\n--- ${rel} ---\n${readFileSync(full, "utf-8")}`;
    } catch (e) {
      console.error(`[penny] Could not load knowledge file ${rel}: ${e.message}`);
    }
  }
  loadedKnowledge = combined;
  return loadedKnowledge;
}

loadKnowledge();

function buildSystemPrompt() {
  return BASE_SYSTEM_PROMPT.replace("__KNOWLEDGE__", loadedKnowledge || "(no knowledge loaded — run /penny-learn to refresh)");
}

const BASE_SYSTEM_PROMPT = `You are Penny, MetroPrints' finance oversight agent.

## Your Role
You audit the finance data that Make automations produce. You do NOT do raw transaction logging — that work belongs to Make scenarios (FBI Fee Logger, Fuel Tracker, USPS Logger, Square/Stripe Logger, all retired as agents, increasingly consolidated into a single Unified Expense Email Logger Make scenario). Your job is judgment: oversight, anomaly detection, exception review.

## What you do
- Audit Make-created finance entries for completeness and accuracy
- Flag missing categories on logged transactions
- Flag duplicate-looking transactions
- Check whether the Finance Tracker has gone 7+ days without an update
- Summarize revenue / expense health on request
- Flag unusual expenses or revenue drops
- Review dedup registry failures

## What you explicitly do NOT do
- You do not log new transactions yourself — that's Make's job now. If asked to log a fuel purchase, Square sale, or USPS fee, say so and point to Make.
- You do not treat the old FBI Fee Logger, Fuel Tracker, or USPS Logger as your job. They're retired as agents.

## Cadence
- Weekly finance QA pass
- Saturday revenue/anomaly pass, coordinated with Metro (Metro = ops-level anomaly flagging, you = transaction-level audit for the same period)

## Coordination
- Metro: joint Saturday pass
- Casey: a case reaching a billable state is a signal you watch for, but Make logs the actual transaction

## Style
Direct, numbers-first, honest about data gaps. If the Finance Tracker / Notion data isn't wired into a specific ask yet, say so plainly instead of fabricating figures. Keep replies tight.

__KNOWLEDGE__`;

async function slack(method, body, token = XOXB) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
  return text.includes(`<@${BOT_USER_ID}>`);
}
function cleanText(text) {
  return text.replace(new RegExp(`<@${BOT_USER_ID}>\\s*`, "g"), "").trim();
}

const activeThreads = new Map();
function trackThread(threadTs) {
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
  return false;
}

const recentEvents = new Set();
function isDuplicate(evt) {
  const key = `${evt.channel}:${evt.user}:${evt.ts}`;
  if (recentEvents.has(key)) return true;
  recentEvents.add(key);
  setTimeout(() => recentEvents.delete(key), 5000);
  return false;
}

async function checkWebsite() {
  try {
    const start = Date.now();
    const res = await fetch(MP_WEBSITE, { method: "HEAD" });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

async function foldContext(messages) {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (total <= 15000) return messages;
  const cut = Math.floor(messages.length * 0.6);
  const old = messages.slice(0, cut);
  const recent = messages.slice(cut);
  const summaryText = old.map((m) => `${m.role}: ${m.content}`).join("\n");
  const summary = await think([
    { role: "system", content: "Summarize this conversation in 2-3 sentences. Preserve: names, case details, decisions, action items." },
    { role: "user", content: summaryText },
  ]);
  return [{ role: "system", content: `[Earlier conversation summary] ${summary}` }, ...recent];
}

async function think(messages) {
  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.7, max_tokens: 1000 }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.choices?.[0]?.message?.content?.trim() || "I wasn't able to generate a response.";
  } catch (e) {
    console.error("[penny] DeepSeek error:", e.message);
    return `I hit an error talking to my reasoning backend: ${e.message}`;
  }
}

async function fetchThreadHistory(channel, threadTs) {
  try {
    const res = await slack("conversations.replies", { channel, ts: threadTs, limit: 20 });
    if (!res.ok) return [];
    return res.messages.map((m) => ({
      role: m.user === BOT_USER_ID ? "assistant" : "user",
      content: m.text || "",
    }));
  } catch {
    return [];
  }
}

async function showHelp(channel, thread) {
  const text = [
    "*Penny — finance oversight*",
    "`/penny <question>` — ask me anything finance-related",
    "`/penny-revenue` — revenue / expense health summary",
    "`/penny-qa` — run a finance QA pass (missing categories, duplicates, stale tracker, anomalies)",
    "`/penny-help` — this message",
    "`/penny-learn` — reload my Obsidian knowledge files",
    "",
    "Or just @mention me / reply in a thread I'm active in.",
  ].join("\n");
  await slack("chat.postMessage", { channel, text, thread_ts: thread });
}

async function handleCommand(command, channel, user, text, responseUrl) {
  if (responseUrl) {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: "One moment..." }),
    }).catch(() => {});
  }

  let reply;
  switch (command) {
    case "/penny-help":
      reply = [
        "*Penny — finance oversight*",
        "`/penny <question>` — ask me anything finance-related",
        "`/penny-revenue` — revenue / expense health summary",
        "`/penny-qa` — run a finance QA pass",
        "`/penny-learn` — reload my knowledge files",
      ].join("\n");
      break;
    case "/penny-learn":
      reply = "Reloading my knowledge files from Obsidian... (restart the listener to pick up edits — hot-reload isn't wired up yet, but I'll note this for the next deploy.)";
      break;
    case "/penny-revenue": {
      const web = await checkWebsite();
      reply = [
        "*Revenue / expense health* — currently a lightweight pass, not yet wired to the live Finance Tracker database.",
        `MetroPrints site check: ${web.ok ? `up (${web.latencyMs}ms)` : `issue — ${web.error || web.status}`}`,
        "For full revenue figures I need the Finance Tracker Notion database ID wired into my NOTION_DBS config — flag that to Shah if you need real numbers right now. In the meantime, Saturday's joint pass with Metro is the place to look for the latest anomaly read.",
      ].join("\n");
      break;
    }
    case "/penny-qa":
      reply = [
        "*Finance QA pass* — checklist mode (live Notion audit not yet wired in):",
        "• Missing categories on recent entries — needs Finance Tracker DB connection",
        "• Duplicate-looking transactions — needs Finance Tracker DB connection",
        "• Finance Tracker staleness (7+ day check) — needs Finance Tracker DB connection",
        "• Dedup registry failures — needs dedup registry DB connection",
        "",
        "I can reason about any of this the moment those DB IDs are added to my config. Until then, ask me directly and I'll do my best from context.",
      ].join("\n");
      break;
    default:
      reply = await think([{ role: "system", content: buildSystemPrompt() }, { role: "user", content: text || "Hi" }]);
  }

  if (responseUrl) {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text: reply }),
    }).catch(() => {});
  } else {
    await slack("chat.postMessage", { channel, text: reply });
  }
}

async function handle(channel, user, text, threadTs) {
  try {
    const thread = threadTs || undefined;
    const history = thread ? await fetchThreadHistory(channel, thread) : [];
    let messages = [{ role: "system", content: buildSystemPrompt() }, ...history, { role: "user", content: text }];
    messages = await foldContext(messages);
    const reply = await think(messages);
    await slack("chat.postMessage", { channel, text: reply, thread_ts: thread });
    trackThread(thread || channel);
  } catch (e) {
    console.error("[penny] handle error:", e.message);
  }
}

async function connect() {
  const url = await getWebSocketUrl();
  console.log("[penny] Connecting to Slack Socket Mode...");
  const ws = new WebSocket(url);
  let pingInterval;

  ws.onopen = () => {
    console.log("[penny] Connected. Listening.");
    pingInterval = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "hello") {
        console.log(`[penny] Hello, connections: ${msg.num_connections}`);
        return;
      }

      if (msg.type === "disconnect") {
        console.log(`[penny] Disconnect: ${msg.reason}. Reconnecting...`);
        clearInterval(pingInterval);
        ws.close();
        setTimeout(connect, 1000);
        return;
      }

      if (msg.type === "slash_commands" && msg.payload) {
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id, type: "ack" }));
        const p = msg.payload;
        await handleCommand(p.command, p.channel_id, p.user_id, p.text, p.response_url);
        return;
      }

      if (msg.type === "events_api" && msg.payload?.event) {
        const evt = msg.payload.event;
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id, type: "ack" }));

        if (evt.user === BOT_USER_ID) return;
        if (evt.subtype === "message_changed" || evt.subtype === "message_deleted") return;
        if (isDuplicate(evt)) return;

        const text = evt.text || "";

        if (evt.type === "message" && isActiveThread(evt) && text.trim()) {
          await handle(evt.channel, evt.user, cleanText(text), evt.thread_ts || evt.ts);
          return;
        }
        if (evt.type === "app_mention") {
          await handle(evt.channel, evt.user, cleanText(text), evt.thread_ts || evt.ts);
          return;
        }
        if (evt.type === "message" && isMentioned(text)) {
          await handle(evt.channel, evt.user, cleanText(text), evt.thread_ts || evt.ts);
          return;
        }
      }
    } catch (e) {
      console.error("[penny] Error:", e.message);
    }
  };

  ws.onerror = (err) => console.error("[penny] WS error:", err.message || err);

  ws.onclose = (event) => {
    console.log(`[penny] Closed (${event.code}). Reconnect in 5s...`);
    clearInterval(pingInterval);
    setTimeout(connect, 5000);
  };
}

console.log("[penny] Starting Socket Mode listener...");
connect();
