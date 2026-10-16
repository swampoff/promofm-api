/**
 * DJ_PLANS — shared source of truth для тарифов DJ-кабинета.
 *
 * Используется в двух местах:
 *   1) src/dj-studio-routes.tsx — GET /plans + price/limits для квот
 *   2) src/checkout-routes.tsx (webhook subscription) — активация
 *      платной подписки и запись квот в djSubscriptionsStore
 *
 * До этого PR (2026-06-10): в checkout-routes.tsx жил локальный
 * DJ_PLANS_LOCAL дубликат (price + limits) с явным комментарием
 * «source-of-truth lives in dj-studio-routes». Цифры были синхронны,
 * но drift-риск реален: если поменять цену в одном файле и забыть
 * во втором, DJ заплатит 990 ₽ за Pro и получит квоты Starter
 * (5 миксов вместо 20). 2026-05-25 уже был incident именно по
 * webhook'у — checkout не имел DJ-ветки, DJ платил 990 ₽ но
 * subscription не активировалась (commit b1ee0c5).
 *
 * Контракт shared-файла:
 * - Содержит ТОЛЬКО money + limits — только то, что нужно webhook'у.
 *   Маркетинг (description / features / popular / color) остаётся
 *   в dj-studio-routes.tsx DJ_PLANS, чтобы редактировать копирайт
 *   без правки checkout.
 * - tsx import без расширения работает в обоих режимах (dev tsx watch
 *   + production tsc → dist/js). Никаких side-эффектов в этом модуле.
 */

export interface DjPlanLimits {
  /** Сколько промо-миксов разрешено создать в активной подписке.
   *  -1 = unlimited. enforced на POST /mixes в dj-studio-routes.tsx. */
  mixes: number;
  /** Сколько events/букингов в месяц. -1 = unlimited.
   *  enforced на POST /events в dj-studio-routes.tsx. */
  events: number;
  /** Уровень аналитики: 'basic' / 'advanced' / 'full' — задаёт
   *  truncation окна в GET /finances/transactions. */
  analytics: 'basic' | 'advanced' | 'full';
}

export interface DjPlanCore {
  id: 'starter' | 'pro' | 'agency';
  name: string;
  /** Месячная цена в рублях. 0 для бесплатного плана. */
  price: number;
  /** Годовая цена в рублях. 0 для бесплатного. */
  priceYear: number;
  limits: DjPlanLimits;
}

export const DJ_PLANS_CORE: Record<DjPlanCore['id'], DjPlanCore> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 0,
    priceYear: 0,
    limits: { mixes: 5, events: 5, analytics: 'basic' },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 990,
    priceYear: 9900,
    limits: { mixes: 20, events: 50, analytics: 'advanced' },
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    price: 2990,
    priceYear: 29900,
    limits: { mixes: -1, events: -1, analytics: 'full' },
  },
};

export type DjPlanId = DjPlanCore['id'];
