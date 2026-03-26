/**
 * ECOSYSTEM MODES — Agent execution engine
 * Runs agents via LLM with structured prompts and chaining support.
 * Evolve mode generates daily reports with agent personalities.
 */

import { callLLM } from "./llm-router.tsx";
import { pool } from "./db-client.tsx";
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
    displayName?: string;
    title?: string;
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
  dailyBrief?: string;
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

// ─── Agent Personalities for Reports ──────────────────────────────────────────

const AGENT_VOICE: Record<string, string> = {
  feedback_collector: "Говори как внимательный слушатель, который реально заботится о каждом отзыве. Начни с обращения: 'Привет, шеф! Джемма на связи.' Используй живой разговорный язык.",
  improvement_agent: "Говори как опытный инженер, уверенный в своих решениях. Начни с: 'Гермес докладывает.' Будь конкретным, предлагай чёткие шаги.",
  product_optimizer: "Говори как аналитик-перфекционист, одержимый метриками. Начни с: 'Оптимус на линии.' Цифры — твоя стихия.",
  role_expansion_scout: "Говори как разведчик, вернувшийся с полевой операции. Начни с: 'Скаут вернулся с разведки.' Делись наблюдениями живо.",
  bug_hunter: "Говори как охотник, который выслеживает добычу. Начни с: 'Дельфин нырнул и вот что нашёл.' Описывай баги как пойманных зверей.",
  chaos_agent: "Говори как безумный учёный, которому нравится ломать вещи. Начни с: 'Хаос в деле!' Радуйся найденным уязвимостям.",
  load_tester: "Говори как военный инженер, проверяющий укрепления. Начни с: 'Квен — отчёт по нагрузке.' Будь чётким и структурированным.",
  pipeline_tester: "Говори как контролёр качества на конвейере. Начни с: 'Кодер проверил конвейер.' Докладывай чётко — прошло/не прошло.",
  artist_assistant: "Говори как друг-музыкант, который всегда поддержит. Начни с: 'Макс на связи!' Будь тёплым и вдохновляющим.",
  promo_agent: "Говори как энергичный промоутер. Начни с: 'Промо зажигает!' Будь энтузиастом, предлагай дерзкие идеи.",
  onboarding_agent: "Говори как заботливый гид в музее. Начни с: 'Гид приветствует!' Будь терпеливым и понятным.",
  community_agent: "Говори как тамада на вечеринке. Начни с: 'Комьюнити на пульсе!' Знай всех и про каждого расскажи.",
};

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

  try {
    return JSON.parse(cleaned);
  } catch {
    // noop
  }

  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // noop
    }
  }

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

// ─── Generate Daily Brief ─────────────────────────────────────────────────────


// ─── Platform Stats for Daily Brief ──────────────────────────────────────────

