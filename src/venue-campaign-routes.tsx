/**
 * Рассылка по заведениям (рестораны и кафе) — promo.air.
 *
 * База: 18 769 адресов от 10 637 заведений, импорт 2026-08-11
 * (`venue_partner_contacts.source='restaurants_xlsx_2026_08'`).
 *
 * Почему волнами, а не одним залпом: рассылка 10 августа дала около 13%
 * отказов на 1 514 писем. Mail.ru и Яндекс режут отправителя примерно с
 * пяти процентов, а вместе с рассылкой перестают доходить транзакционные
 * письма — подтверждения регистраций и дайджесты станциям. Поэтому шлём
 * по сегментам качества A → B → C, порциями, с ежедневным кроном.
 *
 * Дедуп по заведению: is_primary=true. У 2 693 заведений несколько
 * адресов; три письма в один ресторан — это отписка, а не три шанса.
 */
import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { smtpSendBatch, smtpSendEmail } from './smtp-sender.tsx';
import { escapeHtml } from './email-helper.tsx';

const app = new Hono();

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://promo-music.ru';
const ADMIN_COPY = 'info@promofm.ru';
const CAMPAIGN_SOURCE = 'restaurants_xlsx_2026_08';
const CAMPAIGN_ID = 'venue_promoair_2026_08';

async function requireAdminOrKey(c: any, next: any) {
  const key = c.req.header('x-internal-key');
  if (key && key === process.env.VPS_INTERNAL_KEY) return next();
  return c.json({ success: false, error: 'Unauthorized' }, 401);
}

