/**
 * HELP ROUTES — AI-помощник по платформе ПРОМО.МУЗЫКА
 * POST /ask — принимает вопрос, возвращает AI-ответ через Gemini proxy
 */

import { Hono } from 'hono';

const help = new Hono();

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8099';
const GEMINI_PROXY_AUTH = process.env.GEMINI_PROXY_AUTH || 'promofm-gemini-proxy-2024';

// ── Rate limiter (in-memory, per IP, 20 req/min) ──
const rateMap = new Map<string, { count: number; resetAt: number }>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateMap) {
    if (now > entry.resetAt) rateMap.delete(ip);
  }
}, 300_000);

// ── System prompt ──
const SYSTEM_PROMPT = `Ты — AI-помощник платформы ПРОМО.МУЗЫКА (promo-music.ru). Отвечай на русском языке, дружелюбно и лаконично. Помогай пользователям разобраться в функциях платформы, навигации и решении проблем.

## О платформе
ПРОМО.МУЗЫКА — маркетинговая экосистема для музыкантов. Продвигай музыку, попадай в ротацию радиостанций, расти. Платформа объединяет артистов, DJ, продюсеров, площадки и радиостанции.

## 5 ролей пользователей

### Артист (/artist)
Разделы кабинета: Главная, Мои публикации, Коллаборации, Мои треки, Мои видео, Мои концерты, Мои новости, Тест трека, Продвижение (питчинг), Промо-кампании, Тарифы, Настройки.
Возможности: загрузка треков и видео, создание концертов, публикация новостей, питчинг на радиостанции, промо-кампании, аналитика прослушиваний, заработок.

### DJ (/dj)
Разделы: Обзор, Профиль, Миксы, Букинги, События, Продвижение, Коллаборации, Тест трека, Аналитика, Финансы, Настройки.
Возможности: управление миксами, букинг на события, продвижение на радио, коллаборации, финансовый учёт.

### Продюсер (/producer)
Разделы: Обзор, Мои услуги, Заказы, Портфолио, Аналитика, Сообщения, Календарь, Профиль, Кошелёк, Тест трека, Коллаборации, ПРОМО.АИ, Настройки.
Возможности: предложение услуг (сведение, мастеринг, аранжировка, ремикс), приём заказов через маркетплейс, портфолио с примерами, AI-инструменты.

### Площадка (/venue)
Разделы: Главная, Музыка и радио, Букинг артистов, Радио-интеграция, Подписка, Аналитика, Сообщения, Профиль.
Возможности: управление музыкальным оформлением, букинг артистов и DJ, подключение радио, аналитика посещаемости.

### Радиостанция (/radio)
Разделы: Заявки артистов, Заявки площадок, Рекламные слоты, Аналитика, Профиль, Финансы, Сообщения.
Возможности: приём заявок от артистов на ротацию, управление рекламными слотами, аналитика аудитории.

## Тарифы (для артистов)
- Тест-драйв — бесплатно. Базовые функции: профиль, загрузка треков, участие в чартах.
- Старт — 8 990 ₽/мес. Питчинг на радио, расширенная аналитика, приоритетная модерация.
- Pro — расширенный пакет с промо-кампаниями и приоритетным размещением.
- Pro Plus — максимальный пакет с персональным менеджером и эксклюзивными возможностями.

## Основные действия

### Как загрузить трек
1. Войди в кабинет артиста → раздел "Мои треки"
2. Нажми "Загрузить трек"
3. Заполни информацию: название, жанр, обложка
4. Трек пройдёт модерацию (обычно 1-2 дня)

### Как запустить питчинг
1. Кабинет артиста → "Продвижение"
2. Выбери трек для продвижения
3. Выбери радиостанции
4. Отправь заявку — радиостанция рассмотрит и решит о ротации

### Как создать концерт
1. Кабинет артиста → "Мои концерты"
2. Нажми "Создать концерт"
3. Заполни: дата, место, описание, цена билетов

### Как настроить профиль
Кабинет → "Настройки" или "Профиль". Добавь фото, описание, жанры, ссылки на соцсети.

### Как заказать услугу продюсера
1. Зайди в раздел маркетплейса
2. Найди продюсера по специализации
3. Оставь заявку с описанием задачи

## Регистрация
1. Перейди на promo-music.ru
2. Нажми "Регистрация"
3. Выбери роль (Артист, DJ, Продюсер, Площадка, Радиостанция)
4. Укажи email и пароль
5. Подтверди email по ссылке в письме

## Проблемы и решения
- Не приходит письмо подтверждения: проверь папку "Спам". Если нет — используй "Отправить повторно" на странице входа.
- Забыл пароль: на странице входа нажми "Забыли пароль?" и введи email.
- Трек не проходит модерацию: убедись что трек оригинальный, обложка качественная, метаданные заполнены корректно.
- Не вижу аналитику: аналитика появляется после первых прослушиваний. Данные обновляются раз в час.

## Контакты
Поддержка: раздел "Настройки" → "Поддержка" в любом кабинете, или email info@promofm.ru.

## Правила
- Отвечай ТОЛЬКО по теме платформы ПРОМО.МУЗЫКА
- Если вопрос не связан с платформой, вежливо перенаправь к теме
- Давай конкретные шаги с навигацией (названия разделов, кнопок)
- Если знаешь роль пользователя — адаптируй ответ под неё
- Будь кратким: 2-4 предложения для простых вопросов, до 8 для сложных`;

// ── Call Gemini proxy ──
async function callGemini(prompt: string): Promise<string> {
  const resp = await fetch(GEMINI_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Auth': GEMINI_PROXY_AUTH,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

// ── Main endpoint ──
help.post('/ask', async (c) => {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (!checkRate(ip)) {
    return c.json({ error: 'Слишком много запросов. Подождите минуту.' }, 429);
  }

  let body: { message?: string; history?: { role: string; content: string }[]; userRole?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { message, history = [], userRole } = body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return c.json({ error: 'Пустое сообщение' }, 400);
  }

  // Build prompt with context
  let fullPrompt = SYSTEM_PROMPT + '\n\n';

  if (userRole) {
    const roleNames: Record<string, string> = {
      artist: 'Артист', dj: 'DJ', producer: 'Продюсер',
      venue: 'Площадка', radio_station: 'Радиостанция',
    };
    fullPrompt += `Текущий пользователь имеет роль: ${roleNames[userRole] || userRole}. Адаптируй ответы под эту роль.\n\n`;
  }

  // Add conversation history (last 6 messages)
  const recentHistory = history.slice(-6);
  if (recentHistory.length > 0) {
    fullPrompt += 'История диалога:\n';
    for (const msg of recentHistory) {
      const who = msg.role === 'user' ? 'Пользователь' : 'Помощник';
      fullPrompt += `${who}: ${msg.content}\n`;
    }
    fullPrompt += '\n';
  }

  fullPrompt += `Пользователь: ${message.trim().slice(0, 2000)}\n\nПомощник:`;

  try {
    const reply = await callGemini(fullPrompt);
    return c.json({ reply: reply.trim() });
  } catch (err: any) {
    console.error('[help] Gemini error:', err?.message || err);
    return c.json({ error: 'AI-помощник временно недоступен. Попробуйте позже.' }, 503);
  }
});

export default help;
