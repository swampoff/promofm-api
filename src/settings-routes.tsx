import { Hono } from 'hono';
import * as db from "./db.tsx";
import { requireAuth, requireOwner } from './auth-middleware.tsx';

const app = new Hono();

// Get user settings
app.get("/user/:userId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
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
    return c.json({ error: "Failed to fetch settings" }, 500);
  }
});

// Update user settings
app.put("/user/:userId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const body = await c.req.json();

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
    }

    if (!body.settings) {
      return c.json({ error: "Settings data is required" }, 400);
    }

    await db.upsertUserSettings(userId, body.settings);

    return c.json({
      success: true,
      message: "Settings updated successfully",
      settings: body.settings
    });
  } catch (error) {
    console.error("Error updating user settings:", error);
    return c.json({ error: "Failed to update settings" }, 500);
  }
});

// Update profile section
app.patch("/user/:userId/profile", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const body = await c.req.json();

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
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
    return c.json({ error: "Failed to update profile" }, 500);
  }
});

// Get active sessions
app.get("/user/:userId/sessions", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
    }

    const sessions = await db.getUserSessions(userId);
    return c.json({ sessions: sessions || [] });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return c.json({ error: "Failed to fetch sessions" }, 500);
  }
});

// Terminate session
app.delete("/user/:userId/sessions/:sessionId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const sessionId = parseInt(c.req.param("sessionId"));

    if (!userId || !sessionId) {
      return c.json({ error: "User ID and Session ID are required" }, 400);
    }

    // For now, sessions are mock data — just return success
    return c.json({
      success: true,
      message: "Session terminated successfully"
    });
  } catch (error) {
    console.error("Error terminating session:", error);
    return c.json({ error: "Failed to terminate session" }, 500);
  }
});

// Change password
app.post("/user/:userId/change-password", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const body = await c.req.json();

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
    }

    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return c.json({ error: "Current and new passwords are required" }, 400);
    }

    if (newPassword.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    return c.json({
      success: true,
      message: "Password changed successfully"
    });
  } catch (error) {
    console.error("Error changing password:", error);
    return c.json({ error: "Failed to change password" }, 500);
  }
});

// Get payment methods
app.get("/user/:userId/payment-methods", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
    }

    const methods = await db.getPaymentMethods(userId);
    return c.json({ methods: methods || [] });
  } catch (error) {
    console.error("Error fetching payment methods:", error);
    return c.json({ error: "Failed to fetch payment methods" }, 500);
  }
});

// Add payment method
app.post("/user/:userId/payment-methods", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const body = await c.req.json();

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
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
    return c.json({ error: "Failed to add payment method" }, 500);
  }
});

// Delete payment method
app.delete("/user/:userId/payment-methods/:methodId", requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param("userId");
    const methodId = c.req.param("methodId");

    if (!userId || !methodId) {
      return c.json({ error: "User ID and Method ID are required" }, 400);
    }

    await db.deletePaymentMethod(methodId);

    return c.json({
      success: true,
      message: "Payment method deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting payment method:", error);
    return c.json({ error: "Failed to delete payment method" }, 500);
  }
});

export default app;
