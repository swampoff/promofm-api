-- Migration 117: tracks.is_legacy — флаг мигрированных с promo.fm треков (уже оплачены)
--
-- 31.01.2026 в кабинеты пользователей загрузили данные о ~5628 треках с promo.fm
-- (status='approved', is_paid=false). На новой платформе кабинет показывал им
-- «Оплатить публикацию 7000₽» — но они УЖЕ оплачены на старой платформе → ложный
-- запрос оплаты («нарушена логика»). Помечаем их is_legacy; getTracksByUser отдаёт
-- им виртуальный status='legacy' (кабинет: «Архив · promo.fm», без запроса оплаты),
-- при этом РЕАЛЬНЫЙ moderation_status в БД не меняется → они НЕ попадают в новый
-- эфир/чарты (по просьбе: не публиковать легаси массово). Идемпотентно.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS is_legacy boolean NOT NULL DEFAULT false;
UPDATE tracks SET is_legacy = true
 WHERE created_at::date = '2026-01-31'
   AND moderation_status = 'approved'
   AND NOT COALESCE(is_paid, false)
   AND NOT is_legacy;
