/**
 * LLM ROUTER - Универсальный маршрутизатор для LLM-провайдеров
 * 
 * Приоритет провайдеров:
 * 1. OpenRouter (OPENROUTER_API_KEY) - доступ к 200+ моделям
 * 2. Anthropic Direct (ANTHROPIC_API_KEY) - прямой доступ к Claude
 * 
 * Все агенты и ассистенты проекта вызывают callLLM() вместо прямых fetch.
 * Формат запроса унифицирован, конвертация между API происходит внутри.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMRequest {
  /** Массив сообщений (OpenAI-формат). Если system указан отдельно, не добавляйте system-сообщение в массив. */
  messages: LLMMessage[];
  /** System prompt (вынесен отдельно для совместимости с Anthropic) */
  system?: string;
  /** Максимум токенов ответа (по умолчанию 2048) */
  maxTokens?: number;
  /** Модель для OpenRouter (например 'anthropic/claude-sonnet-4-20250514'). Для Anthropic конвертируется автоматически. */
  model?: string;
  /** Температура генерации (0-1) */
  temperature?: number;
  /** Принудительно использовать конкретный провайдер */
  forceProvider?: 'openrouter' | 'anthropic';
  /** Метка для логов (например 'devlab-teamlead', 'adlab-director') */
  tag?: string;
}

export interface LLMResponse {
  /** Текст ответа модели */
  text: string;
  /** Какой провайдер обработал запрос */
  provider: 'openrouter' | 'anthropic';
  /** Какая модель использована */
  model: string;
  /** Время ответа в мс */
  latencyMs: number;
  /** Использование токенов (если провайдер вернул) */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

// ─── Model Mapping ────────────────────────────────────────────────────────────

/** Маппинг: OpenRouter model ID → Anthropic model ID */
const OPENROUTER_TO_ANTHROPIC: Record<string, string> = {
  'anthropic/claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
  'anthropic/claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'anthropic/claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
  'anthropic/claude-3-haiku': 'claude-3-haiku-20240307',
};

/** Дефолтная модель (OpenRouter формат) */
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-20250514';

/** Конвертация OpenRouter model → Anthropic model */
function toAnthropicModel(orModel: string): string {
  return OPENROUTER_TO_ANTHROPIC[orModel] || orModel.replace('anthropic/', '');
}

// ─── Provider Detection ───────────────────────────────────────────────────────

interface ProviderInfo {
  provider: 'openrouter' | 'anthropic';
  apiKey: string;
}

function detectProvider(forceProvider?: 'openrouter' | 'anthropic'): ProviderInfo | null {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (forceProvider === 'openrouter' && openrouterKey) {
    return { provider: 'openrouter', apiKey: openrouterKey };
  }
  if (forceProvider === 'anthropic' && anthropicKey) {
    return { provider: 'anthropic', apiKey: anthropicKey };
  }

  // Приоритет: OpenRouter → Anthropic
  if (openrouterKey) return { provider: 'openrouter', apiKey: openrouterKey };
  if (anthropicKey) return { provider: 'anthropic', apiKey: anthropicKey };

  return null;
}

// ─── OpenRouter Call ──────────────────────────────────────────────────────────

async function callOpenRouter(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
  const model = req.model || DEFAULT_MODEL;
  const messages: LLMMessage[] = [];

  // Добавляем system как первое сообщение
  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }

  // Добавляем остальные сообщения
  messages.push(...req.messages);

  const start = Date.now();

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://promo.music',
      'X-Title': 'ПРОМО.МУЗЫКА',
    },
    body: JSON.stringify({
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens || 2048,
      temperature: req.temperature ?? 0.7,
    }),
  });

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  const usedModel = data.model || model;

  return {
    text,
    provider: 'openrouter',
    model: usedModel,
    latencyMs,
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  };
}

// ─── Anthropic Direct Call ────────────────────────────────────────────────────

async function callAnthropicDirect(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
  const orModel = req.model || DEFAULT_MODEL;
  const model = toAnthropicModel(orModel);

  // Отфильтровываем system-сообщения из messages (Anthropic не поддерживает system role в messages)
  const filteredMessages = req.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  // Собираем system prompt
  const systemParts: string[] = [];
  if (req.system) systemParts.push(req.system);
  const systemMsgs = req.messages.filter(m => m.role === 'system');
  if (systemMsgs.length > 0) systemParts.push(...systemMsgs.map(m => m.content));
  const system = systemParts.join('\n\n') || undefined;

  const start = Date.now();

  const body: any = {
    model,
    max_tokens: req.maxTokens || 2048,
    messages: filteredMessages,
  };
  if (system) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  return {
    text,
    provider: 'anthropic',
    model: data.model || model,
    latencyMs,
    usage: data.usage ? {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    } : undefined,
  };
}

// ─── Main Entry Point ──��──────────────────────────────────────────────────────

/**
 * Универсальный вызов LLM.
 * Автоматически выбирает провайдер, конвертирует формат запроса.
 * 
 * @example
 * const res = await callLLM({
 *   system: 'Ты - эксперт по маркетингу.',
 *   messages: [{ role: 'user', content: 'Проанализируй кампании.' }],
 *   tag: 'adlab-director',
 * });
 * console.log(res.text, res.provider, res.model, `${res.latencyMs}ms`);
 */
export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  const tag = req.tag || 'llm';
  const info = detectProvider(req.forceProvider);

  if (!info) {
    throw new Error('Ни один LLM-провайдер не настроен (нужен OPENROUTER_API_KEY или ANTHROPIC_API_KEY)');
  }

  console.log(`[${tag}] calling ${info.provider}, model: ${req.model || DEFAULT_MODEL}`);

  let result: LLMResponse;

  if (info.provider === 'openrouter') {
    result = await callOpenRouter(req, info.apiKey);
  } else {
    result = await callAnthropicDirect(req, info.apiKey);
  }

  console.log(`[${tag}] ${result.provider}/${result.model} → ${result.text.length} chars, ${result.latencyMs}ms${result.usage ? `, tokens: ${result.usage.totalTokens}` : ''}`);

  return result;
}

/**
 * Быстрый вызов для простых запросов (один system + один user).
 */
export async function quickLLM(system: string, userMessage: string, opts?: {
  maxTokens?: number;
  model?: string;
  tag?: string;
}): Promise<string> {
  const res = await callLLM({
    system,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: opts?.maxTokens || 1500,
    model: opts?.model,
    tag: opts?.tag,
  });
  return res.text;
}

/**
 * Проверка доступности LLM-провайдеров.
 */
export function getLLMStatus(): {
  available: boolean;
  openrouter: boolean;
  anthropic: boolean;
  preferredProvider: string;
  defaultModel: string;
} {
  const openrouter = !!process.env.OPENROUTER_API_KEY;
  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  return {
    available: openrouter || anthropic,
    openrouter,
    anthropic,
    preferredProvider: openrouter ? 'OpenRouter' : anthropic ? 'Anthropic' : 'нет',
    defaultModel: DEFAULT_MODEL,
  };
}
