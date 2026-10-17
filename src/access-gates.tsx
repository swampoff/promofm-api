/**
 * ACCESS GATES: чистые решения о доступе (без базы и сети), общие для
 * нескольких маршрутов. Проверяются tools/be-security.test.mts.
 *
 * 1. Статус аккаунта: может ли аккаунт получить сессию.
 * 2. Данные заведения (AI-ведущий, promo-air-dj-routes.tsx): чьи они.
 *
 * ── 1. Статус аккаунта ──
 *
 * Партнёрские аккаунты (радио, заведения: PARTNER_ROLES в auth-routes.tsx)
 * после регистрации ждут ручного одобрения (users.status = 'pending'). Решение
 * владельца (PROMO.AIR, 16.10.2026): одобрение остаётся ручным, обходов нет.
 * Поэтому все пути, которые выдают сессию (вход по паролю, VK, обмен
 * auto_login-токена после подтверждения почты, /refresh), отказывают одинаково
 * и с одними и теми же ответами.
 *
 * 'inactive' и 'suspended' не блокируют, как и раньше на /signin.
 */

export type AccountBlock = 'pending' | 'rejected' | 'blocked';

// Тексты ответов /signin (не менять: их показывает фронтенд promo-music.ru).
const BLOCK_TEXT: Record<AccountBlock, string> = {
  pending: 'Ваш аккаунт на модерации.',
  rejected: 'Ваша заявка отклонена.',
  blocked: 'Аккаунт заблокирован администрацией.',
};

/**
 * Статус users.status → причина отказа или null (вход разрешён).
 * 'blocked' ставит админка пользователей (POST /auth/admin/users/:id/status),
 * 'banned': бан из UsersManagement и блокировка в админке PROMO.AIR.
 */
export function accountBlockOf(status: unknown): AccountBlock | null {
  switch (String(status ?? '')) {
    case 'pending': return 'pending';
    case 'rejected': return 'rejected';
    case 'blocked':
    case 'banned': return 'blocked';
    default: return null;
  }
}

/** Тело ответа 403, как у /signin. */
export function accountBlockBody(block: AccountBlock): { success: false; error: string; accountStatus: AccountBlock } {
  return { success: false, error: BLOCK_TEXT[block], accountStatus: block };
}

/**
 * Ответ /exchange-auto-login. Сюда приходят сразу после подтверждения почты,
 * поэтому для 'pending' машинный код: страница входа promoair.ru показывает
 * «почта подтверждена, аккаунт на проверке» (fe/src/promoair/api/auth.ts).
 */
export function autoLoginBlockBody(block: AccountBlock): Record<string, unknown> {
  if (block === 'pending') {
    return { success: false, error: 'account_pending', accountStatus: 'pending', message: 'Почта подтверждена. Аккаунт на проверке: напишем, когда откроем доступ.' };
  }
  return accountBlockBody(block);
}

// Подписи статусов для ответа 409 в «Заявках партнёров» (текст уходит в тост).
const STATUS_LABEL: Record<string, string> = {
  active: 'активен',
  pending: 'на проверке',
  rejected: 'отклонён',
  blocked: 'заблокирован',
  banned: 'заблокирован',
  inactive: 'неактивен',
  suspended: 'приостановлен',
};

/** «Одобрить/отклонить можно только заявку на проверке», с текущим статусом. */
export function moderationConflictText(action: 'approve' | 'reject', status: unknown): string {
  const s = String(status ?? '');
  const verb = action === 'approve' ? 'Одобрить' : 'Отклонить';
  const label = Object.prototype.hasOwnProperty.call(STATUS_LABEL, s) ? STATUS_LABEL[s] : (s || 'неизвестно');
  return `${verb} можно только аккаунт на проверке. Сейчас: ${label}.`;
}

// ── 2. Данные заведения (AI-ведущий) ──

export type VenueCaller = { userId: string; role: string; isAdmin: boolean };
export type VenueAccess =
  | { ok: true; venueKey: string }
  | { ok: false; status: 400 | 403; error: string };

const VENUE_DENIED = 'Нет доступа к данным этого заведения';

/** Нужен ли поиск владельца venue_profiles.id для этого запроса. */
export function venueNeedsOwnerLookup(caller: VenueCaller, requested: unknown): boolean {
  const id = String(requested ?? '').trim();
  return !!id && id.length <= 200 && id !== 'current' && id !== caller.userId
    && (caller.isAdmin || caller.role === 'venue');
}

/**
 * Чьи данные просит запрос с venueId (настройки, тексты и очередь
 * AI-ведущего, promo-air-dj-routes.tsx). До 17.10.2026 venueId брался из
 * пути или тела как есть: любой вошедший читал и менял чужие настройки и
 * тратил кредиты LLM/TTS (IDOR).
 *
 * Ключ хранения (promo_air_dj_*.venue_id, text) = userId владельца: одно
 * заведение на аккаунт; на проде строк 0 (17.10.2026), переносить нечего.
 * - 'current' (так шлёт кабинет, radio-brand.tsx) или свой userId → свой ключ;
 * - venue_profiles.id → userId владельца (profileOwner находит маршрут);
 * - заведение работает только со своим, админ с любым (и с userId напрямую);
 * - другие роли: 403.
 */
export function decideVenueAccess(caller: VenueCaller, requested: unknown, profileOwner?: string | null): VenueAccess {
  const id = String(requested ?? '').trim();
  if (!id || id.length > 200) return { ok: false, status: 400, error: 'venueId is required' };
  if (!caller.userId || (!caller.isAdmin && caller.role !== 'venue')) return { ok: false, status: 403, error: VENUE_DENIED };
  if (id === 'current' || id === caller.userId) return { ok: true, venueKey: caller.userId };
  if (profileOwner) {
    return caller.isAdmin || profileOwner === caller.userId
      ? { ok: true, venueKey: profileOwner }
      : { ok: false, status: 403, error: VENUE_DENIED };
  }
  return caller.isAdmin ? { ok: true, venueKey: id } : { ok: false, status: 403, error: VENUE_DENIED };
}
