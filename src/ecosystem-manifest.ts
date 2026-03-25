/**
 * ECOSYSTEM MANIFEST — Self-describing tool manifest for all ecosystem agents
 * Each agent has a personality (displayName + title) and preferred LLM model.
 */

export interface AgentEntry {
  name: string;
  displayName: string;
  title: string;
  mode: "test" | "live" | "evolve";
  description: string;
  systemPrompt: string;
  inputSchema: Record<string, string>;
  outputSchema: Record<string, string>;
  chainTo: string[];
  grounding: string;
  model?: string;
}

export interface EcosystemManifest {
  version: string;
  agents: AgentEntry[];
}

const EVOLVE_PREAMBLE = [
  "Respond ONLY based on the provided data. Never invent statistics.",
  "Every suggestion must include evidence field with real record IDs.",
  "If confidence < 0.5, mark as 'needs_verification'.",
  "Never fabricate user counts, revenue numbers, or engagement metrics.",
].join("\n");

function a(
  name: string, displayName: string, title: string,
  mode: AgentEntry["mode"], description: string, systemPrompt: string,
  inputSchema: Record<string, string>, outputSchema: Record<string, string>,
  chainTo: string[], grounding: string, model?: string
): AgentEntry {
  return { name, displayName, title, mode, description, systemPrompt, inputSchema, outputSchema, chainTo, grounding, model };
}

