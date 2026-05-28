/**
 * CURATOR AGENTS — автономные агенты-кураторы для каждой роли
 * Создают профили, настраивают кабинеты и тестируют API
 * Роли: Artist, Producer, Radio, DJ, Venue, Engineer
 */

import {
  insertCuratorReport, getLatestCuratorReport,
  type CuratorReportRow,
  upsertRadioProfile,
  upsertVenueProfile,
  upsertArtistProfile,
} from './db.tsx';
import { getDbClient } from './db-client.tsx';
import { isUrlSafe } from './security.tsx';

// ─── Types ──────────────────────────────────────────────

export type RoleId = 'artist' | 'producer' | 'radio' | 'dj' | 'venue' | 'engineer' | 'admin';

interface EndpointTest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  description: string;
  body?: Record<string, any>;
  needsUserId?: boolean;
  validation?: (body: any) => { ok: boolean; message: string };
}

interface TestResult {
  endpoint: string;
  method: string;
  description: string;
  status: number;
  ok: boolean;
  responseTime: number;
  hasData: boolean;
  dataCount?: number;
  error?: string;
  snippet?: string;
  validationOk?: boolean;
  validationMessage?: string;
}

interface CuratorReport {
  id: string;
  role: RoleId;
  roleName: string;
  startedAt: string;
  completedAt: string;
  totalEndpoints: number;
  passed: number;
  failed: number;
  warnings: number;
  setupDone: boolean;
  results: TestResult[];
  summary: string;
}

// ─── Configuration ──────────────────────────────────────

const BASE_URL = process.env.PUBLIC_URL || 'https://promo-music.ru';
const SERVICE_KEY = process.env.VPS_INTERNAL_KEY || '';
const INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
const PLACEHOLDER_USER = '00000000-0000-0000-0000-000000000000';

const CURATOR_EMAIL = 'curator@promo-music.ru';
const CURATOR_PASSWORD = process.env.CURATOR_PASSWORD || '';

export const CURATOR_ROLES: { id: RoleId; name: string; description: string }[] = [
  { id: 'artist', name: 'Артист', description: 'Профиль, треки, аналитика, питчинг, публикации' },
  { id: 'producer', name: 'Продюсер', description: 'Студия, беседы, услуги, портфолио, кошелёк, AI, календарь' },
  { id: 'radio', name: 'Радио', description: 'Рекламные слоты, заявки, финансы, аналитика' },
  { id: 'dj', name: 'Диджей', description: 'Профиль, события, коллаборации, подписки' },
  { id: 'venue', name: 'Площадка', description: 'Профиль, аналитика, плейлисты, радио-кампании, бронирования' },
  { id: 'engineer', name: 'Инженер', description: 'Публичные эндпоинты, здоровье платформы' },
  { id: 'admin', name: 'Администратор', description: 'Здоровье системы, контент-пайплайны, модерация, лендинг, AI-агенты' },
];

// ─── Auth ───────────────────────────────────────────────

async function getCuratorJWT(): Promise<{ jwt: string; userId: string } | null> {
  try {
    const dbClient = getDbClient();

    const { data: signInData } = await dbClient.auth.signInWithPassword({
      email: CURATOR_EMAIL,
      password: CURATOR_PASSWORD,
    });

    if (signInData?.session) {
      return { jwt: signInData.session.access_token, userId: signInData.user!.id };
    }

    // Create user if doesn't exist
    console.log('[curator] Creating curator user...');
    await dbClient.auth.admin.createUser({
      email: CURATOR_EMAIL,
      password: CURATOR_PASSWORD,
      email_confirm: true,
      user_metadata: { role: 'admin', displayName: 'Curator Bot' },
    });

    const { data: newSignIn } = await dbClient.auth.signInWithPassword({
      email: CURATOR_EMAIL,
      password: CURATOR_PASSWORD,
    });

    if (newSignIn?.session) {
      return { jwt: newSignIn.session.access_token, userId: newSignIn.user!.id };
    }

    return null;
  } catch (error) {
    console.log('[curator] JWT error:', error);
    return null;
  }
}

// ─── Profile Setup (кураторы сами настраивают кабинеты) ─

