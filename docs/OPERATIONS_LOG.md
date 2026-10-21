# Operations Log — promofm-api

Append-only chronicle of **manual interventions on production data**
that aren't visible in git history: direct SQL on the prod DB,
admin-panel edits, account-specific fixes, config tweaks, manual
service kicks. Plus narrative notes on "weird state" we encountered
and what we did about it.

**Why this file exists:** Claude sessions start with zero memory of
prior sessions. If you ran `UPDATE ...` in psql yesterday or
clicked something in `/ctrl-pm7k2f` that changed prod data, the
next Claude session won't know unless it lives here. Code comments
catch *some* of this (see `track-moderation-routes.tsx:324` "Nadezhda
incident") but free-form ops should land here too.

## Format

Newest entries at the top. Use this template:

```md
## YYYY-MM-DD — <one-line summary>
- **What:** human description of the change
- **Affected:** user IDs / table rows / entities involved
- **Why:** what problem prompted this
- **How:** the actual SQL / command / UI action(s)
- **Verified:** how we know it worked
- **Follow-ups (if any):** related code that should track this,
  or audit-tasks for future sessions
```

For multi-step interventions, list each step under **How**. Keep
SQL snippets exact — future Claude will read them as the canonical
record of what got executed.

---

## 2026-10-20 – PROMO.AIR: бэкапы, чистка venue_profiles, миграции 160/161/162 (laptop, перед выкаткой feat/promoair-domain)

- **What:** подготовка базы к выкатке PROMO.AIR (promoair.ru) по `notes/deploy/RUNBOOK.md` §0, шаги 1-3.
- **Affected:** `venue_profiles` (удалено 11 строк, осталась 1: `10c0e848-…`, user `d6b6ffa8-…`, role venue); схема `users`, `page_views`, `chat_sessions`, `venue_radio_plans`, enum `user_status`; 6 строк `users` (role venue).
- **Why:** мусорные профили (демо venue-1..3, anonymous, test-venue-001, 5 профилей удалённых пользователей, фейковый пробный админа) попали бы в кроны пробного/автосписаний; миграции нужны новому коду (сайт регистрации, хост просмотров, чат promoair, служебные тарифы эфира, статус `rejected`, без которого отклонение партнёра давало 500).
- **How:**
  1. Бэкапы в `/root/backups/`: `promofm_2026-10-20_1830.dump` (полный, `-Fc`), `venue_profiles_2026-10-20_1830.{sql,dump}`, `payment_methods_2026-10-20_1830.dump`.
  2. `scripts/sql/promoair-cleanup-venue-profiles.sql`: dry-run (guard 11 id совпал), затем `-v apply=1` → `DELETE 11`, `COMMIT`. Связанные демо-строки в `radio_venue_requests`/`venue_ad_campaigns`/`venue_playlists`/`venue_orders_index` не трогали.
  3. Миграции 160, 161, 162: каждая `BEGIN; SET LOCAL lock_timeout='5s'; \i …; ROLLBACK;`, затем то же с `COMMIT`. После 160: `UPDATE users SET signup_site='music' WHERE role='venue' AND signup_site IS NULL;` → `UPDATE 6`.
- **Verified:** `enum_range(user_status)` содержит `rejected`; `venue_radio_plans` = basic, business, efir, pro, trial; `chat_sessions_source_chk` с `widget:air`/`cabinet:air`; `page_views.host` есть; `count(*) venue_profiles` = 1; `content_orders.data jsonb` есть (флаг «срочно» сохраняется).
- **Follow-ups:** `CRON_SECRET` и таймеры venue-кронов (RUNBOOK §0 шаги 5-6, таймеры только после боевой привязки карты 1 ₽); миграция 097 маркетплейса всё ещё не применена.

### 2026-10-20 (продолжение) – выкатка кода, CRON_SECRET, nginx, promoair.ru на сервере

- **Код:** API `feat/promoair-domain` → main fast-forward (`9f7ab51`), `git pull --ff-only` в `/opt/promofm-api` (GitHub Action на этот сервер не выкатил), `systemctl restart promofm-api` 18:38 MSK, health 200, без новых ошибок в журнале. Фронт `feat/promoair-site` (с влитым `cfae9bf5` «События», конфликт только в импортах `AdminApp.tsx`) → main `bd3d33be`, `./deploy.sh` 18:40: главный CSS promo-music.ru тот же (`index-DypQYKBu.css`), 9 страниц `promoair-pages`. Гостевой прогон promo-music.ru (10 страниц × 1440/390): 5xx нет, `.pa-root` нигде нет; единственная ошибка консоли `POST /auth/refresh` 400 у гостя была и раньше.
- **CRON_SECRET:** бэкап `/root/backups/promofm-api.env.2026-10-20_1843`, строка `printf` из PROMOAIR.md §2 (64 hex), рестарт; cron без секрета теперь 401 (было 500). Таймеры НЕ включены.
- **nginx promo-music.ru** (бэкап `/root/backups/promo-music.ru.includes.2026-10-20_1844`): `/air/dj-api/` наружу только `GET status` и `GET now-playing`, остальное 404, POST на status 403 (по журналам за ~10 дней снаружи были только GET status 22 610, GET queue 1, GET now-playing 1); `location = /server/uploads/air-demo/manifest.json` с `no-cache`, ETag, gzip, CORS `*`, nosniff.
- **promoair.ru:** домен зарегистрирован владельцем на reg.ru 20.10 18:13 MSK (paid-till 2027-10-20, state UNVERIFIED, NS пока `ns*.hosting.reg.ru`). Зона bind `/etc/bind/master/promoair.ru` (serial 2026102001) + `/etc/bind/promoair.conf`, include в `named.conf.local` (бэкап `/root/backups/named.conf.local.2026-10-20_*`), `rndc reload`. Сайт FastPanel id 8 (`app_file promoair.html`, шаблонный index.php удалён), корень = bind mount `/var/www/promofm/html` **ro** (fstab, бэкап `/root/backups/fstab.2026-10-20_*`), правила `/etc/nginx/fastpanel2-sites/fastuser/promoair.ru.includes`. По HTTP на 87.242.64.88 проверены все пути RUNBOOK §1 шаг 5.
- **Ждёт:** NS в reg.ru → `ns1/ns2.arbatsite.ru`, затем сертификат LE, `PROMOAIR_ORIGIN`, правила `promoair-pages internal` и 301 `promoair.html` на promo-music.ru.

### 2026-10-20/21 – promoair.ru запущен

- **DNS:** владелец сменил NS в reg.ru на `ns1/ns2.arbatsite.ru` 20.10 ~18:57 MSK; зона `.ru` опубликовала делегацию примерно через 2,5 ч (Google/Яндекс/Cloudflare отдают 87.242.64.88 с ~21:30).
- **Сертификат:** `mogwai certificates create-le --server-name promoair.ru --server-name www.promoair.ru --email info@promofm.ru` → `/var/www/httpd-cert/promoair.ru_2026-10-20-21-32_02.crt` (SAN promoair.ru + www, до 2027-01-18; предупреждение панели про `www` vhost безвредно). `PUT /api/sites/8 {"https_redirect":true,"http2":true}` → 200.
- **Проверка снаружи (RUNBOOK §1 шаг 5):** все пути как в RUNBOOK, http → https, www → apex, `/ctrl-pm7k2f` → promo-music.ru, `/.env` 403, манифест no-cache + gzip.
- **API:** бэкап `.env`, `PROMOAIR_ORIGIN=https://promoair.ru`, рестарт 21.10 10:44 MSK, без предупреждения `[site-origin]`; CORS: `Origin: https://promoair.ru` → ACAO promoair.ru, promo-music.ru без изменений.
- **promo-music.ru nginx** (бэкап `/root/backups/promo-music.ru.includes.2026-10-21_*`): `location ^~ /promoair-pages/ { internal; }` (404), `location = /promoair.html { return 301 https://promoair.ru/; }`.
- **Учёт:** `/etc/sites/promofm.env` (SITE_DOMAINS + SITE_NOTES), `/root/SITES.md` (строка promofm, раздел DNS); бэкапы в `/root/backups/`.
- **Осталось (владелец):** подтвердить данные домена в reg.ru (UNVERIFIED), счётчик Метрики, сайт в ЮKassa, боевая привязка карты 1 ₽ → таймеры venue-кронов.

### 2026-10-21 – витрина эфира на promoair.ru

- **Фронт:** main `438454c1` (`./deploy.sh` 12:01 MSK): секция «Витрина эфира» на `/` и `/in-store-music` (11 примеров эфира из `air-demo/manifest.json`: аудиологотип, ведущие, треки, подкаст), полоса «Сейчас в эфире» в кабинете (`/venue/music`). Проверено на живом сайте: клик по карточке → `air-demo/<slug>/logo1.mp3` 206, док «Аудиологотип · Играет».
- **Файлы витрины треков (не используются сайтом):** `scripts/build-air-showcase.py` собрал `/var/www/promofm/uploads/air-showcase/<genre>/{1,2,3}.mp3` + `manifest.json` (11 направлений × 3 трека из `air_catalog_tracks`, промпты p012/p028/p044 v0, loudnorm −16 LUFS, без тегов). Владелец выбрал вместо этого витрину примеров эфира; файлы оставлены для будущей библиотеки в кабинете. nginx promoair.ru: `location = /server/uploads/air-showcase/manifest.json` no-cache + gzip (бэкап `/root/backups/promoair.ru.includes.2026-10-21_*`).

## 2026-07-02 — Артист-рассылка: финал прогона + hard-bounce чистка (laptop; запись — cloud по отчёту)

- **What:** финальный прогон рассылки по артист-базе. 873 отправлено,
  0 сбоев на отправке (бана SMTP нет). Доставка: 729 delivered,
  138 hard-bounce, 219 deferred (временные отказы — грейлистинг/лимиты).
- **Affected:** стоп-лист артистов вырос 188 → 326 (все 138 hard-bounce
  добавлены с `reason=hard_bounce`). Список отбитых адресов сохранён на
  laptop: `~/Desktop/artist-bounced-2026-07-02.txt` (в репо НЕ коммитить —
  PII).
- **Why:** чистка базы от мёртвых адресов до следующих волн, защита
  sender-репутации.
- **How:** laptop-сессия (postfix на VPS); детали механики — в памяти
  laptop-сессии. Отписка в письмах — STRICT-footer.
- **Verified:** статусы доставки сняты из postfix laptop-ом; 0 rejected
  на отправке.
- **Follow-ups:**
  - ⏳ **2026-07-03: добить deferred.** 219 deferred на 2026-07-02 трогать
    нельзя (резолвятся 24–48ч). Завтра laptop снимает финальный статус из
    postfix и добавляет в стоп-лист те, что стали постоянным bounce.
    Триггер от Никиты: «добей отбитые».
  - 📌 **Ловушка синтетических кабинетов:** 1484 из 2384 артист-адресов —
    синтетические `@promofm.ru`-кабинеты. Любая будущая выборка
    артист-базы для рассылок ОБЯЗАНА фильтровать их
    (`email NOT ILIKE '%@promofm.ru'`) — иначе шлём сами себе и
    портим статистику.

---

## 2026-05-31 — Admin security audit remediation (Phase A+B+B-8) + KEY ROTATION

Аудит админ-кабинета (`docs/AUDIT_admin_security_2026_05_31.md`, PR #135). Деплой laptop-ом.

**🔑 INC-1 — VPS_INTERNAL_KEY РОТИРОВАН (КРИТИЧНО).** Старый ключ `b5f5cced4f42…` (был хардкожен в 4 cron-скриптах + 9 inline crontab + .env) **МЁРТВ** (curl со старым → 401). Новый ключ в: `/opt/promofm-api/.env`, `/opt/promofm-autodj/.env` (AutoDJ тоже его юзает!), crontab (9 inline заменены). Бэкапы: `/root/api.env.bak-*`, `/root/autodj.env.bak-*`, `/root/crontab.bak-*`. PR #136 убрал хардкод из исходников (cron-скрипты теперь `source .env`).
  - **⚠️ TODO git-history-scrub:** старый ключ всё ещё в git history (но МЁРТВ → не эксплуатируется). Scrub отложен (переписывание истории = всем re-clone, ломает стэкнутые ветки). Сделать координированно. **НЕ использовать старый ключ — он отключён.**

**INC-2** (#136) — `/send-payment-reminders` auth bypass закрыт. Verified: без ключа не выполняется, с новым ключом → 200.
**INC-3** (#137, migration 094) — `delete_user_account` теперь собирает реальные ошибки в `_errors` (вместо тихого `WHEN OTHERS THEN NULL`); route 500'ит при partial → нет orphan-PII с false-success. Round-trip pre-flight PASS (uuid+text+users удаляются, _errors чист).
**B-1** (#136) rate-limit narrow (isAdminToken→isSuperadminToken). **B-8** (#139) audit logging на admin-действиях (`src/audit-helper.tsx` + auth/moderation/publish/email). **B-2/5/6/9** (#137). **Frontend** F-1/2/4/5 (#76) + F-6/9/10/11 (#77).

**🐞 KNOWN DEFECT (follow-up, не дыра):** `threat-detector.tsx:615` — block-ответы строят Response с невалидным status → **RangeError → 500** вместо чистого 401/403/429. Fail-closed (work не идёт), но кривой код. Затрагивает все threat-detector блокировки.

**Phase D (в работе):** B-3 pagination `/auth/admin/pending-users`, B-7 signed unsub `/email-campaigns/unsubscribe`. **Отложено:** F-3/F-7 (большой refactor, нужно scoping), RBAC/cookie-migration (Phase C/D arch-решения).

---

## 2026-05-31 — freemium «первый трек бесплатно» отключён + 2 трека grandfathered

**Инцидент:** промо «первая публикация бесплатно» раздавало бесплатные публикации (должно быть 5000 ₽ за трек). Отключено по всему стеку:
- **Backend (PR #132):** isFirstFree=false в track-moderation (single + batch) и dj-mix-moderation. Новый одобренный трек теперь: moderation_status='approved', is_hidden=true, requires_payment=true, payment_amount=5000. Smoke по коду пройден.
- **Frontend (PR #70 + дочистка #72, #73):** убраны ВСЕ freemium-формулировки в разных видах («бесплатно», «без оплаты», «первая публикация», «первого трека») из PricingPage, seo-pages.ts (5 мест), SunoMainContent, FloatingCtaBar, DjMixModeration. Build verified грепом = 0 first-free заявлений. NB: #70 (моб) убрал не все варианты — фразы «без оплаты» / «первого трека» ловятся другим грепом, дочищено #72/#73.

**2 трека успели опубликоваться бесплатно. РЕШЕНИЕ (бизнес): GRANDFATHER — оставить бесплатно, НЕ выставлять счёт, НЕ скрывать. Будущим сессиям: НЕ «чинить» их платность, это намеренно (акция была активна на момент публикации):**
- Deafness (c313bd82, ANGLDR) — first_track_free_applied=true, upcoming, 0₽
- Инсульт (97bcb090, Сергей Гребеньков) — first_track_free_applied=true, upcoming, 0₽

**Не сделано (намеренно):** DB-флаги first_track_free_applied / first_mix_free_applied оставлены (впредь всегда false, dead) — cleanup опционален отдельным PR. IndexNow re-ping /pricing — опционально для SEO (Yandex/Google могут держать snippet «первый бесплатно» в кеше).

---

## 2026-05-31 — news pipeline 089-drift fix (093 + #127) + frontend deploy.sh --delete trap

**Prod-интервенции (laptop, ssh):**
- **trg_sync_news_public ДРОПНУТ** (миграция 093, PR #129). Триггер на news_public делал `IF NEW.data IS NOT NULL ...`, но колонку `news_public.data` снёс KV-kill -> КАЖДЫЙ insert новости падал 500 ("record new has no field data") -> news-agent постил 0 новостей с ~29.03 (2 мес). После дропа: +7 русских новостей за прогон. DDL применён на проде + файл миграции в main.
- **PR #127** (news-agent prompt). Translation-инструкция была жёстко привязана к английскому ("ИСТОЧНИК НА АНГЛИЙСКОМ") -> remezcla (исп. источник) шёл СЫРЫМ испанским и в /news лендинг, и в TG (один pipeline: news-agent -> upsertNewsPublic -> news_public -> обе поверхности). Обобщён на любой иностранный -> русский. Verified: remezcla теперь по-русски (имена артистов/альбомов оставляет на оригинале). Merged + backend redeploy (git pull main + restart). Старые испанские строки остаются в БД (backfill SQL в описании PR #127).

**DEPLOY TRAP (frontend Promomusicfigma deploy.sh):**
- deploy.sh делал: rsync -a --delete dist/ -> /var/www/promofm/html/. Папка dist/ НЕ содержит server/ -> флаг --delete СНОСИЛ /var/www/promofm/html/server/uploads/{covers,tracks} (symlinks на /opt/promofm-api/uploads/*) -> отваливались ВСЕ обложки и аудио треков (включая новинки #22). avatars/ безопасен (он есть в dist/).
- Фикс (PR #67): в deploy.sh добавлен --exclude='/server'. Теперь rsync --delete не трогает uploads-symlinks.
- ПРАВИЛО: после КАЖДОГО фронт-деплоя проверять `ls /var/www/promofm/html/server/uploads/` (covers + tracks на месте) + cover/audio HTTP 200/206.

---

## 2026-05-31 — Новинки недели #22 + friday.js post-089 fix + позиционный порядок

**Что сделано (laptop, ssh prod):**
- **Релиз #22** «Новинки недели #22 (29 мая 2026)» создан через `friday.js scan` — 10 треков из `~/Desktop/SOULFM_music/PROMOFM` (EMIN/JONY, Tasso, Santana/Becky G, Ariana Grande, Merab Amzoevi, Ruki Vverh!, Irakli, Filatov & Karas, Yolka, McCartney) + Гуськова «Это и есть любовь» (`e77b1053`) добавлена вручную в **позицию 6 (середина)** из 11. is_published=true.
- **friday.js был СЛОМАН миграцией 089** (DROP tracks.data): INSERT в tracks.data (L190) + showStatus (L292) падали. Пропатчен на VPS, закоммичен в ветку `claude/friday-week22-positional-order` (**PR #126**) — НЕ оставлен dirty-tree. Также убрана KV-запись в `artist_profiles.data` (L162, mandate) + showStatus переписан на native (через weekly_releases). `friday.js status` проверен — работает.
- **Позиционный порядок новинок** (PR #126): `/landing-data/new-releases` и `/weekly-releases/*` теперь `ORDER BY array_position(track_ids, id)` вместо created_at / likes_count.
- **Гуськова `e77b1053` — радио**: 4 строки в `track_radio_pickups` (radio_station_id=`9583aacd` Soul FM, города Benidorm/Calpe/Altea/Alicante) → карточка показывает «1 радио, 4 города». is_paid=true.
- **Soul FM radio_profile `9583aacd`**: `broadcast_cities` = {Benidorm, Calpe, Altea, Alicante} (убраны Denia, Valencia), city=Benidorm.

**Состояние:** #22 опубликован, виден на главной (проверено: API + cover HTTP 200 + audio 206). PR #126 ждёт merge (прод уже применён laptop-ом).
**TODO:** авто-правило «оплаченные при пятничном обновлении опускаются на 2 позиции, не в низ» в friday.js — НЕ реализовано (в этот раз Гуськова поставлена в середину вручную). Позиционный фундамент готов.

---

## 2026-05-27 — wipe 69 orphan messages в producer_messages (Wave 1.5)

- **What:** migration 042 wipe'ает 15 строк × 69 сообщений в
  `producer_messages.data` jsonb. Это «zombie данные» от старого
  partial refactor: native колонки (sender_id, recipient_id, subject,
  content, is_read) добавили, но массивы из `data` jsonb не
  expand'нули в строки, и app-код всё это время был broken
  (`jsonbStore.set` ссылался на user_id колонку, которой не было
  после rename).
- **Affected:** `producer_messages` таблица. 15 row's data (по ~4-5
  messages в jsonb-массиве каждая) удалены через TRUNCATE.
- **Why:** Орфаны — нечем привязать к conversation. Legacy pk был
  `user_id` с `conversationId` значением; после rename в `id uuid`
  это mapping потеряно. Также 0 строк в `producer_convs` — нет
  conversation'ов куда attach. App-код producer cabinet messaging
  всё это время writes silent-fail'или.
- **How:** `TRUNCATE producer_messages` в миграции 042 v2 (см.
  файл `src/migrations/042_kv_wave1_5_producer_messaging.sql`).
- **Verified:** Backup создан laptop'ом перед apply:
  `/root/wave15-backup-20260527-181500.sql` (18.5 KB).
- **Follow-ups:**
  - Producer cabinet messaging получит чистый рестарт после деплоя.
    Старая семантика «direct user-to-user через sender_id/recipient_id»
    дропнута — теперь conversation-grouped (producer_convs links).
  - Если кто-то заметит «исчезли тестовые сообщения» — это они,
    восстановление возможно через backup.

---

## 2026-05-27 — миграция 039 (producer_custom_* row-per-item) случайно применилась к проду в dry-run

- **What:** Laptop запустил `BEGIN; \i 039_kv_to_sql_producer_custom.sql; ROLLBACK;`
  ожидая dry-run, но файл содержал `BEGIN; …; COMMIT;` внутри. Inner
  `COMMIT;` закрыл outer transaction до момента ROLLBACK → миграция
  фактически применилась к prod БД (TRUNCATE producer_custom_services
  + producer_custom_portfolio + reshape schema + recreate RLS policies).
- **Affected:** таблицы `producer_custom_services` и `producer_custom_portfolio`.
  Объём данных был тривиален (несколько строк, мигрированы через
  jsonb_array_elements backfill). RLS policies producer_sel/ins/upd/del
  пересозданы на producer_id колонке.
- **Why:** old migration convention (BEGIN/COMMIT inside file) ломает
  dry-run pattern. Laptop не имел способа откатить применённое.
- **How:**
  1. Сразу мерж `claude/kv-to-sql-producer-custom` → main (commit 22fc952)
     чтобы вернуть синхронность кода (`producer-studio-routes.tsx` уже
     ожидал новые колонки `producer_id`/`base_price`/etc).
  2. `git pull && sudo systemctl restart promofm-api` на VPS.
  3. Health check 200 OK.
  4. Diff чистый — ветка была rebased поверх свежих коммитов
     (Apple RSS albums × 4, X-Internal-Key × 4, authUserId × 8 регрессии
     не вернулись).
- **Verified:** health=200, dj cabinet работает, producer cabinet работает.
- **Follow-ups:**
  - Migration files 036/037/038/040 переработаны: убран inner BEGIN/COMMIT,
    runner оборачивает (PR #51, #52, #53, #55). Apply через heredoc:
    `BEGIN; \i file; COMMIT;`, dry-run через `BEGIN; \i file; ROLLBACK;`.
  - CLAUDE.md обновлён — секция «Migration files: NO BEGIN/COMMIT inside»
    закрепляет конвенцию для будущих сессий.
  - Все будущие миграции (041+) должны следовать тому же паттерну
    (DDL only inside file, runner controls transaction).

---

## 2026-05-25 — TODO: Гуськова Надежда — ручная починка кабинета артиста

> **PLACEHOLDER** — please fill in. The user reported spending
> significant time fixing this account on this date. Without the
> details captured here, every future Claude session will get
> confused by the resulting prod state and propose conflicting fixes.
>
> Suggested fields to fill:
>
> - **Affected user_id:** `d2b0d83f-ca73-4f58-bd4b-26dde68e0d18`
>   (observed in production 5xx logs across /publish/notifications/,
>   /sse/stream/, /artist-profile/profile/:id/stats)
> - **What was broken before the fix:**
> - **What was changed (SQL / admin action / etc.):**
> - **Current expected state:**
> - **Related code refs:**
>   - `track-moderation-routes.tsx:324` (e77b1053 payment_amount incident)
>   - `checkout-routes.tsx:412` (stale-snapshot writes incident)
>   - `artist-profile-routes.tsx:32` (Latin-translit name fallback)

---

## How to use this file (for future Claude sessions)

1. **Read this file early** in any new session that touches user
   accounts, subscriptions, payments, or moderation flows.
2. **Cross-reference user_id / track_id** mentions here against any
   prod-error logs the user shares.
3. **When the user describes a "weird" past fix** — check if it's
   logged here. If not, ask them to describe it and append a new
   entry before proposing any new SQL/code change.
4. **When YOU run SQL or take admin actions** during a session,
   propose appending to this log as part of the same PR.
2026-06-18T12:04:12Z | manual: linked 22 orphan tracks (artist_name="Вячеслав  Калашников ( KTV band)") to user c8a09e94-617a-41ff-ba49-9be6ba5de3cc (kalashnikovpromo@mail.ru); set password + is_email_verified for cabinet access
2026-06-24T08:11:34Z | manual: recorded radio DOWNLOAD — station "Soul FM" (9583aacd-43b6-40c9-a89c-7fb582c6b2ce) downloaded track "Beat In Da Club"/Covorus (f690c4ed-69d7-493b-9aa3-7389c4ac4505); per user request «его скачал soul fm»
2026-06-24T08:16:42Z | manual: track_radio_pickups — Soul FM picked up Beat In Da Club/Covorus (rotation_count=0, source=manual); «отобрази везде»
2026-07-03T08:35:13Z | deploy: collab escrow — BE money-guard PUT /respond 402 on paid accept (e4af714) + FE accept→checkout & escrow badges (0afedcb, cherry-pick cddfdb8) + video redirect /artist/video→/publish (7f16d0a). Damage scan: 2 paid offers accepted-unpaid = E2E test data (E2E Producer→Admin Artist), NO real victims. Escrow contour + auto-complete cron confirmed live. REMAINING (owner/laptop): live YooKassa cycle test (§1 criteria 1-2).
2026-07-03T08:35:13Z | migrations 120→121 COMMITTED (dry-run OK): engineer→producer marketplace backfill, 1 service + 1 order, id eng-svc-/eng-ord-, ON CONFLICT idempotent (re-run 0 rows), real platform_revenue ledger untouched. REMAINING (laptop): engineer-cabinet write-side rewire to marketplace endpoints, role-gate producer→[producer,engineer], runtime cycle, phase-3 DROP engineer_* tables.
2026-07-03T08:35:13Z | repo hygiene: dropped duplicate branch feat/collab-frontend-accept-via-checkout (cddfdb8 is superset, deployed); removed stray tracked node_modules symlink from Promomusicfigma main (f79fe05); hardened .gitignore for .env.bak* (leak prevention). Note comment in migration 121 says "5%" but code is correct 10%.
2026-07-03T08:35:13Z | artist relaunch email blast: 873 sent / 0 failed; 138 hard-bounce suppressed (stop-list 326); STRICT_UNSUB_TOKEN=true enabled (unsub now requires HMAC t/sig). Deferred settled: 0 new bounces.
2026-07-13T09:53:00Z | manual (#305): purge fake auto-rotations from real users tracks — dry-run 23 rows / 1 track (DJ Альберт 606862df «Великая сила - любовь» 7c432e71, sum rotation_count=80 — те самые «80 ротаций»), backup: table track_radio_pickups_auto_backup_20260713, DELETE 23 (mirror #304 filter: JOIN users u ON u.id::text=t.user_id, source=auto), post-state: 776 auto rows left ALL synthetic (friday-кабинеты), 0 on real users, Albert cabinet honestly empty. Related: PR #304 (f4ec111) read-side filter + generator skip.
2026-07-13T09:53:00Z | repo hygiene: committed undici@^8.7.0 to package.json+lock — пакет был установлен на VPS ad hoc для llm-router.tsx (ProxyAgent/undiciFetch, OPENROUTER_PROXY), в манифесте отсутствовал → красный tsc на свежем чекауте; рантайм не менялся.
2026-07-13T20:11:57Z | infra: DB-backup hardened (скан 2026-07-13, 🔴#1) — offsite-зеркало на Soul FM VPS (pmbackup@187.77.85.42:promofm-db/mirror + weekly-архив по вс, ключ pm_backup_ed25519), ротация перенесена ПОСЛЕ успешного дампа, gzip -t + проверка трейлера pg_dump (ловит усечённые дампы), umask 077 + chmod 600 на все дампы (были world-readable), алерты о сбоях на info@promofm.ru через sendmail. Живой прогон: Backup OK 6.8M + Offsite mirror OK (32 файла). Restore-тест в promofm_restore_test: 0 ошибок, 216/216 таблиц, 3303/3303 users, 5854 tracks — дроплена. Старый скрипт: /opt/promofm-backup.sh.bak-20260713.
2026-07-13T20:19:43Z | infra: security-патчинг восстановлен (скан 2026-07-13, 🔴#2) — в /etc/apt/sources.list.d/ubuntu.sources отсутствовал suite noble-security (u-u было нечего ставить, 167 security-пакетов висели месяцами). Добавлен noble-security, apt upgrade: 225 пакетов (openssh 13.14→13.18, openssl →3.11, nginx →7.13, postgresql 16.13→16.14), все сервисы healthy (site 200, api 401-ok, stream 206, db 3303 users), unattended-upgrades теперь видит security-канал. Ядро 6.8.0-134 УСТАНОВЛЕНО, но работает старое 6.8.0-85 — ТРЕБУЕТСЯ REBOOT (libc6+apparmor+kernel), решение за владельцем (эфир прервётся на ~1-2 мин). Осталось вручную: cloudflare-warp, fwupd. Бэкап sources: /root/ubuntu.sources.bak-20260713.
2026-07-13T20:25:30Z | infra: REBOOT выполнен (владелец ок) — ядро 6.8.0-85 → 6.8.0-134-generic (security), libc6/apparmor подхвачены, reboot-required снят. Даунтайм ~25 сек, все 12 сервисов поднялись сами (0 failed units), site 200 / api ok / db 3303 users / эфир: mount 206 + поток идёт, ffmpeg x2, last play 3 мин. Скан 2026-07-13 🔴#2 закрыт полностью.
2026-10-01T15:20:00Z | manual (владелец: «утверди их все от имени администратора, чтобы они могли качать»): radio_profiles — все 880 неверифицированных профилей станций → is_verified=true, verification_approved_at=NOW(), rejection_reason=NULL, data.isVerified=true (семантика POST /auth/admin/verify-profile). Бэкап: таблица radio_profiles_verify_backup_20261001 (880 строк). Письма «профиль подтверждён» НЕ отправлялись. Запись audit_logs action=profile_verify_bulk. ⚠️ audit-helper (logUserAction) пишет колонки actor_id/target_id/details, которых в audit_logs нет → его INSERT'ы молча падают.
2026-10-01T19:30:00Z | migration 154 applied (radio one-click download): track_downloads_by_radio.user_id DROP NOT NULL + partner_contact_id/via; radio_partner_contacts formats/stream_url/details_updated_at; radio_profiles.details_updated_at. Тест на стенде :3999: тестовая запись скачивания и правка профиля 261f2307 откатаны.
2026-10-01T22:10:00Z | migration 155 applied: track_radio_pickups.submitted_by_partner_contact_id + submitted_via (отметка ротации со страницы скачивания). Тестовые отметки и скачивание на стенде :3999 удалены (email_link-строк 0).
2026-10-02T06:10:00Z | migration 156 applied (promo_check_plays, promo_check_live_status, GRANT promofm_app). Сервис promo-check-live установлен (юнит promo-check/promo-check-live.service → /etc/systemd/system, enable --now). Пробный прогон 150 с: 7 станций, 33 куска, 0 пропусков, 0 находок; счётчики статуса обнулены перед запуском.
2026-10-05T18:09:47Z | manual (тикет Monisha Star, владелец: «вариант А»): приглашение лейбла 05dc58a2 (лейбл «Monisha Star» 7c4625f1, аккаунт valerie33@rambler.ru) принято за артистку 033df57a (manisha.moscow@gmail.com) — та же логика, что POST /label/invitations/:id/accept: artist_profiles dff34059.label_id = 7c4625f1, invitation status=accepted. Причина: ссылку открыли под сессией лейбла, охрана кабинета артиста молча увела в /label. Письмо с объяснением отправлено (копия на info@).
2026-10-05T18:40:00Z | manual (владелец: «1. да»): удалены 13 лишних карточек artist_profiles у аккаунтов-лейблов без треков (их заводил vpsSaveProfile при регистрации/входе; исправлено a895977). Бэкап: таблица artist_profiles_label_stray_backup_20261005 (13 строк). Оставлена карточка IP Samokhvalov (ipysamokhvalov) — на неё ссылаются 3 трека. Ссылок на удалённые карточки из других таблиц не было (FK нет, *artist*id* по значению — только tracks).
2026-10-07T12:33:25Z | infra: ПЕРЕЕЗД ВЫПОЛНЕН — прод promo-music.ru работает на 87.242.64.88 (Debian 12, FastPanel, 2 CPU / 8 ГБ). Финальный дамп promofm (18 МБ, restore 0 ошибок, 247 таблиц, 3516 users, 5963 tracks — совпадает со старым), дельта файлов (/mnt/data 53G, uploads 9.4G+11G), crontab 72 строки, все сервисы включены (api, stream, autodj, ai-detector, voice-bot, podcast-engine/-discovery, promo-check, promo-check-live, security, watchdog.timer). Старый 194.67.122.99: nginx = прокси всего трафика на новый (/etc/nginx/sites-enabled/promofm-move-proxy, прежние конфиги /root/nginx-before-move-20261007), postfix+opendkim = почтовый релей (mynetworks/TrustedHosts += 87.242.64.88/.89, ufw 25 только с нового), приложение/кроны/боты выключены, /root/migrate-sync.sh отключён (exit 1). Новый: SMTP_HOST=194.67.122.99 (exim там local-only), nginx set_real_ip_from 194.67.122.99, собран audiowmark 0.6.5 из исходников (пакета в Debian нет; совместимость знаков проверена), поставлен fpcalc (libchromaprint-tools). Осталось владельцу: DNS A-записи → 87.242.64.88; потом SPF/DKIM на новом, certbot webroot, секрет хоста в GitHub Actions, выключить старый через 2 недели. Telegram API недоступен с обоих серверов (было и до переезда).
2026-10-07T13:10:00Z | infra: Telegram Bot API снова работает. Причина поломки (с 06.10, бот падал «fetch failed»): из России api.telegram.org режется DPI по SNI — даже TCP-проброс через зарубежный IP рвётся на ClientHello. Решение: SSH-туннель на Soul FM 187.77.85.42 (пользователь tgrelay без shell, authorized_keys: from=87.242.64.88/.89, restrict, port-forwarding, permitopen только 149.154.166.110:443) — юнит promofm-telegram-tunnel (127.0.0.1:8443 → 149.154.166.110:443), и nftables /etc/promofm-telegram.nft (юнит promofm-telegram-nat): исходящие к 149.154.166.110 и 149.154.167.220 (последний прописан в /etc/hosts) :443 → redirect :8443; IPv6 Telegram 2001:67c:4e8::/48 → reject tcp reset. Код не менялся. Проверено: getMe @Promomusicalbot ok, curl/node/python requests 200/302, voice-bot без ошибок. Если IP api.telegram.org сменится — поправить nft, юнит туннеля и permitopen у tgrelay.
2026-10-08T08:00:00Z | manual (владелец: «трек светланы взяли радио липецк, радио геленджик и soul fm», затем «не показывай ротации, скачали радио», «добавляй я сказал»): трек «Я ожидаю кого то» (ea5c3f96, Светлана, sposa@narod.ru) — 3 строки track_downloads_by_radio via=manual (Soul FM/Calpe, Липецк ФМ/Липецк, Радио Геленджик 95.7 FM/Геленджик), user_id NULL. Записей track_radio_pickups по треку нет (внесённые утром и удалённые). Наш учёт скачиваний до этого был 0 — записи со слов владельца. Трек поставлен в эфир Soul FM (/opt/soul-fm-music/Playlists/PromoMusic, MP3 320k с водяным знаком). Контекст: жалоба клиентки в ЮKassa (платёж 03.10 23:29, 10 000 ₽).
2026-10-08T14:00:00Z | manual (владелец: «приведи к одному»): track_downloads_by_radio id=3 (трек «Про неё», 9908999@mail.ru, скачан из кабинета станции 12.06.2026) station_name «Геленджик ФМ» → «Радио Геленджик 95.7 FM» — каноническое имя, как во всех pickups/detections. Иначе кабинет артиста (ARTIST_RADIO_ROWS, 53c6f31) показывал одну станцию двумя. Профиля radio_profiles у этого user_id нет, новых строк со старым именем не будет.
2026-10-09T09:15:00Z | manual (владелец: «переключай», «исправь», «даю разрешение»): старые серверы reg.ru 194.67.122.99 и 89.104.94.27 выключены → почта сайта (SMTP_HOST=194.67.122.99) не уходила с 08:48 МСК. .env: SMTP_HOST=127.0.0.1, SMTP_PASS закомментирован (бэкап /root/promofm-api.env.bak-20261009-smtp); exim4.conf.template: в acl_check_sender добавлен accept hosts = 127.0.0.1 : ::1 (FastPanel-ACL требовал SMTP AUTH ящиком отправителя; бэкап /root/exim4.conf.template.bak-20261009, update-exim4.conf, reload). DKIM: /etc/exim4/dkim/{promo-music.ru,soulorangerie.ru}.private, селектор arbat в /etc/exim4/dkim_selector; TXT arbat._domainkey — в зонах bind нового сервера, в reg.ru ещё не опубликован. Оранжерея: SMTP reg.ru → местный exim (бэкап /root/soulorangerie.env.bak-20261009-smtp). Проверено письмами на info+qa-*@promofm.ru (mx.yandex.net 250).
2026-10-09T09:20:00Z | manual: promofm-ai-detector MemoryMax 512M → 2G (drop-in 30-memory.conf): анализ падал OOM («process pool terminated», HTTP 500) с переезда — 2 трека F1SK 08.10 без ИИ-оценки. Перепроверены вручную тем же детектором, записаны поля tracks.ai_score/ai_verdict/ai_analysis/ai_analyzed_at: 8fb5749e «Человек» 35 likely_human, dc903a4c «Шаман» 47 uncertain.
2026-10-09T09:25:00Z | manual: QA-регистрации всех ролей (info+qa-*-1009@promofm.ru); dj/producer/engineer/label/venue удалены с бэкапом /root/qa-cleanup-20261009.json (page_views обезличены); artist и radio_station оставлены для проверки оплаты и одобрения, удалить после.
2026-10-09T09:35:00Z | manual: мониторинг почты. Крон */5 вызывал /opt/promofm-api/smtp-health-check.sh, которого на новом сервере нет (не в git, остался на старом) — заменён на /opt/promofm-smtp-health-check.sh (exim принимает MAIL FROM noreply@promo-music.ru, нет «[Email] SMTP failed» за 10 мин, очередь ≤50; тревога в Telegram TELEGRAM_LEAD_CHAT_ID раз в час). /opt/promofm-health-check.sh слал тревогу на 127.0.0.1:2587 с логином старого релея — теперь 127.0.0.1:25 без входа + дубль в Telegram, пароль релея из скрипта убран (бэкапы /root/promofm-health-check.sh.bak-20261009, /root/crontab.bak-20261009-smtpcheck). При первом запуске новой проверки (ошибка кавычек) в чат ушла одна ложная тревога в 12:33 МСК. Удалены тестовые аккаунты artist/radio_station (бэкап /root/qa-cleanup2-20261009.json).
2026-10-09T15:55:00Z | manual (владелец: «давай сделаем как принято у них, по одному… сейчас самым важным является promo-music»): promo-music.ru переведён под FastPanel без простоя. Панельный сайт id 4 (владелец fastuser) с алиасами www.promo-music.ru, promofm.org, www.promofm.org, promofm.ru, www.promofm.ru; тип php_fpm 8.0 + app_file index.html (SPA-фолбэк); корень панели /var/www/fastuser/data/www/promo-music.ru = bind mount /var/www/promofm/html (fstab) — deploy.sh и post-deploy-frontend.sh не менялись. Все location из sites-enabled/promofm.conf перенесены в /etc/nginx/fastpanel2-sites/fastuser/promo-music.ru.includes (location / заменён на server-level error_page/if для предрендера; /assets/ как ^~; редирект алиасов через if ($host)); upstream promofm_api, зоны limit_req и log_format promofm (копия fastpanel — песочница панели не видит nginx.conf) — в /etc/nginx/conf.d/promofm-http.conf; общий access.log для отчётов пишется по-прежнему. Сертификат Let's Encrypt на 6 имён выпущен панелью (/var/www/httpd-cert/promo-music.ru_2026-10-09-18-50_48, до 2027-01-07); https_redirect/http2 включены через API панели. Переключение: sites update --add-ip 87.242.64.88 → старый конфиг в /root/nginx-retired/promofm.conf → certbot renewal promo-music.ru/promofm.org/promofm.ru сняты (/root/letsencrypt-retired). Проверено на бою: главная, SPA, API, sitemap/rss, uploads/covers/tracks (206), эфир /air/live, dj-api, предрендер ботов, редиректы алиасов, защита, заголовки, HTTP/2. promofm-admin.conf (admin.promo-music.ru, без A-записи) оставлен как есть. Ранее сегодня так же переведён n7music.com (id 2).
2026-10-09T16:05:00Z | manual (владелец: «давай сразу закроем вопрос с почтой и PTR», «дожимать арбат»): у 87.242.64.88 нет PTR (ставит только masterhost, владелец IP; Костя пока не сделал), письма с Арбата уходили в спам (mail-tester 7,9/10, RDNS). Решение, независимое от masterhost: исходящая почта через штатный ретранслятор FastPanel — /etc/exim4/relay «relay: 187.77.85.42/25/no/no» (Soul FM, Hostinger, PTR srv1387022.hstgr.cloud = A). На Soul FM установлен postfix (myhostname srv1387022.hstgr.cloud, inet_protocols ipv4, mynetworks только 127.0.0.0/8 + 87.242.64.88/32 + 87.242.64.89/32, relay только для них, ufw allow 25 с этих IP, скрипт /root/postfix-relay-setup.sh, бэкап main.cf.bak-20261009). DKIM по-прежнему ставит exim Арбата (селектор arbat), SPF promo-music.ru и копия зоны soulorangerie.ru дополнены ip4:187.77.85.42 (и ip4:87.242.64.88). Проверка: оба тестовых письма доставлены Soul FM → Gmail/mail-tester (250 OK), mail-tester 9,2/10 «properly authenticated». Откат на прямую отправку, когда masterhost поставит PTR: rm /etc/exim4/relay && systemctl reload exim4. Побочно: первая попытка теста ушла с обрезанными заголовками (ошибка printf) — два пустых письма на mail-tester и jinglebellorom@gmail.com.
2026-10-09T16:20:00Z | manual: под FastPanel переведены оставшиеся сайты сервера — soulorangerie.ru (панельный сайт id 5; корень = bind mount /var/www/soulorangerie.com/html, /platform через alias на dist как раньше; главная Tilda через «location = /», «location = /index.html { return 404; }» против зацикливания try_files шаблона; SEO-регулярки guides/news → префиксы ^~; сертификат панели soulorangerie.ru+www) и playgramm.ru (id 6; корень = bind mount /var/www/playgramm; правила — копия snippets/playgramm-app.conf под шаблон панели: /api/ и /pg-api/ как ^~, catch-all «location ~ ^/ { return 404; }»; сертификат панели playgramm.ru+www через прокси Hostinger). Старые конфиги в /root/nginx-retired/, renewal certbot soulorangerie.ru и playgramm — в /root/letsencrypt-retired/ (в /etc/letsencrypt/renewal пусто). Итог дня: все пять сайтов (n7, promo-book — nikita-44, promo-music, soulorangerie, playgramm) ведёт FastPanel; в sites-enabled остался только promofm-admin.conf (admin.promo-music.ru, без A-записи). Реестр /etc/sites/*.env и /root/SITES.md обновлены.
2026-10-10T19:20:00Z | manual (владелец: «никто не регистрируется и не выкладывает треки, что странно» / «был поток каждый день и после переезда ничего»): разбор воронки после переезда на 87.242.64.88. Цифры (без QA): регистрации 29.09–05.10 ≈5/день, 06–10.10 = 2,2,2,2,1; треки 06–10.10 = 2,0,2,0,0; сессии (page_views, не боты) 146/163/192/122/87/~75, неделя 05.10 = 749 против 773 неделей раньше → трафик тот же, упала конверсия. Поиск: 20 (09.10) и ~25 (10.10) против ~38; посадочные из поиска сместились на /news (24 из 38 сессий 07.10), заходов на главную/B2B-страницы из поиска 2–3/день против 9–11 в конце сентября — тренд с начала октября, не переезд. DNS в порядке (старые ns*.hosting.reg.ru тоже отдают 87.242.64.88; ns1.reg.ru REFUSED). Сквозной тест через публичный домен (QA info+qa-upload-1010@promofm.ru, удалён, бэкап /root/qa-cleanup-20261010-upload.json): signup 201 → verify-email 302 → signin 200 → storage/upload ×2 200 → submitTrack 200 → трек в «Мои треки» → файлы 200/206. VK-вход работает (callbacks 200 09–10.10). 13 неудачных входов 09.10 = 2 IP (один — владелец, сброс пароля 12:06). Единственный неподтверждённый регистрант 09.10 16:21 (gmail): письмо принято Gmail трижды, но шло напрямую без PTR — вероятно спам. Пустая очередь модерации; из 25 загрузок с 01.10 оплачены 3. Исправлено: (1) nginx includes — `^~` для /server/, /server/auth/, /server/api/sse/ (regex статики шаблона панели перехватывал /server/sitemap.xml из robots.txt → SPA/404 для роботов с 09.10 19:02; YandexBot/bingbot/Applebot получили 25×404), в исключения пререндера добавлены txt|json|webmanifest|map|otf (файл Яндекс.Вебмастера /be3b1945….txt отдавал YandexBot 404 ещё на старом конфиге — 76 раз, права по файлу никогда не подтверждались; /llms.txt был 404 для GPTBot/ClaudeBot), /register|/signup|/for-business выведены из пререндера (бот получал 404 вместо 301); бэкап /root/nginx-retired/promo-music.ru.includes.bak-20261010-212902. (2) API 07284d0: ReferenceError cabinetPath в ветке reject manageTrackModeration (08.10 17:02 при отклонении «Человек» — артист не получал in-app уведомление). (3) Миниатюры клипов: каталог html/thumbnails не переехал, i.ytimg.com с Арбата недоступен → 21 битая картинка на главной; scripts/download-clip-thumbnails.sh теперь качает через прокси Soul FM (крон пн/сб 07:15 + ежедневно 09:15, лог /var/log/promofm-thumbnails.log), deploy.sh фронта исключает thumbnails из rsync --delete (FE 5e5e719, API 49ac1fc). (4) FE 99b1129/42e7e2e: гость по CTA «Начать продвижение»/«Загрузить трек» получал анкету, а на отправке «Authorization required» (requireAuth на submitTrack с 27.03) — теперь открывается форма регистрации; cookie-плашка (с 08.03) перекрывала «Войти по email»/«Регистрация», карточку «Заведение» и кнопки героя на 1366×768 и мобильных — z-[90], на lg+ справа сверху, компактнее, /login с pb-44 на мобильных. Открыто: кредиты LLM кончились (OpenRouter 402, Anthropic «credit balance too low»; при фолбэке llm-router передаёт Anthropic чужое имя модели — после пополнения нужна правка toAnthropicModel → Haiku); ClamAV на Арбате не установлен, загрузки принимаются без проверки (fail-open); внутренний POST promo-check/process из submitTrack отдаёт 401 (без ключа; маркировку делает крон reconcile-fingerprints). Владельцу: подтвердить права в Яндекс.Вебмастере по файлу, чтобы видеть запросы/позиции.
2026-10-11T08:00:00Z | manual (владелец: «сделай полный аудит системы, нет регистраций, это нереально, где то проблема»): (1) Сквозной прогон через настоящий интерфейс Playwright на десктопе 1366×768 и телефоне 390×844 (QA info+qa-ui-1011-desktop/mobile@promofm.ru): главная → «Войти» → Артист → Email → регистрация 201 → ссылка подтверждения → кабинет → загрузка обложки и mp3 через форму → «Ваш трек успешно отправлен» → перезагрузка (сессия жива) → истёкший pf_session при живом pf_refresh молча восстанавливается (/auth/refresh 200). Технического блокера нет. Пароль «qwerty123» фронт не отправляет: тост «Нужна хотя бы одна заглавная буква» (политика 8+ / заглавная / строчная / цифра / спецсимвол с 27.03, коммит 247a9de). QA удалены с бэкапом /root/qa-cleanup-20261011-ui.json (2 users, 2 artist_profiles, 2 tracks + 4 файла, токены, уведомления; page_views обезличены). (2) Данные, A = 22.09–05.10 против B = 06–10.10: сессии на главную те же (40,1 → 41,4 в день), конверсия главной в регистрацию 3,7 % → 1,5 %; сессии с yandex.ru 26,1 → 21,4 в день, регистраций с них 16 → 0; по неделям регистрации 15/11/18/25/25/27/31 (17.08–28.09) → 15 (05.10) — откат к уровню конца августа после сентябрьского пика; заходы с Яндекса на /news рухнули с 9.10 (≈20 → 2–9 в день), на главную снижаются с 1.10. Рассылок артистам с сентября не было; волны заведениям (до 03.10) регистраций не давали. Строки is_bot, «пропавшие» 9.10 в 00:00, — краулер Meta (meta-externalagent), к людям отношения не имеют. Google Fonts/Метрика из Москвы доступны (0,1–0,2 с), Google Safe Browsing чисто, домен не в DBL/SURBL, WAF поисковиков не банит, YandexBot 10.10 обошёл 275 страниц (переобход после переезда). Причина спада — поиск (Яндекс) и его качество, не поломка; позиции и запросы видно только в Вебмастере/Метрике. (3) FE e4728aa: плашка «Заметили ошибку? Напишите нам» (RootLayout, все страницы и кабинеты кроме админки) → POST /feedback/bug-report → feedback_reports + Telegram-группа заявок, лимит 5/час с IP.
2026-10-11T14:10:00Z | manual (владелец: «оповещения пришли только в группу в тг… чини»): все письма сайта уходят (exim Арбата → релей Soul FM 187.77.85.42 → получатели), Gmail принимает, но mx.yandex.net с 11.10 08:00 МСК отклоняет каждое письмо на info@promofm.ru: «554 5.7.1 Message rejected under suspicion of SPAM» (до 10.10 22:47 МСК те же письма принимались, «250 Ok: queued»). Проверено 4 тестами на info@promofm.ru: promo-music.ru через релей, promo-music.ru напрямую с 87.242.64.88, promofm.ru через релей, promofm.ru напрямую — все 554. Причина на стороне репутации IP у Яндекса, своими средствами не лечится; под удар попадают и письма подтверждения пользователям с ящиками на Яндексе. Для теста promofm.ru получил DKIM (селектор arbat, ключ /etc/exim4/dkim/promofm.ru.private, запись arbat._domainkey.promofm.ru) и SPF += ip4:87.242.64.88 ip4:187.77.85.42 (бэкап зоны /root/zone-promofm.ru.bak-20261011-dkim) — оставлено, безвредно. Решение: отправка через доверенный сервер — SMTP reg.ru mail.hosting.reg.ru:587 (AUTH PLAIN LOGIN есть, порт с Арбата открыт) под ящиком noreply@promo-music.ru: в .env API SMTP_HOST/SMTP_PORT=587/SMTP_PASS — нужен пароль ящика от владельца; либо включить старый VPS reg.ru 194.67.122.99 (релей на нём настроен) и вписать его в /etc/exim4/relay; в перспективе PTR для 87.242.64.88 от masterhost.
2026-10-11T15:30:00Z | manual (владелец прислал пароль ящика noreply@promo-music.ru на reg.ru): почта API переведена на reg.ru — .env SMTP_HOST=mail.hosting.reg.ru, SMTP_PORT=587, SMTP_PASS, SMTP_TLS=true (бэкап /root/promofm-env.bak-20261011-regru; пароль также в /root/.regru-noreply.pass, 600, для IMAP-проверки отказов). Код c081468: email-helper и smtp-sender шлют через reg.ru, при отказе — 127.0.0.1:25 (exim → релей Soul FM), затем Resend. Лимит reg.ru — 3000 писем в сутки на ящик, 50 адресатов на письмо, лимита в час нет. Проверено: логин ок, Gmail принимает (тест 9), но Яндекс по-прежнему отклоняет письма от noreply@promo-music.ru на info@promofm.ru и через reg.ru («554 5.7.1 … suspicion of SPAM», тесты 6, 7, 8A–8C: HTML/текст, с X-Mailer и без, EHLO arbatsite/arbatsite.ru); принят только первый тест 5 (простой текст, 17:05). Вывод: фильтр Яндекса против отправителя noreply@promo-music.ru (для этого ящика или для домена целиком), а не против сервера. Нужно от владельца: белый список и «Не спам» в info@promofm.ru, любой другой ящик на Яндексе для одного теста, регистрация promo-music.ru в Яндекс Почтовом офисе. Отказы видны в ящике noreply@ (IMAP mail.hosting.reg.ru:993, письма от Mailer-Daemon@server221.hosting.reg.ru).
2026-10-11T15:15:00Z | manual (владелец: «забудь про рег ру, видимо из-за ситуации у Яндекса проблемы, там сегодня разбомбили серверы»): почта API возвращена на прежний путь — .env SMTP_HOST=127.0.0.1, SMTP_PORT=25, SMTP_PASS и SMTP_TLS удалены (бэкапы /root/promofm-env.bak-20261011-regru и -before-revert; /root/.regru-noreply.pass удалён). Код c081468 остаётся: при локальном SMTP запасной транспорт не создаётся, поведение как до 11.10; вернуть reg.ru — три строки в .env и рестарт. Контекст: 08.10 дата-центр Яндекса в Сасово остановлен после пожара от ударов БПЛА, Яндекс Почта работала с перебоями; отказы «554 suspicion of SPAM» начались 11.10 08:00 МСК. Тест 10 в Gmail через exim → релей Soul FM ушёл. Завтрашняя рассылка радио (12:00) пойдёт этим путём; адреса на Яндексе, отклонённые с 554, собрать из /var/log/mail.log Soul FM и разослать повторно, когда Яндекс начнёт принимать.
2026-10-12T08:46:00Z | manual (владелец: «эфиры миксов для диджеев и учёт ростера для лейблов»): API 834a4f1 + FE 0b30c3e/83cce06 — «Ротации на радио» и «Заведения» с ?scope= (radio-scope.tsx): лейбл видит треки всего ростера, диджей — свои миксы. В базе создана недостающая mix_downloads_by_radio (миграция 104). Водяной знак есть только у 1 из 20 миксов, миксы в радиопакеты не попадают — решение за владельцем.
2026-10-12T10:08:00Z | manual (владелец: «сообщение… попало в багрепорт в тг и нигде не отобразилось»): fd9939b — плашка «Заметили ошибку?» создаёт тикет в поддержке (только вошедшему автору), шлёт письмо админам с Reply-To автора и колокольчик. Сообщение 12.10 08:04 (atcherni4encko@yandex.ru) перенесено в тикет TKT-138bafe5….
2026-10-12T10:35:00Z | manual (владелец: «Отправить очередь напрямую с основного сервера… попробуй»): очередь релея Soul FM после радиорассылки 12:00 — 1608 писем (порт 25 к Mail.ru/reg.ru не проходил). 1415 писем выгружены (hold) и отправлены с 87.242.64.88 напрямую: доставлено 554, 43 адреса не существуют, 821 возвращены на Soul FM (Яндекс отклоняет с Арбата «554 spam», Mail.ru с ~13:30 «550 spam message rejected» — остановлено). Скрипты и итог — /root/mailq/ (results.jsonl). Временный ключ Арбат→Soul FM удалён.
2026-10-13T09:33:00Z | manual (владелец: «новинки недели не пришли на info@promofm.ru»): контрольная копия рассылки 12.10 (Soul FM 83C45CFA5) сутки висела в очереди Soul FM — connect to mx.yandex.net:25 timed out; связь восстановилась, письмо отправлено вручную (postqueue -i), Яндекс принял 12:33 МСК. В очереди Soul FM осталось 680 писем рассылки, повторы сами. 5 запросов radio-get 12.10 13:16 без ?k= (403) — сканер ссылок почтовика, не станции.
2026-10-13T09:50:00Z | manual (владелец: «Михаила Землянникова и ВДВОЁМ — Пока мы отдыхаем скачали Soul FM (всегда 5 городов), Геленджик ФМ, Липецк… проставь на главной количество станций и городов»): track_downloads_by_radio id 22–39 (via=manual, «manual: владелец 13.10.2026», релиз #41): «Упрямая ты» и «Пока мы отдыхаем» — Soul FM × Calpe/Benidorm/Denia/Altea/Alicante, Радио Геленджик 95.7 FM, Липецк ФМ; Светлана «Я ожидаю кого то» — Soul FM добавлены 4 города к Calpe. Главная: у трёх треков 3 станции / 7 городов. Других записанных скачиваний по #41 нет.
2026-10-13T10:25:00Z | manual (владелец: «новинки недели не пришли… значит рассылка не состоялась»): проба 40 писем на Soul FM — 0 ушло: Hostinger режет исходящий порт 25 после массовой отправки 12.10 (mx.yandex.net/mxs.mail.ru connect timed out). В очереди 679 писем, срок жизни 2 суток. Ссылки «Скачать» из письма проверены полностью (страница 200, файл WAV отдаётся).
2026-10-13T14:35:00Z | manual (владелец: «включай»): почта сайта переведена на SMTP reg.ru — .env SMTP_HOST=mail.hosting.reg.ru, SMTP_PORT=587, SMTP_TLS=true, SMTP_PASS (пароль ящика в /root/.regru-noreply.pass, бэкап .env /root/promofm-env.bak-20261013-before-regru); API перезапущен, health 200; тест на info@promofm.ru принят reg.ru. Запасной путь — местный exim → Soul FM (код c081468). Досылка 650 писем очереди Soul FM через reg.ru подготовлена (/root/mailq/run_relay.sh: export_relay.sh → send_relay.py → finalize.sh, временный ключ soulfm_tmp), запуск заблокирован классификатором Claude Code — запускает владелец.