function campaignHtml(): string {
  const b = (t: string) => `<p style="margin:0 0 12px;color:#e6e6f0;font-size:15px;line-height:1.65;">${t}</p>`;
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#0a0a1a;padding:20px 10px;">
  <!-- Ширина 100% с ограничением max-width: жёсткое width="600" резало письмо
       на телефонах (жалоба владельца 2026-08-11 со скриншота Яндекс.Почты). -->
  <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;background:#14142a;border-radius:18px;overflow:hidden;">
    <tr><td style="padding:0;">
      <a href="${SITE_URL}/promo-air" style="text-decoration:none;">
        <img src="${SITE_URL}/banners/promo-air-restaurants.jpg" alt="promo.air – собственное радио для вашего ресторана" width="600" style="width:100%;max-width:100%;height:auto;display:block;border:0;" />
      </a>
    </td></tr>
    <tr><td style="padding:24px 22px 8px;">
      <p style="margin:0 0 16px;color:#fff;font-size:17px;">Здравствуйте, <strong>{{name}}</strong>!</p>
      ${b('<strong style="color:#fff;">Promo.air от ПРОМО.МУЗЫКА</strong> – единая система для ресторанов и кафе, которая объединяет музыку, эфир и коммуникации с гостями.')}
      ${b('Вместо обычного фонового плейлиста у вас работает собственный эфир заведения:')}
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:14px 0 18px;">
        ${[
          ['&#127925;', 'постоянно новая музыка, которая не надоедает гостям и персоналу'],
          ['&#127897;', 'ведущие, рубрики и голосовые программы'],
          ['&#128226;', 'анонсы новых блюд, меню, акций, скидок и специальных предложений'],
          ['&#127881;', 'анонсы мероприятий, концертов, вечеринок и других событий'],
          ['&#128266;', 'фирменные джинглы и рекламные сообщения вашего заведения'],
        ].map(([ic, tx]) => `<tr>
          <td width="30" style="padding:6px 0;vertical-align:top;font-size:17px;">${ic}</td>
          <td style="padding:6px 0;color:#dcdce8;font-size:15px;line-height:1.55;">${tx}</td>
        </tr>`).join('')}
      </table>
      ${b('А главное, всё управляется из одного личного кабинета.')}
      ${b('Создали анонс мероприятия один раз, и система разместит его сразу в нужных каналах: в эфире Promo.air, в Telegram, во ВКонтакте и на других подключённых площадках.')}
      ${b('То есть больше не нужно отдельно готовить публикацию для соцсетей, отдельно записывать голосовое объявление и отдельно добавлять его в музыкальную систему.')}
      <p style="margin:18px 0;padding:14px 18px;background:rgba(255,87,127,.1);border-left:3px solid #FF577F;border-radius:8px;color:#fff;font-size:16px;font-weight:600;">
        Одна система. Один кабинет. Один контент. Несколько каналов.
      </p>
      ${b('Promo.air работает как полноценное радио внутри вашего заведения и одновременно становится инструментом продвижения. При этом стоимость подписки сопоставима с обычным сервисом фоновой музыки.')}
      ${b('&#128241; Подключение через Android-приложение.<br>&#128187; Управление полностью через личный кабинет.')}
      <p style="text-align:center;margin:26px 0 10px;">
        <a href="${SITE_URL}/promo-air" style="display:inline-block;padding:15px 36px;background:linear-gradient(135deg,#FF577F 0%,#7C3AED 100%);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;">Попробовать бесплатно</a>
      </p>
      <p style="text-align:center;margin:0 0 6px;color:#9a9ab0;font-size:13px;">promo-music.ru</p>
    </td></tr>
    <tr><td style="padding:18px 22px 24px;border-top:1px solid rgba(255,255,255,.08);">
      <p style="margin:0;color:#7c7c95;font-size:12px;line-height:1.6;">
        Вы получили это письмо как заведение из открытых источников. Если тема неактуальна, отпишитесь ссылкой ниже, и мы больше не побеспокоим.
      </p>
    </td></tr>
  </table>
</div>`;
}

// POST /run-wave?limit=&segment=&test=
app.post('/run-wave', requireAdminOrKey, async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '1500', 10) || 1500, 3000);
  const segParam = (c.req.query('segment') || '').toUpperCase();
  const test = c.req.query('test');
  const subject = 'А что, если ваш ресторан получит собственное радио?';
  const html = campaignHtml();

  try {
    if (test) {
      const r = await smtpSendEmail({
        to: test, subject: `[ТЕСТ] ${subject}`,
        html: html.replace(/\{\{name\}\}/g, 'ТЕСТ-заведение'),
        campaignId: CAMPAIGN_ID, listUnsubscribe: true,
        replyTo: ADMIN_COPY,
      });
      return c.json({ success: r.success, test: true, to: test, error: r.error });
    }

    // Сегмент: явный или первый непустой по порядку качества.
    let segment = segParam;
    if (!segment) {
      const q = await pool.query(
        `SELECT quality_segment FROM venue_partner_contacts
          WHERE source = $1 AND active AND is_primary AND last_sent_at IS NULL
          GROUP BY quality_segment ORDER BY quality_segment LIMIT 1`,
        [CAMPAIGN_SOURCE],
      );
      segment = q.rows[0]?.quality_segment || '';
    }
    if (!segment) return c.json({ success: true, done: true, message: 'Все сегменты разосланы' });

    const rcpt = await pool.query(
      `SELECT id, email, venue_name
         FROM venue_partner_contacts v
        WHERE v.source = $1 AND v.active AND v.is_primary
          AND v.quality_segment = $2
          AND v.last_sent_at IS NULL
          AND v.unsubscribed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM email_unsubscribes u WHERE lower(u.email) = lower(v.email))
        ORDER BY v.city NULLS LAST, v.id
        LIMIT $3`,
      [CAMPAIGN_SOURCE, segment, limit],
    );
    if (!rcpt.rows.length) {
      return c.json({ success: true, done: true, segment, message: 'В сегменте не осталось адресов' });
    }

    const recipients = rcpt.rows.map((r: any) => ({
      email: r.email,
      vars: { name: r.venue_name || 'коллеги' },
    }));

    const res = await smtpSendBatch(recipients, subject, html, {
      campaignId: CAMPAIGN_ID,
      // Ответы заведений — в мониторимый ящик; noreply@promo-music.ru почту не принимает.
      replyTo: ADMIN_COPY,
      batchSize: 40,
      delayMs: 2500,
    });

    await pool.query(
      `UPDATE venue_partner_contacts
          SET last_sent_at = now(), send_count = COALESCE(send_count, 0) + 1
        WHERE id = ANY($1::uuid[])`,
      [rcpt.rows.map((r: any) => r.id)],
    );

    const failRate = res.total ? Math.round((res.failed / res.total) * 100) : 0;
    const left = await pool.query(
      `SELECT quality_segment, count(*)::int AS n FROM venue_partner_contacts
        WHERE source = $1 AND active AND is_primary AND last_sent_at IS NULL
        GROUP BY quality_segment ORDER BY quality_segment`,
      [CAMPAIGN_SOURCE],
    );

    // Копия итога владельцу — «дубли отправок на info»: одно письмо на волну,
    // а не копия каждого письма (18 тысяч копий забили бы ящик).
    await smtpSendEmail({
      to: ADMIN_COPY,
      subject: `[ПРОМО] Волна по заведениям: сегмент ${segment}, отправлено ${res.sent}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:620px;">
        <h2 style="color:#7C3AED;margin:0 0 14px;">Волна рассылки по заведениям</h2>
        <table style="border-collapse:collapse;font-size:15px;">
          <tr><td style="padding:5px 12px 5px 0;color:#666;">Сегмент:</td><td><b>${escapeHtml(segment)}</b></td></tr>
          <tr><td style="padding:5px 12px 5px 0;color:#666;">Отправлено:</td><td><b>${res.sent}</b> из ${res.total}</td></tr>
          <tr><td style="padding:5px 12px 5px 0;color:#666;">Не ушло:</td><td>${res.failed} (${failRate}%)</td></tr>
          <tr><td style="padding:5px 12px 5px 0;color:#666;">Осталось:</td><td>${left.rows.map((r: any) => `${r.quality_segment}: ${r.n}`).join(', ') || 'ничего'}</td></tr>
        </table>
        ${failRate > 10 ? '<p style="margin:16px 0;padding:12px;background:#fee;border-left:3px solid #d00;color:#900;"><b>Высокая доля неудач.</b> Стоит приостановить рассылку и разобраться до следующей волны.</p>' : ''}
        ${res.errors.length ? `<p style="color:#888;font-size:12px;margin-top:14px;">Первые ошибки:<br>${res.errors.slice(0, 5).map(e => escapeHtml(e)).join('<br>')}</p>` : ''}
      </div>`,
    });

    console.log(`[venue-campaign] сегмент ${segment}: отправлено ${res.sent}/${res.total}, неудач ${res.failed}`);
    return c.json({ success: true, segment, sent: res.sent, failed: res.failed, total: res.total, left: left.rows });
  } catch (err: any) {
    console.error('[venue-campaign] ошибка волны:', err);
    return c.json({ success: false, error: String(err?.message || err) }, 500);
  }
});

// GET /status — сколько разослано и сколько осталось
app.get('/status', requireAdminOrKey, async (c) => {
  const r = await pool.query(
    `SELECT quality_segment,
            count(*)::int                                     AS всего,
            count(*) FILTER (WHERE last_sent_at IS NOT NULL)::int AS отправлено,
            count(*) FILTER (WHERE last_sent_at IS NULL)::int      AS осталось
       FROM venue_partner_contacts
      WHERE source = $1 AND active AND is_primary
      GROUP BY quality_segment ORDER BY quality_segment`,
    [CAMPAIGN_SOURCE],
  );
  return c.json({ success: true, segments: r.rows });
});

export default app;
