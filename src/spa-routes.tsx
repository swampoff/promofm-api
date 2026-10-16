// Какие адреса существуют у человека в SPA — источник для ответов роботам
// (seo-routes.tsx) и для карты сайта (sitemap-routes.tsx).
//
// До 24.09.2026 prerender отдавал на ЛЮБОЙ неизвестный путь копию главной
// с кодом 200 (мягкий 404), а в sitemap стояли адреса, которых у человека
// нет вовсе (/tracks/:id, /videos/:id, /dashboard, /coins…).
//
// Список берём из исходников фронта на этом же сервере (deploy.sh держит
// /opt/promofm-frontend на том же коммите, что и выкаченная сборка), чтобы
// новый публичный маршрут не требовал правки бэкенда. Если файлы прочитать
// не удалось — classifySpaPath возвращает null, и вызывающий код ведёт себя
// осторожно (не отдаёт 404).

import { readFileSync, statSync, existsSync } from 'node:fs';

const FE_SRC = process.env.PROMOFM_FRONTEND_SRC || '/opt/promofm-frontend/src';
const PUBLIC_ROUTES_FILE = `${FE_SRC}/app/pages/public-routes.ts`;
const ROOT_ROUTES_FILE = `${FE_SRC}/app/routes.ts`;
const SEO_REGISTRY_FILE = `${FE_SRC}/data/seo-pages.ts`;
const TTL_MS = 5 * 60_000;

export interface SeoRegistryEntry {
  title: string;
  description: string;
  faqs: { q: string; a: string }[];
}

interface SpaIndex {
  checkedAt: number;
  stamp: string;
  publicPatterns: RegExp[];
  publicStatic: string[];
  hasEnglish: boolean;
  registry: Map<string, SeoRegistryEntry>;
}

let cache: SpaIndex | null = null;

// Кабинеты и служебные страницы: у человека есть, в индекс им не нужно.
// Публичные маршруты проверяются раньше, поэтому /radio/submit остаётся
// публичным, хотя /radio — кабинет радиостанции.
const PRIVATE_RE = /^\/(login|reset-password|verify-email|payment\/result|unsubscribe|embed\/|ctrl-|artist|dj|venue|producer|engineer|label|admin|radio|dashboard|messages|checkout|publish)(\/|$)/;

function routeToRegex(route: string): RegExp {
  const parts = route.replace(/^\/+|\/+$/g, '').split('/').map((seg) => {
    if (seg.startsWith(':')) return '[^/]+';
    if (seg === '*') return '.*';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^/${parts.join('/')}/?$`);
}

const STR = String.raw`'((?:[^'\\]|\\.)*)'`;
const unq = (s: string) => s.replace(/\\'/g, "'");

function parseRegistry(src: string): Map<string, SeoRegistryEntry> {
  const map = new Map<string, SeoRegistryEntry>();
  const starts = [...src.matchAll(/\n {2}(?:'[\w-]+'|[\w]+): \{/g)].map((m) => m.index!);
  for (let i = 0; i < starts.length; i++) {
    const seg = src.slice(starts[i], starts[i + 1] ?? src.length);
    const path = seg.match(/canonicalPath:\s*'([^']*)'/)?.[1];
    const title = seg.match(new RegExp(`title:\\s*${STR}`))?.[1];
    const description = seg.match(new RegExp(`description:\\s*${STR}`))?.[1];
    if (!path || !title || !description) continue;
    const faqs = [...seg.matchAll(new RegExp(`q:\\s*${STR},\\s*a:\\s*${STR}`, 'g'))]
      .map((m) => ({ q: unq(m[1]), a: unq(m[2]) }));
    map.set(path, { title: unq(title), description: unq(description), faqs });
  }
  return map;
}

function loadSpaIndex(): SpaIndex | null {
  try {
    if (cache && Date.now() - cache.checkedAt < TTL_MS) return cache;
    const stamp = [PUBLIC_ROUTES_FILE, ROOT_ROUTES_FILE, SEO_REGISTRY_FILE]
      .map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)).join(':');
    if (cache && cache.stamp === stamp) {
      cache.checkedAt = Date.now();
      return cache;
    }
    const routesSrc = readFileSync(PUBLIC_ROUTES_FILE, 'utf-8');
    const routes = [...routesSrc.matchAll(/path:\s*'([^']*)'/g)].map((m) => m[1]);
    if (routes.length < 20) throw new Error(`слишком мало маршрутов (${routes.length}) – формат файла поменялся?`);
    const rootSrc = existsSync(ROOT_ROUTES_FILE) ? readFileSync(ROOT_ROUTES_FILE, 'utf-8') : '';
    let registry = new Map<string, SeoRegistryEntry>();
    try {
      registry = parseRegistry(readFileSync(SEO_REGISTRY_FILE, 'utf-8'));
    } catch (e: any) {
      console.warn('[spa-routes] реестр seo-pages.ts не прочитан:', e?.message);
    }
    cache = {
      checkedAt: Date.now(),
      stamp,
      publicPatterns: routes.map(routeToRegex),
      publicStatic: routes.filter((r) => !r.includes(':') && !r.includes('*')).map((r) => `/${r}`),
      // Английская версия монтирует те же публичные маршруты под /en.
      hasEnglish: /path:\s*'en'/.test(rootSrc),
      registry,
    };
    return cache;
  } catch (e: any) {
    console.warn('[spa-routes] маршруты фронта не прочитаны:', e?.message);
    return null;
  }
}

export type SpaKind = 'public' | 'private' | 'unknown';

/** Есть ли такой адрес у человека. null — нет данных о маршрутах. */
export function classifySpaPath(rawPath: string): SpaKind | null {
  const idx = loadSpaIndex();
  if (!idx) return null;
  const path = rawPath.split('?')[0] || '/';
  if (path === '/' || path === '') return 'public';
  const bare = idx.hasEnglish && /^\/en(\/|$)/.test(path) ? path.slice(3) || '/' : path;
  if (bare === '/') return 'public';
  if (idx.publicPatterns.some((re) => re.test(bare))) return 'public';
  if (PRIVATE_RE.test(bare)) return 'private';
  return 'unknown';
}

/** Заголовок, описание и FAQ страницы из реестра фронта (то, что видит человек). */
export function seoRegistryEntry(path: string): SeoRegistryEntry | undefined {
  return loadSpaIndex()?.registry.get(path);
}

/** Публичные статичные адреса SPA; null — нет данных. */
export function publicStaticPaths(): string[] | null {
  return loadSpaIndex()?.publicStatic ?? null;
}
