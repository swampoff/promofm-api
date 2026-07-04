# Хэндофф: cloud-Claude → laptop-Claude (2026-07-03)

Общее письмо по накопленному за сессию. Ветка — та же
**`claude/add-external-clips-HK56I`** в обоих репо (`promofm-api` +
`Promomusicfigma`). У меня нет ssh к VPS: DDL, миграции, мерж в main,
рестарт и **любой runtime-тест денег** — за тобой.

Три темы этой сессии: **(1) escrow коллабораций**, **(2) слияние
engineer-маркетплейса**, **(3) схлопывание видео-модерации**. Ниже — что
задеплоить, в каком порядке, и что проверить руками (деньги).

Предыдущее письмо `HANDOFF_TO_LAPTOP_2026-06-30.md` (email/radio-рассылки,
аудит) — **всё ещё в силе**, его чеклист миграций 113→116 не отменялся.
Начни с него, если ещё не деплоил; это письмо — сверху.

---

## 1. Escrow коллабораций — закрыть дыру «продюсер не получает денег» ⚠️ ДЕНЬГИ

**Проблема (подтверждена Никитой):** бэкенд escrow-контур собран и **уже на
main** (checkout `collab_accept` → `escrow_pending` → webhook `escrow_held`
→ `/complete` release; auto-complete cron; admin-arbitrage). Но фронт
никогда не роутил приём платного оффера через оплату, а `/respond` не
проверял цену. Итог на проде: платный оффер принимается бесплатно,
завершается бесплатно, **продюсер не получает выплату**. Весь escrow —
мёртвый код.

**Что в ветке (2 коммита, оба этой сессии):**

| Repo | Commit | Что |
|---|---|---|
| promofm-api | `6da0742` | **source-of-truth money-guard**: `PUT /collaboration/offers/:id/respond` c `status=accepted` на оффере `price>0` → **402 payment_required**, статус не меняется. decline/discussion и бесплатные офферы — как раньше. |
| Promomusicfigma | `cddfdb8` | FE: артист жмёт «Принять» на `price>0` → `redirectToPayment(collab_accept)`; escrow-бейджи («Ожидает оплаты»/«В escrow»/«Выплачено»/«Возврат») у артиста и продюсера; `paymentStatus` в типе `CollabOffer`; хинт «после подтверждения N ₽ уйдут продюсеру». |

**СХЕМА НЕ ТРОГАЕТСЯ.** Миграций нет. `6da0742` — только доп. проверка
`Number(price)>0` в существующем хендлере. FE — автодеплой.

**Порядок деплоя (важно из-за гейта):**
- Деплой **FE первым или одновременно** с BE. FE-first безопасен: платный
  приём уходит в checkout ещё до гейта. **BE-first в одиночку** сделает
  платный оффер непринимаемым в UI (кнопка «Принять» → 402), пока FE не
  уедет. Не стейджь BE раньше FE.

**⚠️ Дубликат — смержить ОДНУ версию:** у тебя есть ветка
`feat/collab-frontend-accept-via-checkout` (`ef4c477`) — тот же accept→checkout.
Мой `cddfdb8` — **суперсет** (тот же флоу + `returnUrl`/metadata как у тебя +
видимость статуса + хинты + тип). Мержи `cddfdb8`, ветку `feat/…` дропни,
иначе конфликт по `handleRespond`.

**Кроны (если ещё не стоят — auto-complete escrow по дедлайну):**
```cron
0 4 * * * curl -s -X POST -H "X-Internal-Key: $VPS_INTERNAL_KEY" \
  http://127.0.0.1:3000/server/api/collaboration/offers/auto-complete \
  >> /var/log/promofm-collab-autocomplete.log 2>&1
```

**Критерий «что должно стать правдой» (прогони на проде/стейдже, YooKassa-цикл):**
1. Платный оффер (`price>0`) → артист «Принять» → редирект ЮКасса → оплата
   → webhook → `collab_offers.payment_status='escrow_held'`, `status='accepted'`,
   оффер показывает «В escrow».
2. Артист «Подтвердить завершение» → `payment_balances.available` продюсера
   `+= price` (0% комиссия), `payment_status='released'`, `status='completed'`.
3. Прямой API: `PUT /collaboration/offers/<paid>/respond {"status":"accepted"}`
   → **402**, `status` не меняется.
4. Бесплатный оффер (`price` пусто/0) → «Принять» → сразу `accepted`, без оплаты.

---

## 2. Слияние engineer-маркетплейса в producer-маркетплейс ⚠️ ДЕНЬГИ

Решение владельца (закрыто 2026-07-02): engineer продаёт на общем
маркетплейсе как producer, комиссия **10%** (единая). Детали и маппинг
статусов — `docs/MARKETPLACE_MERGE_PLAN.md`.

**Что в ветке (cloud, готово):**
- `src/migrations/120_merge_engineer_services_into_marketplace.sql` — backfill
  услуг `engineer_services → producer_services` (id `eng-svc-<uuid>`, аддитивно,
  `ON CONFLICT DO NOTHING`, старая таблица цела).
- `src/migrations/121_merge_engineer_orders_into_marketplace.sql` — backfill
  заказов `engineer_orders → service_orders` (id `eng-ord-<uuid>`, commission
  10% / payout 90% как учётная запись, `delivered→in_progress`, оригиналы в
  `extra`). **Реальный ledger `platform_revenue channel='engineer_order'` НЕ
  трогается** — это только копия для единой витрины/истории.
