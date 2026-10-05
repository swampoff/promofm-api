-- 157: audit_logs — колонки, в которые давно пишет код, но которых не было.
--
-- logUserAction / logAdminAction (29 мест: модерация треков и видео,
-- верификация, удаления, профили), смена роли, удаление аккаунта и экспорт
-- данных писали actor_id / target_id / details и падали с «column … does
-- not exist» (ошибка только в console). Журнал действий админов и
-- пользователей не вёлся, а лимит «один экспорт данных в сутки» не
-- срабатывал — его проверка ищет записи, которые не вставлялись.
-- Найдено 2026-10-02 (115 ошибок за 3 дня). Применено на проде 2026-10-05.
--
-- text, а не uuid: actor/target бывают не-UUID (внутренние вызовы, slug).
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_id  text,
  ADD COLUMN IF NOT EXISTS target_id text,
  ADD COLUMN IF NOT EXISTS details   jsonb;

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id);
