# Skeuos web app

Every useful thing, at every auction near you. Skeuos (σκεῦος) is the New Testament Greek word for a
vessel, and for household goods, tools and gear of every kind; see `/about` in the app.

This is the installable web app (PWA) for the platform in `platform/`: mobile first, with a web
layout from 1024 px. It searches live lots from federal, state, county, school, private and estate
auction sites ranked by distance from the user's ZIP, runs standing searches ("hunts"), keeps a
watchlist with a walk-away number, and shows alerts. **It never places bids**: the bid button opens
the lot on the source site (`lots.url`).

The directory is self-contained. The repository root is a different app (AgentHQ); nothing here
reads or changes its `package.json`, `tsconfig` or Netlify settings.

## Setup

Requires Node 22.12 or newer.

```sh
cd platform/web
npm install
cp .env.example .env.local      # then paste the project's anon key
npm run dev                     # http://localhost:5173
```

### Environment

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://sfolywzqtxcdorjwnmsz.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the project's **public** anon key |

`.env.production` holds the real public values, so `npm run build` works with no setup. The anon key
is designed to ship to browsers; row-level security (`supabase/migrations/0003_rls.sql`) and column
grants (`0009_column_privileges.sql`) are what protect data. Without the variables the app shows a
"not configured" screen instead of failing.

For sign-in links to work, add `https://<your host>/auth/callback` (and `http://localhost:5173/auth/callback`
for development) to the Supabase project's Auth redirect URL allow list.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server (no service worker in development) |
| `npm run build` | `tsc -b` (strict type check of the app, the configs and the two engines) then `vite build` into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Vitest unit tests |
| `npm run typecheck` | Type check only |
| `npm run icons` | Regenerate the favicon and PWA icons (SVG and PNG) from `src/brand/jar.ts` |

## Architecture

```
src/
  App.tsx             routes and providers
  main.tsx            entry; registers the service worker in production builds only
  brand/jar.ts        the clay-jar mark (one geometry for the logo, favicon and PWA icons)
  data/               every Supabase call, typed (see "Data layer")
  lib/                pure logic, unit tested: money, dates, search parameters, hunt drafts,
                      LotContext building, portfolio exposure, tiers, distance, storage
  providers/          AuthProvider (session), HomeProvider (home ZIP + profile), AlertsProvider (unread badge, Realtime)
  components/         app shell (top nav / bottom tabs), lot card, filters, walk-away calculator, states
  pages/              one file per route
  styles/             tokens.css (design tokens) and app.css (plain CSS, mobile first)
sw/service-worker.js  the hand-written service worker, emitted as /sw.js by the build
scripts/              generate-icons.ts (dependency-free rasterizer)
public/               manifest, icons, _redirects, _headers
```

### Routes

| Route | Access | Page |
|---|---|---|
| `/` | public | Search: plain-language box, "Read as" line, sort chips, desktop filter sidebar, results, "N more farther than X mi", Save as a hunt |
| `/lot/:id` | public | Lot detail: photos, honest close time, pickup and fees, walk-away calculator, the plan (strategies with evidence labels), Bid on the source, Watch and remind me |
| `/hunts` | sign-in | Hunts with plan usage, status, match counts |
| `/hunts/new` | sign-in | New hunt from plain language: removable chips, distance, name, alert toggle |
| `/hunts/:id` | sign-in | One hunt: pause, resume, check now, rename, delete; matches with dismiss |
| `/bids` | sign-in | Watching / Bid placed / Closed, "I placed my bid", outcome, "If every bid wins, you owe" |
| `/alerts` | sign-in | In-app alerts, newest first, mark read, live via Realtime |
| `/profile` | sign-in | Home ZIP and radius, notifications, quiet hours, time zone, plans, source coverage |
| `/about` | public | What the name means |
| `/signin`, `/auth/callback` | public | Magic link and password sign-in; the link callback |

Signed-out users can search and read lots; their home ZIP is kept in `localStorage` and carried into
their profile when they sign in.

### Data layer (`src/data/`)

All network access is here, typed against `database.types.ts`, a hand-written copy of the public
schema in `supabase gen types` form. Its `Update` types list only the columns 0009 grants to
`authenticated`, and `Insert` is `never` where 0009 or 0003 forbid inserts, so writing
`profiles.tier`, any alert column but `read_at`, or inserting an alert does not compile.

