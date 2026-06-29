import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const XAPP = process.env.SLACK_XAPP_TOKEN;
const XOXB = process.env.SLACK_XOXB_TOKEN;
const SLACK_API = "https://slack.com/api";
const BOT_USER_ID = "U0BELA72LLQ";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";
const MP_WEBSITE = process.env.METROPRINTS_WEBSITE || "https://metroprints.co";

const OBSIDIAN_VAULT = "/Users/shahsaint-cyr/Library/Mobile Documents/iCloud~md~obsidian/Documents/Skills";
const KNOWLEDGE_FILES = [
  "Skills/Metroprints/agents/Cal.md",
  "Skills/Metroprints/agents/Hermes Agent Architecture.md",
  "Skills/Metroprints/playbooks/hermes-agent-sop.md",
];

const NOTION_DBS = {
  activities: "27189d07-dc61-8122-acde-f2cffd",
  planning: "27189d07-dc61-8168-9182-ef0386dbd9e7",
  ori: "731bd0e1-0c8f-4db5-8fc5-4086e9cba134",
  projects: "27189d07-dc61-8140-abb6-d35934cf48a7",
  marketplace: "9bd3910c-6dc2-4bb7-81be-8af80b2a3e74",
};

let loadedKnowledge = "";

function loadKnowledge() {
  let combined = "";
  for (const rel of KNOWLEDGE_FILES) {
    try {
      const full = `${OBSIDIAN_VAULT}/${rel}`;
      combined += `\n\n--- ${rel} ---\n${readFileSync(full, "utf-8")}`;
    } catch (e) {
      console.error(`[cal] Could not load knowledge file ${rel}: ${e.message}`);
    }
  }
  loadedKnowledge = combined;
  return loadedKnowledge;
}

loadKnowledge();

function buildSystemPrompt() {
  return BASE_SYSTEM_PROMPT.replace("__KNOWLEDGE__", loadedKnowledge || "(no knowledge loaded — run /cal-learn to refresh)");
}

const BASE_SYSTEM_PROMPT = `You are Cal, MetroPrints' scheduling and calendar-coordination agent.

## Your Role
You manage the appointment calendar for mobile Live Scan visits. Casey hands you new scheduling requests when a case needs an appointment; you book it, confirm it, send reminders, and report outcomes back to Casey.

## IMPORTANT — your spec is still in draft
Your agent definition has not been fully confirmed yet. Specifically still open:
- Which calendar system you actually read/write (Google Calendar, Apple Calendar, or a Notion-based scheduling view) is not yet wired in
- Whether you manage technician/staff shift scheduling, or only client appointments, isn't confirmed
- Reminder channel(s) — SMS, email, or Slack — and how far ahead reminders fire, isn't confirmed

Because of this, you do NOT have a live calendar data source connected right now. If asked for today's actual schedule, specific appointment times, or to send a real reminder, say plainly that the calendar integration is still being finalized with Shah rather than inventing appointment data. You can still reason helpfully about scheduling logic, conflicts, and process in the abstract.

## What you do (once fully wired up)
- Manage the appointment calendar for mobile Live Scan visits
- Book new appointments handed off from Casey
- Confirm appointments with clients, send reminders ahead of the visit
- Handle reschedule and cancellation requests
- Coordinate technician availability and route/location sequencing for multi-stop days
- Flag scheduling conflicts, gaps, or overbooked windows
- Report completed and missed appointments back to Casey

## Cadence
- Event-driven: new scheduling request from Casey
- Daily AM review: confirmed schedule, route order, unresolved conflicts
- Reminder sends ahead of each appointment (target: 24 hours out)

## Coordination
- Casey: primary relationship — Casey hands you appointments, you report outcomes back
- Metro: appointment volume can roll into Metro's pipeline view
- Penny: a completed appointment is a billable-state signal Penny watches for, but Penny audits the transaction, not the appointment

## Style
Be direct and honest about what's not wired up yet. Don't fabricate calendar data.

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
    console.error("[cal] DeepSeek error:", e.message);
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
    "*Cal — scheduling & calendar coordination*",
    "`/cal <question>` — ask me anything scheduling-related",
    "`/cal-today` — today's schedule and route order",
    "`/cal-reminder` — send an appointment reminder",
    "`/cal-help` — this message",
    "`/cal-learn` — reload my Obsidian knowledge files",
    "",
    "Heads up: my calendar system integration is still being finalized, so schedule/reminder commands are honest stubs until that's wired in.",
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
    case "/cal-help":
      reply = [
        "*Cal — scheduling & calendar coordination*",
        "`/cal <question>` — ask me anything scheduling-related",
        "`/cal-today` — today's schedule and route order",
        "`/cal-reminder` — send an appointment reminder",
        "`/cal-learn` — reload my knowledge files",
      ].join("\n");
      break;
    case "/cal-learn":
      reply = "Reloading my knowledge files from Obsidian... (restart the listener to pick up edits — hot-reload isn't wired up yet, but I'll note this for the next deploy.)";
      break;
    case "/cal-today":
      reply = [
        "*Today's schedule* — I don't have a live calendar source connected yet.",
        "My spec (Cal.md) is still marked draft: which calendar system I read/write (Google, Apple, or Notion-based) hasn't been confirmed with Shah.",
        "Once that's wired in, this command will show today's confirmed Live Scan appointments and technician route order.",
      ].join("\n");
      break;
    case "/cal-reminder":
      reply = [
        "*Appointment reminder* — I can't send a real reminder yet.",
        "The reminder channel (SMS, email, or Slack) and lead time aren't confirmed in my spec yet.",
        "Tell me the appointment details and I can draft reminder copy for you to send manually in the meantime.",
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
    console.error("[cal] handle error:", e.message);
  }
}

async function connect() {
  const url = await getWebSocketUrl();
  console.log("[cal] Connecting to Slack Socket Mode...");
  const ws = new WebSocket(url);
  let pingInterval;

  ws.onopen = () => {
    console.log("[cal] Connected. Listening.");
    pingInterval = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "hello") {
        console.log(`[cal] Hello, connections: ${msg.num_connections}`);
        return;
      }

      if (msg.type === "disconnect") {
        console.log(`[cal] Disconnect: ${msg.reason}. Reconnecting...`);
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
      console.error("[cal] Error:", e.message);
    }
  };

  ws.onerror = (err) => console.error("[cal] WS error:", err.message || err);

  ws.onclose = (event) => {
    console.log(`[cal] Closed (${event.code}). Reconnect in 5s...`);
    clearInterval(pingInterval);
    setTimeout(connect, 5000);
  };
}

console.log("[cal] Starting Socket Mode listener...");
connect();
