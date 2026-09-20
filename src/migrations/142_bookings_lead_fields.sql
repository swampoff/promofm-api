-- Поля лидовой заявки на букинг.
--
-- Заявку оставляет постороннее физлицо через публичную форму, поэтому:
--   client_phone — основной канал связи по таким заказам (свадьбы,
--     корпоративы). Раньше телефон складывали в special_requests
--     строкой «Телефон: …» — искать и сортировать по нему невозможно;
--   consent_at + client_ip — 152-ФЗ: согласие на обработку персональных
--     данных должно фиксироваться с меткой времени и доказательством;
--   admin_status — воронка владельца, ОТДЕЛЬНО от status. status
--     принадлежит исполнителю (accept/reject), и если смешать, админ,
--     двигая лид, будет затирать входящие исполнителя.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_phone text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS consent_at   timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_ip    text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS admin_status text NOT NULL DEFAULT 'new';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS admin_note   text;

-- Очередь владельца: всё, что ещё в работе.
CREATE INDEX IF NOT EXISTS idx_bookings_admin_status
  ON bookings (created_at DESC)
  WHERE admin_status NOT IN ('deal', 'lost', 'spam');

COMMENT ON COLUMN bookings.admin_status IS
  'Воронка владельца: new → contacted → qualified → deal | lost | spam. Не путать со status — тот принадлежит исполнителю.';
COMMENT ON COLUMN bookings.consent_at IS
  'Согласие на обработку персональных данных (152-ФЗ), проставляется при приёме публичной заявки.';
