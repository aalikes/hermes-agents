// Shared utilities for Hermes agent cron jobs
// Loaded by agent cron scripts to post to Slack, call LLM, query Notion

import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME;
const AGENTS_ROOT = join(import.meta.dirname, "..");

function loadEnv(agentName) {
  const plistPath = join(HOME, "Library", "LaunchAgents", `com.metroprints.${agentName}.listener.plist`);
  try {
    const plist = readFileSync(plistPath, "utf-8");
    const env = {};

    const keyMatch = (key) => {
      const regex = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "s");
      const m = plist.match(regex);
      return m ? m[1].trim() : null;
    };

    env.SLACK_XOXB_TOKEN = keyMatch("SLACK_XOXB_TOKEN");
    env.NOTION_API_KEY = keyMatch("NOTION_API_KEY");
    env.DEEPSEEK_API_KEY = keyMatch("DEEPSEEK_API_KEY");
    env.SLACK_BOT_USER_ID = keyMatch("SLACK_BOT_USER_ID");

    return env;
  } catch (e) {
    console.error(`Failed to read plist for ${agentName}:`, e.message);
    return {};
  }
}

export async function slackPost(channel, text, agentName) {
  const env = loadEnv(agentName);
  if (!env.SLACK_XOXB_TOKEN) {
    console.error(`No SLACK_XOXB_TOKEN found for ${agentName}`);
    return null;
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.SLACK_XOXB_TOKEN}`,
    },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error(`Slack post failed: ${data.error}`);
    return null;
  }
  return data;
}

export async function llmThink(systemPrompt, userPrompt, agentName) {
  const env = loadEnv(agentName);
  if (!env.DEEPSEEK_API_KEY) {
    console.error(`No DEEPSEEK_API_KEY found for ${agentName}`);
    return null;
  }

  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1200,
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  if (data.error) {
    console.error("LLM error:", JSON.stringify(data.error));
    return null;
  }
  return data.choices?.[0]?.message?.content || null;
}

export async function notionQuery(databaseId, agentName) {
  const env = loadEnv(agentName);
  if (!env.NOTION_API_KEY) {
    console.error(`No NOTION_API_KEY found for ${agentName}`);
    return null;
  }

  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ page_size: 50 }),
  });

  const data = await res.json();
  if (data.object === "error") {
    console.error("Notion error:", data.message);
    return null;
  }
  return data.results || [];
}

export function formatET() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function toET(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
}
