import { Hono } from "hono";
import { pool } from "./db-client.tsx";
import * as crypto from "crypto";

const consentRoutes = new Hono();

// POST /consent — save user cookie consent preferences
consentRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { analytics, marketing, functional, userId } = body;

    const effectiveUserId = userId || "anonymous-" + Date.now().toString(36);
    const ipRaw = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const ipHash = crypto.createHash("sha256").update(ipRaw).digest("hex").slice(0, 16);
    const ua = (c.req.header("user-agent") || "").slice(0, 200);

    await pool.query(
      `INSERT INTO cookie_consents (user_id, analytics, marketing, functional, ip_hash, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         analytics = $2, marketing = $3, functional = $4, updated_at = NOW()`,
      [effectiveUserId, analytics ?? false, marketing ?? false, functional ?? true, ipHash, ua]
    );

    return c.json({ success: true });
  } catch (error) {
    console.error("Consent save error:", error);
    return c.json({ success: true }); // Don't fail user experience
  }
});

// GET /consent/policy — current consent policy version
consentRoutes.get("/policy", (c) => {
  return c.json({
    success: true,
    data: {
      version: "1.0",
      lastUpdated: "2026-03-27",
      categories: {
        necessary: { required: true, description: "Обязательные cookies для работы сайта" },
        functional: { required: false, default: true, description: "Функциональные cookies (настройки, предпочтения)" },
        analytics: { required: false, default: false, description: "Аналитические cookies (статистика посещений)" },
        marketing: { required: false, default: false, description: "Маркетинговые cookies (персонализированная реклама)" },
      },
    },
  });
});

export default consentRoutes;
