/**
 * AUTH MIDDLEWARE — JWT verification for API routes
 * Drop-in replacement: same API as original
 */
import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';

export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const accessToken = authHeader?.replace('Bearer ', '');

  if (!accessToken) {
    return c.json({ success: false, error: 'Authorization required' }, 401);
  }

  try {
    const decoded = jwt.verify(accessToken, process.env.JWT_SECRET!) as any;

    c.set('userId', decoded.sub);
    c.set('userEmail', decoded.email || '');
    c.set('userRole', decoded.role || 'artist');

    await next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }
}

export async function requireAdmin(c: Context, next: Next) {
  const role = c.get('userRole');
  if (role !== 'admin') {
    return c.json({ success: false, error: 'Admin access required' }, 403);
  }
  await next();
}

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
