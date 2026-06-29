#!/usr/bin/env node
// hermes-deploy — One-command Hermes agent deployment
// Usage: ./hermes-deploy.mjs <name> <xapp> <xoxb> <bot-user-id>

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const [,, name, xapp, xoxb, botUserId, description] = process.argv;

if (!name || !xapp || !xoxb || !botUserId) {
  console.log("Usage: hermes-deploy <name> <xapp> <xoxb> <bot-user-id> [description]");
  console.log("Example: hermes-deploy Penny xapp-1-... xoxb-... U1234 'Finance oversight agent'");
  process.exit(1);
}

const AGENTS_DIR = join(import.meta.dirname, "..", "agents", name.toLowerCase());
const TEMPLATE = join(import.meta.dirname, "..", "agents", "casey", "listener.mjs");
const LAUNCHD_DIR = join(process.env.HOME, "Library", "LaunchAgents");
const LOGS_DIR = join(process.env.HOME, "Library", "Logs");
const PLIST_PATH = join(LAUNCHD_DIR, `com.metroprints.${name.toLowerCase()}.listener.plist`);

console.log(`\n🚀 Deploying Hermes agent: ${name}\n`);

// 1. Create agent directory
mkdirSync(AGENTS_DIR, { recursive: true });
console.log(`📁 ${AGENTS_DIR}`);

// 2. Copy and customize listener
let code = readFileSync(TEMPLATE, "utf-8");

// Replace bot user ID
code = code.replace(/BOT_USER_ID = process\.env\.SLACK_BOT_USER_ID \|\| ""/, `BOT_USER_ID = "${botUserId}"`);
code = code.replace(/const BOT_USER_ID = "U0BD79D3ZHD"/, `const BOT_USER_ID = "${botUserId}"`);

// Replace console prefix from Casey to agent name
code = code.replace(/\[casey\]/g, `[${name.toLowerCase()}]`);

// Replace Obsidian knowledge files with agent-specific ones
code = code.replace(
  /const KNOWLEDGE_FILES = \[[\s\S]*?\];/,
  `const KNOWLEDGE_FILES = [\n  "Skills/Metroprints/agents/${name}.md",\n  "Skills/Metroprints/playbooks/hermes-agent-sop.md",\n];`
);

// Replace start message
code = code.replace(/Starting Casey Socket Mode listener/, `Starting ${name} Socket Mode listener`);

const listenerPath = join(AGENTS_DIR, "listener.mjs");
writeFileSync(listenerPath, code);
console.log(`📝 ${listenerPath}`);

// 3. Create launchd plist
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.metroprints.${name.toLowerCase()}.listener</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/local/bin/node</string>
\t\t<string>${listenerPath}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>WorkingDirectory</key>
\t<string>${AGENTS_DIR}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>DEEPSEEK_API_KEY</key>
\t\t<string>sk-94b26e5ce5de4c3d822b791f1c774677</string>
\t\t<key>SLACK_XAPP_TOKEN</key>
\t\t<string>${xapp}</string>
\t\t<key>SLACK_XOXB_TOKEN</key>
\t\t<string>${xoxb}</string>
\t\t<key>SLACK_BOT_USER_ID</key>
\t\t<string>${botUserId}</string>
\t\t<key>NOTION_API_KEY</key>
\t\t<string>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</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${LOGS_DIR}/com.metroprints.${name.toLowerCase()}.listener.log</string>
\t<key>StandardErrorPath</key>
\t<string>${LOGS_DIR}/com.metroprints.${name.toLowerCase()}.listener.error.log</string>
</dict>
</plist>`;

writeFileSync(PLIST_PATH, plist);
console.log(`🔧 ${PLIST_PATH}`);

// 4. Copy package.json from Casey for imapflow
const caseyPkg = join(import.meta.dirname, "..", "agents", "casey", "package.json");
if (existsSync(caseyPkg)) {
  writeFileSync(join(AGENTS_DIR, "package.json"), readFileSync(caseyPkg));
  console.log(`📦 package.json copied`);
}

// 5. Create manifest template
const manifest = {
  display_information: {
    name,
    description: description || `${name} — MetroPrints agent`,
    background_color: "#1a1a2e"
  },
  features: {
    bot_user: { display_name: name, always_online: true },
    app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    slash_commands: [
      { command: `/${name.toLowerCase()}`, description: `Ask ${name} anything`, usage_hint: "[question]", should_escape: false },
      { command: `/${name.toLowerCase()}-help`, description: "Show available commands", should_escape: false },
      { command: `/${name.toLowerCase()}-learn`, description: "Refresh knowledge from Obsidian vault", should_escape: false }
    ]
  },
  oauth_config: {
    scopes: {
      bot: ["app_mentions:read","channels:history","channels:read","chat:write","commands","groups:history","groups:read","im:history","im:read","im:write","reactions:read","reactions:write","users:read"]
    }
  },
  settings: {
    event_subscriptions: { bot_events: ["app_home_opened","app_mention","message.channels","message.groups","message.im","message.mpim"] },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
    token_rotation_enabled: false
  }
};

writeFileSync(join(AGENTS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`📋 manifest.json`);

// 6. Load launchd
try {
  // Unload existing if any
  execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`, { stdio: "pipe" });
  execSync(`launchctl load "${PLIST_PATH}"`, { stdio: "pipe" });
  console.log(`✅ launchd loaded`);
} catch (e) {
  console.log(`⚠️  launchd load failed: ${e.message}`);
}

// 7. Summary
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ ${name} deployed!\n`);
console.log(`  Listener: ${listenerPath}`);
console.log(`  Plist:    ${PLIST_PATH}`);
console.log(`  Logs:     ${LOGS_DIR}/com.metroprints.${name.toLowerCase()}.listener.log`);
console.log(`  Status:   launchctl list | grep ${name.toLowerCase()}`);
console.log(`\n  Next step: Paste manifest at api.slack.com/apps → App Manifest`);
console.log(`  Then: @${name} should respond in Slack`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
