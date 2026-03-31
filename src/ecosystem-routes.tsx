/**
 * ECOSYSTEM ROUTES — Hono router for ecosystem agent infrastructure
 * Endpoints for running agents, modes, chains, and viewing reports.
 */

import { Hono } from "hono";
import { pool } from "./db-client.tsx";
import { sendEmail } from "./email-helper.tsx";
import {
  getManifest,
  getAgent,
  getAgentsByMode,
} from "./ecosystem-manifest.ts";
import {
  runAgent,
  runMode,
  runChain,
  MODES,
  type ModeName,
} from "./ecosystem-modes.ts";
import { requireAuth, requireAdmin } from "./auth-middleware.tsx";

const app = new Hono();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().slice(0, 8);
  return `eco_${ts}_${rand}`;
}

function jsonOk(data: unknown, meta?: Record<string, unknown>) {
  return { success: true as const, data, meta: meta || {} };
}

function jsonErr(error: string) {
  return { success: false as const, error };
}

async function saveSession(
  sessionId: string,
  sessionData: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO agent_sessions (id, data, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [sessionId, JSON.stringify(sessionData)]
    );
  } catch (err) {
    console.error("[ecosystem] Failed to save session:", err);
  }
}

async function getSession(
  sessionId: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await pool.query(
      "SELECT data FROM agent_sessions WHERE id = $1",
      [sessionId]
    );
    if (res.rows.length === 0) return null;
    const raw = res.rows[0].data;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error("[ecosystem] Failed to get session:", err);
    return null;
  }
}

// ─── GET /manifest ────────────────────────────────────────────────────────────

app.get("/manifest", requireAuth, requireAdmin, (c) => {
  const manifest = getManifest();
  return c.json(
    jsonOk(manifest, {
      totalAgents: manifest.agents.length,
      modes: Object.keys(MODES),
      timestamp: new Date().toISOString(),
    })
  );
});

// ─── POST /mode/:mode/run ─────────────────────────────────────────────────────

