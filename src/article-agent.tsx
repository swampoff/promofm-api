/**
 * ARTICLE AGENT — ежедневные АВТОРСКИЕ статьи под семантику аудиторий
 * (решение Никиты 2026-07-08: «раз в день авторская статья, чтобы
 * привлечь артистов, диджеев, миксинженеров, продюсеров, радио, ТВ
 * и заведения»).
 *
 * Отличие от news-agent.tsx: тот ПЕРЕРАБАТЫВАЕТ чужие новости из
 * внешних источников; этот пишет ОРИГИНАЛЬНЫЕ evergreen-статьи под
 * информационные запросы семантического ядра (SEMANTIC_CORE.md
 * разделы 1/3/16/17 + venue-ядро 2026-07). Публикация — в тот же
 * news_public: лента, sitemap (lastmod), prerender-снапшоты и
 * IndexNow уже работают для него.
 *
 * Ротация: одна статья в день, аудитория по кругу из 7; внутри
 * аудитории — первая неиспользованная тема (маркер data.seoTopic в
 * news_public — новых таблиц/миграций НЕ требуется). Темы исчерпаны
 * у аудитории — берётся следующая; исчерпаны все — агент честно
 * отвечает done:true и ничего не публикует.
 */

import { quickLLM } from './llm-router.tsx';
import { listAllNewsPublic, upsertNewsPublic } from './db.tsx';

interface ArticleTopic {
  slug: string;        // уникальный маркер использования (data.seoTopic)
  title: string;       // рабочий заголовок (LLM может улучшить)
  queries: string[];   // целевые поисковые запросы из ядра
}

interface Audience {
  key: string;
  label: string;
  category: string;    // news_public category
  persona: { name: string; avatar: string; style: string };
  landing: string;     // куда органично вести читателя
  topics: ArticleTopic[];
}

