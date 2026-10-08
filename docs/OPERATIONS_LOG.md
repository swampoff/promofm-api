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
