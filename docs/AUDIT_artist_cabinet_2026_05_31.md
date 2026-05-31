# Artist Cabinet Security & Quality Audit — 2026-05-31

**Scope:** Кабинет артиста (frontend Promomusicfigma `src/cabinet/`, `src/artist/`, `src/app/components/`; backend promofm-api `src/tracks-routes.tsx`, `src/artist-profile-routes.tsx`, `src/auth-routes.tsx`, `src/vps-userdata.tsx`).

**Метод:** 4 параллельных audit-агента (Explore subagents):
- Mocks/fallback в UI
- API integration (silent-drop, missing endpoints, 500-prone)
- Dead UI (empty handlers, coming-soon placeholders)
- Security/privacy (PII, authz, XSS, audit log, rate limit)

**Шкала:** 🔥 INC (incident) / 🔴 КРИТ / 🟠 ВАЖНО / 🟡 ЗАМЕТКА. Та же что использовалась в admin-аудите 2026-05-31.

---

## 🔥 INCIDENTS

### INC-A1 — `/tracks/radio-stats/all` data leak (competitor analytics)
**Файл:** `promofm-api/src/tracks-routes.tsx:329-339`

При попадании в "fallback" ветку (артист без треков с pickups) endpoint возвращает radio_count/city_count для **ВСЕХ треков ВСЕХ артистов** в БД:

```ts
// Fallback: if no results by user_id, return all tracks with radio pickups
if (result.rows.length === 0) {
  result = await pool.query(`
    SELECT trp.track_id, COUNT(DISTINCT trp.station_name) as radio_count, ...
    FROM track_radio_pickups trp
    GROUP BY trp.track_id
  `);
}
```

Авторизация есть (`if (!userId) return 401` на L313), но **fallback игнорирует** owner-check. Любой новый артист → видит chart активности всех треков платформы. Конкурентная analytics leak.

Дополнительно: catch на L353 возвращает `success: true, data: {}` — error прячется, клиент думает что "у меня нет stats".

**Fix:** удалить fallback ветку полностью. catch → 500 с `success: false`.

### INC-A2 — JWT в plaintext localStorage (XSS exfiltration vector)
**Файлы:** `Promomusicfigma/src/contexts/AuthContext.tsx:117,194`, `src/utils/api/fetch-with-auth.ts:19`

`access_token` + `refresh_token` лежат в `localStorage` без encryption. Любой XSS в кабинете артиста (а dangerouslySetInnerHTML встречается — см. A-4) → exfil токенов. Это та же проблема что F-3 в admin-аудите.

**Fix:** требует архитектурный refactor (HttpOnly Secure SameSite cookies + backend CORS adjust). Оставляем в Phase D как F-3.

---

## 🔴 КРИТ

### B-A1 — Нет audit logging на destructive artist actions
**Файлы:** `promofm-api/src/artist-profile-routes.tsx` (PUT /profile, POST /request-verification), `src/tracks-routes.tsx` (DELETE /:id, submit track)

