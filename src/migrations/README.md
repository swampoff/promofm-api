# SQL Migrations — ВНИМАНИЕ: не применяются автоматически

`src/migration-runner.tsx` сейчас является stub'ом (`Migrations skipped: schema bootstraps inline`). Файлы в этой директории **не запускаются** при старте `promofm-api.service`. Применяй их руками.

## Как применять

Под `postgres` superuser (он владеет таблицами):

```bash
# Применить одну миграцию
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f /opt/promofm-api/src/migrations/<file>.sql

# Применить серию (каждая в своей транзакции; одна fail не аборт всех)
for f in /opt/promofm-api/src/migrations/004_native_columns_step2_v2.sql \
         /opt/promofm-api/src/migrations/004_step2_concerts.sql \
         /opt/promofm-api/src/migrations/005_native_step3.sql \
         /opt/promofm-api/src/migrations/006_native_step4.sql \
         /opt/promofm-api/src/migrations/007_kv_final.sql; do
  echo "=== $f ==="
  sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f "$f"
done
```

## Что уже применено на проде (2026-05-22)

Идемпотентные миграции (`ADD COLUMN IF NOT EXISTS`, `CREATE TRIGGER` через `DROP IF EXISTS` + `CREATE`) — повторное применение безопасно.

| Файл | Назначение |
|---|---|
| `003_native_columns_step1.sql` | publish_orders, subscriptions |
| `004_native_columns_step2_v2.sql` | news_public, verification_tokens |
| `004_step2_concerts.sql` | concert_agent_data (отдельно — там price парсится regex'ом) |
| `005_native_step3.sql` | agent_sessions, curator_reports, track_moderation, payment_withdrawals, production_360_orders |
| `006_native_step4.sql` | contracts, email_history, notification_campaigns, track_test_all_requests, investor_inquiries |
| `007_kv_final.sql` | booking_calendar, publish_email_prefs, track_test_expert_stats, payment_webhook_logs |
| `008_cabinet_email_status_phone.sql` | KV-phase-out Phase 1: добавляет `email`/`is_email_verified`/`account_status`/`phone` во все 6 cabinet-таблиц + бэкфилл из `users`. Подготовка к снятию `vps-userdata.tsx`. |

См. подробности в memory: `kv-to-sql-migration.md`.

## Гарантии после применения

- Все `data` jsonb остаются единственным источником истины при записи (через `jsonbStore` wrapper в `db.tsx`)
- `BEFORE INSERT/UPDATE` триггер `trg_sync_<table>_native` парсит `data` → native columns
- SELECT-запросы могут использовать индексы по native columns (admin-модерация, сортировки, фильтры)
- Старый код, читающий из `data jsonb`, продолжает работать без изменений

## TODO — реальный migration-runner

Сейчас `src/migration-runner.tsx` — заглушка. Когда-нибудь её надо заменить на:
1. Сканирование `src/migrations/*.sql` в алфавитном порядке
2. Применение каждой в транзакции
3. Запись `(filename, applied_at)` в служебную таблицу `_applied_migrations`
4. Skip уже применённых

Тогда этот документ можно будет удалить.
