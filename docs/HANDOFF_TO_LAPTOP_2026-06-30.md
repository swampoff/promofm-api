# Хэндофф: cloud-Claude → laptop-Claude (2026-06-30)

Привет! Это cloud-сессия. За эту сессию я собрал бэкенд системы рассылок и
закрыл серию багов. Всё в ветке **`claude/add-external-clips-HK56I`** (repo
`promofm-api`). Ты уже разослал 876/876 (SPF/DKIM/throttling — 🔥, спасибо).
Ниже что задеплоить и как нам свести единую базу. У меня нет ssh к VPS — DDL и
прод за тобой.

---

## 1. Деплой-чеклист (по порядку)

**Миграции — применить ДО рестарта, строго 113 → 114 → 115:**
```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
\i /opt/promofm-api/src/migrations/113_radio_weekly_digest.sql           -- колонка + radio_partner_contacts
\i /opt/promofm-api/src/migrations/114_radio_partner_contacts_seed.sql   -- 1195 адресов (ON CONFLICT — идемпотентно)
\i /opt/promofm-api/src/migrations/115_radio_partner_contacts_send_tracking.sql -- last_sent_at, send_count
COMMIT;
SQL
```

**ENV:** `RESEND_API_KEY` в `/opt/promofm-api/.env` (тот же, что у email-helper).
Без него bulk-рассылки уйдут только если жив Postfix.

**Рестарт:** `systemctl restart promofm-api`

**Кроны (НЕ в репо, ставим вручную):**
```cron
CRON_TZ=Europe/Moscow
0 12 * * 1  /opt/promofm-api/radio-weekly-cron.sh        >> /var/log/promofm-radio-weekly.log 2>&1   # понедельник 12:00 МСК — дайджест новинок
*/5 * * * * /opt/promofm-api/email-campaigns-cron.sh     >> /var/log/promofm-email-campaigns.log 2>&1 # отложенные admin-кампании
```

---

## 2. Единая база рассылки — сводим твои результаты в `radio_partner_contacts`

Таблица — ЕДИНСТВЕННЫЙ источник истины (детали: `docs/RADIO_MAILING_SYSTEM.md`):
- `active AND unsubscribed_at IS NULL` → можно слать
- `last_sent_at IS NULL` → ещё ни разу не слали (это и есть «остаток»)
- weekly-крон сам штампует `last_sent_at` после отправки

**Сведи свои 876/188 в таблицу (у тебя есть список):**
```sql
-- отправленные 876 → пометить
UPDATE radio_partner_contacts
   SET last_sent_at = COALESCE(last_sent_at, NOW()), send_count = send_count + 1
 WHERE LOWER(email) = ANY(ARRAY[ /* ...876... */ ]::text[]);

-- мёртвые 188 → погасить
UPDATE radio_partner_contacts
   SET active = false
 WHERE LOWER(email) = ANY(ARRAY[ /* ...188... */ ]::text[]);
```

**Остаток (кому ещё не слали) — гонишь сам по SQL (как договорились):**
```sql
SELECT station_name, email FROM radio_partner_contacts
 WHERE active AND unsubscribed_at IS NULL AND last_sent_at IS NULL;
```
После каждой порции — `UPDATE ... SET last_sent_at=NOW(), send_count=send_count+1`.

### ❓ Вопрос для сверки (ответь в репо или Никите)
Моя миграция 114 засеяла **1195** уникальных адресов, ты разослал по **876**.
**Твои 876 — это из `radio_partner_contacts` (114 применял) или отдельный список?**
- Если из таблицы → после UPDATE выше «остаток» = 1195 − 876 − мёртвые, его и догоняем.
- Если отдельный список → сначала применить 114 (дедуп по `LOWER(email)` сам уберёт
  пересечения), потом те же UPDATE, потом запрос остатка.

---

## 3. Что ещё в ветке (баг-фиксы — учти при мерже в main)

| Commit | Что |
|---|---|
| `f64ff47` | bulk-сендер → Resend-fallback (рассылки не падают при дохлом Postfix) |
| `1de2b37` | **CRIT** campaign list/send больше не 404 (artist_id-фильтр по пустой колонке) |
| `f73250a` | **SECURITY** IDOR в чате заказов (чтение/запись чужой переписки + спуф роли) |
| `55c3fb9` | fail-closed internal-key guards + анонимность донатов + единый стор отписок |
| `5be0728` | сид 1195 контактов (mig 114) + анти-дабл-сенд + token-type guard |
| `16b8031` | планировщик scheduled-рассылок (#3) + рекуррент продлевается только при succeeded (#4) |
| `1a8bae3` | send-tracking (mig 115) + `RADIO_MAILING_SYSTEM.md` |

Осталось из bug-sweep: **#10** (`booking_payments` `ON CONFLICT` без target — дубль-
леджер при retry). LOW. Нужен твой `\d booking_payments` чтобы подтвердить
наличие/отсутствие уникального констрейнта на `(booking_id, payment_type)` или
`orderId`. Дай вывод — добью.

---

## 4. Pre-flight (колонки, на которые опирается новый код — прогони `\d` + BEGIN/ROLLBACK)

- `tracks`: `radio_weekly_digest_sent_at` (mig 113), + `id, title, artist_name, genre, audio_url, cover_url, moderation_status, user_id, created_at`
- `radio_partner_contacts` (mig 113/114/115): `station_name, email, region, city, source, active, unsubscribed_at, last_sent_at, send_count`
- `users`: `email, full_name, role` (weekly-получатели)
- `email_unsubscribes`: `email` (глобальный opt-out)
- `email_campaigns`: проверь `\d` — мой фикс `1de2b37` снял зависимость от
  нативной `artist_id`, но интересно подтвердить, есть ли она вообще.

Пиши сюда же (новый md или в OPERATIONS_LOG) — синхронизируемся. — cloud
