/**
 * ERROR CLASSIFIER — deterministic + LLM classification pipeline
 * 1. Error comes in (ErrorBoundary, backend onError, agent failure, user report)
 * 2. Deterministic classification by patterns (regex)
 * 3. Fallback → LLM classification via callLLM()
 * 4. Write to memory_errors with fix_suggestion
 * 5. If severity >= high → email info@promofm.ru via sendEmail()
 */

import { pool } from './db-client.tsx';
import { callLLM } from './llm-router.tsx';
import { sendEmail } from './email-helper.tsx';

export type ErrorType = 'bug' | 'ai_error' | 'ux_issue' | 'idea' | 'inactive_ui';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

interface ClassifiedError {
  error_type: ErrorType;
  severity: Severity;
  fix_suggestion: string | null;
  message: string;
}

// ─── Deterministic Patterns ───────────────────────────────────────────────────

const PATTERNS: Array<{ regex: RegExp; type: ErrorType; severity: Severity; hint: string }> = [
  { regex: /cannot read prop|undefined is not|null is not/i, type: 'bug', severity: 'high', hint: 'Null reference – add null check or optional chaining' },
  { regex: /network error|fetch failed|ECONNREFUSED|ETIMEDOUT/i, type: 'bug', severity: 'medium', hint: 'Network/connectivity issue – check endpoint availability' },
  { regex: /CORS|cross-origin|blocked by/i, type: 'bug', severity: 'medium', hint: 'CORS policy – verify allowed origins in backend' },
  { regex: /rate limit|429|too many requests/i, type: 'bug', severity: 'medium', hint: 'Rate limiting – implement backoff or increase limits' },
  { regex: /syntax error|unexpected token|parse error/i, type: 'bug', severity: 'high', hint: 'Syntax/parse error – check JSON or code syntax' },
  { regex: /out of memory|heap|stack overflow/i, type: 'bug', severity: 'critical', hint: 'Memory issue – check for leaks, reduce payload size' },
  { regex: /permission denied|unauthorized|403|401/i, type: 'bug', severity: 'medium', hint: 'Auth/permission issue – verify token and roles' },
  { regex: /hallucin|made up|invented|fabricat/i, type: 'ai_error', severity: 'high', hint: 'AI hallucination detected – add grounding constraints' },
  { regex: /LLM.*error|model.*unavailable|openrouter.*fail/i, type: 'ai_error', severity: 'medium', hint: 'LLM provider issue – check fallback chain' },
  { regex: /button.*not work|nothing happens|click.*no response/i, type: 'inactive_ui', severity: 'medium', hint: 'Dead UI element – check event handler binding' },
  { regex: /confus|unclear|dont understand/i, type: 'ux_issue', severity: 'low', hint: 'UX clarity issue – simplify text or add tooltip' },
  { regex: /feature request/i, type: 'idea', severity: 'low', hint: 'Feature request – evaluate and prioritize' },
];

// ─── Classify ─────────────────────────────────────────────────────────────────

function classifyByPatterns(message: string): ClassifiedError | null {
  for (const p of PATTERNS) {
    if (p.regex.test(message)) {
      return { error_type: p.type, severity: p.severity, fix_suggestion: p.hint, message };
    }
  }
  return null;
}

async function classifyByLLM(message: string, context?: string): Promise<ClassifiedError> {
  try {
    const resp = await callLLM({
      messages: [{ role: 'user', content: `Classify this error/feedback. Respond ONLY with valid JSON:
{"error_type": "bug|ai_error|ux_issue|idea|inactive_ui", "severity": "low|medium|high|critical", "fix_suggestion": "brief fix hint"}

Message: ${message}
${context ? `Context: ${context}` : ''}` }],
      system: 'You are an error classifier. Respond with valid JSON only. No markdown.',
      maxTokens: 200,
      temperature: 0.1,
      tag: 'error-classifier',
    });

    const parsed = JSON.parse(resp.text.replace(/```json?|```/g, '').trim());
    return {
      error_type: parsed.error_type || 'bug',
      severity: parsed.severity || 'medium',
      fix_suggestion: parsed.fix_suggestion || null,
      message,
    };
  } catch {
    return { error_type: 'bug', severity: 'medium', fix_suggestion: null, message };
  }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function classifyAndLog(
  error: string | Error,
  endpoint?: string,
  userId?: string,
  context?: Record<string, unknown>
): Promise<string> {
  const message = typeof error === 'string' ? error : error.message;
  const stack = typeof error === 'string' ? undefined : error.stack;

  // 1. Try deterministic classification
  let classified = classifyByPatterns(message);

  // 2. Fallback to LLM
  if (!classified) {
    classified = await classifyByLLM(message, endpoint);
  }

  // 3. Store in memory_errors
  const res = await pool.query(
    `INSERT INTO memory_errors (error_type, message, context, user_id, endpoint, stack, severity, fix_suggestion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      classified.error_type,
      message,
      context ? JSON.stringify(context) : null,
      userId || null,
      endpoint || null,
      stack || null,
      classified.severity,
      classified.fix_suggestion,
    ]
  );

  const errorId = res.rows[0].id;

  // 4. Email if severity >= high
  if (classified.severity === 'high' || classified.severity === 'critical') {
    await sendEmail({
      to: 'info@promofm.ru',
      subject: `[${classified.severity.toUpperCase()}] ${classified.error_type}: ${message.slice(0, 80)}`,
      html: `<h3>Error Classification</h3>
<p><b>Type:</b> ${classified.error_type}</p>
<p><b>Severity:</b> ${classified.severity}</p>
<p><b>Message:</b> ${message}</p>
<p><b>Endpoint:</b> ${endpoint || 'N/A'}</p>
<p><b>Fix suggestion:</b> ${classified.fix_suggestion || 'N/A'}</p>
<p><b>Error ID:</b> ${errorId}</p>
${stack ? `<pre>${stack}</pre>` : ''}`,
    }).catch(() => {}); // Don't fail on email errors
  }

  return errorId;
}

export { classifyByPatterns, classifyByLLM };
