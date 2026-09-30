# Skeuos web app

Equip for the road ahead. Skeuos finds tools, provisions and gear at government, school, private and
estate auctions near you, checks every source every hour, and keeps watch until you have what you need.

This is the installable web app (PWA) for the platform in `platform/`: mobile first, with a web
layout from 1024 px. It searches live lots ranked by distance from the user's ZIP, runs standing
searches ("hunts"), keeps a watchlist with a walk-away number, plans the pickup run for won lots,
and shows alerts. **It never places bids**: the bid button opens the lot on the source site
(`lots.url`).

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
| `npm run build` | `tsc -b` (strict type check of the app, the tests, the configs and the two engines) then `vite build` into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Vitest unit tests |
| `npm run typecheck` | Type check only |
| `npm run icons` | Regenerate the favicon and PWA icons (SVG and PNG) from `src/brand/pack.ts` |

## The brand

The concept artboards are in `platform/docs/design/*.dc.html` ("Provisioned": Brand, Kit, and one
board per screen). The app follows them for colour, type, spacing, components and copy.

**The name.** The app never explains its name. "Skeuos" appears only as the wordmark and in plain
sentences such as "Skeuos never bids for you." No page or line of copy explains it, and
`src/routes.test.ts` scans the source, the shipped files and this README to keep it that way.

**The mark.** "The pack": a 48-unit drawing (handle, rounded body, flap, S-shaped strap) defined once
in `src/brand/pack.ts`. `components/Logo.tsx` draws the header lockup (the pine pack beside "Skeuos"
in Zilla Slab 700); `scripts/generate-icons.ts` draws the app icon (a pine rounded tile with the pack
in canvas and pine details) for the favicon, the PWA icons and the Apple touch icon. The generator
has no dependencies: it parses the SVG paths (arcs and relative commands included), fills with 4 x 4
supersampling (8 x 8 for the small sizes) and strokes by distance to the path, which gives the round
caps and joins the artboard uses. Its PNGs match Chromium's rendering of the same SVGs to within
anti-aliasing.

**Colour** (`src/styles/tokens.css`). Pine `#24402E` (brand, active navigation, public-seller tags),
ember `#B3431B` (primary actions, white text), brass `#E0B457` ("Worth the trip", ink text), canvas
`#F3EEE3` (ground), card `#FFFDF8`, kit `#E6DDCB` (photo placeholders, wells, the tab track), line
`#D6CBB5`, input border `#BFB199`, ink `#1E1B16`, secondary text `#3E3A31`, muted `#5A5346`, deadline
chip `#F6E3B4` with `#7A4210`, pine light `#E4ECE5` (info panels), link `#8C3514`. There is no dark
theme (`color-scheme: light`).

**Type.** Zilla Slab 600/700 for headlines and the wordmark, Public Sans for body text, IBM Plex Mono
500/600 for prices, distances, ZIPs, tags and counts. All three load from Google Fonts in
`index.html`; the service worker caches them.

**Components** (`components/Tags.tsx` and `styles/app.css`): the ink luggage-tag price (mono, a small
canvas dot, a rounded left end); seller tags in mono caps, pine for federal, state, county, city and
school, muted for private, estate and the rest; the brass "Worth the trip" badge (sleeper score 5 or
more); distance in mono caps with the trail icon ("1.4 MI"); close dates as deadline chips; hunts as a
numbered manifest (01, 02, …) with dashed separators and status pills; the sale tag (the manifest icon
and "Sale · 421 lots" in mono caps on pine light, squared, where a sale-level row has no price tag). The
Hunts tab uses the compass; the Bids tab keeps the paddle.

**Plans.** The database tiers stay `free`, `pro` and `dealer`; the app shows them as Traveler,
Outfitter and Quartermaster (`lib/plans.ts`). Display only: nothing is written with those names.

**Contrast.** Every text pair is 4.5:1 or better. The verification harness measured every rendered
text node on every screen, at 390 px and 1440 px, including input values and placeholders.

## Architecture