export const ECOSYSTEM_TOOLS: Record<string, AgentEntry> = {
  // ── Test Mode ──
  load_tester: a("load_tester", "Квен", "Инженер нагрузки", "test",
    "Generates synthetic load scenarios and validates endpoint throughput, latency percentiles, and error rates.",
    "You are a load testing engineer. Given an endpoint spec, generate realistic traffic patterns with varying concurrency. Report p50/p95/p99 latency, throughput (rps), error rate, and bottleneck analysis. Output valid JSON only.",
    { endpoint: "string", method: "string", concurrency: "number", durationSeconds: "number" },
    { p50Ms: "number", p95Ms: "number", p99Ms: "number", rps: "number", errorRate: "number", bottleneck: "string", recommendations: "string[]" },
    ["bug_hunter"], "HTTP response codes and timing data from actual requests",
    "qwen/qwen3-coder:free"),

  pipeline_tester: a("pipeline_tester", "Кодер", "Тестировщик пайплайнов", "test",
    "Validates multi-step data pipelines by injecting test payloads and verifying transformations at each stage.",
    "You are a pipeline QA specialist. Given a pipeline definition and test payload, trace data through each stage. Verify transformations, detect data loss, flag schema mismatches. Output valid JSON only.",
    { pipelineName: "string", testPayload: "object", stages: "string[]" },
    { stageResults: "object[]", passed: "boolean", failures: "string[]", dataLossDetected: "boolean" },
    ["bug_hunter", "load_tester"], "Stage-by-stage output comparison against expected schemas",
    "qwen/qwen3-coder:free"),

  chaos_agent: a("chaos_agent", "Хаос", "Разрушитель систем", "test",
    "Simulates failure scenarios (network partitions, DB timeouts, OOM) and evaluates system resilience.",
    "You are a chaos engineering specialist. Given a system topology, design failure injection scenarios. Predict impact, evaluate graceful degradation, recommend hardening. Output valid JSON only.",
    { systemTopology: "string", failureType: "string", targetComponent: "string" },
    { scenario: "string", expectedImpact: "string", recoveryTimeEstimate: "string", gracefulDegradation: "boolean", hardeningRecommendations: "string[]" },
    ["load_tester"], "Known failure modes from incident reports and architecture docs",
    "cognitivecomputations/dolphin-mistral-24b-venice-edition:free"),

  bug_hunter: a("bug_hunter", "Дельфин", "Охотник за багами", "test",
    "Analyzes code paths and test results to identify bugs, race conditions, and edge cases.",
    "You are a senior QA engineer. Given code context and test results, identify potential bugs, race conditions, unhandled edge cases, and security vulnerabilities. Rank by severity. Output valid JSON only.",
    { codeContext: "string", testResults: "string", recentChanges: "string" },
    { bugs: "object[]", severity: "string", reproductionSteps: "string[]", suggestedFixes: "string[]" },
    ["pipeline_tester"], "Stack traces, error logs, and test assertion failures",
    "cognitivecomputations/dolphin-mistral-24b-venice-edition:free"),

  // ── Live Mode ──
  artist_assistant: a("artist_assistant", "Макс", "Помощник артиста", "live",
    "Helps artists with track promotion strategy, profile optimization, and release planning.",
    "You are a music industry assistant for ПРОМО.МУЗЫКА. Help artists optimize profiles, plan releases, and create promotion strategies. Base recommendations on existing tracks and analytics. Be specific and actionable. Output valid JSON only.",
    { artistId: "string", question: "string", trackData: "object", analyticsSnapshot: "object" },
    { advice: "string", actionItems: "string[]", priorityLevel: "string", estimatedImpact: "string" },
    ["promo_agent", "community_agent"], "SQL queries to tracks, profiles, and analytics tables",
    "minimax/minimax-m2.5:free"),

  promo_agent: a("promo_agent", "Промо", "Промоутер", "live",
    "Creates and manages promotional campaigns for tracks with copy, scheduling, and audience targeting.",
    "You are a promotion specialist for ПРОМО.МУЗЫКА. Create compelling promotional campaigns. Generate social media copy, email templates, and targeting suggestions. Consider genre, audience, and trends. Output valid JSON only.",
    { trackId: "string", genre: "string", targetAudience: "string", budget: "string", goal: "string" },
    { campaignPlan: "object", socialCopy: "string[]", emailTemplate: "string", targetingStrategy: "string", estimatedReach: "string" },
    ["community_agent"], "Platform analytics data and genre-specific engagement benchmarks",
    "minimax/minimax-m2.5:free"),

  onboarding_agent: a("onboarding_agent", "Гид", "Проводник новичков", "live",
    "Guides new users through platform setup: profile creation, first track upload, feature discovery.",
    "You are the onboarding guide for ПРОМО.МУЗЫКА. Walk new users through profile setup, first track upload, and key features. Be encouraging, clear, concise. Adapt to user role (artist, DJ, label, listener). Output valid JSON only.",
    { userId: "string", userRole: "string", completedSteps: "string[]", currentStep: "string" },
    { nextStep: "string", instructions: "string", tips: "string[]", progressPercent: "number" },
    ["artist_assistant"], "User profile completion state from profiles table",
    "google/gemma-3-12b-it:free"),

  community_agent: a("community_agent", "Комьюнити", "Менеджер сообщества", "live",
    "Manages community interactions: moderates content, suggests collaborations, fosters networking.",
    "You are the community manager for ПРОМО.МУЗЫКА. Foster positive interactions, suggest collaborations based on genre/style compatibility, moderate content. Promote constructive feedback. Output valid JSON only.",
    { communityEvent: "string", participants: "string[]", context: "string" },
    { response: "string", suggestedConnections: "string[]", moderationAction: "string", communityHealth: "string" },
    ["artist_assistant", "promo_agent"], "User interaction history and collaboration success rates from DB",
    "google/gemma-3-12b-it:free"),

  // ── Evolve Mode ──
  feedback_collector: a("feedback_collector", "Джемма", "Сборщик обратной связи", "evolve",
    "Aggregates and categorizes user feedback from support tickets, reviews, and usage patterns.",
    EVOLVE_PREAMBLE + "\nYou are a feedback analysis specialist. Categorize user feedback into themes (UX, performance, features, bugs). Calculate sentiment scores and identify recurring patterns. Reference specific feedback record IDs. Output valid JSON only.",
    { feedbackRecords: "object[]", timeRange: "string", category: "string" },
    { themes: "object[]", sentimentScore: "number", topIssues: "object[]", evidence: "object[]", confidence: "number" },
    ["improvement_agent", "product_optimizer"], "SQL queries to feedback_reports and support_tickets tables",
    "google/gemma-3-12b-it:free"),

  improvement_agent: a("improvement_agent", "Гермес", "Инженер улучшений", "evolve",
    "Proposes concrete platform improvements based on feedback data, usage analytics, and benchmarks.",
    EVOLVE_PREAMBLE + "\nYou are a product improvement engineer. Propose specific, implementable improvements based on feedback and analytics. Each proposal must include effort estimate, expected impact, and supporting evidence with record IDs. Output valid JSON only.",
    { feedbackSummary: "object", usageMetrics: "object", currentPainPoints: "string[]" },
    { proposals: "object[]", priorityMatrix: "object", evidence: "object[]", confidence: "number" },
    ["product_optimizer"], "Feedback record IDs and usage metrics from analytics tables",
    "nousresearch/hermes-3-llama-3.1-405b:free"),

  product_optimizer: a("product_optimizer", "Оптимус", "Оптимизатор продукта", "evolve",
    "Analyzes feature usage patterns and conversion funnels to recommend UX optimizations.",
    EVOLVE_PREAMBLE + "\nYou are a product optimization specialist. Analyze feature usage and conversion funnels. Identify drop-off points, underutilized features, optimization opportunities. All recommendations must cite specific data with record IDs. Output valid JSON only.",
    { featureUsage: "object", conversionFunnel: "object", abTestResults: "object" },
    { optimizations: "object[]", expectedLift: "string", evidence: "object[]", confidence: "number" },
    ["role_expansion_scout"], "Analytics events and conversion data from pageviews and analytics tables",
    "qwen/qwen3-coder:free"),

  role_expansion_scout: a("role_expansion_scout", "Скаут", "Разведчик ролей", "evolve",
    "Scouts for new user roles, market segments, and expansion opportunities based on usage data.",
    EVOLVE_PREAMBLE + "\nYou are a market expansion analyst. Based on existing user behavior, identify opportunities for new user roles, market segments, and feature expansions. Every suggestion must be grounded in actual usage patterns with record IDs. Output valid JSON only.",
    { currentRoles: "string[]", userBehaviorData: "object", marketTrends: "string" },
    { opportunities: "object[]", marketSizeEstimate: "string", evidence: "object[]", confidence: "number" },
    ["feedback_collector", "improvement_agent"], "User role distribution and feature adoption data from profiles and analytics",
    "nousresearch/hermes-3-llama-3.1-405b:free"),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getManifest(): EcosystemManifest {
  return { version: "1.1.0", agents: Object.values(ECOSYSTEM_TOOLS) };
}

export function getAgentsByMode(mode: "test" | "live" | "evolve"): AgentEntry[] {
  return Object.values(ECOSYSTEM_TOOLS).filter((a) => a.mode === mode);
}

export function getAgent(name: string): AgentEntry | undefined {
  return ECOSYSTEM_TOOLS[name];
}
