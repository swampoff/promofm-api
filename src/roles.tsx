/**
 * RBAC (Role-Based Access Control) — Central role & permission system
 *
 * Roles are defined as code (not DB-only), versioned with the codebase.
 * Allowlist model: everything not explicitly permitted is DENIED.
 * Superadmin: ONLY n.moiseev@gmx.de — hardcoded, cannot be assigned via API.
 *
 * Role hierarchy (high → low):
 *   superadmin > admin > producer > radio_station > dj > venue > artist > guest
 */

// ─── ROLE DEFINITIONS ───────────────────────────────────────────

export const ROLES = [
  'superadmin', 'admin', 'producer', 'radio_station', 'label', 'dj', 'venue', 'artist', 'engineer',
] as const;

export type Role = typeof ROLES[number];

// Superadmin is ONLY this email — hardcoded, cannot be changed.
// Used by requireSuperadmin для самых чувствительных операций.
export const SUPERADMIN_EMAIL = 'n.moiseev@gmx.de';

// Admin-доступ к /admin/* endpoint'ам (admin-кабинет, live-chat,
// модерация и т.д.). Явный allowlist email'ов — оба полноценные админы.
// requireAdmin требует email ∈ ADMIN_EMAILS. Email берётся из подписанного
// JWT/cookie (подделать нельзя), а сами email'ы уникальны в users —
// поэтому allowlist по email безопасен.
export const ADMIN_EMAILS = [
  'n.moiseev@gmx.de',
  'info@promofm.ru',
] as const;

// Регистронезависимая, trimmed проверка членства в admin-allowlist.
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const norm = email.toLowerCase().trim();
  return (ADMIN_EMAILS as readonly string[]).some((e) => e.toLowerCase() === norm);
}

// Role hierarchy levels (higher = more privileges)
const ROLE_LEVEL: Record<Role, number> = {
  superadmin: 100,
  admin: 90,
  producer: 50,
  radio_station: 40,
  engineer: 40,
  label: 35,
  dj: 30,
  venue: 30,
  artist: 10,
};

export function getRoleLevel(role: string): number {
  return ROLE_LEVEL[role as Role] ?? 0;
}

export function isValidRole(role: string): role is Role {
  return ROLES.includes(role as Role);
}

// ─── PERMISSION DEFINITIONS ─────────────────────────────────────

export type Permission =
  // Content
  | 'tracks:create' | 'tracks:read' | 'tracks:update' | 'tracks:delete'
  | 'tracks:moderate'
  | 'news:create' | 'news:read' | 'news:update' | 'news:delete'
  | 'videos:create' | 'videos:read' | 'videos:update' | 'videos:delete'
  // Profiles
  | 'profile:read' | 'profile:update'
  | 'profile:read_any' | 'profile:update_any'
  // Radio
  | 'radio:manage' | 'radio:broadcast'
  // Bookings & Venues
  | 'bookings:create' | 'bookings:manage'
  | 'venues:manage'
  // Payments & Commerce
  | 'payments:create' | 'payments:view_own' | 'payments:view_all'
  | 'checkout:create'
  // Analytics
  | 'analytics:view_own' | 'analytics:view_all'
  // Admin
  | 'users:manage' | 'users:approve' | 'users:set_role'
  | 'system:config' | 'system:security' | 'system:agents'
  // Moderation
  | 'moderation:manage'
  // Ecosystem / Agents
  | 'agents:execute' | 'agents:manage';