| Function | Table / RPC |
|---|---|
| `searchLots`, `countSearchLots` | `rpc('search_lots')` (count via HEAD + `count=exact`, nulls dropped so SQL defaults apply) |
| `fetchLotCloseInfo` | `lots` → `raw->_meta->closeTimePrecise`, embedded `auctions(timezone)` |
| `getLotDetail` | `lots` with embedded `auctions`, `sources`, `categories`, `lot_images` |
| `lookupPostalCode(s)`, `resolvePlace` | `postal_codes` (public read) |
| `getMyProfile`, `updateMyProfile` | `profiles` (own row; 0009 columns only) |
| `getMyEntitlements` | `v_my_entitlements` (plan limits and usage) |
| `listTierLimits` | `tier_limits` |
| `getSourceCoverage` | `v_source_status` |
| `listMyHunts`, `getHunt`, `createHunt`, `setHuntActive`, `renameHunt`, `deleteHunt` | `hunts` |
| `runMyHunt` | `rpc('run_my_hunt')` |
| `listHuntMatches`, `dismissHuntMatch` | `hunt_matches` with embedded `lots`, `sources`, `auctions` |
| `listMyWatchlist`, `getMyWatch`, `watchLot` (upsert on user_id, lot_id), `updateWatch`, `removeWatch` | `watchlist` with embedded `lots` |
| `listMyAlerts`, `countMyUnreadAlerts`, `markAlertRead`, `markAllAlertsRead` | `alerts` (`channel = 'in_app'`) |
| `subscribeToMyAlerts` | Realtime `postgres_changes` on `alerts`, filtered to the user |
| `sendMagicLink`, `signInWithPassword`, `signUpWithPassword`, `signOut`, `exchangeCode` | Supabase Auth |

Errors become a `DataError` with a `kind` (network, auth, not_found, hunt_limit, …). The hunt-limit
trigger's message ("Hunt limit reached…", `check_violation`) becomes an upgrade prompt.

### The engines

Both are sibling zero-dependency packages imported from source through path aliases
(`vite.config.ts` `resolve.alias`, `tsconfig.app.json` `paths`, `allowImportingTsExtensions`):

- **`@platform/query`** (`../packages/query/src/index.ts`). `parseQuery(text, { homePostalCode,
  defaultRadiusMiles })` runs on every search. Its `searchParams` feed `search_lots` through
  `lib/searchParams.ts`, where the sort chips and sidebar override what the words said. Its
  `explanation` fills the "How your words were read" panel. For hunts, `parse.hunt` (hunts column
  names) becomes the insert payload in `lib/huntDraft.ts`; chips remove fields, and the draft
  rebuilds `parsed.websearchQuery`, which is what `run_hunt_matcher` (0013) searches with. The unit
  tests check the rebuild reproduces the parser's own string.
- **`@platform/strategy`** (`../packages/strategy/src/index.ts`). The lot page builds a `LotContext`
  from the lot, auction and source rows plus the user's resale estimate and margin
  (`lib/lotContext.ts`) and calls `recommend(context, now)`. It shows `hammerCeilingCents` as the
  walk-away number, `maxBidCents` as what to type in, the breakdown, the timing instruction and the
  ranked strategies. PLACEHOLDER and UNVERIFIED values are tagged "unverified". "Watch and remind
  me" saves the hammer ceiling as `watchlist.max_bid_cents` and `timing.alertSecondsBefore` as
  `remind_seconds_before`. The Bids page totals exposure with `portfolioExposure`.

## Rules the UI keeps

- **Money is integer cents.** `lib/money.ts` formats with `Intl.NumberFormat('en-US', USD)` from an
  exact decimal string built with BigInt; parsing assembles cents from digits.
- **Date-only closes get no countdown.** When `raw._meta.closeTimePrecise` is false (GSA), the UI
  shows "Closes <date> · time not published" in the amber style, with the date stated in the
  auction's time zone.
- **No invented numbers.** With no resale estimate the calculator asks for one instead of showing a
  number.

## PWA

`public/manifest.webmanifest` (name and short name "Skeuos", theme `#C2410C`, background `#F6F3EC`)
with SVG and PNG icons. The service worker is hand-written: at build time a small Vite plugin
injects the build's file list and a build id. It precaches that app shell, serves page loads network
first with the cached shell as the offline fallback, and caches Google Fonts. It never caches API
responses: Supabase and listing-photo requests are not intercepted. It is registered in production
builds only.

## Deployment

It is a static single-page app: build with `npm run build` and serve `dist/`. **The host must rewrite
every path to `/index.html`**, or deep links such as `/lot/…` and `/auth/callback` return 404.

- Netlify: set the site's base directory to `platform/web`. `netlify.toml` here sets the build, and
  `public/_redirects` holds `/* /index.html 200`. `public/_headers` keeps `sw.js` uncached.
- Vercel: set the root directory to `platform/web`. `vercel.json` has the SPA rewrite and headers.
- Anywhere else: add an equivalent fallback rewrite, and serve `sw.js` with `Cache-Control: no-cache`.

iOS uses `icons/apple-touch-icon.png` for the home screen; an installed iOS web app keeps its own
storage, so a magic link opened in Safari signs in Safari. Password sign-in works inside the installed app.

## Tests

`npm test` covers money and date formatting, close-time rendering (precise versus date-only),
building the LotContext from database rows, parseQuery output to the hunts insert (and chip edits),
sidebar filters to `search_lots` parameters, portfolio exposure, and the row mappers. ZIP code data:
U.S. Census Bureau ZCTA gazetteer (public domain) and GeoNames (CC BY 4.0), credited on the Profile page.