// Персонажи — те же, что в news-agent (единая «редакция» сайта).
const AUDIENCES: Audience[] = [
  {
    key: 'artists', label: 'Артисты', category: 'industry',
    persona: { name: 'Лиана', avatar: '/avatars/avatar_liana.png', style: 'аналитика, индустрия, бизнес музыки. Пишет вдумчиво, с цифрами и контекстом' },
    landing: '/promotion',
    topics: [
      // Банк выровнен по семантике «артисты и музыканты РФ» (xlsx Никиты
      // 2026-07-08, 132 запроса/12 кластеров): дистрибуция и продвижение —
      // самый массовый спрос; «ротация в заведениях» — голубой океан
      // (конкуренции в выдаче почти нет, прямой оффер платформы).
      { slug: 'artist-track-in-venues', title: 'Как сделать, чтобы твой трек играл в кафе и магазинах — и приносил роялти', queries: ['как чтобы мой трек играл в кафе', 'ротация трека в заведениях', 'разместить музыку в кафе и магазинах', 'фоновая музыка заведений как попасть'] },
      { slug: 'artist-release-to-streamings', title: 'Как выложить трек на Яндекс Музыку, VK и все стриминги: пошагово', queries: ['как выложить трек на Яндекс Музыку', 'как выложить трек на VK Музыку', 'как выложить трек на Spotify', 'дистрибуция музыки'] },
      { slug: 'artist-promote-track-2026', title: 'Как продвигать трек в 2026 году: рабочие каналы без накруток', queries: ['продвижение музыки', 'раскрутка трека', 'как раскрутить трек', 'продвижение артиста'] },
      { slug: 'artist-playlist-pitching', title: 'Как попасть в плейлисты Яндекс Музыки, VK и Звука: питчинг без магии', queries: ['как попасть в плейлист Яндекс Музыки', 'питчинг трека', 'редакторские плейлисты как попасть', 'попасть в Нитро'] },
      { slug: 'artist-radio-rotation', title: 'Как попасть на радио музыканту: от заявки до ротации', queries: ['как попасть на радио музыканту', 'ротация на радио', 'отправить трек на радио', 'как попасть в ротацию на радио'] },
      { slug: 'artist-music-earnings', title: 'Как заработать на музыке: стриминги, роялти, эфиры и заведения', queries: ['как заработать на музыке', 'сколько платят за прослушивания', 'роялти в музыке', 'монетизация музыки'] },
      { slug: 'artist-rao-vois-rights', title: 'РАО и ВОИС для артиста: как регистрировать треки и получать отчисления', queries: ['регистрация в РАО', 'как зарегистрировать песню', 'авторские права на трек', 'авторские отчисления'] },
      { slug: 'artist-sync-licensing', title: 'Как продать трек в рекламу, кино и сериал: sync-лицензирование по-русски', queries: ['как попасть в саундтрек', 'продать трек в рекламу', 'лицензирование музыки для рекламы'] },
      { slug: 'artist-first-release', title: 'Первый релиз с нуля: гайд для начинающего артиста', queries: ['как выпустить первый трек', 'продвижение музыканта с нуля', 'как начать музыкальную карьеру'] },
      { slug: 'artist-press-kit', title: 'Пресс-кит артиста: что положить, чтобы редактор дослушал', queries: ['пресс-кит артиста', 'EPK музыканта', 'пресс-релиз для музыканта'] },
      { slug: 'artist-track-quality-radio', title: 'Почему радио отклоняет треки: требования к качеству и формату', queries: ['требования радио к трекам', 'мастеринг для радио LUFS'] },
      { slug: 'artist-concert-booking', title: 'Первые концерты: как артисту попасть на площадки без букинг-агента', queries: ['как организовать концерт', 'букинг артиста'] },
    ],
  },
  {
    key: 'djs', label: 'Диджеи', category: 'club',
    persona: { name: 'DJ Den', avatar: '/avatars/avatar_dj_den.png', style: 'клубная культура, электроника, DJ-сцена. Пишет энергично и с инсайдерским знанием клубной жизни' },
    landing: '/for-djs',
    topics: [
      { slug: 'dj-mix-promotion', title: 'Куда девать готовый микс: продвижение DJ-сетов в 2026', queries: ['продвижение диджей микса', 'куда загрузить микс'] },
      { slug: 'dj-radio-residency', title: 'Резиденция на радио: как диджею получить своё шоу в эфире', queries: ['диджей на радио', 'радиошоу диджея'] },
      { slug: 'dj-earnings-breakdown', title: 'Сколько зарабатывает диджей: гонорары, резиденции, эфиры', queries: ['сколько зарабатывает диджей', 'гонорар диджея'] },
      { slug: 'dj-first-gigs', title: 'Первые выступления: как диджею попасть в клуб без связей', queries: ['как диджею попасть в клуб', 'первый гиг диджея'] },
      { slug: 'dj-mix-rights', title: 'Авторские права в DJ-миксах: что можно, что нельзя и как легально', queries: ['авторские права диджей микс', 'легален ли диджей сет'] },
      { slug: 'dj-venues-work', title: 'Диджей и заведения: как строить постоянную работу с барами и ресторанами', queries: ['диджей в ресторан', 'диджей на мероприятие'] },
    ],
  },
  {
    key: 'engineers', label: 'Звукорежиссёры', category: 'production',
    persona: { name: 'Нико', avatar: '/avatars/avatar_nico.png', style: 'европейская сцена, классика, джаз, авангард. Пишет изысканно, со знанием музыкальной теории' },
    landing: '/for-engineers',
    topics: [
      { slug: 'mixing-cost-guide', title: 'Сколько стоит сведение трека и из чего складывается цена', queries: ['сколько стоит сведение трека', 'цена сведения и мастеринга'] },
      { slug: 'mastering-lufs-streaming', title: 'Мастеринг под стриминги и радио: громкость, LUFS и форматы', queries: ['мастеринг LUFS', 'громкость для стриминга'] },
      { slug: 'engineer-find-clients', title: 'Где звукорежиссёру брать заказы: от сарафана к маркетплейсам', queries: ['заказы на сведение', 'работа звукорежиссёром'] },
      { slug: 'mix-before-after', title: 'Что слушать в чужом миксе: как оценить работу инженера до заказа', queries: ['как выбрать звукорежиссёра', 'примеры сведения до после'] },
      { slug: 'home-vs-studio-recording', title: 'Домашняя запись против студии: когда пора платить за студийный час', queries: ['запись вокала дома или в студии', 'аренда студии звукозаписи'] },
    ],
  },
  {
    key: 'producers', label: 'Продюсеры и битмейкеры', category: 'production',
    persona: { name: 'Марк', avatar: '/avatars/avatar_mark.png', style: 'хип-хоп, рэп, R&B. Пишет в уличном стиле, знает культуру изнутри' },
    landing: '/beats-marketplace',
    topics: [
      { slug: 'sell-beats-guide', title: 'Как продавать биты: площадки, лицензии и цены в 2026', queries: ['как продавать биты', 'продажа битов', 'маркетплейс битов'] },
      { slug: 'beat-license-types', title: 'Лицензии на биты: lease, exclusive и что писать в договоре', queries: ['лицензия на бит', 'эксклюзив на бит'] },
      { slug: 'producer-artist-collab', title: 'Продюсер и артист: как оформлять коллаборацию, чтобы не поссориться на роялти', queries: ['коллаборация продюсера и артиста', 'сплит роялти'] },
      { slug: 'beatmaker-portfolio', title: 'Портфолио битмейкера: как оформить каталог, который покупают', queries: ['портфолио битмейкера', 'как оформить биты на продажу'] },
    ],
  },
  {
    key: 'radio', label: 'Радиостанции', category: 'industry',
    persona: { name: 'Лиана', avatar: '/avatars/avatar_liana.png', style: 'аналитика, индустрия, бизнес музыки. Пишет вдумчиво, с цифрами и контекстом' },
    landing: '/radio-stations',
    topics: [
      { slug: 'radio-find-new-music', title: 'Где радиостанции берут новую музыку: от самотёка к кураторским пакетам', queries: ['новая музыка для радио', 'треки для эфира'] },
      { slug: 'radio-monetize-airtime', title: 'Монетизация эфира региональной станции: что работает кроме рекламы', queries: ['монетизация радиоэфира', 'доход радиостанции'] },
      { slug: 'radio-rotation-how', title: 'Как устроена ротация: почему одни треки крутят, а другие нет', queries: ['ротация на радио', 'плейлист-комитет'] },
      { slug: 'radio-audience-2026', title: 'Аудитория радио в 2026: кто ещё слушает FM и зачем станции интернет-эфир', queries: ['аудитория радио', 'интернет-радио статистика'] },
    ],
  },
  {
    key: 'tv', label: 'ТВ и клипы', category: 'video',
    persona: { name: 'Сандра', avatar: '/avatars/avatar_sandra.png', style: 'поп-музыка, мейнстрим, фестивали. Пишет ярко, эмоционально, с акцентом на тренды' },
    landing: '/tv-rotation',
    topics: [
      { slug: 'music-video-on-tv', title: 'Как попасть с клипом на ТВ: путь от загрузки до ротации', queries: ['клип на тв', 'ротация клипа на телевидении'] },
      { slug: 'music-video-budget', title: 'Клип за разумные деньги: на чём можно и нельзя экономить', queries: ['сколько стоит клип', 'бюджет музыкального клипа'] },
      { slug: 'tv-vs-youtube-clips', title: 'ТВ против YouTube: зачем клипу телевизор в эпоху стримингов', queries: ['зачем клип на тв', 'продвижение клипа'] },
    ],
  },
  {
    key: 'venues', label: 'Заведения', category: 'business',
    persona: { name: 'РэдКэт', avatar: '/avatars/avatar_radkat.png', style: 'технологии в музыке, AI, стриминг, цифровая индустрия. Пишет технично и футуристично' },
    landing: '/legal-music',
    topics: [
      { slug: 'music-sales-impact', title: 'Как музыка влияет на продажи: что показывают исследования ритейла', queries: ['влияние музыки на продажи', 'как музыка влияет на покупателей'] },
      { slug: 'restaurant-volume-guide', title: 'Громкость музыки в ресторане: как найти уровень, при котором заказывают больше', queries: ['какая громкость музыки в ресторане', 'уровень громкости в кафе'] },
      { slug: 'audio-branding-intro', title: 'Аудиобрендинг: как сети делают так, что их узнают на слух', queries: ['аудиобрендинг', 'звуковой брендинг', 'музыкальный маркетинг'] },
      { slug: 'cafe-music-choice', title: 'Какая музыка подходит для кафе: жанры, темп и время дня', queries: ['какая музыка подходит для кафе', 'как выбрать музыку для ресторана'] },
      { slug: 'seasonal-music-retail', title: 'Сезонная музыка в магазине: когда включать новогодний плейлист и что это даёт', queries: ['новогодняя музыка для магазина', 'сезонные плейлисты'] },
      { slug: 'rao-vois-check-guide', title: 'Проверка РАО в заведении: как проходит и что спрашивают', queries: ['проверка РАО в заведении', 'можно ли включать музыку в кафе'] },
    ],
  },
];

