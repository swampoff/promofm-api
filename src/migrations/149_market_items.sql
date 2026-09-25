-- 149: маркетплейс готовых битов, минусов и песен (25.09.2026).
--
-- Решение владельца: «Продавай свои песни, минуса и биты через маркетплейс
-- ПРОМО.МУЗЫКА». Продают все (артисты, продюсеры, DJ, лейблы, звукорежиссёры).
-- Биты и минусы — по лицензии (многим) и/или эксклюзивно (один раз, затем
-- снимается с продажи). Песня — только эксклюзивно. Комиссия платформы 10 %.
-- Деньги поступают на счёт платформы, продавцу начисляется цена минус 10 %,
-- вывод — заявкой (payment_withdrawals, source='market').
--
-- Старая витрина beats/digital_goods — тестовая (выдуманные продюсеры, без
-- файлов), снята с продажи 25.09.2026; эти таблицы не трогаем.

CREATE TABLE IF NOT EXISTS market_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        text NOT NULL,
  seller_name      text NOT NULL DEFAULT '',
  seller_role      text,
  kind             text NOT NULL CHECK (kind IN ('beat', 'minus', 'song')),
  title            text NOT NULL,
  genre            text,
  bpm              integer CHECK (bpm IS NULL OR (bpm BETWEEN 30 AND 300)),
  music_key        text,
  description      text NOT NULL DEFAULT '',
  cover_url        text,
  preview_url      text,                 -- публичное превью (mp3)
  file_path        text,                 -- закрытый полный файл: имя в uploads/market-private
  file_name        text,                 -- исходное имя файла для скачивания
  file_size        bigint,
  price_lease      numeric CHECK (price_lease IS NULL OR price_lease > 0),
  price_exclusive  numeric CHECK (price_exclusive IS NULL OR price_exclusive > 0),
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'active', 'sold', 'hidden', 'removed')),
  rights_confirmed_at timestamptz,       -- продавец подтвердил, что он правообладатель
  plays            integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- песня продаётся только эксклюзивно
  CONSTRAINT market_items_song_exclusive_only CHECK (kind <> 'song' OR price_lease IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_market_items_catalog ON market_items (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_items_seller ON market_items (seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_purchases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES market_items(id),
  buyer_id    text NOT NULL,
  seller_id   text NOT NULL,
  license     text NOT NULL CHECK (license IN ('lease', 'exclusive')),
  amount      numeric NOT NULL CHECK (amount > 0),
  commission  numeric NOT NULL,
  payout      numeric NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'canceled', 'refunded')),
  order_id    text,
  item_title  text NOT NULL DEFAULT '',
  item_kind   text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_market_purchases_buyer ON market_purchases (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_purchases_seller ON market_purchases (seller_id, status);
CREATE INDEX IF NOT EXISTS idx_market_purchases_item ON market_purchases (item_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_purchases_order ON market_purchases (order_id) WHERE order_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON market_items, market_purchases TO promofm_app;
