# PROMO.AIR: integration handoff

Independent design preview, not an update to production promo-music.ru.

## Verified public architecture, 15 October 2026
- React SPA, Vite-style hashed assets. Root div and vendor-react, vendor-motion, vendor-ui and vendor-charts chunks.
- Production canonical route in router: /promo-air. /promoair was not found in published router. Do not replace existing route. Add alias only after source review.
- Existing login: /login. Registration appears in unified authentication flow; do not invent /register.
- Related routes: /promo-air/own-radio, /promo-air/audio-branding, /promo-air/in-store-music, /promo-air/network-radio, /promo-air/wine-bars, /promo-air/legal-music, /promo-air/demo.
- Public support navigation: /support-info.
- Published pages mention schedules, zones, network management, jingles, browser and Android playback. Runtime functionality and API contracts were not independently tested.
- Public texts contain inconsistent trial periods. This design uses user-confirmed 7 days without payment.
- Public bundle contains marketing price constants; no authoritative billing-settings API was available. No prices or payment promises are displayed.
- GitHub list_repositories returned no repositories. No production code or authorization state was modified.

## Integration boundary
Port Header, Hero, SpaceGallery, DemoPlayer, FeaturePanel, DayTimeline, RadioSection, NetworkOverview, StartSteps, PlanCards and Footer into existing components. Preserve existing auth providers, backend clients, role selection and payment handlers. Replace external navigation with existing router components only after inspecting source.

Use the actual product tariff loader and checkout components; do not add speculative endpoints. Retain demo labels until backed by authenticated server state. Current player simulates states without audio; demo listening link goes to production demo page.

## Design
styles.css contains reusable CSS variables for palette, fonts, radius and shadow. Layout uses 1/2, 1/3 and 1/4 proportions corresponding to a 12-column content grid. Sections use responsive grids. Assets are original imagegen renders converted to WebP. Collection is rendered from one atlas using background positioning. Time-of-day scene uses a lighting treatment of the same cafe, not distinct generated renderings. Network section is an illustrative collection, not live telemetry.

## Validation and remaining work
JavaScript syntax and local asset/link references checked. Managed browser QA was unavailable, so visual viewport and keyboard verification remain necessary before production integration. Verify fonts, real route behavior, audio loading/error states, WCAG contrast, CSP, analytics consent, canonical metadata, mobile overflow, billing and registration end-to-end in the real repository.

Preview uses noindex. Remove only after production route SEO review. No licensing claims or testimonials included.

## Internal page expansion
Added static routes under /promo-air/: demo, in-store-music, own-radio, audio-branding, network-radio, legal-music, artists, wine-bars, plus /promo-air/ homepage alias. Shared navigation remains connected to production login. No authentication or billing replacements.
Four local instrumental sketches in assets/preview-*.wav demonstrate real HTML audio playback, volume, pause, repeat and selection. These are procedural original sketches, not the service catalogue. Schedule is browser-local, zone controls are UI examples, brand greeting is a text preview. No backend changes or live device commands.
Validation: JS syntax, all root-relative local resources and links, four WAV files. Browser QA unavailable in this environment; mobile layout still needs visual QA. Preserve noindex until integration.

## Visual polish v4
New portrait atlas characters-v4.webp generated with built-in imagegen using hero-mobile.webp as identity reference. Brief: four floating glossy vinyl heads on pale sky blue, 2x2; bald orange Nico, turquoise Sandra, lavender/chrome Leo, mint/pearl Mia; no text or bodies. Original generated output preserved. UI uses shared acrylic buttons, glass player surface, native SVG controls, pause-linked vinyl/equalizer, previous/next mood, and elapsed time. Homepage mini-player now plays the local sketch. Pointer tilt is desktop-only; reduced-motion disables decorative motion. Browser visual QA remains unavailable; syntax and local route/asset checks passed.

## Reference correction v5
User supplied IMG_2730 through IMG_2736: premium collectible full-body vinyl toys, sunny miniature venues, pale blue/white base, orange accents and glass tablet product UI. Replaced realistic head atlas with characters-v5.webp: bald Nico with orange glasses/headphones, Sandra cafe character, lavender Leo, mint Mia. Added character roles and descriptions. New hero-v5.webp shows same toy Nico over miniature cafe with clouds and glass ring. Built-in imagegen used; prompts specify molded toy materials, complete figures, no realistic skin or text. Shared assets retained without overwriting earlier versions. Homepage dashboard redesigned as glass tablet with working navigation and local audio preview. Browser QA unavailable; route/asset checks and JS syntax passed.