function findAudience(key: string): Audience | undefined {
  return AUDIENCES.find(a => a.key === key);
}

/** Темы, уже опубликованные (маркер data.seoTopic в news_public). */
async function usedTopicSlugs(): Promise<Set<string>> {
  const all = await listAllNewsPublic().catch(() => []);
  const used = new Set<string>();
  for (const n of all as any[]) {
    const t = n?.seoTopic || n?.data?.seoTopic;
    if (t) used.add(String(t));
  }
  return used;
}

function buildPrompt(a: Audience, t: ArticleTopic): { system: string; user: string } {
  const system =
    `Ты — ${a.persona.name}, автор редакции платформы ПРОМО.МУЗЫКА (promo-music.ru). ` +
    `Твой стиль: ${a.persona.style}. Пишешь ОРИГИНАЛЬНУЮ авторскую статью на русском для аудитории «${a.label}». ` +
    `Требования: 900–1300 слов; структура — короткий лид (2–3 предложения), 4–6 разделов с подзаголовками h2 (HTML-тег <h2>), ` +
    `абзацы <p>, где уместно — списки <ul><li>; конкретика и практика вместо воды; ` +
    `естественно используй формулировки запросов: ${t.queries.join(', ')} — но БЕЗ переспама. ` +
    `ЗАПРЕЩЕНО: выдумывать статистику и цены платформы ПРОМО.МУЗЫКА, обещать гарантии результата, упоминать конкретные суммы её тарифов. ` +
    `Общеотраслевые ориентиры и практики описывать можно. ` +
    `Ровно ОДНО ненавязчивое упоминание платформы: одним предложением ближе к концу, со ссылкой <a href="${a.landing}">…</a> по смыслу. ` +
    `Ответ — СТРОГО JSON без markdown-обёртки: {"title": "...", "excerpt": "... (140-160 знаков)", "content": "<p>...</p>..."}`;
  const user = `Тема статьи: «${t.title}». Напиши статью.`;
  return { system, user };
}

