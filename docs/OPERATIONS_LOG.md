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
