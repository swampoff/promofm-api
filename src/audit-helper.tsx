/**
 * AUDIT HELPER — единая запись admin-действий в audit_logs.
 *
 * Audit B-8 (2026-05-31): большинство admin mutation endpoints не
 * логировались — не было forensic trail кто одобрил/отклонил/удалил.
 * Только signup/signin/role_change/account_deletion/data_export писались.
 *
 * Этот helper пишет в audit_logs использующиеся колонки actor_id /
 * target_id / action / resource_type / details / ip_address (superset
 * существующих writer'ов в auth-routes.tsx). Fire-and-forget: ошибка
 * логирования НЕ должна ломать само admin-действие.
 *
 * Usage:
 *   import { logAdminAction } from './audit-helper.tsx';
 *   logAdminAction(c, {
 *     action: 'track_moderation_approve',
 *     resourceType: 'track',
 *     targetId: trackId,
 *     details: { title: track.title, price: PUBLICATION_PRICE },
 *   });
 */

import type { Context } from 'hono';
import { pool } from './db-client.tsx';

interface AdminActionLog {
  action: string;                    // e.g. 'track_moderation_approve'
  resourceType?: string;             // e.g. 'track' | 'dj_mix' | 'user' | 'profile'
  targetId?: string | null;          // id of the affected entity
  details?: Record<string, any>;     // arbitrary context (titles, prices, reasons)
  status?: string;                   // 'success' | 'failure'
}

function clientIp(c: Context): string {
  // x-forwarded-for может быть "ip1, ip2, ..." — берём первый и trim'аем.
  // Comma-list ломает inet-колонку, поэтому single IP.
  const raw = c.req.header('x-forwarded-for')
    || c.req.header('x-real-ip')
    || '0.0.0.0';
  return raw.split(',')[0].trim() || '0.0.0.0';
}

/**
 * Fire-and-forget. Не await'ить в hot path — пусть пишется в фоне.
 * actor_id берётся из JWT context (c.get('userId')) — это admin
 * совершивший действие.
 */
export function logAdminAction(c: Context, entry: AdminActionLog): void {
  const actorId = (c.get('userId') as string | undefined) || null;
  const ip = clientIp(c);
  pool.query(
    `INSERT INTO audit_logs
       (action, actor_id, target_id, resource_type, details, ip_address, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      entry.action,
      actorId,
      entry.targetId ?? null,
      entry.resourceType ?? 'admin',
      JSON.stringify(entry.details ?? {}),
      ip,
      entry.status ?? 'success',
    ],
  ).catch((e: any) => {
    // Логирование не должно ронять действие. Только console.
    console.error('[audit] logAdminAction failed:', e?.message || e);
  });
}
