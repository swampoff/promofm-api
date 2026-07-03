-- Migration 122: значение 'blocked' в enum user_status
--
-- Админ-кабинет «Пользователи» имеет кнопку блокировки, но:
--   (а) эндпоинта /admin/users/:id/status не существовало (FE бил в 404
--       с фейковым success-тостом),
--   (б) в enum user_status не было значения 'blocked' — логин отбивает
--       только 'pending'/'rejected'.
-- Этот файл — часть (б). Эндпоинт + login-гейт — в том же PR
-- (auth-routes.tsx POST /admin/users/:id/status).
--
-- ALTER TYPE ... ADD VALUE разрешён внутри транзакции с PG12 при условии,
-- что новое значение не ИСПОЛЬЗУЕТСЯ в той же транзакции — здесь только ADD,
-- поэтому стандартный BEGIN; \i file; COMMIT; паттерн работает.
--
-- Apply:
--   BEGIN; \i .../122_user_status_blocked.sql; COMMIT;

ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'blocked';