// ─── ROLE → PERMISSIONS MATRIX ──────────────────────────────────

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  superadmin: [
    // Superadmin has ALL permissions
    'tracks:create', 'tracks:read', 'tracks:update', 'tracks:delete', 'tracks:moderate',
    'news:create', 'news:read', 'news:update', 'news:delete',
    'videos:create', 'videos:read', 'videos:update', 'videos:delete',
    'profile:read', 'profile:update', 'profile:read_any', 'profile:update_any',
    'radio:manage', 'radio:broadcast',
    'bookings:create', 'bookings:manage', 'venues:manage',
    'payments:create', 'payments:view_own', 'payments:view_all',
    'checkout:create',
    'analytics:view_own', 'analytics:view_all',
    'users:manage', 'users:approve', 'users:set_role',
    'system:config', 'system:security', 'system:agents',
    'moderation:manage',
    'agents:execute', 'agents:manage',
  ],

  admin: [
    'tracks:create', 'tracks:read', 'tracks:update', 'tracks:delete', 'tracks:moderate',
    'news:create', 'news:read', 'news:update', 'news:delete',
    'videos:create', 'videos:read', 'videos:update', 'videos:delete',
    'profile:read', 'profile:update', 'profile:read_any', 'profile:update_any',
    'radio:manage', 'radio:broadcast',
    'bookings:create', 'bookings:manage', 'venues:manage',
    'payments:create', 'payments:view_own', 'payments:view_all',
    'checkout:create',
    'analytics:view_own', 'analytics:view_all',
    'users:manage', 'users:approve', 'users:set_role',
    'system:config', 'system:agents',
    'moderation:manage',
    'agents:execute', 'agents:manage',
  ],

  producer: [
    'tracks:create', 'tracks:read', 'tracks:update', 'tracks:delete',
    'videos:create', 'videos:read', 'videos:update', 'videos:delete',
    'profile:read', 'profile:update',
    'bookings:create',
    'payments:create', 'payments:view_own',
    'checkout:create',
    'analytics:view_own',
  ],

  radio_station: [
    'tracks:read',
    'news:read',
    'profile:read', 'profile:update',
    'radio:manage', 'radio:broadcast',
    'payments:create', 'payments:view_own',
    'checkout:create',
    'analytics:view_own',
  ],

  engineer: [
    'tracks:create', 'tracks:read', 'tracks:update',
    'profile:read', 'profile:update',
    'payments:create', 'payments:view_own',
    'checkout:create',
    'analytics:view_own',
  ],

  dj: [
    'tracks:create', 'tracks:read', 'tracks:update', 'tracks:delete',
    'videos:create', 'videos:read', 'videos:update',
    'profile:read', 'profile:update',
    'bookings:create',
    'payments:create', 'payments:view_own',
    'checkout:create',
    'analytics:view_own',
  ],

  venue: [
    'tracks:read',
    'profile:read', 'profile:update',
    'venues:manage',
    'bookings:create', 'bookings:manage',
    'payments:create', 'payments:view_own',
    'checkout:create',
    'analytics:view_own',
  ],

  artist: [
    'tracks:create', 'tracks:read', 'tracks:update', 'tracks:delete',
    'videos:create', 'videos:read', 'videos:update', 'videos:delete',
    'profile:read', 'profile:update',
    'bookings:create',
    'payments:create', 'payments:view_own',
    'checkout:create',
    'analytics:view_own',
  ],

  // Record label: superset of artist (publishes on behalf of roster artists)
  // plus moderation-light roster operations. No `tracks:moderate` — releases
  // still go through admin moderation.
  label: [
    'tracks:create', 'tracks:read', 'tracks:update', 'tracks:delete',
    'videos:create', 'videos:read', 'videos:update', 'videos:delete',
    'profile:read', 'profile:update',
    'bookings:create',
    'payments:create', 'payments:view_own',
    'checkout:create',
    'analytics:view_own',
  ],
};

// ─── PERMISSION CHECK ───────────────────────────────────────────

export function hasPermission(role: string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role as Role];
  if (!perms) return false;
  return perms.includes(permission);
}

export function hasAnyPermission(role: string, permissions: Permission[]): boolean {
  return permissions.some(p => hasPermission(role, p));
}

export function hasAllPermissions(role: string, permissions: Permission[]): boolean {
  return permissions.every(p => hasPermission(role, p));
}

// ─── ROLE COMPARISON ────────────────────────────────────────────

/**
 * Check if roleA outranks roleB in the hierarchy.
 * Used for delegation rules: cannot assign role >= own.
 */
export function outranks(roleA: string, roleB: string): boolean {
  return getRoleLevel(roleA) > getRoleLevel(roleB);
}

/**
 * Roles that a given role is allowed to assign to others.
 * Rule: can only assign roles strictly BELOW own level.
 */
export function assignableRoles(currentRole: string): Role[] {
  const level = getRoleLevel(currentRole);
  return ROLES.filter(r => ROLE_LEVEL[r] < level && r !== 'superadmin');
}

// ─── ROLE CHANGE VALIDATION ────────────────────────────────────

export interface RoleChangeResult {
  allowed: boolean;
  reason?: string;
}

export function validateRoleChange(
  actorRole: string,
  actorEmail: string,
  targetCurrentRole: string,
  newRole: string
): RoleChangeResult {
  // Superadmin can only be the designated email
  if (newRole === 'superadmin') {
    return { allowed: false, reason: 'superadmin role cannot be assigned via API' };
  }

  // Only superadmin or admin can change roles
  if (actorRole !== 'superadmin' && actorRole !== 'admin') {
    return { allowed: false, reason: 'Only admins can change user roles' };
  }

  // Cannot assign role >= own level (except superadmin who can do anything)
  if (actorRole !== 'superadmin' && getRoleLevel(newRole) >= getRoleLevel(actorRole)) {
    return { allowed: false, reason: 'Cannot assign role equal to or higher than your own' };
  }

  // Cannot modify a user with equal or higher role (except superadmin)
  if (actorRole !== 'superadmin' && getRoleLevel(targetCurrentRole) >= getRoleLevel(actorRole)) {
    return { allowed: false, reason: 'Cannot modify user with equal or higher role' };
  }

  if (!isValidRole(newRole)) {
    return { allowed: false, reason: `Invalid role: ${newRole}` };
  }

  return { allowed: true };
}

// ─── ROLE CHANGE AUDIT LOG ──────────────────────────────────────

export interface RoleChangeLog {
  timestamp: string;
  actorId: string;
  actorEmail: string;
  actorRole: string;
  targetUserId: string;
  previousRole: string;
  newRole: string;
  reason?: string;
  ip: string;
}

export function formatRoleChangeLog(log: RoleChangeLog): string {
  return `[RBAC] ${log.timestamp} | ${log.actorEmail} (${log.actorRole}) changed ${log.targetUserId} role: ${log.previousRole} → ${log.newRole} | IP: ${log.ip}${log.reason ? ' | Reason: ' + log.reason : ''}`;
}
