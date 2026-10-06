-- 158: «Хит-парад ПРОМО» — правая колонка главной (владелец 2026-10-06).
--
-- В хит-параде только треки наших артистов (опубликованные и оплаченные).
-- Закреплённые владельцем места хранятся здесь и идут первыми по position;
-- остальные места — по активности (прослушивания на сайте за 30 дней +
-- подтверждённые радиоотчёты, без auto-декора). Менять закрепления — SQL:
--   INSERT INTO hit_parade_pins (track_id, position) VALUES (…, 1)
--   ON CONFLICT (track_id) DO UPDATE SET position = EXCLUDED.position;
CREATE TABLE IF NOT EXISTS hit_parade_pins (
  track_id   uuid PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  position   int  NOT NULL CHECK (position >= 1),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON hit_parade_pins TO promofm_app;

-- Первое место — Подиум «Прости я улетаю 2026» (решение владельца 2026-10-06).
INSERT INTO hit_parade_pins (track_id, position, note)
VALUES ('ce5cf1cf-304a-45c7-a4d1-94823d2dd65c', 1, 'Подиум — Прости я улетаю, #1 по решению владельца 2026-10-06')
ON CONFLICT (track_id) DO UPDATE SET position = EXCLUDED.position, note = EXCLUDED.note;