export interface GeneratedArticle {
  ok: boolean;
  done?: boolean;          // все темы исчерпаны
  id?: string;
  title?: string;
  audience?: string;
  topic?: string;
  error?: string;
}

/**
 * Сгенерировать и опубликовать одну авторскую статью.
 * @param audienceKey — явная аудитория; без неё ротация по дню года.
 * @param topicSlug — явная тема (для ручного запуска/перегенерации).
 */
export async function generateDailyArticle(audienceKey?: string, topicSlug?: string): Promise<GeneratedArticle> {
  const used = await usedTopicSlugs();

  // Порядок обхода: с «аудитории дня» по кругу — если её темы кончились,
  // день не пропадает, статью получает следующая аудитория.
  const dayOfYear = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000);
  const startIdx = audienceKey
    ? Math.max(0, AUDIENCES.findIndex(a => a.key === audienceKey))
    : dayOfYear % AUDIENCES.length;

  let audience: Audience | undefined;
  let topic: ArticleTopic | undefined;
  for (let i = 0; i < AUDIENCES.length; i++) {
    const a = AUDIENCES[(startIdx + i) % AUDIENCES.length];
    if (audienceKey && a.key !== audienceKey && i === 0 && !findAudience(audienceKey)) {
      return { ok: false, error: `Unknown audience '${audienceKey}'` };
    }
    const t = topicSlug
      ? a.topics.find(x => x.slug === topicSlug)
      : a.topics.find(x => !used.has(x.slug));
    if (t && (!topicSlug || !used.has(t.slug) || topicSlug === t.slug)) {
      audience = a; topic = t; break;
    }
    if (audienceKey) break; // явная аудитория без свободных тем — не перескакиваем
  }
  if (!audience || !topic) return { ok: true, done: true };

  const { system, user } = buildPrompt(audience, topic);
  let raw: string;
  try {
    raw = await quickLLM(system, user, { maxTokens: 4000, tag: `article-agent-${audience.key}` });
  } catch (e: any) {
    return { ok: false, error: `LLM failed: ${e?.message || e}` };
  }

  // LLM иногда заворачивает JSON в ```json … ``` — снимаем обёртку.
  const jsonStr = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: { title?: string; excerpt?: string; content?: string };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { ok: false, error: 'LLM вернул не-JSON, статья не опубликована (перегенерируй: тот же topicSlug)' };
  }
  if (!parsed.title || !parsed.content || parsed.content.length < 1500) {
    return { ok: false, error: 'Ответ LLM неполный/короткий, статья не опубликована' };
  }

  const now = new Date().toISOString();
  const id = `article-${topic.slug}`;
  await upsertNewsPublic({
    id,
    title: String(parsed.title).slice(0, 200),
    excerpt: String(parsed.excerpt || '').slice(0, 300),
    content: parsed.content,
    category: audience.category,
    source: 'promo-editorial',
    seoTopic: topic.slug,
    seoAudience: audience.key,
    tags: [audience.label, 'авторская'],
    authorName: audience.persona.name,
    authorAvatar: audience.persona.avatar,
    publishedAt: now,
    status: 'published',
    createdAt: now,
  } as any);

  // Мгновенная индексация — тот же путь, что у остальных новостей.
  import('./landing-data-routes.tsx').then(m => m.pingSitemapAsync(id)).catch(() => {});

  return { ok: true, id, title: parsed.title, audience: audience.key, topic: topic.slug };
}

/** Сводка банка тем: сколько осталось по каждой аудитории. */
export async function articleTopicsStatus() {
  const used = await usedTopicSlugs();
  return AUDIENCES.map(a => ({
    audience: a.key,
    label: a.label,
    total: a.topics.length,
    published: a.topics.filter(t => used.has(t.slug)).length,
    next: a.topics.find(t => !used.has(t.slug))?.slug || null,
  }));
}
