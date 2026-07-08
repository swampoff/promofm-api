/**
 * ARTICLE AGENT — авторские статьи под семантику аудиторий, 2 раза в день
 * (решения Никиты 2026-07-08: «статьи максимально про ПРОМО.МУЗЫКА,
 * вести через фразы на нужные разделы, оставаясь максимально
 * информативными; где-то рерайт, где-то чистое авторство; выходить
 * в 10:00 и 18:00»).
 *
 * Отличие от news-agent.tsx: тот перерабатывает ЧУЖИЕ новости из внешних
 * источников; этот пишет СВОИ статьи под информационные запросы девяти
 * семантических ядер (xlsx 2026-07: заведения, артисты, диджеи,
 * инженеры, продюсеры/композиторы, лейблы, международное продвижение +
 * SEMANTIC_CORE §16 радио / раздел ТВ). Публикация — в news_public:
 * лента, sitemap, prerender-снапшоты и IndexNow уже работают.
 *
 * Ротация: каждая публикация двигает аудиторию по кругу (startIdx =
 * количество уже опубликованных статей агента), поэтому два тика в
 * день дают две РАЗНЫЕ аудитории. Внутри аудитории — первая
 * неиспользованная тема (маркер data.seoTopic в news_public — новых
 * таблиц/миграций НЕ требуется). Темы аудитории кончились — статью
 * получает следующая; кончилось всё — честный done:true без публикации.
 *
 * mode темы: 'authored' — оригинальный экспертный гайд;
 * 'review' — обзор существующих сервисов/практик рынка (рерайт
 * общеизвестного с позицией ПРОМО.МУЗЫКА как одного из инструментов).
 */

import { quickLLM } from './llm-router.tsx';
import { listAllNewsPublic, upsertNewsPublic } from './db.tsx';

interface ArticleTopic {
  slug: string;         // уникальный маркер использования (data.seoTopic)
  title: string;        // рабочий заголовок (LLM может улучшить)
  queries: string[];    // целевые поисковые запросы из ядра
  mode?: 'authored' | 'review';  // default authored
  landings?: string[];  // доп. разделы для ссылок (сверх дефолта аудитории)
}

interface Audience {
  key: string;
  label: string;
  category: string;     // news_public category
  persona: { name: string; avatar: string; style: string };
  landing: string;      // дефолтный раздел для ссылок
  topics: ArticleTopic[];
}

// Персонажи — те же, что в news-agent (единая «редакция» сайта).
const P = {
  liana:  { name: 'Лиана', avatar: '/avatars/avatar_liana.png', style: 'аналитика, индустрия, бизнес музыки. Пишет вдумчиво, с цифрами и контекстом' },
  den:    { name: 'DJ Den', avatar: '/avatars/avatar_dj_den.png', style: 'клубная культура, электроника, DJ-сцена. Пишет энергично и с инсайдерским знанием клубной жизни' },
  niko:   { name: 'Нико', avatar: '/avatars/avatar_nico.png', style: 'европейская сцена, классика, джаз, авангард. Пишет изысканно, со знанием музыкальной теории' },
  mark:   { name: 'Марк', avatar: '/avatars/avatar_mark.png', style: 'хип-хоп, рэп, R&B. Пишет в уличном стиле, знает культуру изнутри' },
  sandra: { name: 'Сандра', avatar: '/avatars/avatar_sandra.png', style: 'поп-музыка, мейнстрим, фестивали. Пишет ярко, эмоционально, с акцентом на тренды' },
  pablo:  { name: 'Пабло', avatar: '/avatars/avatar_pablo.png', style: 'мировая музыка, международная сцена. Пишет с уважением к культурным корням и знанием глобального рынка' },
  redcat: { name: 'РэдКэт', avatar: '/avatars/avatar_radkat.png', style: 'технологии в музыке, AI, стриминг, цифровая индустрия. Пишет технично и футуристично' },
};

