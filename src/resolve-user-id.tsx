/**
 * RESOLVE USER ID — Same API as original, uses JWT instead of Supabase Auth
 */
import jwt from 'jsonwebtoken';

export async function resolveUserId(c: any, demoFallback: string): Promise<string> {
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    try {
      const token = authHeader.replace('Bearer ', '');
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      if (decoded.sub) return decoded.sub;
    } catch { /* fall through */ }
  }
  // X-User-Id header removed for security (was allowing user impersonation)
  // Only internal API calls (with X-Internal-Key) can set user context
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey === process.env.VPS_INTERNAL_KEY) {
    const headerUserId = c.req.header('X-User-Id');
    if (headerUserId) return headerUserId;
  }
  return demoFallback;
}
