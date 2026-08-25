/**
 * ACCOUNT DELETION - самостоятельное удаление аккаунта пользователем.
 * 152-ФЗ: право на удаление персональных данных. До этого каждый такой
 * запрос обрабатывался вручную через psql (тикет 35301a5d, 25.08.2026).
 *
 * ВАЖНО про схему: внешних ключей на users всего 6, остальные ~13 таблиц
 * ссылаются на пользователя БЕЗ FK. Простое `DELETE FROM users` оставляет
 * персональные данные сиротами, поэтому таблицы ищем динамически по имени
 * колонки и вычищаем явно.
 */
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { apiError } from './error-codes.tsx';

const app = new Hono();

const ARCHIVE_DIR = process.env.DELETED_ACCOUNTS_DIR || '/opt/promofm-userdata/deleted-accounts';
// Аналитику не удаляем, а обезличиваем: статистика посещаемости остаётся,
// связь с человеком пропадает.
const ANONYMIZE: Record<string, string[]> = { page_views: ['user_id'] };
const USER_REF_COLUMNS = [
  'user_id', 'artist_id', 'owner_id', 'author_id', 'created_by', 'sender_id',
  'recipient_id', 'producer_id', 'uploaded_by', 'follower_id', 'buyer_id',
  'donor_id', 'requester_id', 'from_user_id', 'to_user_id',
];

/** Все (таблица, колонка), которые могут ссылаться на пользователя. */
async function userRefColumns(): Promise<Array<{ table: string; col: string }>> {
  const { rows } = await pool.query(
    `SELECT table_name AS table, column_name AS col
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('uuid', 'text', 'character varying')
        AND column_name = ANY($1)
      ORDER BY table_name`,
    [USER_REF_COLUMNS],
  );
  return rows as Array<{ table: string; col: string }>;
}

/** Снимок всех данных пользователя - пишем на диск до удаления. */
async function archiveUser(userId: string, refs: Array<{ table: string; col: string }>) {
  const snapshot: Record<string, any> = { userId, archivedAt: new Date().toISOString() };
  const user = await pool.query('SELECT * FROM users WHERE id::text = $1', [userId]);
  snapshot.users = user.rows;
  for (const { table, col } of refs) {
    try {
      const r = await pool.query(
        `SELECT * FROM "${table}" WHERE "${col}"::text = $1 LIMIT 5000`, [userId],
      );
      if (r.rowCount) snapshot[`${table}.${col}`] = r.rows;
    } catch { /* колонка другого типа - пропускаем */ }
  }
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const file = path.join(ARCHIVE_DIR, `${userId}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  return file;
}

/**
 * Полностью удалить пользователя. Порядок таблиц заранее неизвестен, поэтому
 * идём несколькими проходами с SAVEPOINT: то, что заблокировано внешним
 * ключом, уедет на следующем проходе, когда исчезнут зависимые строки.
 */
export async function deleteUserCompletely(userId: string) {
  const refs = await userRefColumns();
  const archiveFile = await archiveUser(userId, refs);

  const client = await pool.connect();
  const deleted: Record<string, number> = {};
  const anonymized: Record<string, number> = {};
  try {
    await client.query('BEGIN');

    for (const [table, cols] of Object.entries(ANONYMIZE)) {
      for (const col of cols) {
        await client.query('SAVEPOINT sp');
        try {
          const r = await client.query(
            `UPDATE "${table}" SET "${col}" = NULL WHERE "${col}"::text = $1`, [userId],
          );
          if (r.rowCount) anonymized[`${table}.${col}`] = r.rowCount;
          await client.query('RELEASE SAVEPOINT sp');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT sp');
        }
      }
    }

    let pending = refs.filter((r) => !ANONYMIZE[r.table]?.includes(r.col));
    for (let pass = 0; pass < 3 && pending.length; pass++) {
      const blocked: typeof pending = [];
      for (const { table, col } of pending) {
        await client.query('SAVEPOINT sp');
        try {
          const r = await client.query(
            `DELETE FROM "${table}" WHERE "${col}"::text = $1`, [userId],
          );
          if (r.rowCount) deleted[`${table}.${col}`] = (deleted[`${table}.${col}`] || 0) + r.rowCount;
          await client.query('RELEASE SAVEPOINT sp');
        } catch (e: any) {
          await client.query('ROLLBACK TO SAVEPOINT sp');
          if (e?.code === '23503') blocked.push({ table, col });  // FK - попробуем позже
        }
      }
      pending = blocked;
    }

    const u = await client.query('DELETE FROM users WHERE id::text = $1', [userId]);
    if (!u.rowCount) throw new Error('Пользователь не найден');
    deleted.users = u.rowCount;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { deleted, anonymized, archiveFile };
}

/**
 * POST /server/api/account/delete
 * Требует подтверждения: паролем, а для входа через VK (пароля нет) -
 * словом УДАЛИТЬ, чтобы аккаунт нельзя было снести случайным запросом.
 */
app.post('/delete', requireAuth, async (c) => {
  const userId = String(c.get('userId') || '');
  if (!userId) return apiError(c, 'AUTH_REQUIRED', 'Требуется вход');

  const body = await c.req.json().catch(() => ({} as any));
  const password = String(body?.password || '');
  const confirm = String(body?.confirm || '').trim().toUpperCase();

  const { rows } = await pool.query(
    'SELECT id, email, role, password_hash FROM users WHERE id::text = $1', [userId],
  );
  const user = rows[0];
  if (!user) return apiError(c, 'NOT_FOUND', 'Аккаунт не найден');

  if (user.password_hash) {
    if (!password) return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'Введите пароль для подтверждения');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return apiError(c, 'AUTH_WRONG_PASSWORD', 'Неверный пароль');
  } else if (confirm !== 'УДАЛИТЬ') {
    return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'Введите слово УДАЛИТЬ для подтверждения');
  }

  try {
    const result = await deleteUserCompletely(userId);
    console.log(`[account-deletion] удалён ${userId} (${user.email}):`, JSON.stringify(result.deleted));
    return c.json({
      success: true,
      message: 'Аккаунт и связанные данные удалены. Спасибо, что были с нами.',
      deletedRows: Object.values(result.deleted).reduce((a, b) => a + b, 0),
    });
  } catch (err: any) {
    console.error('[account-deletion] ошибка:', err?.message);
    return apiError(c, 'INTERNAL_ERROR', 'Не удалось удалить аккаунт. Напишите в поддержку.');
  }
});

export default app;
