import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { pool } from './db-client.tsx';
import bcrypt from 'bcryptjs';

const profileRoutes = new Hono();

// GET /profile
profileRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const profile = await db.getProfile(userId);
    return c.json({
      success: true,
      data: profile || {
        userId,
        name: 'New Artist',
        subscribers: 0,
        totalPlays: 0,
        totalTracks: 0,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /profile
profileRoutes.put('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const existing = await db.getProfile(userId);
    const updated = {
      ...(existing || { userId, subscribers: 0, totalPlays: 0, totalTracks: 0 }),
      ...body,
      userId,
      updatedAt: new Date().toISOString(),
    };
    await db.upsertProfile(userId, updated);
    return c.json({ success: true, data: updated });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});



// ── GET /data-export — выгрузка всех данных пользователя (GDPR/152-ФЗ) ──
profileRoutes.get('/data-export', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');

    // Rate limit: 1 export per 24 hours
    const lastExport = await pool.query(
      `SELECT created_at FROM audit_logs WHERE user_id = $1 AND action = 'data_export' AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [userId]
    ).catch(() => ({ rows: [] }));

    if (lastExport.rows.length > 0) {
      return c.json({
        success: false,
        error: 'Экспорт данных доступен раз в 24 часа. Следующий будет доступен после ' + lastExport.rows[0].created_at,
      }, 429);
    }

    // Collect all user data from major tables
    const tables = [
      { name: 'users', query: 'SELECT id, email, role, created_at, consent_at FROM users WHERE id = $1', sensitive: true },
      { name: 'profiles', query: 'SELECT * FROM profiles WHERE user_id = $1' },
      { name: 'artist_profiles', query: 'SELECT * FROM artist_profiles WHERE user_id = $1' },
      { name: 'producer_profiles', query: 'SELECT * FROM producer_profiles WHERE user_id = $1' },
      { name: 'dj_profiles', query: 'SELECT * FROM dj_profiles WHERE user_id = $1' },
      { name: 'radio_profiles', query: 'SELECT * FROM radio_profiles WHERE user_id = $1' },
      { name: 'venue_profiles', query: 'SELECT * FROM venue_profiles WHERE user_id = $1' },
      { name: 'tracks', query: 'SELECT id, title, genre, release_date, created_at FROM tracks WHERE user_id = $1' },
      { name: 'comments', query: 'SELECT id, content, created_at FROM comments WHERE user_id = $1' },
      { name: 'likes', query: 'SELECT * FROM likes WHERE user_id = $1' },
      { name: 'bookings', query: 'SELECT * FROM bookings WHERE user_id = $1' },
      { name: 'subscriptions', query: 'SELECT * FROM subscriptions WHERE user_id = $1' },
      { name: 'payment_sessions', query: 'SELECT order_id, amount, currency, status, type, created_at FROM payment_sessions WHERE user_id = $1' },
      { name: 'payment_transactions', query: 'SELECT * FROM payment_transactions WHERE user_id = $1' },
      { name: 'notifications', query: 'SELECT id, type, title, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100' },
      { name: 'user_settings', query: 'SELECT * FROM user_settings WHERE user_id = $1' },
      { name: 'notification_settings', query: 'SELECT * FROM notification_settings WHERE user_id = $1' },
      { name: 'pitches', query: 'SELECT * FROM pitches WHERE user_id = $1' },
      { name: 'concerts', query: 'SELECT * FROM concerts WHERE user_id = $1' },
    ];

    const exportData: Record<string, any> = {
      export_date: new Date().toISOString(),
      user_id: userId,
      format_version: '1.0',
    };

    // Audit B-2 (2026-05-31): strip password_hash (+ другие secrets) ВНУТРИ
    // каждого присвоения, не одним post-step на text-path. Раньше UUID-fallback
    // loop мог заполнить exportData.users ПОСЛЕ единственного strip-step,
    // пропуская hash в экспорт. Теперь sanitize на источнике.
    const stripSecrets = (rows: any[], tableName: string): any[] => {
      if (tableName !== 'users') return rows;
      return rows.map((u: any) => {
        const { password_hash, mfa_secret, ...safe } = u;
        return safe;
      });
    };

    for (const table of tables) {
      try {
        const result = await pool.query(table.query, [userId]);
        if (result.rows.length > 0) {
          exportData[table.name] = stripSecrets(result.rows, table.name);
        }
      } catch {
        // Table might not exist or have different schema
      }
    }

    // Also try UUID match
    for (const table of tables) {
      if (!exportData[table.name]) {
        try {
          const uuidQuery = table.query.replace('= $1', '= $1::uuid');
          const result = await pool.query(uuidQuery, [userId]);
          if (result.rows.length > 0) {
            exportData[table.name] = stripSecrets(result.rows, table.name);
          }
        } catch {}
      }
    }

    // Log the export
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, created_at) VALUES ($1, 'data_export', '{"tables": ${Object.keys(exportData).length}}', NOW())`,
      [userId]
    ).catch(() => {});

    return c.json({
      success: true,
      data: exportData,
    });
  } catch (error) {
    console.error('Data export error:', error);
    return c.json({ success: false, error: 'Ошибка при экспорте данных' }, 500);
  }
});

