# Security &amp; Privacy Audit — Admin Cabinet
**Date:** 2026-05-31
**Scope:** Admin кабинет (`/ctrl-pm7k2f`) — frontend + backend endpoints
**Out of scope:** Other cabinets, UX, performance, code quality

Два независимых агента проверили `Promomusicfigma/src/admin/**` и
`promofm-api` (endpoints с `requireAdmin`/`requireAdminOrKey`).
Не правлено ничего — только аудит.

---

## TL;DR — что чинить ПЕРВЫМ

| # | Зона | Что | Effort |
|---|---|---|---|
| 1 | `promofm-api` cron-скрипты | **Hardcoded `VPS_INTERNAL_KEY` в 4 файлах git-репо** = full backend admin для любого с read-доступом | ротация + `.env` + git-history scrub |
| 2 | `promofm-api` `track-moderation-routes.tsx:1167` | **`send-payment-reminders` без auth** — anyone может trigger mass email | 1 line fix |
| 3 | `promofm-api` migration 092 | **`delete_user_account` swallows ALL errors** — GDPR regression vector | переписать exception handling |
| 4 | `promofm-api` `rate-limiter.tsx:23` | **Admin role token bypasses rate limit ALL endpoints** | убрать `skip` или ужесточить |
| 5 | `Promomusicfigma` `EmailCampaigns.tsx:766` | **XSS в email preview** через `dangerouslySetInnerHTML` без sanitize (хотя `sanitizeHtml` импортирован тут же) | обернуть в sanitize |
| 6 | `Promomusicfigma` `AuthContext.tsx` | **JWT в localStorage** — exfilтрируется любым XSS (см. #5) | переход на HttpOnly cookie |

Пункты 1, 2, 3 — **incident-level**, чинить сегодня.

---

## INCIDENTS — действовать сегодня

### INC-1: `VPS_INTERNAL_KEY` plaintext в репо
**Файлы:**
- `evolve-cron.sh:7`
- `news-cron.sh:4`
- `promote-upcoming-cron.sh:18`
- `concert-announce-cron.sh:5`

Key: `b5f5cced4f4297465726e7069e35c1d113319187853b765af0e8b4df80d7acc3`

**Что unlock'ает** (через `requireAdminOrKey`):
- `charts/full-update` — expensive LLM jobs (можно abuse биллинг)
- `landing/admin/news` CRUD
- `landing/admin/tracks` CRUD
- `ecosystem/mode/evolve/run`
- `concert-agent/*`, `news-agent/*`, `release-agent/*`, `curator/*`
- `landing/seed-live`, `landing/releases/archive-past` — direct DB writes

**Любой с read-доступом к репо** имеет full backend admin. Включая всех past-collaborators, любой read-only mirror, любой ИИ который видел репо.

**Remediation:**
1. Сгенерировать новый key (`openssl rand -hex 32`)
2. Положить в `.env` на проде, в cron-скриптах читать `${VPS_INTERNAL_KEY}`
3. Force-push history rewrite для удаления старого ключа из git history
4. Audit git history на другие leak'и (grep на 64-hex strings, base64 patterns)

### INC-2: `/track-moderation/send-payment-reminders` auth bypass
**File:** `src/track-moderation-routes.tsx:1167-1177`

`requireAuth` пишет 401 через `c.json()` но **не throws**. Окружающий
`try/catch` не срабатывает. Handler падает в `success: true` на L1241.

**Результат:** unauthenticated POST → mass email blast всем артистам
с approved треками + DB writes в `last_payment_reminder_at`.

**Remediation:** заменить на Hono middleware composition (`requireAuth` как
middleware) или explicit return check.

### INC-3: `delete_user_account` swallows errors → orphan PII
**File:** `src/migrations/092_fix_delete_user_account.sql:88-91, 113, 124, 132`

Каждый per-table delete обёрнут `EXCEPTION WHEN OTHERS THEN NULL`. Если
FK constraint блокирует delete (или RLS denial), row остаётся, **ошибка
не surface'ится**, `users` row всё равно удаляется на L129 → orphan PII.

Route reports `success: true` потому что check'ает только `deletedCounts.users === 1`.

**GDPR/152-ФЗ regression vector** — пользователь думает что удалён,
PII осталась в чьих-то FK-связанных таблицах.

**Remediation:** собрать failures в `deleted_counts.errors`, route 500'ить
если non-empty.

---

## 🔴 КРИТИЧНО (Backend)

### B-1: Admin token bypasses ALL rate limiting
**File:** `src/rate-limiter.tsx:23-33, 113`

`apiLimiter.skip = isAdminToken` — токен с role=admin минует rate limit
на **каждом** `/server/api/*` endpoint. Любой compromised admin токен =
uncapped traffic (charts/full-update LLM spend, email campaigns spam, etc.).

**Plus:** `isAdminToken` проверяет только role из JWT, **не** `SUPERADMIN_EMAIL`
gate которым пользуется `requireAdmin`. То есть skip срабатывает шире чем
sам admin auth.

**Fix:** убрать `skip`, или ужесточить условие до `email === SUPERADMIN_EMAIL`.

### B-2: PII export ships `password_hash` на UUID-fallback path
**File:** `src/profile-routes.tsx:110-128`

`SELECT *` на retry path; password_hash filter (L122-128) только на первой
итерации с text-id. Если retry path заполнил `exportData.users` — pass'нул
password_hash в client.

**Fix:** strip password_hash внутри loop или column-allowlist.

### B-3: `/auth/admin/pending-users` PII leak (conditional)
**File:** `src/auth-routes.tsx:894-901`

Возвращает email + full_name + role каждого pending user. Сейчас защищено
`requireAdmin` (фактически = superadmin) — surface маленький. Но если
`requireAdmin` когда-то ослабнет — массовый дамп.

**Fix:** добавить pagination + ownership-style проверку; не возвращать
больше чем UI рендерит.

---

## 🔴 КРИТИЧНО (Frontend)

### F-1: Auth gate по email
**File:** `Promomusicfigma/src/admin/AdminApp.tsx:103`

```js
if (!isAuthenticated || isDemoMode || userRole !== 'admin' || userEmail !== ADMIN_EMAIL)
```

`userEmail !== 'n.moiseev@gmx.de'` — email это **данные**, не authorization.
`userRole === 'admin'` уже достаточно. Hardcoded email:
- Создаёт ложное чувство безопасности
- Блокирует rotation админа
- Phishing target

**Fix:** убрать email check из gate. Полагаться на серверный `userRole === 'admin'` + server-side allowlist (если нужен).

### F-2: XSS в Email Campaign preview
**File:** `Promomusicfigma/src/admin/pages/EmailCampaigns.tsx:766`

```jsx
dangerouslySetInnerHTML={{ __html: html.replace(...) }}
```

`html` — raw input из textarea (L743-749). `sanitizeHtml` **импортирован**
в этом же файле (L15) **но не вызван здесь**. `&lt;img src=x onerror=fetch('/...?'+localStorage.access_token)&gt;`
→ exfil admin JWT в admin origin.

**Fix:** обернуть в `sanitizeHtml(html.replace(...))`.

### F-3: JWT в `localStorage`
**Files:** `Promomusicfigma/src/contexts/AuthContext.tsx:117, 194, 250, 373` + `src/utils/auth/info.tsx:16`

access_token + refresh_token в `localStorage`, доступны любому JS на origin.
В связке с F-2 любой XSS = exfil admin tokens + refresh = persistent compromise.

**Fix:** HttpOnly Secure SameSite=Strict cookie + CSRF double-submit token.

### F-4: EmailCampaigns API helper без Bearer
**File:** `Promomusicfigma/src/admin/pages/EmailCampaigns.tsx:56-62`

`apiCall` не прокидывает `Authorization`. Все `/campaigns/*`, `/segment/preview`,
`/test`, `/send`, `DELETE /campaigns/:id` идут без auth header.

Либо security hole (если backend защищён только cookie), либо broken feature
(backend ожидает Bearer и rejects). Оба сценария плохие.

**Fix:** прокинуть `getAccessToken()` в headers как в `Settings.tsx:18-29`.

### F-5: Privileged actions без confirm
**Files:**
- `Promomusicfigma/src/admin/pages/UsersManagement.tsx:159-171` (`handleBlock`)
- `Promomusicfigma/src/admin/pages/PartnersManagement.tsx:87-91` (`handleDeletePartner`)

Один клик = блок реального юзера / delete партнёра. Misclick = инцидент.

**Fix:** AlertDialog confirm с указанием имени.

### F-6: PII drafts в `localStorage`
**File:** `Promomusicfigma/src/admin/pages/EmailCampaigns.tsx:518, 874-887`

`customEmails` (список любых email-адресов) сохраняется в localStorage
draft в plain JSON. На общем admin-устройстве оставшийся черновик утечёт
адресатов.

**Fix:** sessionStorage + cleanup при logout/leave.

---

## 🟠 ВАЖНО (Backend)

### B-4: `requireAdmin` фактически = `requireSuperadmin`
**File:** `src/auth-middleware.tsx:48`

Условие требует ОБА: правильную role И literal superadmin email. Любой
с role=admin но не `n.moiseev@gmx.de` получает 403. Defensive но
inconsistent с rate-limiter (который trusts role alone) и RBAC docs.

**Fix:** определиться — RBAC по role, или single-superadmin email-gate.

### B-5: Path traversal в content-orders upload
**File:** `src/content-orders-routes.tsx:228-238`

`orderId` из form body конкатенируется в filename без sanitization:
`content_${orderId}_${Date.now()}.${ext}`. Admin может прислать
`orderId=../../../etc/foo` → escape upload dir. Extension берётся из
user-supplied filename без allowlist (`.php`, `.html`).

**Fix:** validate `orderId` regex UUID; `validateFileType` как в
`storage-routes.tsx:182`.

### B-6: `X-Internal-Key` exposed via CORS
**File:** `src/index.ts:186`

`allowHeaders` включает `X-Internal-Key`. Малотчная frontend на allowed
origin (или через XSS) мог бы trigger admin endpoints если получил key.

**Fix:** удалить `X-Internal-Key` из `allowHeaders`. Cron — server-side,
не нужен browser header.

### B-7: `/email-campaigns/unsubscribe` без token
**File:** `src/email-campaigns-routes.tsx:198-221`

Нет token, нет ownership check. Attacker может mass-unsubscribe любой
известный email из всех кампаний.

**Fix:** signed unsub token в email link, validate перед mutation.

### B-8: Нет audit logging на большинстве admin actions
`audit_logs` только signup/signin/role-change/account-deletion/data-export.

**Не логируются:**
- `/admin/approve-user`, `/admin/reject-user`
- `/admin/verify-profile`
- `track-moderation/manageTrackModeration`
- `dj-mix-moderation/manage-dj-mix-moderation`
- `publish/orders/:id/status`, `publish/admin/batch-status`
- `email-campaigns/*/send`
- `landing/admin/tracks` delete
- `content-orders/orders/:id` delete

**Forensic trail отсутствует.** Кто approved Гуськову? Кто refund'нул юзера?
Никаких записей.

**Fix:** `logAuthEvent`-equivalent в каждом admin handler.

### B-9: Admin input reflected unescaped в emails
**Files:**
- `src/dj-mix-moderation-routes.tsx:181-198, 268-283`
- `src/track-moderation-routes.tsx:465`

`mix.title`, `moderator_notes`, `rejection_reason` inlined в HTML email
через string concat. Admin-controlled — но `title` от артиста.
Артист-controlled HTML в admin email.

**Fix:** HTML-escape interpolated values.

### B-10: `/admin/verify-profile` принимает role mismatch
**File:** `src/auth-routes.tsx:925-1001`

Caller выбирает таблицу (`role` param: artist/radio/venue/producer), но
нет проверки что `userId` actually имеет эту role. Admin может flip
`is_verified=true` на wrong profile row.

**Fix:** verify user's actual role matches `role` param.

---

## 🟠 ВАЖНО (Frontend)

### F-7: Secrets рендерятся в admin UI
**File:** `Promomusicfigma/src/admin/pages/Settings.tsx:891, 928, 1463, 1520, 657-658`

`tbankSecretKey`, `yukassaSecretKey`, `smtpPassword`, `apiKey`,
`telegramBotToken` грузятся `GET /api/settings/user/:id` и рендерятся
в `<input type=password>`. Маска не защищает — JS читает DOM. `showApiKey`
toggle (L61, 1463) раскрывает API key plain.

Если backend возвращает secrets через GET → компрометация одного
admin-сеанса = компрометация всех платёжных secret'ов.

**Fix:** secrets никогда не приходят клиенту. Backend хранит. UI показывает
`••••• [last 4]` + ротация. Update через write-only POST.

### F-8: CSRF protection отсутствует, но UI говорит что есть
**File:** `Promomusicfigma/src/admin/pages/Settings.tsx:790-792`

Показывает `csrfProtection: true` в UI. **Misleading** — никакого CSRF
mechanism в клиенте нет. Если когда-то перейдут на cookie-auth, всё
станет уязвимо.

**Fix:** убрать misleading UI; при переходе на HttpOnly добавить
double-submit token.

### F-9: Hardcoded URLs bypass `config.functionsUrl`
**File:** `Promomusicfigma/src/admin/pages/AdminDmReports.tsx:89, 113`

Относительные `/server/api/messaging/admin/reports` без префикса. Работает
только на same-origin. Dev/staging/preview-deploy → сломается.

**Fix:** через `config.functionsUrl`.

### F-10: Optimistic UI маскирует API failures
**File:** `Promomusicfigma/src/admin/pages/Support.tsx:417-420, 442-445, 458-461`

В `catch` стоит `toast.success(...)` (copy-paste bug). Пользователю
показывают «отправлено», даже если API упал. Admin думает что закрыл
тикет — юзер всё ещё ждёт.

**Fix:** `toast.error` в catch.

### F-11: `window.prompt` для admin-decisions
**Files:**
- `Promomusicfigma/src/admin/pages/UsersManagement.tsx:195`
- `Promomusicfigma/src/admin/pages/AdminDmReports.tsx:235, 251`

Браузерный `prompt` для rejection reason. Нет валидации длины, escaping,
audit logging. Текст идёт в backend и юзеру в email.

**Fix:** proper modal с trim + max length + warning.

---

## 🟡 ЗАМЕТКИ (hardening)

**Backend:**
- `charts-routes.tsx:18` — `requireAdminOrKey` использует non-constant-time `===`. Timing side-channel theoretical, использовать `crypto.timingSafeEqual`.
- `landing-data-routes.tsx:778-779` — same `!==` issue в `releases/archive-past`.
- `profile-routes.tsx:184-209` — Telegram alert leak'ает `userId.slice(0,8)` в TG chat (quasi-identifier в third-party).
- `auth-routes.tsx:1142` `send-activation-batch` — нет per-day global cap → можно re-flood все 5700 legacy artists в 12 calls.
- `email-campaigns-routes.tsx:659-687` `/test` — admin шлёт arbitrary HTML на arbitrary email. Fine как admin-only, но не логируется recipient для abuse trail.
- `feedback-routes.tsx:159-209` `/bug-report` rate-limit использует `context->>'ip'` (user-controlled) — bypass возможен.
- `index.ts:190` `credentials:true` в CORS — не нужен (Bearer-auth не cookie), убрать.

**Frontend:**
- `adminProfileId` в localStorage — низкий риск, ещё один артефакт сессии.
- CSV экспорт без confirm объёма (`UsersManagement.tsx:246`, `PartnersManagement.tsx:117`) — GDPR-риск, нет audit-trail.
- Auto-save email draft в localStorage навсегда (`EmailCampaigns.tsx:518`) — нет TTL.
- `URL.createObjectURL` без revoke — memory leak.
- `Settings.tsx:339-340` reset через `window.location.reload` без save — теряет несохранённые данные.
- `PublishModeration.tsx:812-829` iframe src от regex на user input — embed обычно sandboxed, но whitelist-валидация не помешала бы.
- console.log с PII (~60 мест в admin chunk) — strip-console через vite plugin.

---

## Рекомендуемый порядок remediation

### Week 1 (incidents)
1. **INC-1** — ротация VPS_INTERNAL_KEY + git history scrub
2. **INC-2** — fix `send-payment-reminders` auth
3. **INC-3** — переписать exception handling в migration 092

### Week 2 (критичные)
4. **B-1** — убрать admin skip из rate limiter
5. **F-2** — XSS sanitize в EmailCampaigns
6. **F-4** — Bearer в EmailCampaigns apiCall
7. **F-7** — secrets из admin UI (масштабный refactor)
8. **B-2** — strip password_hash в profile export

### Week 3 (важные)
9. **F-1** — убрать email-gate из AdminApp
10. **F-5** — confirm dialogs на block/delete
11. **B-5** — path traversal fix в content-orders
12. **B-7** — sign'ed unsub token
13. **B-8** — audit logging на admin actions (большая работа)

### Quarter (системное)
14. **F-3** — миграция JWT → HttpOnly cookies (требует backend changes)
15. **B-4** — RBAC vs superadmin — определиться и причесать middleware

---

## Что НЕ покрыто этим аудитом

- **Другие 7 кабинетов** (artist/dj/venue/label/radio/producer/engineer) — могут иметь те же или другие security issues
- **Public-facing endpoints** (landing, signup, public profile) — могут иметь IDOR, enumeration, abuse vectors
- **Payment webhooks** (ЮКасса/Stripe/Т-Банк) — signature verification, replay attacks
- **UX bugs** не related к security
- **Performance** (N+1, missing indexes)
- **Backend code quality** (dead code, KV anti-patterns не в admin scope)

Если нужны эти зоны — отдельные аудиты после remediation текущего списка.