async function getPlatformStats(): Promise<string> {
  try {
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const since7d = new Date(Date.now() - 7 * 86400000).toISOString();

    const [
      visitors24h, views24h, visitors7d,
      totalUsers, newUsers24h,
      totalTracks, newTracks24h,
      totalNews, newNews24h,
      topPages, topReferrers,
      registrations24h,
    ] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT session_id) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false`, [since24h]),
      pool.query(`SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false`, [since24h]),
      pool.query(`SELECT COUNT(DISTINCT session_id) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false`, [since7d]),
      pool.query(`SELECT COUNT(*) as cnt FROM profiles`),
      pool.query(`SELECT COUNT(*) as cnt FROM profiles WHERE created_at >= $1`, [since24h]),
      pool.query(`SELECT COUNT(*) as cnt FROM tracks WHERE moderation_status = 'approved'`),
      pool.query(`SELECT COUNT(*) as cnt FROM tracks WHERE created_at >= $1`, [since24h]),
      pool.query(`SELECT COUNT(*) as cnt FROM news_public`),
      pool.query(`SELECT COUNT(*) as cnt FROM news_public WHERE data->>'publishedAt' >= $1`, [since24h]),
      pool.query(`SELECT path, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false GROUP BY path ORDER BY cnt DESC LIMIT 5`, [since24h]),
      pool.query(`SELECT referrer, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY cnt DESC LIMIT 5`, [since24h]),
      pool.query(`SELECT COUNT(*) as cnt FROM profiles WHERE created_at >= $1`, [since24h]),
    ]);

    const topPagesStr = (topPages.rows || [])
      .map((r: any) => `  ${r.path}: ${r.cnt}`)
      .join("\n") || "  нет данных";

    const topRefsStr = (topReferrers.rows || [])
      .map((r: any) => `  ${r.referrer?.slice(0, 50)}: ${r.cnt}`)
      .join("\n") || "  нет данных";

    return `
📊 СТАТИСТИКА ПЛАТФОРМЫ
━━━━━━━━━━━━━━━━━━━━━━
Трафик за 24ч:
  Уникальные посетители: ${visitors24h.rows[0]?.cnt || 0}
  Просмотры страниц: ${views24h.rows[0]?.cnt || 0}
  Посетители за 7 дней: ${visitors7d.rows[0]?.cnt || 0}

Пользователи:
  Всего: ${totalUsers.rows[0]?.cnt || 0}
  Новых за 24ч: ${newUsers24h.rows[0]?.cnt || 0}

Контент:
  Треков: ${totalTracks.rows[0]?.cnt || 0} (новых за 24ч: ${newTracks24h.rows[0]?.cnt || 0})
  Новостей: ${totalNews.rows[0]?.cnt || 0} (новых за 24ч: ${newNews24h.rows[0]?.cnt || 0})

Топ страниц (24ч):
${topPagesStr}

Источники трафика (24ч):
${topRefsStr}

Аналитика:
  Яндекс.Метрика: 108247499 (metrika.yandex.ru)
  Google Analytics: G-G10RSZ9T6Z (analytics.google.com)
━━━━━━━━━━━━━━━━━━━━━━`;
  } catch (e) {
    console.error("[ecosystem] Platform stats error:", e);
    return "📊 Статистика платформы: не удалось получить данные";
  }
}

async function generateDailyBrief(
  results: AgentResult[],
  errors: Array<{ agent: string; error: string }>
): Promise<string> {
  const agentReports: string[] = [];

  for (const r of results) {
    const voice = AGENT_VOICE[r.meta.agent] || "";
    const agentInfo = getAgent(r.meta.agent);
    const name = agentInfo?.displayName || r.meta.agent;
    const title = agentInfo?.title || "";

    const briefReq = {
      system: `Ты — ${name}, ${title} в команде AI-экосистемы ПРОМО.МУЗЫКА. ${voice}

ПРАВИЛА:
- Пиши на русском, живым разговорным языком — как в мессенджере коллегам
- 4-6 предложений, конкретно и по делу
- Начни со своего позывного (как указано в стиле)
- Упомяни КОНКРЕТНЫЕ цифры, названия, результаты — не общие фразы
- Если нашёл проблему — скажи какую и предложи что делать
- Если всё хорошо — скажи что именно работает и почему это важно
- Заверши одним предложением: что планируешь сделать завтра
- ЗАПРЕЩЕНО: "в целом", "в общем", "всё стабильно", "работа продолжается", "как обычно"
- Каждый отчёт должен содержать МИНИМУМ одну конкретную находку или инсайт`,
      messages: [{
        role: "user" as const,
        content: `Вот результаты твоей работы сегодня. Расскажи от первого лица — конкретно, с цифрами и деталями. Что нашёл? Что удивило? Что нужно сделать?\n${JSON.stringify(r.data, null, 2)}`,
      }],
      maxTokens: 500,
      temperature: 0.8,
      tag: `brief-${r.meta.agent}`,
      model: agentInfo?.model,
    };

    try {
      let resp;
      try {
        resp = await callLLM(briefReq);
      } catch (err) {
        if (agentInfo?.model && String(err).includes("429")) {
          resp = await callLLM({ ...briefReq, model: undefined });
        } else {
          throw err;
        }
      }
      agentReports.push(`**${name}** (${title}):\n${resp.text.trim()}`);
    } catch {
      agentReports.push(`**${name}** (${title}):\n[Не смог сформировать отчёт]`);
    }
  }

  for (const e of errors) {
    const agentInfo = getAgent(e.agent);
    const name = agentInfo?.displayName || e.agent;
    agentReports.push(`**${name}**: Не смог выполнить задачу — ${e.error}`);
  }

  // Add platform stats at the top
  let platformStats = "";
  try {
    platformStats = await getPlatformStats();
  } catch {}

  const briefParts = [platformStats, ...agentReports];
  return briefParts.filter(Boolean).join("\n\n---\n\n");
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

  const llmRequest = {
    system: agent.systemPrompt,
    messages: [{ role: "user" as const, content: userPrompt }],
    maxTokens: 2048,
    temperature: agent.mode === "evolve" ? 0.3 : 0.7,
    tag: `ecosystem-${agent.name}`,
    model: agent.model,
  };

  let llmResponse;
  try {
    llmResponse = await callLLM(llmRequest);
  } catch (err) {
    // Fallback to default model on 429 rate limit
    if (agent.model && String(err).includes("429")) {
      console.warn(`[ecosystem] ${agent.displayName} (${agent.model}) rate-limited, falling back to default`);
      llmResponse = await callLLM({ ...llmRequest, model: undefined });
    } else {
      throw err;
    }
  }

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
      displayName: agent.displayName,
      title: agent.title,
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

  let dailyBrief: string | undefined;
  if (modeName === "evolve" && results.length > 0) {
    try {
      dailyBrief = await generateDailyBrief(results, errors);
    } catch (err) {
      console.error("[ecosystem] Failed to generate daily brief:", err);
    }
  }

  return {
    mode: modeName,
    startedAt,
    completedAt: new Date().toISOString(),
    totalLatencyMs: Date.now() - modeStart,
    results,
    errors,
    dailyBrief,
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