// ── DELETE /account — полное удаление аккаунта (GDPR/152-ФЗ) ──
profileRoutes.delete('/account', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({}));
    const { password, confirmation } = body;

    // Require explicit confirmation
    if (confirmation !== 'DELETE_MY_ACCOUNT') {
      return c.json({
        success: false,
        error: 'Для удаления аккаунта отправьте confirmation: "DELETE_MY_ACCOUNT"',
      }, 400);
    }

    // Verify password
    if (!password) {
      return c.json({ success: false, error: 'Введите пароль для подтверждения' }, 400);
    }

    // Get user record to verify password
    const userResult = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return c.json({ success: false, error: 'Пользователь не найден' }, 404);
    }

    const user = userResult.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      return c.json({ success: false, error: 'Неверный пароль' }, 403);
    }

    // Execute cascading deletion
    const deleteResult = await pool.query(
      'SELECT delete_user_account($1) AS result',
      [userId]
    );

    const deletedCounts = deleteResult.rows[0]?.result || {};

    // Log the deletion event (anonymized)
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, created_at)
       VALUES (NULL, 'account_deleted', $1, NOW())`,
      [JSON.stringify({ tables_affected: Object.keys(deletedCounts).length, timestamp: new Date().toISOString() })]
    ).catch(() => {});

    // Send Telegram alert about account deletion
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_LEAD_CHAT_ID;
      if (token && chatId) {
        const msg = `🗑️ Аккаунт удалён\n\nUser ID: ${userId.slice(0, 8)}...\nТаблиц затронуто: ${Object.keys(deletedCounts).length}\nВремя: ${new Date().toISOString()}`;
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: msg }),
        }).catch(() => {});
      }
    } catch {}

    // Audit INC-3 (2026-05-31): gate на _errors. Migration 094 теперь
    // собирает РЕАЛЬНЫЕ per-table failures (FK violation, RLS) в _errors —
    // раньше они silently swallowed → orphan PII при success:true.
    if (deletedCounts._errors && Object.keys(deletedCounts._errors).length > 0) {
      console.error('[account-delete] partial failure – PII may remain', { userId, errors: deletedCounts._errors });
      return c.json({ success: false, error: 'Аккаунт удалён частично – часть данных не удалось стереть. Обратитесь в поддержку, мы завершим удаление вручную.' }, 500);
    }

    if (deletedCounts.users !== 1) {
      console.error('[account-delete] incomplete – users row not removed', { userId, deletedCounts });
      return c.json({ success: false, error: 'Не удалось полностью удалить аккаунт. Обратитесь в поддержку.' }, 500);
    }

    return c.json({
      success: true,
      message: 'Ваш аккаунт и все данные полностью удалены',
      details: {
        tables_cleaned: Object.keys(deletedCounts).length,
      },
    });
  } catch (error) {
    console.error('Account deletion error:', error);
    return c.json({ success: false, error: 'Ошибка при удалении аккаунта' }, 500);
  }
});

export default profileRoutes;
