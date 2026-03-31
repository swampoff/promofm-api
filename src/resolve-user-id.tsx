/**
 * RESOLVE USER ID — Extracts user ID from JWT token or internal API header.
 * SECURITY: Never falls back to demo/anonymous user for write operations.
 * For read-only routes, caller can provide a fallback explicitly.
 */
import jwt from 'jsonwebtoken';

/**
 * Resolve user ID strictly from JWT or internal API key.
 * Returns null if no valid authentication found.
 * Callers MUST handle null (return 401) on write endpoints.
 */
export async function resolveUserId(c: any): Promise<string | null> {
  // 1. JWT token (primary auth)
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    try {
      const token = authHeader.replace('Bearer ', '');
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      if (decoded.sub) return decoded.sub;
    } catch { /* invalid token — fall through */ }
  }

  // 2. Middleware-set userId (from requireAuth)
  const middlewareUserId = c.get('userId');
  if (middlewareUserId) return middlewareUserId;

  // 3. Internal API calls (with X-Internal-Key)
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey === process.env.VPS_INTERNAL_KEY) {
    const headerUserId = c.req.header('X-User-Id');
    if (headerUserId) return headerUserId;
  }


  return null;
}

/**
 * Strict version — returns userId or throws 401.
 * Use this on ALL write endpoints (POST, PUT, DELETE).
 */
export async function requireUserId(c: any): Promise<string> {
  const userId = await resolveUserId(c);
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }
  return userId;
}