```
src/
  App.tsx             providers and the router, built from routes.ts
  routes.ts           every route as data (path, page, public or account, inside the shell or not)
  main.tsx            entry; registers the service worker in production builds only
  brand/pack.ts       the pack mark (one geometry for the lockup, the favicon and the PWA icons)
  data/               every Supabase call, typed (see "Data layer")
  lib/                pure logic, unit tested: money, dates, distance, search parameters, hunt drafts,
                      onboarding, the pickup run, plans, LotContext building, portfolio exposure, tiers
  providers/          AuthProvider (session), HomeProvider (home ZIP + profile), AlertsProvider (unread badge, Realtime)
  components/         app shell (top nav / bottom tabs), lot card, tags, filters, Count the cost, states
  pages/              one file per route
  styles/             tokens.css (design tokens) and app.css (plain CSS, mobile first)
sw/service-worker.js  the hand-written service worker, emitted as /sw.js by the build
scripts/              generate-icons.ts (dependency-free rasterizer)
public/               manifest, icons, _redirects, _headers
```

### Routes

| Route | Access | Page |
|---|---|---|
| `/` | public | Search: "What do you need?", the "Read as" line, sort chips, the web filter sidebar, results, "N farther away", "Keep watch for this" |
| `/lot/:id` | public | Lot: photos, the luggage-tag price, the close date, The trip, Count the cost, the plan, Bid on the source, Watch and remind me. A sale-level row: the sale tag, the close, The trip, In this sale, Open the sale, Watch and remind me |
| `/welcome` | sign-in | Before you set out: home ZIP, how far, what you are gathering (each pick becomes a hunt) |
| `/hunts` | sign-in | The hunts manifest, with plan usage |
| `/hunts/new` | sign-in | New hunt from plain language: removable chips, distance, name, "Tell me when one is listed" |
| `/hunts/:id` | sign-in | One hunt: pause, resume, check now, rename, delete; matches with dismiss |
| `/bids` | sign-in | Watching / Bid placed / Won, "If every bid wins, you owe", outcomes, the pickup-run link |
| `/bids/pickup` | sign-in | The pickup run: won lots' stops in nearest-neighbour order, what to bring, the route in Maps |
| `/alerts` | sign-in | In-app alerts, newest first, mark read, live via Realtime |
| `/profile` | sign-in | Where you set out from, how far you will travel, notifications, quiet hours, time zone, plans, source coverage |
| `/signin`, `/auth/callback` | public | Magic link and password sign-in; the link callback |

Anything else shows "There is nothing at this address". Signed-out users can search and read lots;
their home ZIP is kept in `localStorage` and carried into their profile when they sign in.

### After sign-in: "Before you set out"

`components/AfterSignIn.tsx` (used by the sign-in page and the link callback) waits for the profile,
then sends a profile with no home ZIP that has not been through it to `/welcome?next=…`, once:
finishing or skipping sets `profiles.onboarded_at` (a column 0009 lets the user write). The page
checks the ZIP against `postal_codes` as the Profile page does, saves it with the radius (25, 60, 100
or 200 mi), and makes one hunt per picked choice through the New Hunt page's own path (`parseQuery`,
`draftFromParse`, `toHuntInsert`, `createHunt`, then a first `run_my_hunt`). Each choice is one
either-or list of words sellers put in titles (`lib/onboarding.ts`), because the parser drops generic
labels such as "tools" from the text query. Picks are capped at the plan's free hunt slots
(`v_my_entitlements`, else `tier_limits`), and the page says so when the cap is reached. Skip goes on
to search (or to the page the sign-in was for).

### The pickup run

Reached from Bids (Won, or the "N won lots to pick up" link). Won watchlist lots are grouped into
stops by their pickup address: the lot's own city, state and ZIP, with the auction's street line only
when the auction's place agrees with the lot's (`lib/pickup.ts`). Stops are ordered nearest-neighbour
from the home ZIP's centroid. A stop's point is its ZIP's centroid, or, with no ZIP, its city's
(through `postal_codes`, and marked ≈); a stop that cannot be placed goes last, and a lot with no
pickup location is listed separately with a note. "Open the route in Maps" is a Google Maps
directions link from the home ZIP, through the stops, back to the home ZIP. The "What to bring"
checklist is kept in `localStorage` under a key made from the set of lots. Pickup windows are not
invented: the listing's own inspection and removal text (`lots.raw->_meta->terms`) is shown where
there is one, with "Windows come from each listing. Confirm with the seller before you drive."