const AUDIENCES: Audience[] = [
  {
    key: 'artists', label: 'Артисты', category: 'industry',
    persona: P.liana, landing: '/promotion',
    // Ядро «артисты и музыканты РФ» (132 запроса): дистрибуция и
    // продвижение — массовый спрос; «трек в заведениях» — голубой океан.
    topics: [
      { slug: 'artist-track-in-venues', title: 'Как сделать, чтобы твой трек играл в кафе и магазинах — и приносил роялти', queries: ['как чтобы мой трек играл в кафе', 'ротация трека в заведениях', 'разместить музыку в кафе и магазинах'], landings: ['/for-venues'] },
      { slug: 'artist-release-to-streamings', title: 'Как выложить трек на Яндекс Музыку, VK и все стриминги: пошагово', queries: ['как выложить трек на Яндекс Музыку', 'как выложить трек на VK Музыку', 'дистрибуция музыки'], landings: ['/distribution'] },
      { slug: 'artist-promote-track-2026', title: 'Как продвигать трек в 2026 году: рабочие каналы без накруток', queries: ['продвижение музыки', 'раскрутка трека', 'как раскрутить трек', 'продвижение артиста'] },
      { slug: 'artist-playlist-pitching', title: 'Как попасть в плейлисты Яндекс Музыки, VK и Звука: питчинг без магии', queries: ['как попасть в плейлист Яндекс Музыки', 'питчинг трека', 'редакторские плейлисты как попасть'] },
      { slug: 'artist-radio-rotation', title: 'Как попасть на радио музыканту: от заявки до ротации', queries: ['как попасть на радио музыканту', 'ротация на радио', 'отправить трек на радио'], landings: ['/get-in-chart'] },
      { slug: 'artist-music-earnings', title: 'Как заработать на музыке: стриминги, роялти, эфиры и заведения', queries: ['как заработать на музыке', 'сколько платят за прослушивания', 'роялти в музыке'] },
      { slug: 'artist-rao-vois-rights', title: 'РАО и ВОИС для артиста: как регистрировать треки и получать отчисления', queries: ['регистрация в РАО', 'как зарегистрировать песню', 'авторские отчисления'] },
      { slug: 'artist-sync-licensing', title: 'Как продать трек в рекламу, кино и сериал: sync-лицензирование по-русски', queries: ['как попасть в саундтрек', 'продать трек в рекламу'] },
      { slug: 'artist-first-release', title: 'Первый релиз с нуля: гайд для начинающего артиста', queries: ['как выпустить первый трек', 'продвижение музыканта с нуля'] },
      { slug: 'artist-press-kit', title: 'Пресс-кит артиста: что положить, чтобы редактор дослушал', queries: ['пресс-кит артиста', 'EPK музыканта'] },
      { slug: 'artist-track-quality-radio', title: 'Почему радио отклоняет треки: требования к качеству и формату', queries: ['требования радио к трекам', 'мастеринг для радио LUFS'] },
      { slug: 'artist-concert-booking', title: 'Первые концерты: как артисту попасть на площадки без букинг-агента', queries: ['как организовать концерт', 'букинг артиста'], landings: ['/concerts'] },
    ],
  },
  {
    key: 'djs', label: 'Диджеи', category: 'club',
    persona: P.den, landing: '/for-djs',
    // Ядро «диджеи РФ» (145): обучение и «где брать музыку» — массовые
    // магниты; боль — баны за чужие треки; оффер — сеты в заведениях.
    topics: [
      { slug: 'dj-sets-in-venues', title: 'Крути свои сеты в заведениях легально — и получай за это роялти', queries: ['диджейский сет для бара', 'плейлист от диджея для заведения', 'курировать музыку для ресторана', 'фоновый микс для кафе'], landings: ['/for-venues'] },
      { slug: 'dj-how-to-become', title: 'Как стать диджеем с нуля: путь от спальни до первого гига', queries: ['как стать диджеем', 'диджеинг с нуля', 'научиться сводить треки'] },
      { slug: 'dj-where-get-music', title: 'Где диджею брать музыку легально: пулы, промо и подводные камни', queries: ['где брать музыку диджею', 'dj pool', 'промо пул для диджеев', 'музыка для диджеинга'], mode: 'review' },
      { slug: 'dj-mix-strikes', title: 'Почему миксы банят на SoundCloud и как выкладывать сеты без страйков', queries: ['авторские права на микс', 'можно ли выкладывать миксы', 'как легально выкладывать миксы'] },
      { slug: 'dj-controller-start', title: 'Первый DJ-контроллер: что реально нужно начинающему', queries: ['dj контроллер для начинающих', 'что нужно начинающему диджею', 'диджейское оборудование'], mode: 'review' },
      { slug: 'dj-mix-promotion', title: 'Куда девать готовый микс: продвижение DJ-сетов в 2026', queries: ['куда выкладывать миксы', 'продвижение диджея', 'продвижение в SoundCloud'] },
      { slug: 'dj-resident-club', title: 'Как стать резидентом клуба: путь к постоянным гигам', queries: ['как стать резидентом клуба', 'как найти заказы диджею', 'резиденция диджея'] },
      { slug: 'dj-earnings-breakdown', title: 'Сколько зарабатывает диджей: гонорары, резиденции, эфиры', queries: ['сколько зарабатывает диджей', 'гонорар диджея', 'диджей на мероприятие цена'] },
      { slug: 'dj-radio-residency', title: 'Резиденция на радио: как диджею получить своё шоу в эфире', queries: ['диджей на радио', 'радиошоу диджея'], landings: ['/air-live'] },
      { slug: 'dj-events-weddings', title: 'Диджей на свадьбу и корпоратив: как выигрывать коммерческие заказы', queries: ['диджей на свадьбу', 'диджей на корпоратив', 'свадебный диджей'] },
    ],
  },
  {
    key: 'engineers', label: 'Звукорежиссёры', category: 'production',
    persona: P.niko, landing: '/for-engineers',
    // Ядро «инженеры РФ» (143): услуги/обучение — трафик; стыки с
    // продуктом — мастеринг под трансляцию и продакшн аудиорекламы.
    topics: [
      { slug: 'mixing-order-guide', title: 'Заказать сведение трека: как выбрать инженера и не переплатить', queries: ['заказать сведение трека', 'сведение и мастеринг заказать', 'сколько стоит сведение трека'], landings: ['/services-marketplace'] },
      { slug: 'mastering-lufs-streaming', title: 'Мастеринг под стриминги и радио: громкость, LUFS и форматы', queries: ['мастеринг для стриминга', 'LUFS для Spotify', 'мастеринг для Яндекс Музыки', 'что такое мастеринг'] },
      { slug: 'mastering-for-broadcast', title: 'Мастеринг под трансляцию: почему эфиру нужна единая громкость', queries: ['мастеринг для радио', 'громкость для эфира', 'LUFS для вещания', 'мастеринг фоновой музыки'] },
      { slug: 'audio-ad-production', title: 'Продакшн аудиорекламы: как делаются джинглы и ролики для торговых залов', queries: ['запись аудиоролика', 'продакшн аудиорекламы', 'джингл на заказ', 'сделать аудиорекламу для магазина'], landings: ['/indoor-advertising'] },
      { slug: 'vocal-mixing-basics', title: 'Как свести вокал: эквализация, компрессия и место в миксе', queries: ['как свести вокал', 'эквализация вокала', 'компрессия вокала'] },
      { slug: 'engineer-find-clients', title: 'Где звукорежиссёру брать заказы: от сарафана к маркетплейсам', queries: ['как найти клиентов звукорежиссёру', 'заказы на сведение', 'работа звукорежиссёром'], landings: ['/services-marketplace'] },
      { slug: 'engineer-career-path', title: 'Как стать звукорежиссёром: обучение, практика, первые деньги', queries: ['как стать звукорежиссёром', 'курсы сведения и мастеринга', 'сколько зарабатывает звукорежиссёр'] },
      { slug: 'home-vs-studio-recording', title: 'Домашняя студия против коммерческой: когда пора платить за студийный час', queries: ['домашняя студия что нужно', 'запись вокала дома или в студии'] },
    ],
  },
  {
    key: 'producers', label: 'Продюсеры и композиторы', category: 'production',
    persona: P.mark, landing: '/beats-marketplace',
    // Ядро «продюсеры/авторы/композиторы» (158): САМАЯ близкая к продукту
    // аудитория — производители инструменталов = источник каталога эфира.
    topics: [
      { slug: 'production-music-for-venues', title: 'Куда сдать фоновую музыку для бизнеса: инструменталы, которые зарабатывают офлайн', queries: ['куда сдать фоновую музыку для бизнеса', 'продать инструментал для фоновой музыки', 'production music', 'музыка для заведений композитору'], landings: ['/for-venues'] },
      { slug: 'sell-beats-guide', title: 'Как продавать биты: площадки, лицензии и цены в 2026', queries: ['как продавать биты', 'где продавать биты', 'продать бит'] },
      { slug: 'beat-license-types', title: 'Лицензии на биты: lease, exclusive и что писать в договоре', queries: ['лицензия на бит', 'эксклюзив на бит', 'авторские права на бит'] },
      { slug: 'stock-music-earnings', title: 'Заработок на стоковой музыке: от AudioJungle до офлайн-ротации', queries: ['стоковая музыка заработок', 'где продать музыку', 'как попасть в Epidemic Sound', 'royalty free музыка создать'], mode: 'review' },
      { slug: 'composer-for-hire', title: 'Композитор на заказ: как брать проекты для кино, рекламы и видео', queries: ['композитор на заказ', 'музыка для рекламы композитор', 'написать музыку для видео', 'музыка для кино на заказ'] },
      { slug: 'sound-logo-design', title: 'Звуковой логотип и аудиобрендинг: как sound-дизайнеру продавать бизнесу', queries: ['звуковой логотип на заказ', 'саунд дизайн на заказ', 'звуковой брендинг'], landings: ['/indoor-advertising'] },
      { slug: 'beatmaker-career', title: 'Как стать битмейкером: от первых битов до стабильного дохода', queries: ['как стать битмейкером', 'как делать биты', 'курсы битмейкинга'] },
      { slug: 'arrangement-orders', title: 'Аранжировка на заказ: как оформлять работу и цены', queries: ['аранжировка на заказ', 'сделать аранжировку', 'минус на заказ'] },
      { slug: 'producer-artist-collab', title: 'Продюсер и артист: как оформлять коллаборацию, чтобы не поссориться на роялти', queries: ['коллаборация продюсера и артиста', 'сплит роялти', 'договор на музыку на заказ'] },
      { slug: 'songwriting-sell', title: 'Продать песню: как авторы зарабатывают на чужих голосах', queries: ['продать песню', 'написать текст песни на заказ', 'написать песню на заказ'] },
    ],
  },
  {
    key: 'labels', label: 'Лейблы', category: 'industry',
    persona: P.liana, landing: '/for-labels',
    // Ядро «лейблы РФ» (120): конвертятся адресным B2B, семантика — для
    // контента (читают её артисты) + стык «каталог для заведений».
    topics: [
      { slug: 'label-catalog-licensing', title: 'Лицензирование каталога лейбла для заведений: новый источник роялти', queries: ['лицензировать каталог для фоновой музыки', 'B2B лицензирование музыки', 'лицензирование музыки для вещания', 'монетизация каталога лейбла'], landings: ['/for-venues'] },
      { slug: 'how-to-start-label', title: 'Как создать музыкальный лейбл: от идеи до первого релиза', queries: ['как создать музыкальный лейбл', 'как открыть свой лейбл', 'свой лейбл с нуля'] },
      { slug: 'how-to-get-signed', title: 'Как попасть на лейбл: демо, питч и что смотрят A&R', queries: ['как попасть на лейбл', 'отправить демо на лейбл', 'куда отправить демо'] },
      { slug: 'label-contract-traps', title: 'Контракт с лейблом: 360-сделки, роялти и подводные камни', queries: ['контракт с лейблом', '360 сделка с лейблом', 'договор с лейблом подводные камни'] },
      { slug: 'label-vs-distributor', title: 'Лейбл или дистрибьютор: что выбрать артисту в 2026', queries: ['лейбл или дистрибьютор', 'что делает лейбл', 'дистрибуция для лейбла'], mode: 'review', landings: ['/distribution'] },
      { slug: 'label-neighboring-rights', title: 'Смежные права лейбла: как фонограммы зарабатывают через ВОИС', queries: ['смежные права лейбла', 'права на фонограмму', 'роялти за публичное исполнение'] },
    ],
  },
  {
    key: 'international', label: 'Международное продвижение', category: 'industry',
    persona: P.pablo, landing: '/promotion',
    // Ядро «мир/Европа/Spotify» (131): EN-домен; статьи на русском для
    // выходящих на зарубеж — контент-магнит для creator-аудиторий.
    topics: [
      { slug: 'spotify-playlist-pitching-ru', title: 'Как попасть в плейлисты Spotify из России: editorial, алгоритмы, кураторы', queries: ['продвижение в Spotify', 'spotify playlist pitching', 'как попасть в плейлисты Spotify'] },
      { slug: 'european-radio-plugging', title: 'Европейское радио для независимого артиста: как работает radio plugging', queries: ['european radio promotion', 'radio plugging', 'как попасть на европейское радио'] },
      { slug: 'worldwide-distribution-ru', title: 'Дистрибуция музыки за рубеж: как выпустить релиз на весь мир из РФ', queries: ['дистрибуция музыки за рубеж', 'distribute music worldwide', 'как загрузить музыку на Spotify'], landings: ['/distribution'] },
      { slug: 'tiktok-viral-track', title: 'Как завирусить трек в TikTok и Reels: механика, а не везение', queries: ['как завирусить трек', 'продвижение музыки в TikTok', 'tiktok music promotion'] },
      { slug: 'pitching-services-review', title: 'SubmitHub, Groover и другие: обзор сервисов питчинга для выхода на Запад', queries: ['submithub', 'groover music promotion', 'playlist pitching service'], mode: 'review' },
      { slug: 'music-pr-blogs', title: 'Музыкальный PR за рубежом: как попасть в блоги и медиа', queries: ['music blog submission', 'music pr', 'музыкальный pr'] },
    ],
  },
  {
    key: 'radio', label: 'Радиостанции', category: 'industry',
    persona: P.liana, landing: '/radio-stations',
    topics: [
      { slug: 'radio-find-new-music', title: 'Где радиостанции берут новую музыку: от самотёка к кураторским пакетам', queries: ['новая музыка для радио', 'треки для эфира'] },
      { slug: 'radio-monetize-airtime', title: 'Монетизация эфира региональной станции: что работает кроме рекламы', queries: ['монетизация радиоэфира', 'доход радиостанции'] },
      { slug: 'radio-rotation-how', title: 'Как устроена ротация: почему одни треки крутят, а другие нет', queries: ['ротация на радио', 'плейлист-комитет'] },
      { slug: 'radio-audience-2026', title: 'Аудитория радио в 2026: кто ещё слушает FM и зачем станции интернет-эфир', queries: ['аудитория радио', 'интернет-радио статистика'] },
    ],
  },
  {
    key: 'tv', label: 'ТВ и клипы', category: 'video',
    persona: P.sandra, landing: '/tv-rotation',
    topics: [
      { slug: 'music-video-on-tv', title: 'Как попасть с клипом на ТВ: путь от загрузки до ротации', queries: ['клип на тв', 'ротация клипа на телевидении'] },
      { slug: 'music-video-budget', title: 'Клип за разумные деньги: на чём можно и нельзя экономить', queries: ['сколько стоит клип', 'бюджет музыкального клипа'] },
      { slug: 'tv-vs-youtube-clips', title: 'ТВ против YouTube: зачем клипу телевизор в эпоху стримингов', queries: ['зачем клип на тв', 'продвижение клипа'] },
    ],
  },
  {
    key: 'venues', label: 'Заведения', category: 'business',
    persona: P.redcat, landing: '/legal-music',
    topics: [
      { slug: 'dj-vs-radio-venue', title: 'Диджей каждый вечер — дорого. Что заведению даёт легальное радио 24/7', queries: ['диджей в бар цена', 'заказать диджея на мероприятие', 'музыка для заведения'], landings: ['/for-venues'] },
      { slug: 'music-sales-impact', title: 'Как музыка влияет на продажи: что показывают исследования ритейла', queries: ['влияние музыки на продажи', 'как музыка влияет на покупателей'], landings: ['/for-venues'] },
      { slug: 'restaurant-volume-guide', title: 'Громкость музыки в ресторане: как найти уровень, при котором заказывают больше', queries: ['какая громкость музыки в ресторане'], landings: ['/music-for-restaurants'] },
      { slug: 'audio-branding-intro', title: 'Аудиобрендинг: как сети делают так, что их узнают на слух', queries: ['аудиобрендинг', 'звуковой брендинг', 'музыкальный маркетинг'], landings: ['/audio-branding'] },
      { slug: 'cafe-music-choice', title: 'Какая музыка подходит для кафе: жанры, темп и время дня', queries: ['какая музыка подходит для кафе', 'как выбрать музыку для ресторана'], landings: ['/music-for-cafe'] },
      { slug: 'seasonal-music-retail', title: 'Сезонная музыка в магазине: когда включать новогодний плейлист и что это даёт', queries: ['новогодняя музыка для магазина'], landings: ['/music-for-shop'] },
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
  const landings = [a.landing, ...(t.landings || [])];
  const modeLine = t.mode === 'review'
    ? 'Формат: ОБЗОР/РАЗБОР существующих на рынке сервисов, инструментов и практик (нейтральный пересказ общеизвестного — без копирования конкретных чужих текстов), в котором ПРОМО.МУЗЫКА естественно присутствует как один из инструментов со своим уникальным углом.'
    : 'Формат: оригинальный экспертный гайд — чистое авторство, практические шаги и разборы.';
  const system =
    `Ты — ${a.persona.name}, автор редакции платформы ПРОМО.МУЗЫКА (promo-music.ru). ` +
    `Твой стиль: ${a.persona.style}. Пишешь статью на русском для аудитории «${a.label}». ${modeLine} ` +
    `Статья — часть контент-стратегии ПРОМО.МУЗЫКА: платформа и её разделы — естественная часть повествования, а не приписка в конце. ` +
    `Вплети 2–4 ссылки на разделы платформы из списка: ${landings.join(', ')} — тегом <a href="...">анкор</a>, ` +
    `анкоры формулируй из целевых фраз по смыслу абзаца, без рекламных вставок «в лоб». ` +
    `При этом статья обязана быть МАКСИМАЛЬНО ИНФОРМАТИВНОЙ и честной: читатель получает полный ответ на свой вопрос, даже если не кликнет ни одну ссылку. ` +
    `Структура: 900–1300 слов; короткий лид (2–3 предложения); 4–6 разделов с <h2>; абзацы <p>; где уместно — списки <ul><li>. ` +
    `Естественно используй формулировки запросов: ${t.queries.join(', ')} — но БЕЗ переспама. ` +
    `ЗАПРЕЩЕНО: выдумывать статистику, цены и цифры платформы ПРОМО.МУЗЫКА, обещать гарантии результата. Общеотраслевые ориентиры и практики описывать можно. ` +
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
 * Сгенерировать и опубликовать одну статью.
 * Ротация: startIdx = число уже опубликованных статей агента → каждый
 * тик (10:00 / 18:00) двигает аудиторию, два тика в день = две разные.
 * @param audienceKey — явная аудитория (ручной запуск).
 * @param topicSlug — явная тема (перегенерация).
 */
export async function generateDailyArticle(audienceKey?: string, topicSlug?: string): Promise<GeneratedArticle> {
  const used = await usedTopicSlugs();

  if (audienceKey && !findAudience(audienceKey)) {
    return { ok: false, error: `Unknown audience '${audienceKey}'` };
  }
  const startIdx = audienceKey
    ? AUDIENCES.findIndex(a => a.key === audienceKey)
    : used.size % AUDIENCES.length;

  let audience: Audience | undefined;
  let topic: ArticleTopic | undefined;
  for (let i = 0; i < AUDIENCES.length; i++) {
    const a = AUDIENCES[(startIdx + i) % AUDIENCES.length];
    const t = topicSlug ? a.topics.find(x => x.slug === topicSlug) : a.topics.find(x => !used.has(x.slug));
    if (t) { audience = a; topic = t; break; }
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
