# План: полное слияние engineer-маркетплейса в producer-маркетплейс

Решение владельца: engineer продаёт на общем маркетплейсе как producer —
одна система (`producer_services` / `service_orders`), один каталог, один
флоу заказа/оплаты. Ниже — точный план. **Cloud не может ssh/тестировать
прод — деньги/заказы и runtime за laptop'ом + sign-off владельца.**

## Почему это атомарная единица (нельзя дробить)
Backfill только услуг создаёт разрыв: заказ на мигрированную engineer-услугу
(`eng-svc-<id>` уже в `producer_services`) уйдёт через
`POST /marketplace/services/:id/order` в `service_orders`, а кабинет инженера
читает `engineer_orders` → инженер заказ не увидит. Поэтому услуги + заказы +
write-side кабинета применяются вместе.

## Схемы (сверены по коду)
| engineer_services | → producer_services |
|---|---|
| id uuid | id text = `eng-svc-<uuid>` |
| user_id text | producer_id |
| — (users.full_name) | producer_name |
| title, service_type, description, base_price, delivery_days | 1:1 |
| is_active bool | status: true→'active', false→'inactive' |
| — | orders_count=0, rating=0, extra={sellerType:engineer,srcId} |

| engineer_orders | → service_orders |
|---|---|
| id uuid | id text = `eng-ord-<uuid>` |
| service_id uuid | service_id = `eng-svc-<uuid>` |
| engineer_id text | producer_id |
| client_id text | client_id |
| title | service_title |
| service_type, price | 1:1 |
| brief | message / details |
| **status** ⚠️ | см. маппинг ниже |
| delivery_url, delivery_note, payment_order_id, paid_at | → extra jsonb (не терять) |
| — | commission, producer_payout ⚠️ (см. sign-off) |

### ⚠️ Статус-словари РАЗНЫЕ — нужен маппинг
- engineer: `pending → accepted → in_progress → delivered → completed`; `declined`, `cancelled`
- producer: `pending → accepted → in_progress → revision → completed → reviewed`; `rejected`
- Предлагаемый маппинг: delivered→`in_progress` (доставлено, ждёт подтверждения
  клиента; у producer нет 'delivered'), declined→`rejected`, cancelled→`rejected`,
  остальные 1:1. **Подтвердить у владельца** — от статуса зависят доступные
  переходы и когда пишется commission.

### ⚠️ Деньги — sign-off владельца
- Выплаты инженеров уже идут отдельным каналом `platform_revenue
  channel='engineer_order'`. Backfill строк `engineer_orders → service_orders`
  их НЕ трогает (ledger отдельный). Но `service_orders.commission` /
  `producer_payout` для мигрированных строк надо задать. **Вопрос владельцу:**
  комиссия платформы для инженерных заказов = такая же, как у продюсеров?
  Если да — пересчитать по той же формуле; если нет — ставить 0/`price` и
  пометить legacy. До ответа — не пересчитывать деньги, класть price в
  producer_payout, commission=0, оригиналы в extra.

## Порядок деплоя (laptop, одним окном, с dry-run)
1. **Услуги** — миграция `120_merge_engineer_services_into_marketplace.sql`
   (уже в репо, безопасна, аддитивна, ON CONFLICT DO NOTHING).
2. **Заказы** — написать миграцию `121_merge_engineer_orders.sql` по маппингу
   выше ПОСЛЕ ответа владельца по статусам/комиссии. Аддитивно, `eng-ord-`
   префикс, ON CONFLICT DO NOTHING, оригиналы в extra.
3. **Write-side (код, оба репо):**
   - Engineer-кабинет FE: создание/редактирование услуги → маркетплейс-эндпоинты
     (producer_services), а не `POST /engineer/services`. Список заказов →
     читать `service_orders` (producer_id = engineer user id), а не
     `engineer_orders`. Действия (accept/deliver/complete) → маркетплейс
     transitions (`PUT /marketplace/orders/:id/status`).
   - Бэкенд: `POST /marketplace/services` create-эндпоинт (если его нет — сейчас
     продюсер создаёт услугу через producer-studio; проверить и дать инженеру
     тот же путь). `POST /beats`, `/digital-goods` уже открыты (requireAuth) —
     инженеру доступны, нужен лишь UI-вход в кабинете.
   - Роль-гейты FE: где `role === 'producer'` контролирует продажу — заменить на
     `['producer','engineer'].includes(role)`.
