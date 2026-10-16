# PROMO.AIR owner cabinet prototype

Route: /cabinet/. Started 16.10.2026 from user-provided 345C2115-A8F0-4E44-A82C-52FB6F5BA4E9.jpeg and latest sketch discussion.

## Design
Permanent sidebar and light topbar, a single hero on Home, 3 meaningful demo counts, restrained material accents. Nico is bald with orange glasses and headphones in Home banner only; a small Sandra curator accent supports the library. Venues have no Nico; Playlists is minimal with vinyl, ceramic cup, speaker and soft ring cover motifs. White/light blue, orange controls, Unbounded/Manrope, Design by Promo.Art. Sidebar becomes a mobile drawer. Sticky audio dock persists across screens.

New image: assets/cabinet-hero.webp. Generated with built-in imagegen using supplied sketch as reference; sunny cafe scene on right, bald Nico with glasses/headphones, pale blue negative space on left, no text or UI. Original generator output retained. CSS cover motifs are code-native.

## Screens and local interactions
Home; My venues (filter/search, add/edit); Playlists (search/moods/favorites, local drafts); Schedule (venue/day selection, 4 slots); Zones/devices (per-venue, add/toggle/format/volume); Radio/jingles (greeting draft, text brief); Advertising (text announcement drafts); Analytics (local listening duration and local counts, empty telemetry); Billing (marketing plans, link to real login); Support (FAQ, link to real service). Global search across demo venues and music formats.

## Data boundary
localStorage key promo-air-cabinet-v1, versioned schema validation. All user-input strings escaped before rendering. HTMLAudio plays only the included sketches on current device; persistent single audio element, play request guard, scrub/volume/previous/next. No authenticated API, billing, real schedule execution, audio generation, sending or live-device commands. No invented visitor uplift or account telemetry.

## Integration
Reuse existing venue identity/auth, player context, tariff loader and role/tenant ACL in real codebase. Replace local data layer with discovered APIs; never invent endpoints from this prototype. Existing production login is linked. Marketing prices are dated to 15.10.2026 and must be loaded from billing before production. Keep noindex until integration. The prior handoff files describe backend boundaries in more detail.

## Verification
JS syntax, all 10 screen render functions executed in a lightweight DOM stub, template resource paths checked. This does not verify actual browser layout or controls. Managed browser QA unavailable: visual checks, keyboard/dialog flows, iOS Safari playback and mobile widths remain required.