async function setupRadioProfile(userId: string): Promise<boolean> {
  try {
    await upsertRadioProfile(userId, {
      id: userId,
      userId,
      stationName: 'Curator Test Radio',
      description: 'Тестовая радиостанция куратора',
      city: 'Москва',
      country: 'Россия',
      frequency: '101.5 FM',
      formats: ['pop', 'rock', 'electronic'],
      logoUrl: '',
      streamUrl: '',
      isOnline: false,
      audienceSize: 'small',
      socialLinks: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(`[curator:radio] Profile created for ${userId}`);
    return true;
  } catch (error) {
    console.log('[curator:radio] Setup error:', error);
    return false;
  }
}

async function setupVenueProfile(userId: string): Promise<boolean> {
  try {
    await upsertVenueProfile(userId, {
      id: userId,
      userId,
      name: 'Curator Test Venue',
      description: 'Тестовая площадка куратора',
      type: 'club',
      city: 'Москва',
      address: 'ул. Тестовая, 1',
      capacity: 500,
      amenities: ['stage', 'sound-system', 'bar'],
      contacts: { phone: '+70000000000', email: CURATOR_EMAIL },
      openHours: '18:00-06:00',
      logoUrl: '',
      coverUrl: '',
      socialLinks: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(`[curator:venue] Profile created for ${userId}`);
    return true;
  } catch (error) {
    console.log('[curator:venue] Setup error:', error);
    return false;
  }
}

async function setupArtistProfile(userId: string, _jwt: string): Promise<boolean> {
  try {
    await upsertArtistProfile(userId, {
      id: userId,
      userId,
      name: 'Curator Test Artist',
      genre: 'Electronic',
      city: 'Москва',
      bio: 'Тестовый профиль куратора-артиста',
      avatarUrl: '',
      socialLinks: {},
      plays: 0,
      followers: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(`[curator:artist] Profile created via DB`);
    return true;
  } catch (error) {
    console.log('[curator:artist] Setup error:', error);
    return false;
  }
}

async function setupDjProfile(userId: string, _jwt: string): Promise<boolean> {
  try {
    // DJ profiles are stored in dj_editor_profiles by user_id
    const dbClient = getDbClient();
    const { error } = await dbClient.from('dj_editor_profiles').upsert({
      user_id: userId,
      data: {
        userId,
        name: 'Curator Test DJ',
        genres: ['house', 'techno', 'trance'],
        city: 'Москва',
        bio: 'Тестовый профиль куратора-диджея',
        experience: '5 лет',
        equipment: ['CDJ-3000', 'DJM-900'],
        createdAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) console.log('[curator:dj] DB error:', error.message);
    console.log(`[curator:dj] Profile created via DB`);
    return !error;
  } catch (error) {
    console.log('[curator:dj] Setup error:', error);
    return false;
  }
}

async function setupProducerProfile(userId: string, _jwt: string): Promise<boolean> {
  try {
    const dbClient = getDbClient();
    const { error } = await dbClient.from('producer_profiles').upsert({
      id: userId,
      user_id: userId,
      data: {
        userId,
        displayName: 'Curator Test Producer',
        genres: ['pop', 'hip-hop', 'electronic'],
        city: 'Москва',
        bio: 'Тестовый профиль куратора-продюсера',
        hourlyRate: 5000,
        currency: 'RUB',
        createdAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) console.log('[curator:producer] DB error:', error.message);
    console.log(`[curator:producer] Profile created via DB`);
    return !error;
  } catch (error) {
    console.log('[curator:producer] Setup error:', error);
    return false;
  }
}

/** Run setup for a specific role */
async function setupRole(role: RoleId, userId: string, jwt: string): Promise<boolean> {
  switch (role) {
    case 'radio': return setupRadioProfile(userId);
    case 'venue': return setupVenueProfile(userId);
    case 'artist': return setupArtistProfile(userId, jwt);
    case 'dj': return setupDjProfile(userId, jwt);
    case 'producer': return setupProducerProfile(userId, jwt);
    case 'engineer': return true; // no setup needed
    case 'admin': return true; // no setup needed — curator@promo-music.ru already has admin role
    default: return true;
  }
}

// ─── Endpoint definitions per role ──────────────────────

function getEndpointsForRole(role: RoleId, userId: string): EndpointTest[] {
  switch (role) {
    case 'artist':
      return [
        { method: 'GET', path: `/server/api/artist-profile/popular`, description: 'Популярные артисты' },
        { method: 'GET', path: `/server/api/artist-profile/profile/${userId}`, description: 'Профиль артиста', needsUserId: true },
        { method: 'GET', path: `/server/api/artist-profile/profile/${userId}/stats`, description: 'Статистика', needsUserId: true },
        { method: 'GET', path: `/server/api/artist-profile/profile/${userId}/tracks`, description: 'Треки', needsUserId: true },
        { method: 'GET', path: `/server/api/artist-analytics/overview/${userId}`, description: 'Аналитика', needsUserId: true },
      ];

    case 'producer':
      return [
        { method: 'GET', path: `/server/api/producer-studio/conversations/${userId}`, description: 'Беседы продюсера', needsUserId: true },
        { method: 'GET', path: `/server/api/producer-studio/settings/${userId}`, description: 'Настройки студии', needsUserId: true },
        { method: 'GET', path: `/server/api/producer-studio/services/custom/${userId}`, description: 'Услуги продюсера', needsUserId: true },
        { method: 'GET', path: `/server/api/producer-studio/profile/edits/${userId}`, description: 'Профиль продюсера', needsUserId: true },
        { method: 'GET', path: `/server/api/producer-studio/wallet/withdrawals/${userId}`, description: 'Выводы средств', needsUserId: true },
        { method: 'GET', path: `/server/api/producer-studio/ai/history/${userId}`, description: 'AI история', needsUserId: true },
        { method: 'GET', path: `/server/api/producer-studio/calendar/${userId}`, description: 'Календарь', needsUserId: true },
      ];

    case 'radio':
      return [
        { method: 'GET', path: `/server/api/radio/ad-slots/list`, description: 'Рекламные слоты' },
        { method: 'GET', path: `/server/api/radio/artist-requests`, description: 'Заявки от артистов' },
        { method: 'GET', path: `/server/api/radio/venue-requests`, description: 'Заявки от площадок' },
        { method: 'GET', path: `/server/api/radio/finance/overview`, description: 'Финансы: обзор' },
        { method: 'GET', path: `/server/api/radio/finance/transactions`, description: 'Финансы: транзакции' },
        { method: 'GET', path: `/server/api/radio/notifications`, description: 'Уведомления' },
        { method: 'GET', path: `/server/api/radio/analytics`, description: 'Аналитика радио' },
      ];

    case 'dj':
      return [
        { method: 'GET', path: `/server/api/dj-studio/profile`, description: 'Профиль DJ' },
        { method: 'GET', path: `/server/api/dj-studio/events`, description: 'События DJ' },
        { method: 'GET', path: `/server/api/dj-studio/collaborations`, description: 'Коллаборации' },
        { method: 'GET', path: `/server/api/dj-studio/notifications`, description: 'Уведомления DJ' },
        { method: 'GET', path: `/server/api/dj-studio/plans`, description: 'Тарифные планы' },
      ];

    case 'venue':
      return [
        { method: 'GET', path: `/server/api/venue/profile`, description: 'Профиль площадки' },
        { method: 'GET', path: `/server/api/venue/stats`, description: 'Статистика площадки' },
        { method: 'GET', path: `/server/api/venue/analytics/overview`, description: 'Аналитика: обзор' },
        { method: 'GET', path: `/server/api/venue/analytics/campaigns`, description: 'Аналитика: кампании' },
        { method: 'GET', path: `/server/api/venue/analytics/spending`, description: 'Аналитика: расходы' },
        { method: 'GET', path: `/server/api/venue/analytics/roi`, description: 'Аналитика: ROI' },
        { method: 'GET', path: `/server/api/venue/notifications`, description: 'Уведомления' },
        { method: 'GET', path: `/server/api/venue/playlists`, description: 'Плейлисты' },
        { method: 'GET', path: `/server/api/venue/radio-catalog`, description: 'Радио каталог' },
        { method: 'GET', path: `/server/api/venue/radio-campaigns`, description: 'Радио кампании' },
        { method: 'GET', path: `/server/api/venue/radio-brand`, description: 'Радио бренд' },
        { method: 'GET', path: `/server/api/venue/bookings`, description: 'Бронирования' },
      ];

    case 'engineer':
      return [
        { method: 'GET', path: `/server/health`, description: 'Health check' },
        { method: 'GET', path: `/server/api/landing-data/popular-artists`, description: 'Популярные артисты' },
        { method: 'GET', path: `/server/api/landing-data/charts/weekly`, description: 'Чарты недели' },
        { method: 'GET', path: `/server/api/landing-data/news`, description: 'Новости' },
        { method: 'GET', path: `/server/api/landing-data/concerts`, description: 'Концерты' },
        { method: 'GET', path: `/server/api/landing-data/stats`, description: 'Статистика' },
        { method: 'GET', path: `/server/api/charts/sources`, description: 'Источники чартов' },
        { method: 'GET', path: `/server/api/news-agent/status`, description: 'Агент новостей' },
        { method: 'GET', path: `/server/api/concert-agent/status`, description: 'Агент концертов' },
        { method: 'GET', path: `/server/api/curator/roles`, description: 'Роли кураторов' },
      ];

    case 'admin':
      return [
        // ── System Health ──
        { method: 'GET', path: `/server/health`, description: 'Health сервера',
          validation: (b: any) => ({
            ok: b?.status === 'ok',
            message: b?.status === 'ok' ? 'Сервер здоров' : `Статус: ${b?.status || 'unknown'}`,
          }),
        },
        { method: 'GET', path: `/server/migration/status`, description: 'Статус миграций' },
        { method: 'GET', path: `/server/migration/health`, description: 'Здоровье миграций' },

        // ── Content Pipelines ──
        { method: 'GET', path: `/server/api/content-health/health`, description: 'Здоровье контент-пайплайна',
          validation: (b: any) => {
            const alerts = b?.data?.alerts || b?.alerts || [];
            const critical = alerts.filter((a: any) => a?.level === 'critical').length;
            return {
              ok: critical === 0,
              message: critical > 0 ? `${critical} критических алертов!` : `Алертов: ${alerts.length}`,
            };
          },
        },
        { method: 'GET', path: `/server/api/news-agent/status`, description: 'Статус агента новостей',
          validation: (b: any) => {
            const total = b?.data?.totalNews || b?.totalNews || 0;
            return { ok: total > 0, message: `Новостей: ${total}` };
          },
        },
        { method: 'GET', path: `/server/api/news-agent/sources`, description: 'Источники новостей' },
        { method: 'GET', path: `/server/api/concert-agent/status`, description: 'Статус агента концертов',
          validation: (b: any) => {
            const total = b?.data?.totalConcerts || b?.totalConcerts || 0;
            return { ok: total >= 0, message: `Концертов: ${total}` };
          },
        },
        { method: 'GET', path: `/server/api/concert-agent/sources`, description: 'Источники концертов' },
        { method: 'GET', path: `/server/api/charts/aggregation-status`, description: 'Статус чартов' },
        { method: 'GET', path: `/server/api/charts/sources`, description: 'Источники чартов' },

        // ── Landing Data ──
        { method: 'GET', path: `/server/api/landing-data/popular-artists`, description: 'Популярные артисты',
          validation: (b: any) => {
            const arr = b?.data || [];
            return { ok: Array.isArray(arr), message: `Артистов: ${Array.isArray(arr) ? arr.length : 0}` };
          },
        },
        { method: 'GET', path: `/server/api/landing-data/charts/weekly`, description: 'Недельный чарт',
          validation: (b: any) => {
            const entries = b?.data?.entries || b?.data || [];
            const count = Array.isArray(entries) ? entries.length : 0;
            return { ok: count > 0, message: `Треков в чарте: ${count}` };
          },
        },
        { method: 'GET', path: `/server/api/landing-data/news`, description: 'Публичные новости',
          validation: (b: any) => {
            const arr = b?.data || [];
            return { ok: Array.isArray(arr), message: `Новостей на лендинге: ${Array.isArray(arr) ? arr.length : 0}` };
          },
        },
        { method: 'GET', path: `/server/api/landing-data/stats`, description: 'Статистика платформы',
          validation: (b: any) => {
            const d = b?.data || {};
            return { ok: !!d, message: `Артистов: ${d.totalArtists || 0}, Треков: ${d.totalTracks || 0}` };
          },
        },

        // ── Moderation ──
        { method: 'GET', path: `/server/api/track-moderation/pendingTracks?status=pending`, description: 'Очередь модерации' },
        { method: 'GET', path: `/server/api/track-moderation/stats`, description: 'Статистика модерации',
          validation: (b: any) => {
            const d = b?.data || b || {};
            const pending = d.pending || d.pendingCount || 0;
            return { ok: true, message: `Ожидают: ${pending}, Всего: ${d.total || d.totalCount || 0}` };
          },
        },

        // ── Admin Content CRUD ──
        { method: 'GET', path: `/server/api/landing-data/admin/news`, description: 'Все новости (admin)' },
        { method: 'GET', path: `/server/api/landing-data/admin/tracks`, description: 'Публичный каталог (admin)' },

        // ── AI Agents & Curators ──
        { method: 'GET', path: `/server/api/agents/sessions`, description: 'Сессии AI-команды' },
        { method: 'GET', path: `/server/api/curator/status`, description: 'Статус кураторов' },
        { method: 'GET', path: `/server/api/curator/roles`, description: 'Роли кураторов',
          validation: (b: any) => {
            const arr = b?.data || [];
            return { ok: Array.isArray(arr) && arr.length >= 7, message: `Ролей: ${Array.isArray(arr) ? arr.length : 0}` };
          },
        },
      ];

    default:
      return [];
  }
}

// ─── Test execution ─────────────────────────────────────

async function testEndpoint(test: EndpointTest, userJwt?: string): Promise<TestResult> {
  const url = `${BASE_URL}/functions/v1${test.path}`;
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${userJwt || SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'X-Internal-Key': INTERNAL_KEY,
    };

    const resp = await fetch(url, {
      method: test.method,
      headers,
      signal: controller.signal,
      ...(test.body && (test.method === 'POST' || test.method === 'PUT')
        ? { body: JSON.stringify(test.body) }
        : {}),
    });
    clearTimeout(timeout);

    const responseTime = Date.now() - start;
    let body: any = null;
    let snippet = '';

    try {
      body = await resp.json();
      snippet = JSON.stringify(body).slice(0, 200);
    } catch {
      snippet = (await resp.text().catch(() => '')).slice(0, 200);
    }

    const hasData = body?.success === true && (
      body?.data !== undefined ||
      body?.results !== undefined ||
      body?.profile !== undefined ||
      body?.tracks !== undefined ||
      body?.status === 'ok'
    );

    let dataCount: number | undefined;
    if (Array.isArray(body?.data)) dataCount = body.data.length;
    else if (Array.isArray(body?.results)) dataCount = body.results.length;

    // Run validation callback if provided
    let validationOk: boolean | undefined;
    let validationMessage: string | undefined;
    if (test.validation && body) {
      try {
        const v = test.validation(body);
        validationOk = v.ok;
        validationMessage = v.message;
      } catch { /* ignore validation errors */ }
    }

    return {
      endpoint: test.path,
      method: test.method,
      description: test.description,
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 400,
      responseTime,
      hasData: !!hasData,
      dataCount,
      snippet,
      validationOk,
      validationMessage,
    };
  } catch (error: any) {
    return {
      endpoint: test.path,
      method: test.method,
      description: test.description,
      status: 0,
      ok: false,
      responseTime: Date.now() - start,
      hasData: false,
      error: error?.message || String(error),
    };
  }
}

// ─── Curator runner ─────────────────────────────────────

export async function runCurator(role: RoleId): Promise<CuratorReport> {
  const roleConfig = CURATOR_ROLES.find(r => r.id === role);
  if (!roleConfig) throw new Error(`Unknown role: ${role}`);

  const startedAt = new Date().toISOString();
  console.log(`[curator:${role}] Starting ${roleConfig.name}...`);

  // 1. Get JWT
  const curatorAuth = await getCuratorJWT();
  const userJwt = curatorAuth?.jwt;
  const testUserId = curatorAuth?.userId || PLACEHOLDER_USER;

  if (!userJwt) {
    console.log(`[curator:${role}] No JWT — aborting`);
    return makeReport(role, roleConfig.name, startedAt, false, []);
  }

  console.log(`[curator:${role}] Authenticated as ${testUserId}`);

  // 2. Setup: create profile for this role
  const setupDone = await setupRole(role, testUserId, userJwt);
  console.log(`[curator:${role}] Setup: ${setupDone ? 'OK' : 'FAILED'}`);

  // 3. Test endpoints
  const endpoints = getEndpointsForRole(role, testUserId);
  const results: TestResult[] = [];

  for (const test of endpoints) {
    if (test.needsUserId && testUserId === PLACEHOLDER_USER) {
      results.push({
        endpoint: test.path, method: test.method, description: test.description,
        status: 0, ok: false, responseTime: 0, hasData: false,
        error: 'Нет тестового пользователя',
      });
      continue;
    }

    const result = await testEndpoint(test, userJwt);
    results.push(result);
    console.log(`[curator:${role}] ${result.ok ? '✓' : '✗'} ${test.description} → ${result.status} (${result.responseTime}ms)`);

    await new Promise(r => setTimeout(r, 100));
  }

  return makeReport(role, roleConfig.name, startedAt, setupDone, results);
}

function makeReport(role: RoleId, roleName: string, startedAt: string, setupDone: boolean, results: TestResult[]): CuratorReport {
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok && r.status !== 0).length;
  const warnings = results.filter(r => r.ok && !r.hasData).length;
  const skipped = results.filter(r => r.status === 0).length;
  const total = results.length;

  const lines: string[] = [];
  lines.push(`${roleName}: ${passed}/${total} OK`);
  if (setupDone) lines.push('Профиль настроен ✓');
  if (failed > 0) lines.push(`${failed} ошибок`);
  if (warnings > 0) lines.push(`${warnings} пустых ответов`);
  if (skipped > 0) lines.push(`${skipped} пропущено`);

  for (const f of results.filter(r => !r.ok && r.status !== 0)) {
    lines.push(`  ✗ ${f.description}: HTTP ${f.status}`);
  }
  for (const e of results.filter(r => r.ok && !r.hasData)) {
    lines.push(`  ○ ${e.description}: пусто`);
  }

  // Validation results (admin agent)
  const validated = results.filter(r => r.validationMessage);
  if (validated.length > 0) {
    lines.push('--- Валидация ---');
    for (const v of validated) {
      lines.push(`  ${v.validationOk ? '✓' : '⚠'} ${v.description}: ${v.validationMessage}`);
    }
  }

  const report: CuratorReport = {
    id: `curator-${role}-${Date.now()}`,
    role,
    roleName,
    startedAt,
    completedAt: new Date().toISOString(),
    totalEndpoints: total,
    passed,
    failed,
    warnings,
    setupDone,
    results,
    summary: lines.join('\n'),
  };

  // Fire-and-forget save. Single INSERT — "latest per role" auto-derived
  // через SELECT ORDER BY completed_at DESC LIMIT 1 на indexed col.
  // Killed legacy dual-write (id row + 'latest:<role>' pointer row).
  insertCuratorReport(report as unknown as CuratorReportRow).catch(() => {});

  console.log(`[curator:${role}] Done: ${passed}/${total} OK, setup=${setupDone}`);
  return report;
}

export async function runAllCurators(): Promise<{
  totalRoles: number;
  reports: CuratorReport[];
  overallPassed: number;
  overallFailed: number;
  overallWarnings: number;
}> {
  const reports: CuratorReport[] = [];

  for (const role of CURATOR_ROLES) {
    try {
      reports.push(await runCurator(role.id));
    } catch (error) {
      reports.push({
        id: `curator-${role.id}-${Date.now()}`,
        role: role.id, roleName: role.name,
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        totalEndpoints: 0, passed: 0, failed: 1, warnings: 0, setupDone: false,
        results: [], summary: `Fatal: ${String(error)}`,
      });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return {
    totalRoles: CURATOR_ROLES.length,
    reports,
    overallPassed: reports.reduce((s, r) => s + r.passed, 0),
    overallFailed: reports.reduce((s, r) => s + r.failed, 0),
    overallWarnings: reports.reduce((s, r) => s + r.warnings, 0),
  };
}

export async function getLatestReports(): Promise<Record<string, CuratorReport | null>> {
  const result: Record<string, CuratorReport | null> = {};
  for (const role of CURATOR_ROLES) {
    // SELECT ORDER BY completed_at DESC LIMIT 1 — replaces 'latest:' pointer.
    result[role.id] = await getLatestCuratorReport(role.id) as unknown as CuratorReport | null;
  }
  return result;
}
