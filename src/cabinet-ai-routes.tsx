/**
 * Universal Cabinet AI Assistant — ПРОМО.АИ
 * Per-cabinet LLM analysis with context-aware system prompts
 * POST /analyze — ask question with cabinet context
 * GET /history — last Q&A for a cabinet type
 */

import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import { quickLLM, getLLMStatus } from './llm-router.tsx';

const app = new Hono();

// ─── KV store for last AI response per user+cabinet ──────────────────────────

const aiHistoryMap = new Map<string, { question: string; response: string; timestamp: string }>();

function historyKey(userId: string, cabinet: string) {
  return `${userId}:${cabinet}`;
}

// ─── Per-cabinet system prompts ──────────────────────────────────────────────

const CABINET_PROMPTS: Record<string, string> = {
  artist: `Ты - AI-помощник артиста на платформе ПРОМО.МУЗЫКА.
Ты знаешь всё о кабинете артиста: треки, видео, концерты, новости, публикации, тест трека, промо-кампании, питчинг, коллаборации.
Помогай артисту развивать карьеру: продвижение музыки, увеличение охватов, стратегии релизов, работа с лейблами, рекомендации по контенту.
Давай конкретные, действенные советы. Русский язык. Краткие тире (-). Формат с эмодзи.`,

  dj: `Ты - AI-помощник DJ на платформе ПРОМО.МУЗЫКА.
Ты знаешь всё о кабинете DJ: миксы, букинги, события, продвижение, коллаборации, тест трека, аналитика, финансы.
Помогай DJ развиваться: стратегии продвижения, увеличение букингов, работа с промоутерами и клубами, техника сведения, создание миксов.
Давай конкретные, действенные советы. Русский язык. Краткие тире (-). Формат с эмодзи.`,

  venue: `Ты - AI-помощник заведения на платформе ПРОМО.МУЗЫКА.
Ты знаешь всё о кабинете заведения: музыкальное оформление (радио-бренд), букинг артистов, радио-интеграция, аналитика, подписка.
Помогай заведению: подбор музыки для атмосферы, букинг правильных артистов, увеличение посещаемости, работа с плейлистами.
Давай конкретные, действенные советы. Русский язык. Краткие тире (-). Формат с эмодзи.`,

  radio: `Ты - AI-помощник радиостанции на платформе ПРОМО.МУЗЫКА.
Ты знаешь всё о кабинете радио: заявки артистов, заявки заведений, рекламные слоты, аналитика, финансы.
Помогай радиостанции: оптимизация эфирной сетки, работа с артистами, монетизация рекламных слотов, анализ аудитории.
Давай конкретные, действенные советы. Русский язык. Краткие тире (-). Формат с эмодзи.`,

  producer: `Ты - AI-помощник продюсера на платформе ПРОМО.МУЗЫКА.
Ты знаешь всё о кабинете продюсера: услуги, заказы, портфолио, аналитика, сообщения, календарь, кошелёк, коллаборации.
Помогай продюсеру развивать бизнес: оптимизация цен, привлечение клиентов, улучшение портфолио, планирование загрузки.
Давай конкретные, действенные советы. Русский язык. Краткие тире (-). Формат с эмодзи.`,
};

// ─── Fallback responses (when LLM unavailable) ──────────────────────────────

