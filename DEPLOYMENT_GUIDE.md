---
title: Hermes Agent Deployment Guide
type: playbook
system: MetroPrints
status: live
tags: [hermes, agent, deployment, slack, playbook, manifest]
created: 2026-06-29
---

# Hermes Agent Deployment Guide

Practical reference for deploying the next Hermes Slack agent (#5+), built from a direct comparison of the four live agents: Casey, Metro, Penny, Cal. This is a playbook, not a narrative — use it as a checklist when you spin up a new agent or debug an existing one.

**Supersedes, for architecture questions:** `hermes-agent-template.md` and `hermes-agent-sop.md` (both describe an older OpenCode + slack-mcp-server design that isn't what's actually running; both live in the Obsidian vault, not this repo). **Stays the reference for mechanics:** `hermes-deploy-workflow.md` (the one-command deploy script is accurate and current). See [Related Docs](#9-related-docs) for the full picture.

---

## 1. Architecture — What's Actually Running

Each agent is a standalone, zero-dependency Node.js process (`listener.mjs`), kept alive by `launchd`, holding one persistent Socket Mode WebSocket to Slack. When it needs to generate a reply, it calls DeepSeek's chat completions API directly (`think()` in the listener) — there is no OpenCode subagent in the live reply path.

```
launchd (KeepAlive)  →  node listener.mjs  →  WebSocket (xapp token)  →  Slack Socket Mode
                              │
                              └─→ DeepSeek chat completions (xoxb token used separately for Slack Web API calls)
```

The OpenCode `*-agent-def.md` files in the Obsidian vault (`Metroprints/agents/`) document each persona's role/spec and expose the workspace via `slack-<agent>_*` MCP tools — that's a parallel, read-mostly interface for a human (or OpenCode) to query the workspace as that persona. It is **not** how the bot answers `@mentions` or slash commands in Slack; don't confuse the two when debugging "the bot isn't responding."

---

## 2. Manifest Anatomy

| Field | Controls | Notes |
|---|---|---|
| `display_information.name/description/background_color` | Cosmetic — Slack directory listing | No functional effect |
| `features.bot_user.display_name/always_online` | Bot identity | |
| `features.app_home` | Home tab behavior | All 4 agents: home+messages tabs on, read-only off |
| `features.slash_commands[]` | **Registers** which `/commands` Slack will route to your app at all | Must list every command `handleCommand()` actually supports, or Slack rejects the command before your code ever sees it |
| `oauth_config.scopes.bot[]` | What the **xoxb token is allowed to do** via the Web API (post messages, read history, etc.) | Does **not** control what gets pushed to your socket — see Gotcha #1 |
| `settings.event_subscriptions.bot_events[]` | What gets **pushed to you** as `events_api` envelopes over the socket | Independent of OAuth scopes |
| `settings.interactivity.is_enabled` | Required for buttons/modals | All 4 set `true`; none currently use interactive components |
| `settings.socket_mode_enabled` | Must be `true` for an xapp-token listener | |
| `org_deploy_enabled` / `token_rotation_enabled` | Enterprise Grid features | Leave `false` unless you specifically need them |

### Manifest comparison (verified against live files, 2026-06-29)

| | Casey | Metro | Penny | Cal |
|---|---|---|---|---|
| Slash commands | 13 | 8 | 5 | 5 |
| Bot OAuth scopes | 20 | **13** | 20 | 20 |
| `event_subscriptions.bot_events` | 6 (identical set) | 6 | 6 | 6 |
| `interactivity.is_enabled` | true | true | true | true |
| `socket_mode_enabled` | true | true | true | true |

Metro is missing 7 scopes that Casey/Penny/Cal all have: `assistant:write`, `channels:join`, `channels:manage`, `files:read`, `files:write`, `groups:write`, `usergroups:read`. Metro still works because its actual usage never touches those scopes — but if you copy Metro's manifest as a starting point for a new agent, you're copying the short list, not the current standard.

**Takeaway:** Penny's and Cal's manifest *content* was never the problem — field-for-field they're identical to Casey's. The problem was entirely operational (see Gotcha #1 below).

---

## 3. Gotcha #1 — Manifest paste activates Event Subscriptions, not OAuth scopes

`manifest.json` sitting in a repo is just a file. Slack does not read it automatically, ever. The live app configuration only changes when:
- a human pastes that JSON into **api.slack.com/apps → your app → Features → App Manifest → Save**, or
- something calls `apps.manifest.update` with a short-lived `xoxe.xoxp-1` **config token** — which the running listener process does not have (it only holds `xoxb`/`xapp`).

Casey and Metro work because someone pasted their manifests into the dashboard already, most likely by hand during initial setup, before `hermes-deploy.mjs` existed. Penny and Cal shipped with manifests that are structurally identical to Casey's (see table above) and still didn't respond to `@mentions` — because nobody had pasted either one into its dashboard yet.

**Diagnostic signature:** the listener's Socket Mode handshake succeeds (you see `hello` in the log, no errors), `launchctl list` shows the process running — but zero events ever arrive, and slash commands return Slack's "command not found"-style failure. A clean WebSocket connection only proves the `xapp` token is valid. It proves nothing about whether Event Subscriptions or Slash Commands are turned on app-side.

**Check before declaring an agent live:** open the app's Event Subscriptions page and Slash Commands page directly in the dashboard and confirm they list what you expect — don't infer activation from "the process is running and the manifest file looks right."

---

## 4. Gotcha #2 (new finding from this comparison) — slash-command envelope type mismatch, fleet-wide

Comparing all four `listener.mjs` files side by side surfaced a second, independent bug: **none of the four agents can currently dispatch a real Slack slash command**, for two different reasons:

- **Casey & Metro:** the slash-command check is nested inside `if (msg.type === "events_api" && msg.payload?.event) { const evt = msg.payload.event; ... if (evt.type === "slash_command") {...} }`. Slash-command invocations never arrive as a nested `event` inside an `events_api` envelope — they arrive as their own top-level envelope type. This branch is structurally unreachable.
- **Penny & Cal:** the check sits at the correct top level (`if (msg.type === "slash_command")`), but Slack's actual Socket Mode envelope type for slash commands is `"slash_commands"` (**plural**), confirmed against Slack's own Socket Mode documentation. The literal never matches, so this branch never fires either.

Net effect: `handleCommand()` in every agent is complete, working logic that real Slack traffic never reaches.

**Status: diagnosed from source code, not yet confirmed against a live captured envelope.** No one has watched an actual `slash_commands` payload get silently dropped on any of the four listeners. Before patching, do a 5-minute live check: add `console.log(msg.type)` at the top of `onmessage` for one agent, run one of its slash commands in Slack, and confirm `slash_commands` shows up in the log and is being ignored.

**Where this lives, and why it will keep propagating:** the bug exists in `casey/listener.mjs`, `metro/listener.mjs` (nested form), `penny/listener.mjs`, `cal/listener.mjs` (mis-stringed form), **and** in the canonical `listener-template.mjs` and the template-source copy at `casey/listener.mjs` that `hermes-deploy.mjs` copies for every new agent. Fixing it only in a deployed agent's own folder does not fix it for agent #5 — fix the template first.

**Fix (once confirmed live):** in Casey/Metro, pull the slash-command check out of the `events_api` branch and place it at the top level, where Penny/Cal's already is. In all four, plus the template, correct the string to `"slash_commands"`.

---

## 5. Where the Files Actually Live (read this before editing anything)

There are **two repos**, and they are not the same thing:

| Repo | Role | Path |
|---|---|---|
| `metroprints` | **Live / canonical.** `launchd` plists point here. Editing here changes runtime behavior after a restart. | `~/Projects/metroprints/agents/{casey,metro,penny,cal}/`, deploy script at `~/Projects/metroprints/scripts/hermes-deploy.mjs` |
| `hermes-agents` (this repo) | **Backup mirror**, git-tracked. Confirmed (via file size/line-count/mtime comparison) to be point-in-time snapshots copied *from* `metroprints/agents/*` minutes-to-hours after the live files were last edited — not the other way around. | `~/Projects/hermes-agents/{casey,metro,penny,cal}/`, plus a stale copy of the deploy script and `listener-template.mjs` |

**Implication:** editing files in *this repo* does nothing to the running bot. Fix bugs (including Gotcha #2) in `metroprints/agents/<name>/listener.mjs` and in `metroprints/scripts/hermes-deploy.mjs`, restart via `launchctl`, confirm live, *then* re-sync this backup copy. This repo's own `hermes-deploy.mjs` and `listener-template.mjs` are themselves stale snapshots — that's why the `TEMPLATE` path inside this repo's `hermes-deploy.mjs` resolves outside the repo (it assumes an `agents/` subfolder that only exists in `metroprints`, not here). Don't try to run a deploy from inside this repo; use the `metroprints/scripts/` copy.

---

## 6. Deployment Checklist for the Next Agent

### Must-have — blocks a working bot or silently ships a known bug forward

1. **Fix `hermes-deploy.mjs`'s built-in scope list** (currently the 13-scope Metro-era list) to the live 20-scope standard before the next deploy — add `assistant:write`, `channels:join`, `channels:manage`, `files:read`, `files:write`, `groups:write`, `usergroups:read`. Otherwise every new agent launches under-scoped and someone has to hand-patch it the same way Penny/Cal apparently were.
2. **Fix the slash-command envelope bug (Gotcha #2)** in `metroprints/agents/casey/listener.mjs` (the deploy script's template source) and in `listener-template.mjs` before generating agent #5 — otherwise the bug ships into the new agent too.
3. **Paste the generated manifest into api.slack.com/apps → App Manifest → Save before declaring the agent live (Gotcha #1).** Treat this as a hard gate you verify in the dashboard, not just the console reminder the script already prints at the end of its run.
4. **Create the matching `<name>-agent-def.md`** in the Obsidian vault's `Metroprints/agents/` folder, following the existing frontmatter (`description`, `mode: subagent`, `model: deepseek/deepseek-v4-pro`, `permission`) plus the Role / What-you-do / Cadence / Coordination / Slack-tools / Slash-commands / Reference section pattern used by `casey-agent-def.md`, `penny-agent-def.md`, and `cal-agent-def.md`. **Metro currently has none of this** — it's the gap to backfill, not just a pattern to repeat going forward.
5. **Mirror `<name>-listener.mjs` and `<name>-manifest.json`** into that same Obsidian folder. Casey, Penny, and Cal all have this mirror; **Metro is missing both files.**
6. **Make sure the agent-def.md Reference table's Listener/Plist paths match where the agent's files actually live** — point at `metroprints/agents/<name>/`, not this repo's `<name>/` (see Section 5). Don't copy a reference table from an older template without checking the paths still resolve.
7. **If the new agent's spec has unresolved design questions** (the way Cal's calendar-system, staff-scheduling-scope, and reminder-channel decisions are still open), say so explicitly in both the Obsidian spec page and the agent-def.md's own "IMPORTANT" section, and make `handleCommand()` return an honest "not wired up yet" stub for anything touching that gap — don't let the LLM fabricate a confident answer about an integration that doesn't exist.
8. **Check for naming/lineage collisions before shipping.** Two were found in this fleet after the fact: the "Casey" name is used both for this case-routing persona and for a separately-documented Slack-admin bot elsewhere in the workspace; and Cal's spec claims no predecessor agent existed, when an existing "Live Scan Appointment Formatter" (documented in the workspace's "AI Workflow Skill Set" Notion page) already did technician-formatting and ORI-code resolution that overlaps with Cal's stated scope. Search Notion and Obsidian `systems/` docs for the new agent's name and core function before finalizing its spec.

### Nice-to-have

- **Reconcile the agent-count mismatch.** The MetroPrints Workflow Audit (Notion, 2026-06-28) recommends five generically-named Hermes agents (Ops Intelligence, Intake & Case Router, Task Triage & Escalation, Finance & Transaction Control, Knowledge/Content & Sync); this fleet ships four persona-named agents (Metro, Casey, Penny, Cal) covering similar ground under different names. Not reconciled as of this writing. Fine to leave as-is operationally — but when you spec agent #5, add one line stating which of the five generic roles it covers, so the mapping doesn't have to be re-derived from scratch later.
- Add the missing Notion DB citations to specs that don't have them (Cal and Metro don't currently cite the databases their stated scope implies, e.g. `MP - ORI Codes`, `MP - Appointments`).
- Fix Metro's fallback-reply text, which still reads "I'm Casey, the MetroPrints workspace admin" — a copy-paste leftover from building Metro off Casey's listener. Cosmetic, but user-visible.
- Decide whether `interactivity.is_enabled: true` is worth keeping at `true` by default — no agent currently ships buttons or modals, so it's unused either way.

---

## 7. Diagnostic & Support Slash Commands (Proposed)

Current command surface: Casey 13 (general Q&A, audit/channels/members/status, alert, recall, help, learn, plus 4 FBI-case commands), Metro 8 (Q&A, snapshot, pipeline, revenue, briefing, content, help, learn), Penny 5 (Q&A, revenue, qa, help, learn), Cal 5 (Q&A, today, reminder, help, learn). **None of the four currently has anything that checks the bot's own health** — the closest is Casey's `/casey-status`, which reports workspace state (channels, members), not the listener process's own connection state.

**Caveat:** a new diagnostic command is itself a slash command, so it inherits Gotcha #2 — if the envelope-type bug isn't fixed first, a new `/agent-diag` won't fire either. Item 0 below is the exception; it doesn't depend on slash-command dispatch at all and should ship regardless of when the bug gets fixed.

0. **Verbose envelope logging — not a slash command, a permanent listener habit.** Add `console.log(`[agent] recv type=${msg.type}`)` at the very top of `onmessage`, before any branching. This single line would have surfaced Gotcha #2 immediately, by showing `slash_commands` arriving and never matching anything — instead it took a side-by-side source read across four files to find. Make this the default in the template.
1. **`/<name>-diag`** — process/connection health: socket connected (bool), connection uptime, time since last event of any kind, time since last ping/pong, dedup-set size, active-thread count, whether `DEEPSEEK_API_KEY` is present (masked, never the value). Answers "is this process actually alive and talking to Slack" without tailing log files.
2. **`/<name>-tokencheck`** — calls `auth.test` with the bot's own `xoxb` token and reports team/user/bot ID or the exact Slack error; attempts `apps.connections.open` with the `xapp` token to confirm Socket Mode auth still works. Turns the manual curl-the-token step from the troubleshooting table into a one-line in-Slack check.
3. **`/<name>-eventcheck`** — heuristic Event Subscriptions health: track `connectedAt` and `firstEventAt` (first `events_api` envelope ever received) in memory. If the connection has been up for a long time with zero events ever received, surface "Event Subscriptions may not be activated — confirm the manifest was pasted at api.slack.com/apps." Can't read the dashboard's actual config (that needs a config token this process doesn't have), but gets most of the way there without a human cross-referencing logs.
4. **`/<name>-ping`** — deliberately trivial echo-with-timestamp. The simplest possible canary for "did slash-command dispatch work end-to-end at all" — run this before troubleshooting anything fancier.
5. **Fleet-level, not per-agent: `scripts/fleet-doctor.mjs`** — reads each agent's `xoxb`/`xapp` tokens (from its plist's `EnvironmentVariables` or a shared `.env`) and loops `auth.test` + `apps.connections.open` across all deployed agents in one pass, printing a status table. Replaces the one-at-a-time root-cause hunt (checking `launchctl list`, tailing four separate log files, curling tokens individually) with a single command.

---

## 8. Quick Reference

| Agent | Slack app | Bot user ID | Live listener path |
|---|---|---|---|
| Casey | `A0BDNNVFFDG` | `U0BD79D3ZHD` | `~/Projects/metroprints/agents/casey/listener.mjs` |
| Metro | not confirmed in this pass — see Slack app Basic Information page | — | `~/Projects/metroprints/agents/metro/listener.mjs` |
| Penny | not confirmed in this pass — see Slack app Basic Information page | — | `~/Projects/metroprints/agents/penny/listener.mjs` |
| Cal | `A0BDA5DA63H` | `U0BELA72LLQ` | `~/Projects/metroprints/agents/cal/listener.mjs` |

All four: workspace MetroPrints (`T0BD9B6L8V6`); plist at `~/Library/LaunchAgents/com.metroprints.<name>.listener.plist`; logs at `~/Library/Logs/com.metroprints.<name>.listener.{log,error.log}`. Backup mirror of each agent's files: this repo, `~/Projects/hermes-agents/<name>/` (see Section 5 for why this is a mirror, not the source of truth).

Token types, for anyone new to Slack apps: `xapp-...` is the app-level token used only to open the Socket Mode WebSocket (`apps.connections.open`); `xoxb-...` is the bot token used for every other Web API call (`chat.postMessage`, `auth.test`, etc.). Neither is the config token (`xoxe.xoxp-1-...`) needed to push manifest changes programmatically — that token isn't issued to the running listener at all, which is part of why Gotcha #1 has to be resolved by hand in the dashboard.

---

## 9. Related Docs

- **`hermes-deploy-workflow.md`** (Obsidian `Metroprints/playbooks/`) — accurate and current. Keep using it for the one-command "spin up agent #5" mechanics (`node scripts/hermes-deploy.mjs <name> <xapp> <xoxb> <bot-user-id> [description]`).
- **`hermes-agent-template.md`** (Obsidian `Metroprints/agents/`) — describes Casey's original OpenCode + `slack-mcp-server` + Socket-Mode-listener architecture. The listener code template in it still has the same Gotcha #2 pattern (nested `events_api` check). Useful for the OpenCode agent-definition `.md` frontmatter convention; not authoritative for how the bot replies live in Slack — see Section 1.
- **`hermes-agent-sop.md`** (Obsidian `Metroprints/playbooks/`) — same OpenCode-centric architecture, additionally sets `interactivity.is_enabled: false` in its manifest snippet, which contradicts the live standard (`true`) across all four agents. Superseded by this guide for architecture questions.
- **`slack-agent-runbook.md`** (Obsidian `Metroprints/playbooks/`) — describes an unrelated "OpenClaw" gateway/CLI system (`openclaw.json`, `openclaw status --deep`, etc.) that this fleet does not run anywhere. None of its commands apply to Casey/Metro/Penny/Cal. Recommend retiring or re-scoping it so it isn't mistaken for guidance relevant to this stack.
- **Notion — "MetroPrints Workflow Audit — Agent + Automation Improvement Breakdown"** and **"🔎 Hermes Agent Architecture — Gap Analysis & Cron Audit (2026-06-28)"** — source of the 5-vs-4 agent mismatch and Cal's lineage gap cited in Section 6.

---

*Mirrored at: Obsidian vault `Metroprints/agents/DEPLOYMENT_GUIDE.md`.*
