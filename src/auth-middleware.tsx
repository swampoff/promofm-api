/**
 * AUTH MIDDLEWARE — JWT verification for API routes
 * Drop-in replacement: same API as original
 */
import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';

import { createLogger } from "./logger.tsx";

const log = createLogger("auth-mw");

export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const accessToken = authHeader?.replace('Bearer ', '');

  if (!accessToken) {
    return c.json({ success: false, error: 'Authorization required' }, 401);
  }

  try {
    const decoded = jwt.verify(accessToken, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as any;

    // Check token_version — invalidated tokens are rejected
    if (decoded.tv) {
      const { pool } = await import('./db-client.tsx');
      const res = await pool.query('SELECT token_version FROM users WHERE id = $1', [decoded.sub]);
      if (res.rows.length > 0 && res.rows[0].token_version > (decoded.tv || 0)) {
        return c.json({ success: false, error: 'Session expired. Please sign in again.' }, 401);
      }
    }

    c.set('userId', decoded.sub);
    c.set('userEmail', decoded.email || '');
    c.set('userRole', decoded.role || 'artist');

    await next();
  } catch (err) {
    log.error({ err }, 'auth_middleware_error');
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }
}

export async function requireAdmin(c: Context, next: Next) {  const role = c.get("userRole");  const email = c.get("userEmail");  const { SUPERADMIN_EMAIL } = await import("./roles.tsx");  if (role !== "admin" || email !== SUPERADMIN_EMAIL) {    return c.json({ success: false, error: "Admin access required" }, 403);  }  await next();}

export function requireOwner(paramName: string) {
  return async (c: Context, next: Next) => {
    const userId = c.get('userId');
    const resourceOwnerId = c.req.param(paramName);
    if (resourceOwnerId && resourceOwnerId !== userId) {
      return c.json({ success: false, error: 'Access denied: not resource owner' }, 403);
    }
    await next();
  };
}


// ─── RBAC ROLE-BASED MIDDLEWARE ────────────────────────────────

/**
 * Require specific role(s). Usage: requireRole('admin', 'superadmin')
 * Must be placed AFTER requireAuth in middleware chain.
 */
export function requireRole(...allowedRoles: string[]) {
  return async (c: Context, next: Next) => {
    const role = c.get('userRole');
    if (!allowedRoles.includes(role)) {
      return c.json({ success: false, error: 'Insufficient role' }, 403);
    }
    await next();
  };
}

/**
 * Require minimum role level. Usage: requireMinRole('producer')
 * Checks if user's role level >= specified role level.
 */
export function requireMinRole(minRole: string) {
  return async (c: Context, next: Next) => {
    const { getRoleLevel } = await import('./roles.tsx');
    const userRole = c.get('userRole');
    if (getRoleLevel(userRole) < getRoleLevel(minRole)) {
      return c.json({ success: false, error: 'Insufficient privileges' }, 403);
    }
    await next();
  };
}

/**
 * Require specific permission. Usage: requirePermission('tracks:moderate')
 */
export function requirePermission(permission: string) {
  return async (c: Context, next: Next) => {
    const { hasPermission } = await import('./roles.tsx');
    const role = c.get('userRole');
    if (!hasPermission(role, permission as any)) {
      return c.json({ success: false, error: 'Permission denied' }, 403);
    }
    await next();
  };
}

/**
 * Superadmin-only middleware. Checks email against hardcoded SUPERADMIN_EMAIL.
 */
export async function requireSuperadmin(c: Context, next: Next) {
  const { SUPERADMIN_EMAIL } = await import('./roles.tsx');
  const email = c.get('userEmail');
  if (email !== SUPERADMIN_EMAIL) {
    return c.json({ success: false, error: 'Superadmin access required' }, 403);
  }
  await next();
}
