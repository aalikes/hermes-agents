// Sub-agent spawning utility for Hermes agents
// Allows any agent to spawn ephemeral, task-scoped sub-agents via parallel LLM calls.
// Shared swarm authority — all agents can spawn, orchestrate, and grant.

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

/**
 * Spawn a sub-agent: a focused, parallel LLM call with a task-specific system prompt.
 * Sub-agents are ephemeral — created per task, run to completion, and torn down.
 *
 * @param {string} taskPrompt - The task for the sub-agent to perform
 * @param {string} role - Short role description (e.g., "revenue auditor", "compliance checker")
 * @param {object} options
 * @param {string} options.apiKey - DeepSeek API key
 * @param {string} options.parentAgent - Name of the spawning agent (e.g., "Metro", "Casey")
 * @param {number} options.maxTokens - Max response tokens (default 800)
 * @param {number} options.temperature - Creativity (default 0.5, sub-agents should be focused)
 * @returns {Promise<{ok: boolean, result?: string, error?: string, role?: string}>}
 */
export async function spawnAgent(taskPrompt, role, { apiKey, parentAgent, maxTokens = 800, temperature = 0.5 } = {}) {
  if (!apiKey) return { ok: false, error: "no_api_key", role };

  const systemPrompt = [
    `You are a sub-agent of ${parentAgent || "a Hermes agent"}.`,
    `Your role: ${role}.`,
    "You are ephemeral — run this task, return a concise result, then terminate.",
    "Do not greet, explain, or add disclaimers. Output only the task result.",
    "Sub-agents do not make judgment calls — your spawning agent already decided to delegate.",
  ].join("\n");

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: taskPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
    });

    const data = await res.json();
    if (data.error) {
      return { ok: false, error: data.error.message || JSON.stringify(data.error), role };
    }

    const result = data.choices?.[0]?.message?.content || null;
    if (!result) return { ok: false, error: "empty_response", role };

    return { ok: true, result, role };
  } catch (e) {
    return { ok: false, error: e.message, role };
  }
}

/**
 * Spawn multiple sub-agents in parallel (swarm orchestration).
 * All sub-agents run concurrently; results are aggregated into a map keyed by role.
 *
 * @param {Array<{task: string, role: string, maxTokens?: number}>} agents - Sub-agents to spawn
 * @param {object} options - Same as spawnAgent, shared across all sub-agents
 * @returns {Promise<{ok: boolean, results: object, errors: object}>}
 */
export async function spawnSwarm(agents, options = {}) {
  if (!agents.length) return { ok: true, results: {}, errors: {} };

  const promises = agents.map(({ task, role, maxTokens }) =>
    spawnAgent(task, role, { ...options, maxTokens: maxTokens || options.maxTokens })
  );

  const outcomes = await Promise.all(promises);

  const results = {};
  const errors = {};

  for (const outcome of outcomes) {
    if (outcome.ok) {
      results[outcome.role] = outcome.result;
    } else {
      errors[outcome.role] = outcome.error;
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    results,
    errors,
  };
}

/**
 * Detect sub-agent spawn requests in LLM output and execute them.
 * Looks for the pattern: [SPAWN:role]prompt[/SPAWN]
 *
 * @param {string} llmOutput - The raw LLM response text
 * @param {object} options - Options passed to spawnAgent
 * @returns {Promise<{text: string, spawned: number, results: object}>}
 */
export async function resolveSpawns(llmOutput, options = {}) {
  const spawnPattern = /\[SPAWN:([^\]]+)\]([\s\S]*?)\[\/SPAWN\]/g;
  const spawns = [];
  let match;

  while ((match = spawnPattern.exec(llmOutput)) !== null) {
    spawns.push({ role: match[1].trim(), task: match[2].trim() });
  }

  if (spawns.length === 0) return { text: llmOutput, spawned: 0, results: {} };

  const swarm = await spawnSwarm(spawns, options);

  let text = llmOutput;
  for (const { role } of spawns) {
    const result = swarm.results[role] || `(sub-agent ${role} failed: ${swarm.errors[role]})`;
    text = text.replace(
      new RegExp(`\\[SPAWN:${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*?\\[\\/SPAWN\\]`),
      `**[Sub-agent: ${role}]**\n${result}`
    );
  }

  return { text, spawned: spawns.length, results: swarm.results };
}