В admin-аудите B-8 (PR #139) добавили `logAdminAction` для admin actions. Аналог для **artist self-service** отсутствует. 152-ФЗ / GDPR требуют audit-trail на data modifications.

**Fix:** добавить `logArtistAction(c, {action, resourceType, targetId})` helper и подключить к:
- `PUT /artist-profile/profile/:artistId` → `artist_profile_update`
- `DELETE /tracks/:id` → `artist_track_delete`
- `POST /artist-profile/request-verification` → `artist_verification_request`
- account closure / email change

### B-A2 — Нет rate-limit на destructive artist endpoints
**Файлы:** `promofm-api/src/tracks-routes.tsx` (DELETE, PUT), `src/artist-profile-routes.tsx`

`uploadLimiter` ограничивает POST `/tracks`, но `DELETE /:id`, `PUT /profile` — нет лимита. Артист может в burst:
- удалить все свои треки (если accountом завладели через XSS из INC-A2)
- спамить profile-PUT (триггерит email confirmation loops если email меняется)
- спамить `POST /request-verification` → завалить admin-inbox

**Fix:** обернуть в существующий `uploadLimiter` или создать `profileLimiter` (5 req/min/user).

### B-A3 — Hardcoded fake metrics в analytics fallback
**Файл:** `Promomusicfigma/src/cabinet/analytics-page.tsx:204-207`

При ошибке API stat-cards показывают `"31.4K plays"`, `"2.8K listeners"`, `"4.2K likes"` — захардкоженные числа выглядящие как реальные данные. Артист видит одни и те же показатели снова и снова → trust degradation, может принять бизнес-решение на ложных данных.

**Fix:** заменить на skeleton-loader или явное "Данные временно недоступны" сообщение.

---

## 🟠 ВАЖНО

### A-1 — Dead UI: «Подключить» для Промо-коинов
**Файл:** `Promomusicfigma/src/cabinet/settings-page.tsx:2871`

```ts
onClick={() => toast.success('Способ оплаты будет добавлен')}
```

Кнопка показывает success-toast вместо реальной работы. Юзер думает что подключил Промо-коины как способ оплаты — ничего не произошло. Misleading UX.

**Fix:** удалить кнопку (если фича не планируется) или disable + tooltip "В разработке".

### A-2 — Dead onClick на карточке трека в TOP 20
**Файл:** `Promomusicfigma/src/cabinet/analytics-page.tsx:755`

```ts
onClick={() => { /* track detail disabled — see PR commit */ }}
```

Карточка имеет cursor=pointer + onClick, но handler пустой. Юзер кликает — feedback'а нет.

**Fix:** убрать onClick и cursor=pointer, либо реализовать модалку (зависит от существования track-detail endpoint).

### A-3 — Dead onClick на GenreTag (2 места)
**Файлы:** `src/app/components/track-upload-page.tsx:136`, `src/cabinet/pitching-page.tsx:520`

```ts
<GenreTag genre={g} size="sm" onClick={() => {}} />
```

GenreTag принимает onClick, теги выглядят кликабельно — но handler пустой. Сигналит интерактивность которой нет.

**Fix:** убрать `onClick` пропс (компонент по дефолту non-interactive) или реализовать фильтр по жанру.

### A-4 — track-upload без MIME verification
**Файл:** `Promomusicfigma/src/app/components/track-upload-page.tsx:21-29,200-250`

Frontend проверяет только file.size. MIME guessed by extension — артист может загрузить .exe переименованный в .mp3 / .png. Backend хранит как есть, nginx отдаёт с image/audio Content-Type → MIME confusion attack.

**Fix:** валидировать `file.type` против allowlist (`['audio/mpeg','audio/wav','image/jpeg','image/png']`) до upload.

### A-5 — track-upload без input length validation
**Файл:** `Promomusicfigma/src/app/components/track-upload-page.tsx:66-84,400`

`title`, `artist`, `description`, `musicComposer`, `lyricist` шлются без length-check / control-char strip. Backend whitelist помогает но не валидирует длину/encoding — может попасть в SQL/email-template чрезмерно длинная строка, control chars в email → CRLF injection.

**Fix:** validate `title.length ≤ 200`, strip `\x00-\x1f` из всех text fields перед POST.

### A-6 — localStorage fallback synthesizes fake email
**Файл:** `Promomusicfigma/src/utils/api/artist-profile.ts:94-145` (getLocalFallback)

Если API падает, профиль восстанавливается из localStorage И email синтезируется как `${name.toLowerCase()}@promo.fm`. Юзер видит чужой/выдуманный email в своём кабинете → может принять за официальный.

**Fix:** при API failure → return null + показать error UI, без fallback-synthesis.

### A-7 — Dead Component UploadPage не используется
**Файл:** `Promomusicfigma/src/app/components/upload-page.tsx`

Экспортирован, но в кабинете артиста используется `TrackUploadPage` (другой файл). Dead code — рискует получить fix-by-mistake в неактивном файле.

**Fix:** удалить файл `upload-page.tsx`.

### A-8 — JWT clock skew check missing
**Файл:** `Promomusicfigma/src/contexts/AuthContext.tsx:137-144`

`(payload.exp * 1000) > Date.now()` — без tolerance. Server clock на 1сек ahead → токен silently rejected, артист залогаут без error.

**Fix:** буфер 30s: `(payload.exp + 30) * 1000 > Date.now()`.

---

## 🟡 ЗАМЕТКИ (defense-in-depth)

- **D-A1** `/artist-profile/:id/stats` public — нет rate-limit на enumeration attack
- **D-A2** `POST /request-verification` — нет cooldown, можно спамить кнопку
- **D-A3** Refresh token rotation отсутствует — leaked refresh token usable indefinitely
- **D-A4** No JSON schema validation на PUT /profile — relies на ALLOWED_UPDATE_FIELDS whitelist (работает, но fragile)
- **D-A5** home-page.tsx:283 «Ротаций в заведениях: Скоро» — intentional placeholder (нет SQL источника для venue plays). OK как is, но желательно либо реализовать, либо убрать card.
- **D-A6** subscription-page.tsx:580 «Промо-коины: Скоро» — intentional, правильно disabled. ОК.

---

## Что НЕ нашли

- **Silent-drop полей**: migration 057 закрыла все 6 ранее-затерянных fields (`label`, `manager`, `booking_email`, `career_start`, `languages`, `location`). Verified в `vps-userdata.tsx:161-196` — все маппятся в INSERT + ON CONFLICT UPDATE (COALESCE).
- **Missing endpoints**: все frontend `fetch('/server/api/...')` имеют backend match. Routes registered в `index.ts`.
- **RLS/RBAC bypass**: `requireOwner('userId')` корректно используется. Ownership-check robust.
- **Coming-soon dead routes**: все routes в `/artist` ведут на реальные страницы. Нет dead tabs.
- **Inline mocks**: основной кабинет — чистый. Mocks только в `video-page.tsx` demoVideos (показывается ТОЛЬКО при 0 видео — acceptable demo-pattern).

---

## Приоритизированный план фиксов

| Phase | PR | Что | Приоритет |
|---|---|---|---|
| **1** | Backend #1 | INC-A1 radio-stats fallback drop (CRITICAL data leak) | 🔥 СРОЧНО |
| **1** | Backend #2 | B-A1 audit logging + B-A2 rate-limit | 🔴 |
| **1** | Frontend #1 | B-A3 analytics fake metrics + A-1/A-2/A-3 dead UI cleanup + A-7 dead file | 🔴+🟠 |
| **1** | Frontend #2 | A-4 MIME + A-5 length + A-6 localStorage synth + A-8 clock skew | 🟠 |
| **Phase D** | — | INC-A2 JWT→cookies (= F-3) | требует архитектурного решения |

Phase 1 — **4 PR'а**. Все могут идти параллельно от main (нет зависимостей).