4. **Проверка (runtime):** инженер создаёт услугу → видна в общем каталоге →
   клиент заказывает → инженер видит заказ в кабинете → проводит по статусам →
   выплата в ledger корректна.
5. **Phase 3 (после верификации, отдельным PR):** `DROP TABLE engineer_services,
   engineer_orders` + удалить `/engineer/services`,`/orders` эндпоинты. Только
   когда write-side подтверждён на проде.

## Что уже сделано в cloud
- Анализ + сверка схем (этот файл).
- Миграция 120 (услуги) — безопасный первый шаг, но **применять только в
  связке** с шагами 2–3 (иначе разрыв видимости заказов, см. выше).

## Решения владельца (2026-07-02) — ЗАКРЫТЫ
1. **Комиссия инженерных заказов = 10%** — единая с продюсерами (одна ставка,
   финальное решение). Реализовано:
   - Новые заказы: `POST /marketplace/services/:id/order` — плоские 10% для
     всех продавцов (per-seller ветку убрали за ненадобностью).
   - Backfill исторических (migration 121): commission=price·0.10,
     payout=price·0.90; реальный ledger platform_revenue не трогается.
2. **Статус `delivered` → `in_progress`** (migration 121, оригинал в
   `extra.origStatus`).

## Остаток — write-side кабинета

### ✅ Сделано (cloud, 2026-07-03, ветка `claude/promomusicfigma-architecture-ms7sbs`)
- **Engineer-кабинет FE переведён на маркетплейс** — переписан API-слой
  `utils/api/engineer-studio.ts` (UI-компоненты почти не тронуты):
  - услуги: CRUD → producer-studio `/services/create|update|delete|custom`
    (role-agnostic, owner = JWT userId; sync в общий каталог — автоматом);
  - публичная витрина: общий каталог `GET /marketplace/services?producerId=…`
    (мигрированные `eng-svc-*` и новые `svc-*` приходят одинаково);
  - заказы: `GET /marketplace/orders?role=producer|client` + переходы
    `PUT /orders/:id/status`. Маппинг статусов для UI: rejected→declined,
    revision→in_progress; `delivered` не существует.
  - **Флоу-изменения** (следствие «одной системы»): accept инженера =
    accepted + сразу in_progress (оплатного ЮКасса-гейта в marketplace-флоу
    нет); сдача работы = completed (клиентского «Подтвердить приём» нет,
    ссылка/заметка — в statusMessage); для зависших accepted (мигрированные
    строки) в кабинете кнопка «Взять в работу».
- **BE**: клиент может отозвать pending-заявку (`pending → rejected`,
  role both) — аналог старого cancel, денег на pending нет.
- **Роль-гейты FE**: проверены — sell-гейтов `role === 'producer'` не
  нашлось (producer-studio/marketplace эндпоинты role-agnostic;
  `ServiceOrdersPanel.role` — сторона сделки, не платформенная роль;
  навигация Suno* уже включает engineer). Менять оказалось нечего.
- **Известный gap**: сводка `/engineer/earnings` считает только legacy-канал
  `platform_revenue channel='engineer_order'`; новые marketplace-заказы
  пишут commission каналом `'service'` — единый earnings-виджет отдельной
  задачей.

### Осталось (laptop / после верификации)
- Runtime-цикл на проде: инженер создаёт услугу → в общем каталоге →
  клиент заказывает → инженер принимает (auto in_progress) → сдаёт
  (completed) → commission 10% в ledger.
- Phase-3 (отдельный PR, ТОЛЬКО после верификации): drop
  engineer_services/engineer_orders + удалить `/engineer/services|orders`
  эндпоинты (профиль/портфолио/earnings в engineer-routes остаются).
