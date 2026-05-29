/**
 * OG IMAGE ROUTES - Серверный рендеринг Open Graph изображений
 * Возвращает SVG 1200x630 для социальных сетей
 * 
 * Функционал:
 * - Динамические данные из KV (количество артистов, треков, продюсеров)
 * - Dark/Light mode через query-параметр ?mode=light|dark
 * - Кабинет-специфичные OG с уникальными цветами
 * - Кэширование на 24 часа
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { getPlatformStats } from './db.tsx';

const app = new Hono();

/** Получение актуальной статистики платформы из KV */
async function getOgPlatformStats(): Promise<{
  totalArtists: number;
  totalTracks: number;
  totalPlays: number;
  totalProducers: number;
  totalBeats: number;
}> {
  try {
    const stats = await getPlatformStats('platform');
    if (stats && typeof stats === 'object') {
      return {
        totalArtists: (stats as any).totalArtists || 0,
        totalTracks: (stats as any).totalTracks || 0,
        totalPlays: (stats as any).totalPlays || 0,
        totalProducers: (stats as any).totalProducers || 0,
        totalBeats: (stats as any).totalBeats || 0,
      };
    }
  } catch (e) {
    console.log('OG image: failed to get platform stats:', e);
  }
  // Fallback defaults
  return { totalArtists: 0, totalTracks: 0, totalPlays: 0, totalProducers: 0, totalBeats: 0 };
}

/** Форматирование числа с суффиксом K/M */
function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

type OgMode = 'dark' | 'light';

interface OgTheme {
  bgMain: string;
  bgMid: string;
  bgEnd: string;
  logoBg: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  dotColor: string;
  statBg: string;
  statBorder: string;
}

const themes: Record<OgMode, OgTheme> = {
  dark: {
    bgMain: '#0a0a14',
    bgMid: '#0c0c1e',
    bgEnd: '#0a1628',
    logoBg: '#1a0a2e',
    textPrimary: 'white',
    textSecondary: 'white',
    textMuted: 'white',
    dotColor: 'white',
    statBg: '#ffffff08',
    statBorder: '#ffffff15',
  },
  light: {
    bgMain: '#f8fafc',
    bgMid: '#f1f5f9',
    bgEnd: '#e2e8f0',
    logoBg: '#f5f0ff',
    textPrimary: '#0f172a',
    textSecondary: '#334155',
    textMuted: '#64748b',
    dotColor: '#94a3b8',
    statBg: '#00000008',
    statBorder: '#00000012',
  },
};

