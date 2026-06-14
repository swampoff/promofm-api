/**
 * Hono ContextVariableMap module augmentation
 *
 * Назначение: типизировать те переменные которые мы кладём в Hono
 * context через c.set(...) и достаём через c.get(...). Без этого
 * объявления каждый c.get('userId') / c.set('rlsUserRole', ...)
 * выкидывает TS2769 'No overload matches this call. Argument of type
 * "userId" is not assignable to parameter of type "never"'.
 *
 * Эти ключи реально пишутся в:
 *  - auth-middleware.tsx:47-49,82-84 — userId / userEmail / userRole
 *    (после JWT-валидации)
 *  - rls-middleware.tsx — rlsUserId / rlsUserRole (для RLS bypass)
 *  - body-parser-middleware — parsedBody (закэшированный JSON body)
 *
 * Добавлено 2026-06-14 в рамках TS-marathon: 258 TS2769 ошибок
 * (44% всех баз ошибок) закрываются этим одним объявлением.
 */

import 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    // Auth context — заполняется requireAuth/optionalAuth middleware
    userId: string;
    userEmail: string;
    userRole: string;

    // RLS context — заполняется rls-middleware для PG row-level security
    rlsUserId: string;
    rlsUserRole: string;

    // Body cache — заполняется body-parser middleware (избегаем
    // повторного парсинга stream'а если несколько handlers читают body)
    parsedBody: unknown;
  }
}
