import { Hono } from 'hono';
import { apiError } from './error-codes.tsx';
import * as db from "./db.tsx";
import { requireAuth, requireOwner } from './auth-middleware.tsx';

const app = new Hono();

// Get user settings
app.get("/user/:userId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");

    if (!userId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID is required');
    }

    const settings = await db.getUserSettings(userId);

    // Return empty defaults if none exist
    if (!settings) {
      const defaultSettings = {
        profile: {
          displayName: "",
          bio: "",
          location: "",
          website: "",
          genres: [],
        },
        security: { twoFactorEnabled: false },
        notifications: {
          pushNotifications: true,
          emailNotifications: true,
          smsNotifications: false,
          soundEnabled: true,
          notifyNewDonations: true,
          notifyNewMessages: true,
          notifyNewComments: true,
          notifyNewFollowers: true,
          notifyAnalytics: true,
          notifyStreamMilestones: true,
          notifyMarketingCampaigns: false,
          notifySubscriptionExpiry: true,
        },
        privacy: {
          profileVisibility: "public",
          allowMessages: "everyone",
          showOnlineStatus: true,
          showLastSeen: true,
          allowTagging: true,
        },
        analytics: {
          trackPageViews: true,
          trackClicks: true,
          trackListens: true,
          trackDonations: true,
          shareDataWithPartners: false,
        },
        appearance: {
          theme: "dark",
          accentColor: "cyan",
          compactMode: false,
          reducedMotion: false,
          largeText: false,
          highContrast: false,
        },
        advanced: { language: "ru" },
      };

      return c.json({ settings: defaultSettings });
    }

    return c.json({ settings });
  } catch (error) {
    console.error("Error fetching user settings:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// Update user settings
app.put("/user/:userId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const body = await c.req.json();

    if (!userId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID is required');
    }

    if (!body.settings) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'Settings data is required');
    }

    await db.upsertUserSettings(userId, body.settings);

    return c.json({
      success: true,
      message: "Settings updated successfully",
      settings: body.settings
    });
  } catch (error) {
    console.error("Error updating user settings:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// Update profile section
app.patch("/user/:userId/profile", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const body = await c.req.json();

    if (!userId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID is required');
    }

    const currentSettings = await db.getUserSettings(userId) || {};

    const updatedSettings = {
      ...currentSettings,
      profile: {
        ...(currentSettings.profile || {}),
        ...body,
      },
    };

    await db.upsertUserSettings(userId, updatedSettings);

    return c.json({
      success: true,
      message: "Profile updated successfully",
      profile: updatedSettings.profile
    });
  } catch (error) {
    console.error("Error updating profile:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// Get active sessions
app.get("/user/:userId/sessions", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");

    if (!userId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID is required');
    }

    const sessions = await db.getUserSessions(userId);
    return c.json({ sessions: sessions || [] });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// Terminate session
app.delete("/user/:userId/sessions/:sessionId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const sessionId = parseInt(c.req.param("sessionId"));

    if (!userId || !sessionId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID and Session ID are required');
    }

    // For now, sessions are mock data — just return success
    return c.json({
      success: true,
      message: "Session terminated successfully"
    });
  } catch (error) {
    console.error("Error terminating session:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// NOTE: change-password lives at POST /auth/change-password (auth-routes.tsx).
// The previous duplicate here returned success without verifying currentPassword
// or persisting newPassword — a no-op dressed up as a working endpoint. Removed
// because nothing in the frontend called it; settings-api.ts already targets the
// real /auth path.

// Get payment methods
app.get("/user/:userId/payment-methods", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");

    if (!userId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID is required');
    }

    const methods = await db.getPaymentMethods(userId);
    return c.json({ methods: methods || [] });
  } catch (error) {
    console.error("Error fetching payment methods:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// Add payment method
app.post("/user/:userId/payment-methods", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const body = await c.req.json();

    if (!userId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID is required');
    }

    const existingMethods = await db.getPaymentMethods(userId);

    const methodId = `pm-${Date.now()}`;
    const newMethod = {
      id: methodId,
      ...body,
      isDefault: (!existingMethods || existingMethods.length === 0),
    };

    await db.upsertPaymentMethod(methodId, userId, newMethod);

    return c.json({
      success: true,
      message: "Payment method added successfully",
      method: newMethod
    });
  } catch (error) {
    console.error("Error adding payment method:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// Delete payment method
app.delete("/user/:userId/payment-methods/:methodId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const methodId = c.req.param("methodId");

    if (!userId || !methodId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'User ID and Method ID are required');
    }

    await db.deletePaymentMethod(methodId);

    return c.json({
      success: true,
      message: "Payment method deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting payment method:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// Save onboarding wizard answers.
//
// userId берём из JWT (cookie), НЕ из URL: OnboardingWizard.tsx до фикса
// слал /user/unknown/onboarding (localStorage 'userId' после B2 никто не
// пишет), а роута не существовало вовсе — ответы молча терялись
// (contract-audit 2026-07-02). Кладём в user_settings.data.onboarding.
app.post("/onboarding", requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId') || '');
    if (!userId) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'No user in session');
    }
    const body = await c.req.json().catch(() => ({}));
    // userId из тела не доверяем — источник истины JWT.
    const { userId: _ignored, ...answers } = body || {};

    const current = (await db.getUserSettings(userId)) || {};
    const updated = {
      ...current,
      onboarding: {
        ...(current.onboarding || {}),
        ...answers,
        completedAt: new Date().toISOString(),
      },
    };
    await db.upsertUserSettings(userId, updated);
    return c.json({ success: true });
  } catch (error) {
    console.error("Error saving onboarding:", error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

export default app;