/** Главный OG-эндпоинт с динамическими данными */
app.get("/", async (c) => {
  const title = c.req.query("title") || "ПРОМО.МУЗЫКА";
  const subtitle = c.req.query("subtitle") || "Маркетинговая экосистема для музыкантов";
  const mode = (c.req.query("mode") as OgMode) || "dark";
  const showStats = c.req.query("stats") !== "false"; // По умолчанию показываем

  const stats = showStats ? await getOgPlatformStats() : null;

  const svg = generateOgSvg({
    title,
    subtitle,
    mode,
    stats,
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

/** OG для отдельных кабинетов */
app.get("/:cabinet", async (c) => {
  const cabinet = c.req.param("cabinet");
  const mode = (c.req.query("mode") as OgMode) || "dark";

  const cabinetConfig: Record<string, {
    title: string;
    subtitle: string;
    accentColor: string;
    glowColor: string;
    statsFilter?: (s: any) => Array<{ label: string; value: string }>;
  }> = {
    artist: {
      title: "Кабинет артиста",
      subtitle: "Аналитика, треки, концерты, продвижение",
      accentColor: "#06b6d4",
      glowColor: "#0891b2",
      statsFilter: (s) => [
        { label: "Артистов", value: formatNum(s.totalArtists) },
        { label: "Треков", value: formatNum(s.totalTracks) },
        { label: "Прослушиваний", value: formatNum(s.totalPlays) },
      ],
    },
    admin: {
      title: "Админ-панель",
      subtitle: "Модерация, управление, статистика",
      accentColor: "#ef4444",
      glowColor: "#dc2626",
    },
    dj: {
      title: "DJ Studio",
      subtitle: "Миксы, букинги, промоушен",
      accentColor: "#8b5cf6",
      glowColor: "#7c3aed",
    },
    radio: {
      title: "ПРОМО.ЭИР",
      subtitle: "Радио-кабинет, реклама, ротация",
      accentColor: "#6366f1",
      glowColor: "#4f46e5",
    },
    venue: {
      title: "Venue Cabinet",
      subtitle: "Музыка для заведений, плейлисты",
      accentColor: "#6366f1",
      glowColor: "#4338ca",
    },
    producer: {
      title: "Продюсерская студия",
      subtitle: "Услуги, портфолио, коллаборации",
      accentColor: "#14b8a6",
      glowColor: "#0d9488",
      statsFilter: (s) => [
        { label: "Продюсеров", value: formatNum(s.totalProducers) },
        { label: "Битов", value: formatNum(s.totalBeats) },
      ],
    },
  };

  const config = cabinetConfig[cabinet] || {
    title: "ПРОМО.МУЗЫКА",
    subtitle: "Маркетинговая экосистема для музыкантов",
    accentColor: "#FF577F",
    glowColor: "#FF577F",
  };

  const rawStats = await getOgPlatformStats();
  const cabinetStats = config.statsFilter
    ? config.statsFilter(rawStats)
    : [
        { label: "Артистов", value: formatNum(rawStats.totalArtists) },
        { label: "Треков", value: formatNum(rawStats.totalTracks) },
      ];

  const svg = generateOgSvg({
    title: config.title,
    subtitle: config.subtitle,
    accentColor: config.accentColor,
    glowColor: config.glowColor,
    mode,
    stats: rawStats.totalArtists > 0 ? rawStats : null,
    customStats: rawStats.totalArtists > 0 ? cabinetStats : null,
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

interface OgSvgOptions {
  title: string;
  subtitle: string;
  accentColor?: string;
  glowColor?: string;
  mode?: OgMode;
  stats?: { totalArtists: number; totalTracks: number; totalPlays: number; totalProducers: number; totalBeats: number } | null;
  customStats?: Array<{ label: string; value: string }> | null;
}

function generateOgSvg(opts: OgSvgOptions): string {
  const {
    title,
    subtitle,
    accentColor = "#FF577F",
    glowColor = "#FF577F",
    mode = "dark",
    stats,
    customStats,
  } = opts;

  const t = themes[mode] || themes.dark;
  const isDark = mode === 'dark';

  // Escape HTML entities in text
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Build stat badges
  const statBadges = customStats
    ? customStats
    : stats
      ? [
          { label: "Артистов", value: formatNum(stats.totalArtists) },
          { label: "Треков", value: formatNum(stats.totalTracks) },
          { label: "Прослушиваний", value: formatNum(stats.totalPlays) },
        ]
      : null;

  const statsSvg = statBadges
    ? statBadges
        .map((s, i) => {
          const x = 360 + i * 170;
          return `
    <g transform="translate(${x}, 490)">
      <rect width="150" height="52" rx="10" fill="${t.statBg}" stroke="${t.statBorder}" stroke-width="1"/>
      <text x="75" y="22" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="18" font-weight="800" fill="${accentColor}" text-anchor="middle">
        ${esc(s.value)}
      </text>
      <text x="75" y="42" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="11" font-weight="500" fill="${t.textMuted}" text-anchor="middle" opacity="0.6">
        ${esc(s.label)}
      </text>
    </g>`;
        })
        .join("")
    : "";

  // Light mode glow overrides
  const glowOpacity1 = isDark ? '0.15' : '0.08';
  const glowOpacity2 = isDark ? '0.08' : '0.05';
  const borderOpacity = isDark ? '0.6' : '0.4';
  const shadowOpacity = isDark ? '0.5' : '0.15';
  const textPrimaryOpacity = isDark ? '0.95' : '1';
  const textSubtitleOpacity = isDark ? '0.5' : '0.6';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="og-bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${t.bgMain}"/>
      <stop offset="40%" stop-color="${t.bgMid}"/>
      <stop offset="100%" stop-color="${t.bgEnd}"/>
    </linearGradient>
    <linearGradient id="og-pink" x1="0" y1="0" x2="400" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FF577F"/>
      <stop offset="50%" stop-color="#FF6B8F"/>
      <stop offset="100%" stop-color="#FF577F"/>
    </linearGradient>
    <linearGradient id="og-cyan" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="og-accent" x1="0" y1="0" x2="600" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${accentColor}"/>
      <stop offset="100%" stop-color="${glowColor}"/>
    </linearGradient>
    <radialGradient id="og-glow1" cx="250" cy="315" r="300" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${glowColor}" stop-opacity="${glowOpacity1}"/>
      <stop offset="100%" stop-color="${glowColor}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="og-glow2" cx="950" cy="315" r="350" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#22d3ee" stop-opacity="${glowOpacity2}"/>
      <stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <filter id="og-shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="${shadowOpacity}"/>
    </filter>
    <linearGradient id="og-border-top" x1="0" y1="0" x2="1200" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="transparent"/>
      <stop offset="20%" stop-color="${accentColor}" stop-opacity="${borderOpacity}"/>
      <stop offset="80%" stop-color="#22d3ee" stop-opacity="${isDark ? '0.4' : '0.3'}"/>
      <stop offset="100%" stop-color="transparent"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#og-bg)"/>
  <rect width="1200" height="630" fill="url(#og-glow1)"/>
  <rect width="1200" height="630" fill="url(#og-glow2)"/>

  <!-- Top accent line -->
  <rect x="0" y="0" width="1200" height="3" fill="url(#og-border-top)"/>

  <!-- Bottom accent line -->
  <rect x="0" y="627" width="1200" height="3" fill="url(#og-border-top)"/>

  <!-- Decorative grid dots -->
  <g opacity="${isDark ? '0.03' : '0.06'}">
    ${Array.from({ length: 20 }, (_, i) =>
      Array.from({ length: 10 }, (_, j) =>
        `<circle cx="${60 + i * 60}" cy="${60 + j * 60}" r="1" fill="${t.dotColor}"/>`
      ).join("")
    ).join("")}
  </g>

  <!-- Logo P icon (scaled) -->
  <g transform="translate(80, ${statBadges ? '160' : '200'}) scale(3.5)">
    <rect width="64" height="64" rx="14" fill="${t.logoBg}"/>
    <rect width="64" height="64" rx="14" fill="${glowColor}" fill-opacity="${isDark ? '0.1' : '0.06'}"/>
    <rect x="1" y="1" width="62" height="62" rx="13" stroke="${accentColor}" stroke-width="1.5" stroke-opacity="0.4" fill="none"/>
    <path d="M18 48V16h12c7.2 0 12 4.2 12 10.5S37.2 37 30 37h-4.5v11H18z" fill="url(#og-pink)"/>
    <path d="M25.5 22v9H30c3.3 0 5.5-1.8 5.5-4.5S33.3 22 30 22h-4.5z" fill="${t.logoBg}"/>
    <circle cx="40" cy="48" r="2.5" fill="url(#og-cyan)"/>
    <path d="M45 42v6h1.8v-4.2c0-.9.6-1.5 1.4-1.5s1.2.5 1.2 1.4V48h1.8v-4.2c0-.9.6-1.5 1.4-1.5s1.2.5 1.2 1.4V48H56v-4.8c0-1.8-1-3-2.6-3-.9 0-1.7.4-2.2 1.1-.4-.7-1.1-1.1-2-1.1-.8 0-1.5.3-2 .9V42H45z" fill="url(#og-cyan)"/>
  </g>

  <!-- PROMO text -->
  <text x="360" y="${statBadges ? '270' : '310'}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="96" font-weight="900" fill="url(#og-pink)" letter-spacing="-2" filter="url(#og-shadow)">
    PROMO
  </text>

  <!-- .music text -->
  <text x="360" y="${statBadges ? '330' : '370'}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="36" font-weight="700" fill="url(#og-cyan)" letter-spacing="8">
    .MUSIC
  </text>

  <!-- Divider -->
  <rect x="360" y="${statBadges ? '355' : '395'}" width="120" height="2" fill="url(#og-accent)" rx="1" opacity="0.6"/>

  <!-- Title -->
  <text x="360" y="${statBadges ? '400' : '440'}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="28" font-weight="600" fill="${t.textPrimary}" opacity="${textPrimaryOpacity}">
    ${esc(title)}
  </text>

  <!-- Subtitle -->
  <text x="360" y="${statBadges ? '435' : '475'}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="20" font-weight="400" fill="${t.textSecondary}" opacity="${textSubtitleOpacity}">
    ${esc(subtitle)}
  </text>

  <!-- Dynamic Stats -->
  ${statsSvg}

  <!-- URL -->
  <text x="360" y="${statBadges ? '580' : '560'}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="16" font-weight="500" fill="${accentColor}" opacity="0.7" letter-spacing="2">
    PROMO.MUSIC
  </text>

  <!-- Glass card accent -->
  <rect x="340" y="${statBadges ? '205' : '245'}" width="4" height="180" rx="2" fill="url(#og-accent)" opacity="0.5"/>
</svg>`;
}

export default app;