### Data layer (`src/data/`)

All network access is here, typed against `database.types.ts`, a hand-written copy of the public
schema in `supabase gen types` form. Its `Update` types list only the columns 0009 grants to
`authenticated`, and `Insert` is `never` where 0009 or 0003 forbid inserts, so writing
`profiles.tier`, any alert column but `read_at`, or inserting an alert does not compile.

| Function | Table / RPC |
|---|---|
| `searchLots`, `countSearchLots` | `rpc('search_lots')` with `p_query` and `p_tsquery` (count via HEAD + `count=exact`, nulls dropped so SQL defaults apply) |
| `fetchLotCloseInfo` | `lots` → `raw->_meta->closeTimePrecise`, embedded `auctions(timezone)` |
| `getLotDetail` | `lots` with embedded `auctions`, `sources`, `categories`, `lot_images`; `pickup_geo_source` |
| `lookupPostalCode(s)`, `resolvePlace` | `postal_codes` (public read) |
| `getMyProfile`, `updateMyProfile` | `profiles` (own row; 0009 columns only, `onboarded_at` included) |
| `getMyEntitlements` | `v_my_entitlements` (plan limits and usage) |
| `listTierLimits` | `tier_limits` |
| `getSourceCoverage` | `v_source_status` |
| `listMyHunts`, `getHunt`, `createHunt`, `setHuntActive`, `renameHunt`, `deleteHunt` | `hunts` |
| `runMyHunt` | `rpc('run_my_hunt')` |
| `listHuntMatches`, `dismissHuntMatch` | `hunt_matches` with embedded `lots` (with `pickup_geo_source`), `sources`, `auctions` |
| `listMyWatchlist`, `getMyWatch`, `watchLot` (upsert on user_id, lot_id), `updateWatch`, `removeWatch` | `watchlist` with embedded `lots` and the auction's pickup address and seller |
| `listMyAlerts`, `countMyUnreadAlerts`, `markAlertRead`, `markAllAlertsRead` | `alerts` (`channel = 'in_app'`) |
| `subscribeToMyAlerts` | Realtime `postgres_changes` on `alerts`, filtered to the user |
| `sendMagicLink`, `signInWithPassword`, `signUpWithPassword`, `signOut`, `exchangeCode` | Supabase Auth |

Errors become a `DataError` with a `kind` (network, auth, not_found, hunt_limit, …). The hunt-limit
trigger's refusal becomes an upgrade prompt that names the plan ("Traveler keeps watch on 3 hunts at
a time").

**The grouped query (0018).** `search_lots` takes `p_tsquery`, the parser's `tsquery` (synonym and
model-variant groups), beside `p_query` (its `websearchQuery`); the server uses the grouped one when it
parses and falls back to the plain one otherwise. The search page sends both, on the search and on the
"farther away" count (`lib/searchParams.ts`, `toSearchArgs(…, { tsquery })`). Only the parser's own
string is sent. A hunt stores the parser's `tsquery` in `parsed`, and `run_hunt_matcher` passes it;
after a chip edit it is stored empty, because a unit's to_tsquery form depends on parser state
`ParsedQuery` does not expose (which model numbers get a prefix match), so an edited hunt is matched
by its rebuilt `websearchQuery` alone.

**Approximate distances (0016, 0018).** `search_lots`, `lots` and `auctions` report
`pickup_geo_source`. When it is `city`, the point is the city's centroid, so a distance to it is shown
as approximate: "≈ 18 MI" on cards, "about 18 mi from 53202" on the lot page (`lib/distance.ts`).

