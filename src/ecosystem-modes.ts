/**
 * ECOSYSTEM MODES — Agent execution engine
 * Runs agents via LLM with structured prompts and chaining support.
 */

import { callLLM } from "./llm-router.tsx";
import {
  getAgent,
  getAgentsByMode,
  type AgentEntry,
} from "./ecosystem-manifest.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentResult {
  data: Record<string, unknown>;
  meta: {
    agent: string;
    mode: string;
    latencyMs: number;
    next_actions: Array<{ tool: string; hint: string }>;
    memory_hint: { key: string; namespace: string };
  };
}

export interface ModeReport {
  mode: string;
  startedAt: string;
  completedAt: string;
  totalLatencyMs: number;
  results: AgentResult[];
  errors: Array<{ agent: string; error: string }>;
}

export interface ChainResult {
  task: string;
  chain: string[];
  startedAt: string;
  completedAt: string;
  totalLatencyMs: number;
  steps: AgentResult[];
  finalOutput: Record<string, unknown>;
}

// ─── Mode Configs ─────────────────────────────────────────────────────────────

export const MODES = {
  test: {
    name: "test",
    description: "Load testing, pipeline validation, chaos engineering, bug hunting",
    defaultSequence: ["load_tester", "pipeline_tester", "chaos_agent", "bug_hunter"],
    timeout: 120000,
  },
  live: {
    name: "live",
    description: "Artist assistance, promotion, onboarding, community management",
    defaultSequence: ["onboarding_agent", "artist_assistant", "promo_agent", "community_agent"],
    timeout: 60000,
  },
  evolve: {
    name: "evolve",
    description: "Feedback collection, improvements, optimization, expansion scouting",
    defaultSequence: ["feedback_collector", "improvement_agent", "product_optimizer", "role_expansion_scout"],
    timeout: 90000,
  },
} as const;

export type ModeName = keyof typeof MODES;

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(
  agent: AgentEntry,
  input: Record<string, unknown>,
  context?: Record<string, unknown>
): string {
  const parts: string[] = [];

  parts.push("## Input Data");
  parts.push("```json");
  parts.push(JSON.stringify(input, null, 2));
  parts.push("```");

  if (context && Object.keys(context).length > 0) {
    parts.push("");
    parts.push("## Context from Previous Agent");
    parts.push("```json");
    parts.push(JSON.stringify(context, null, 2));
    parts.push("```");
  }

  parts.push("");
  parts.push("## Expected Output Schema");
  parts.push("```json");
  parts.push(JSON.stringify(agent.outputSchema, null, 2));
  parts.push("```");

  parts.push("");
  parts.push("## Grounding");
  parts.push(agent.grounding);

  parts.push("");
  parts.push(
    "Respond with a single valid JSON object matching the output schema. No markdown, no explanation — only JSON."
  );

  return parts.join("\n");
}

// ─── Parse LLM JSON Response ─────────────────────────────────────────────────

function parseJsonResponse(text: string): Record<string, unknown> {
  const cleaned = text.trim();

  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // noop
  }

  // Try extracting JSON from markdown code block
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // noop
    }
  }

  // Try finding first { ... } block
  const braceStart = cleaned.indexOf("{");
  const braceEnd = cleaned.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(cleaned.slice(braceStart, braceEnd + 1));
    } catch {
      // noop
    }
  }

  return { raw_response: cleaned, parse_error: true };
}

// ─── Run Single Agent ─────────────────────────────────────────────────────────

export async function runAgent(
  agentName: string,
  input: Record<string, unknown>,
  context?: Record<string, unknown>
): Promise<AgentResult> {
  const agent = getAgent(agentName);
  if (!agent) {
    throw new Error(`Agent not found: ${agentName}`);
  }

  const userPrompt = buildPrompt(agent, input, context);
  const start = Date.now();

  const llmResponse = await callLLM({
    system: agent.systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 2048,
    temperature: agent.mode === "evolve" ? 0.3 : 0.7,
    tag: `ecosystem-${agent.name}`,
  });

  const latencyMs = Date.now() - start;
  const data = parseJsonResponse(llmResponse.text);

  const nextActions = agent.chainTo.map((tool) => ({
    tool,
    hint: `pass ${agent.name} output as context`,
  }));

  return {
    data,
    meta: {
      agent: agent.name,
      mode: agent.mode,
      latencyMs,
      next_actions: nextActions,
      memory_hint: {
        key: `${agent.mode}:${agent.name}:${Date.now()}`,
        namespace: "ecosystem",
      },
    },
  };
}

// ─── Run Mode ─────────────────────────────────────────────────────────────────

export async function runMode(
  modeName: string,
  trigger?: Record<string, unknown>
): Promise<ModeReport> {
  const modeConfig = MODES[modeName as ModeName];
  if (!modeConfig) {
    throw new Error(
      `Unknown mode: ${modeName}. Valid: ${Object.keys(MODES).join(", ")}`
    );
  }

  const agents = getAgentsByMode(modeName as ModeName);
  if (agents.length === 0) {
    throw new Error(`No agents found for mode: ${modeName}`);
  }

  const startedAt = new Date().toISOString();
  const modeStart = Date.now();
  const results: AgentResult[] = [];
  const errors: Array<{ agent: string; error: string }> = [];

  let previousContext: Record<string, unknown> | undefined;

  for (const agentName of modeConfig.defaultSequence) {
    try {
      const input = trigger || {
        mode: modeName,
        triggeredAt: startedAt,
        previousResults: results.length,
      };

      const result = await runAgent(agentName, input, previousContext);
      results.push(result);
      previousContext = result.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ agent: agentName, error: message });
      console.error(`[ecosystem] Agent ${agentName} failed:`, message);
    }
  }

  return {
    mode: modeName,
    startedAt,
    completedAt: new Date().toISOString(),
    totalLatencyMs: Date.now() - modeStart,
    results,
    errors,
  };
}

// ─── Run Chain ────────────────────────────────────────────────────────────────

const DEFAULT_CHAIN = [
  "artist_assistant",
  "promo_agent",
  "community_agent",
  "feedback_collector",
];

export async function runChain(
  task: string,
  options?: {
    trackId?: string;
    genre?: string;
    goal?: string;
    chain?: string[];
  }
): Promise<ChainResult> {
  const chain = options?.chain || DEFAULT_CHAIN;
  const startedAt = new Date().toISOString();
  const chainStart = Date.now();
  const steps: AgentResult[] = [];

  let currentContext: Record<string, unknown> = {
    task,
    trackId: options?.trackId || null,
    genre: options?.genre || null,
    goal: options?.goal || null,
  };

  for (const agentName of chain) {
    const agent = getAgent(agentName);
    if (!agent) {
      console.warn(`[ecosystem] Chain skip — agent not found: ${agentName}`);
      continue;
    }

    try {
      const result = await runAgent(agentName, currentContext);
      steps.push(result);
      currentContext = {
        ...currentContext,
        [`${agentName}_output`]: result.data,
        previousAgent: agentName,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ecosystem] Chain agent ${agentName} failed:`, message);
      steps.push({
        data: { error: message },
        meta: {
          agent: agentName,
          mode: agent.mode,
          latencyMs: 0,
          next_actions: [],
          memory_hint: {
            key: `chain-error:${agentName}`,
            namespace: "ecosystem",
          },
        },
      });
    }
  }

  const finalOutput =
    steps.length > 0
      ? steps[steps.length - 1].data
      : { error: "No steps completed" };

  return {
    task,
    chain,
    startedAt,
    completedAt: new Date().toISOString(),
    totalLatencyMs: Date.now() - chainStart,
    steps,
    finalOutput,
  };
}