app.post("/mode/:mode/run", requireAuth, requireAdmin, async (c) => {
  const modeName = c.req.param("mode");

  if (!MODES[modeName as ModeName]) {
    return c.json(
      jsonErr(
        `Unknown mode: ${modeName}. Valid: ${Object.keys(MODES).join(", ")}`
      ),
      400
    );
  }

  let trigger: Record<string, unknown> | undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body === "object") {
      trigger = body;
    }
  } catch {
    // No body is fine
  }

  const sessionId = generateId();
  const startedAt = new Date().toISOString();

  await saveSession(sessionId, {
    mode: modeName,
    status: "running",
    startedAt,
    trigger: trigger || null,
  });

  try {
    const report = await runMode(modeName, trigger);

    const sessionData = {
      mode: modeName,
      status: "completed",
      startedAt,
      completedAt: report.completedAt,
      totalLatencyMs: report.totalLatencyMs,
      agentCount: report.results.length,
      errorCount: report.errors.length,
      report,
    };

    await saveSession(sessionId, sessionData);

    // Email daily brief for evolve mode
    if (modeName === "evolve" && report.dailyBrief) {
      const today = new Date().toISOString().slice(0, 10);
      await sendEmail({
        to: "info@promofm.ru",
        subject: `[ECOSYSTEM] Ежедневный отчёт команды — ${today}`,
        html: `<h2>Ежедневный отчёт AI-команды ПРОМО.МУЗЫКА</h2>
<p><b>Дата:</b> ${today} | <b>Агентов:</b> ${report.results.length} | <b>Время:</b> ${report.totalLatencyMs}ms</p>
<hr/>
${report.dailyBrief.replace(/\n/g, "<br/>")}
<hr/>
<p><small>Сгенерировано AI-экосистемой ПРОМО.МУЗЫКА v1.1</small></p>`,
      }).catch((e: unknown) => console.error("[ecosystem] Brief email failed:", e));
    }

    return c.json(
      jsonOk(report, {
        sessionId,
        mode: modeName,
        latencyMs: report.totalLatencyMs,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await saveSession(sessionId, {
      mode: modeName,
      status: "failed",
      startedAt,
      error: message,
    });

    return c.json(jsonErr(`Mode execution failed: ${message}`), 500);
  }
});

// ─── GET /mode/:mode/status ───────────────────────────────────────────────────

app.get("/mode/:mode/status", requireAuth, requireAdmin, async (c) => {
  const modeName = c.req.param("mode");

  if (!MODES[modeName as ModeName]) {
    return c.json(
      jsonErr(
        `Unknown mode: ${modeName}. Valid: ${Object.keys(MODES).join(", ")}`
      ),
      400
    );
  }

  try {
    const res = await pool.query(
      `SELECT id, data, created_at FROM agent_sessions
       WHERE data->>'mode' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [modeName]
    );

    if (res.rows.length === 0) {
      return c.json(
        jsonOk(
          { mode: modeName, status: "no_runs", lastRun: null },
          { mode: modeName, timestamp: new Date().toISOString() }
        )
      );
    }

    const row = res.rows[0];
    const data =
      typeof row.data === "string" ? JSON.parse(row.data) : row.data;

    return c.json(
      jsonOk(
        {
          sessionId: row.id,
          mode: modeName,
          status: data.status || "unknown",
          startedAt: data.startedAt || null,
          completedAt: data.completedAt || null,
          totalLatencyMs: data.totalLatencyMs || null,
          agentCount: data.agentCount || 0,
          errorCount: data.errorCount || 0,
        },
        { mode: modeName, timestamp: new Date().toISOString() }
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(jsonErr(`Status query failed: ${message}`), 500);
  }
});

// ─── POST /agent/:name/run ────────────────────────────────────────────────────

app.post("/agent/:name/run", requireAuth, requireAdmin, async (c) => {
  const agentName = c.req.param("name");
  const agent = getAgent(agentName);

  if (!agent) {
    const allAgents = getManifest().agents.map((a) => a.name);
    return c.json(
      jsonErr(
        `Agent not found: ${agentName}. Available: ${allAgents.join(", ")}`
      ),
      404
    );
  }

  let body: {
    input?: Record<string, unknown>;
    context?: Record<string, unknown>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      jsonErr("Request body must be valid JSON with { input, context? }"),
      400
    );
  }

  if (!body.input || typeof body.input !== "object") {
    return c.json(
      jsonErr("Missing or invalid 'input' field in request body"),
      400
    );
  }

  const sessionId = generateId();

  try {
    const result = await runAgent(agentName, body.input, body.context);

    await saveSession(sessionId, {
      type: "single_agent",
      agent: agentName,
      mode: agent.mode,
      status: "completed",
      input: body.input,
      context: body.context || null,
      result,
    });

    return c.json(
      jsonOk(result.data, {
        sessionId,
        agent: result.meta.agent,
        mode: result.meta.mode,
        latencyMs: result.meta.latencyMs,
        next_actions: result.meta.next_actions,
        memory_hint: result.meta.memory_hint,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(jsonErr(`Agent execution failed: ${message}`), 500);
  }
});

// ─── POST /chain ──────────────────────────────────────────────────────────────

app.post("/chain", requireAuth, requireAdmin, async (c) => {
  let body: {
    task?: string;
    trackId?: string;
    genre?: string;
    goal?: string;
    chain?: string[];
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json(
      jsonErr(
        "Request body must be valid JSON with { task, trackId?, genre?, goal?, chain? }"
      ),
      400
    );
  }

  if (!body.task || typeof body.task !== "string") {
    return c.json(jsonErr("Missing or invalid 'task' field"), 400);
  }

  const sessionId = generateId();

  try {
    const result = await runChain(body.task, {
      trackId: body.trackId,
      genre: body.genre,
      goal: body.goal,
      chain: body.chain,
    });

    await saveSession(sessionId, {
      type: "chain",
      status: "completed",
      task: body.task,
      chain: result.chain,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      totalLatencyMs: result.totalLatencyMs,
      stepCount: result.steps.length,
      result,
    });

    return c.json(
      jsonOk(result, {
        sessionId,
        chain: result.chain,
        latencyMs: result.totalLatencyMs,
        steps: result.steps.length,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(jsonErr(`Chain execution failed: ${message}`), 500);
  }
});

// ─── GET /reports ─────────────────────────────────────────────────────────────

app.get("/reports", requireAuth, requireAdmin, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const mode = c.req.query("mode");
  const type = c.req.query("type");

  try {
    let sql =
      "SELECT id, data, created_at FROM agent_sessions WHERE id LIKE 'eco_%'";
    const params: unknown[] = [];
    let paramIdx = 1;

    if (mode) {
      sql += ` AND data->>'mode' = $${paramIdx}`;
      params.push(mode);
      paramIdx++;
    }

    if (type) {
      sql += ` AND data->>'type' = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const res = await pool.query(sql, params);

    const reports = res.rows.map(
      (row: { id: string; data: unknown; created_at: string }) => {
        const data =
          typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        return {
          sessionId: row.id,
          createdAt: row.created_at,
          ...data,
        };
      }
    );

    return c.json(
      jsonOk(reports, {
        count: reports.length,
        limit,
        filters: { mode: mode || null, type: type || null },
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(jsonErr(`Reports query failed: ${message}`), 500);
  }
});

// ─── GET /agents ──────────────────────────────────────────────────────────────

app.get("/agents", requireAuth, requireAdmin, (c) => {
  const mode = c.req.query("mode");
  const manifest = getManifest();

  let agents = manifest.agents;
  if (mode) {
    agents = agents.filter((a) => a.mode === mode);
  }

  const summary = agents.map((a) => ({
    name: a.name,
    mode: a.mode,
    description: a.description,
    chainTo: a.chainTo,
  }));

  return c.json(
    jsonOk(summary, {
      total: summary.length,
      mode: mode || "all",
      timestamp: new Date().toISOString(),
    })
  );
});

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get("/health", requireAuth, requireAdmin, async (c) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    // DB not available
  }

  const manifest = getManifest();

  return c.json(
    jsonOk({
      status: dbOk ? "healthy" : "degraded",
      database: dbOk,
      agentCount: manifest.agents.length,
      modes: Object.keys(MODES),
      version: manifest.version,
    })
  );
});

export default app;