const FALLBACK: Record<string, string> = {
  artist: `📊 **ПРОМО.АИ — Рекомендации для артиста**

- 🎵 Регулярно выпускайте новые треки (минимум 1 в месяц)
- 📹 Снимайте видео — визуальный контент даёт x3 охватов
- 📰 Публикуйте новости о себе — это повышает узнаваемость
- 🎤 Организуйте концерты через платформу
- 🧪 Закажите тест трека — получите экспертный фидбек
- 🚀 Используйте промо-кампании для продвижения
- 🤝 Ищите коллаборации — это расширяет аудиторию`,

  dj: `📊 **ПРОМО.АИ — Рекомендации для DJ**

- 🎧 Загружайте миксы регулярно — это ваше портфолио
- 📅 Откликайтесь на букинги — чем больше выступлений, тем выше рейтинг
- 🎤 Посещайте события для нетворкинга
- 📈 Анализируйте статистику — какие миксы популярнее
- 🤝 Ищите коллаборации с артистами и продюсерами
- 🧪 Тестируйте свои треки у экспертов
- 💰 Оптимизируйте финансы — отслеживайте доходы`,

  venue: `📊 **ПРОМО.АИ — Рекомендации для заведения**

- 🎵 Настройте музыкальный бренд — правильная музыка = атмосфера
- 🎤 Букайте артистов через платформу — живая музыка увеличивает чек
- 📻 Подключите радио-интеграцию для фонового вещания
- 📊 Следите за аналитикой — какая музыка нравится гостям
- ⭐ Оформите подписку для доступа ко всем функциям
- 📱 Отвечайте на сообщения оперативно`,

  radio: `📊 **ПРОМО.АИ — Рекомендации для радиостанции**

- 📬 Обрабатывайте заявки артистов вовремя — это ваш контент
- 🏢 Привлекайте заведения — больше точек вещания
- 💰 Оптимизируйте рекламные слоты — это основной доход
- 📊 Анализируйте аудиторию — понимайте свою ЦА
- 💼 Следите за финансами и оптимизируйте расходы
- 🔔 Настройте уведомления чтобы не пропускать заявки`,

  producer: `📊 **ПРОМО.АИ — Рекомендации для продюсера**

- 🎛 Добавьте больше услуг — расширяйте предложение
- 💰 Оптимизируйте цены на основе спроса
- 📁 Обновляйте портфолио регулярно
- 📅 Планируйте загрузку через календарь
- 💬 Отвечайте клиентам быстро — это повышает рейтинг
- 🤝 Ищите коллаборации для новых проектов`,
};

// ─── POST /analyze ───────────────────────────────────────────────────────────

app.post('/analyze', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as string;
    const { cabinetType, question } = await c.req.json();

    if (!cabinetType || !CABINET_PROMPTS[cabinetType]) {
      return c.json({ success: false, error: 'Invalid cabinetType' }, 400);
    }

    const q = question?.trim() || 'Дай общие рекомендации по развитию.';
    const systemPrompt = CABINET_PROMPTS[cabinetType];

    const llmStatus = getLLMStatus();
    if (!llmStatus.available) {
      const key = historyKey(userId, cabinetType);
      const fb = FALLBACK[cabinetType] || FALLBACK.artist;
      aiHistoryMap.set(key, { question: q, response: fb, timestamp: new Date().toISOString() });
      return c.json({ success: true, data: { response: fb, model: 'fallback' } });
    }

    try {
      const response = await quickLLM(systemPrompt, q, { maxTokens: 1500, tag: `cabinet-ai-${cabinetType}` });
      const key = historyKey(userId, cabinetType);
      aiHistoryMap.set(key, { question: q, response, timestamp: new Date().toISOString() });
      return c.json({ success: true, data: { response, model: 'ПРОМО.АИ' } });
    } catch (err) {
      console.error(`Cabinet AI (${cabinetType}) LLM error:`, err);
      const fb = FALLBACK[cabinetType] || FALLBACK.artist;
      return c.json({ success: true, data: { response: fb, model: 'fallback' } });
    }
  } catch (error) {
    console.error('Cabinet AI error:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ─── GET /history ────────────────────────────────────────────────────────────

app.get('/history', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as string;
    const cabinet = c.req.query('cabinet') || 'artist';
    const key = historyKey(userId, cabinet);
    const last = aiHistoryMap.get(key) || null;
    return c.json({ success: true, data: last });
  } catch {
    return c.json({ success: true, data: null });
  }
});

export default app;