**Sale-level rows (0023).** Some sources list sales, not lots (AuctionGuide: "Farm and tool auction, 421
lots, Greenleaf WI, ends today"). Such a sale is one `lots` row with `sale_level = true`: its title,
description, close and `url` are the sale's, and its price, next bid, bid count and sleeper score are null.
`search_lots` returns `sale_level` and `sale_lot_count` (the auction's `lot_count`); the lot page, the
watchlist and hunt matches read `lots.sale_level` and `auctions.lot_count`. `LotCard` draws such a row as a
sale: "Sale · 421 lots" where a lot has its price, the close as a time of day in the viewer's zone
("Closes today, 7:00 PM"; a date-only close keeps its rule), the place and distance, and the auctioneer
(else the source); the whole card opens the lot page. There `components/SaleDetail.tsx` shows the
listing's description ("In this sale"), the close, The trip and the seller, with "Open the sale" as the
action; there is no price, bid, Count the cost or plan, and Watch saves no walk-away. On Bids a watched
sale shows as a sale and is left out of "If every bid wins, you owe"; it joins the pickup run only once
marked Won. Under the Price and Worth the trip sorts, sales come after the lots (nulls last), and the
results say so.

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
- **`@platform/strategy`** (`../packages/strategy/src/index.ts`). **Count the cost** runs the
  engine's personal-use arm (`userGoal: 'use'`, docs/06 S2): "Worth to you" is
  `estimatedValueCents` (what the same thing costs new or from a dealer), "Cushion you keep" is the
  margin kept below it, and resale costs (selling fees, shipping to a buyer, a resale profit) do not
  apply. The lot page builds a `LotContext` from the lot, auction and source rows (`lib/lotContext.ts`)
  and calls `recommend(context, now)`. "Walk away above" is `hammerCeilingCents`; `maxBidCents` is
  what to type in; the premium, tax and card fee, the trip, repairs and the risk reserve are listed.
  PLACEHOLDER and UNVERIFIED values are tagged "unverified". "Watch and remind me" saves the ceiling as
  `watchlist.max_bid_cents` and `timing.alertSecondsBefore` as `remind_seconds_before`. The Bids page
  totals exposure with `portfolioExposure`.

## Rules the UI keeps

- **Money is integer cents.** `lib/money.ts` formats with `Intl.NumberFormat('en-US', USD)` from an
  exact decimal string built with BigInt; parsing assembles cents from digits.
- **Date-only closes get no countdown.** When `raw._meta.closeTimePrecise` is false (GSA), the UI
  shows "Closes <date> · time not published" in the deadline style, with the date stated in the
  auction's time zone.
- **No invented numbers or facts.** With no worth entered, Count the cost asks for one instead of
  showing a number. The pickup run shows only addresses, windows and terms the listings give.
- **Alert bodies are the database's.** Titles and bodies from 0013 are shown as written; only the
  labels the app composes ("Found · Generator, up to $800", "Closing soon", "Outbid", "Sold") follow
  the app's voice.

## PWA

`public/manifest.webmanifest` (name and short name "Skeuos", theme `#24402E`, background `#F3EEE3`)
with SVG and PNG icons. The service worker is hand-written: at build time a small Vite plugin injects
the build's file list and a build id. It precaches that app shell, serves page loads network first
with the cached shell as the offline fallback, and caches Google Fonts (stale-while-revalidate, cache
`skeuos-fonts-v2`; older font caches are dropped on activate). It never caches API responses:
Supabase and listing-photo requests are not intercepted. It is registered in production builds only.

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
building the LotContext from database rows, Count the cost on the engine's personal-use arm, parseQuery
output to the hunts insert (and chip edits), the hunts manifest line, sidebar filters to
`search_lots` parameters (with `p_tsquery`), approximate distances, portfolio exposure, plan names,
onboarding (each choice's hunt through the New Hunt path, and the plan cap), the pickup run (stop
grouping, nearest-neighbour order, the Maps link, the checklist key), the route table, the
name rule, the row mappers, and sale-level rows. The `*.test.tsx` files render components to static
markup with `react-dom/server` (no DOM needed): the sale card, the sale's lot page and a watched sale on
Bids, beside the unchanged lot card, lot page and watch card.

ZIP code data: U.S. Census Bureau ZCTA gazetteer (public domain) and GeoNames (CC BY 4.0), credited on
the Profile page.