- `marketplace-routes.tsx` `POST /services/:id/order` — плоские 10% для всех
  продавцов.

**Порядок деплоя:** миграции строго **120 → 121**, dry-run сначала:
```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
\i /opt/promofm-api/src/migrations/120_merge_engineer_services_into_marketplace.sql
\i /opt/promofm-api/src/migrations/121_merge_engineer_orders_into_marketplace.sql
ROLLBACK;   -- поменяй на COMMIT после проверки row-count'ов
SQL
```
Pre-flight-колонки — в шапках обоих файлов (сверены по коду, но прогони `\d`).

**Осталось за тобой (write-side, нельзя из облака — прод + деньги):**
- Engineer-кабинет FE: создание/список/действия услуг и заказов → маркетплейс-
  эндпоинты (`producer_services`/`service_orders`) вместо `/engineer/services|orders`.
- Роль-гейты FE `role === 'producer'` → `['producer','engineer'].includes(role)`.
- Runtime-цикл на проде: инженер создаёт услугу → в общем каталоге → клиент
  заказывает → инженер видит заказ → проводит по статусам → выплата в ledger.
- **Phase-3 (отдельный PR, после верификации):** `DROP TABLE engineer_services,
  engineer_orders` + удалить `/engineer/services|orders` эндпоинты.

---

## 3. Схлопывание видео-модерации (FE, отдельная ветка) — ⛔ ОТМЕНЕНО ВЛАДЕЛЬЦЕМ

> **2026-07-03, решение Никиты: отдельный видео-тракт КАНОНИЧЕН и должен
> работать.** Оценка «нерабочая демка» устарела: на ветке
> `claude/promomusicfigma-architecture-ms7sbs` тракт реализован полностью
> (upload → таблица `videos`, реальная модерация `/api/videos/admin/*`,
> платный промо-pipeline 10 000/15 000 ₽ с ЮКасса-вебхуками, «Новые клипы»
> на главной, миграции 122–124). Редирект `/artist/video → /artist/publish`
> и убранный таб «Видео» **откачены** на той же ветке — при её мерже прод
> вернётся к рабочему разделу. НЕ применяй действия этого параграфа;
> ветку `claude/video-moderation-pipeline` дропни.

Видео больше не отдельная тема модерации — оно уже идёт через publish/releases
флоу (работает для артиста И лейбла). Я убрал дублирующую ветку.

- Ветка **`claude/video-moderation-pipeline`** (Promomusicfigma):
  `src/app/routes.ts` — `/artist/video` → `redirect('/artist/publish')`;
  `src/admin/pages/Moderation.tsx` — убран таб «Видео» (модерация видео живёт
  в `PublishModeration`).
- Бэкенд-часть видео-пайплайна я **откатил** (не нужна) — на main ничего
  лишнего не уехало.
- Действие: смержи FE-ветку в main (только эти два файла), проверь что
  `/artist/video` редиректит и в админ-модерации нет пустого таба «Видео».

---

## 4. Сводный порядок (если деплоишь всё разом)

1. **promofm-api** сначала (фронт зависит):
   - Прошлое письмо: миграции 113→116 (если ещё не), ENV `RESEND_API_KEY`, кроны.
   - Это письмо: миграции **120→121** (marketplace, dry-run→commit).
   - Мерж ветки в main → `systemctl restart promofm-api`.
   - Кроны: collab auto-complete (§1), radio-weekly + email-campaigns (прошлое письмо).
2. **Promomusicfigma** (автодеплой):
   - Мерж `claude/add-external-clips-HK56I` (collab escrow FE `cddfdb8`).
   - Мерж `claude/video-moderation-pipeline` (видео-редирект).
   - Дропни `feat/collab-frontend-accept-via-checkout` (суперсед, см. §1).
3. **Runtime-тесты денег** (§1 критерий + §2 цикл) — на тебе, у меня нет прода.

---

## 5. Остаток на pre-flight (из прошлого письма, ещё открыто)
- `\d booking_payments` — есть ли UNIQUE на `(booking_id, payment_type)`?
  (LOW: дубль-леджер при retry).
- `\d email_campaigns` — нативные колонки (для истории).

Пиши сюда же или в `OPERATIONS_LOG.md`. — cloud

---

## Аддендум (cloud, вторая сессия, 2026-07-03) — ЗАКРЫТО

Параллельно с этим письмом существовал мой runbook «добей отбитые»
(219 deferred артист-рассылки) под тем же именем файла — merge-конфликт
разрешён в пользу этого письма, потому что задача УЖЕ исполнена:
OPERATIONS_LOG (append-строки внизу) — «artist relaunch email blast:
873 sent / 0 failed; 138 hard-bounce suppressed (stop-list 326);
Deferred settled: 0 new bounces». Стоп-лист остался 326.

Также: мои миграции на ветке `claude/promomusicfigma-architecture-ms7sbs`
ПЕРЕНУМЕРОВАНЫ 120–124 → **122–126** (номера 120/121 заняли твои
marketplace-миграции, уже применённые на проде). Актуальный список моей
ветки: 127_videos_pipeline, 128_videos_moderation,
129_videos_category_tags, 130_news_image_url, 131_news_moderation.
