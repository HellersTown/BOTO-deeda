# 12. Session handoff: carrying Skeuos into a new Claude Code account

Written 2026-10-09 at 02:00 UTC. It closes the Claude Code session that built
Skeuos under the owner's Max plan. The owner now works from a Team account, and
nothing from the old session carries over except this repository and the live
services: no chat history, no scratchpad files, no scheduled check-ins and no
connector grants.

A new session should read this file first, then `docs/11` (database load) and
`docs/10` (permission letters). Everything below was checked against the live
project when it was written. The **Live state** section is a snapshot, so re-run
its queries before acting on it.

---

## 1. Starting a session on the new account

### What the new account must connect

| What | Why | Where |
|---|---|---|
| GitHub: the `HellersTown` account, and the Claude GitHub App installed on `HellersTown/BOTO-deeda` | Clone, push and the PR | https://claude.ai/connect-github. A session's repositories are picked when it starts, so start the session with `BOTO-deeda` selected. |
| Supabase connector, signed in to the Supabase account that owns project `sfolywzqtxcdorjwnmsz` | Every database read, migration, Edge Function deploy and log query | https://claude.ai/customize/connectors, then start a **new** session. Connectors are read when a session starts. |
| Vercel connector, for team `team_UECdYAtzcZcLm1VYYP6QFcOL` | Deploying and checking waystock.org | Same page |
| Gmail (optional) | Only if the owner asks for a permission letter as a draft | Same page |

The default cloud network policy is enough for the repository, npm and the
tests. The MCP tools run outside the container and need no allowed domains. To
check the live site in a real browser from the container, add `www.waystock.org`
to the environment's allowed domains. The setting is under the environment menu
in the session title bar, then **Edit**, then **Network access**.

### Prompt to paste into the first new session

> Read `platform/docs/12-session-handoff.md`, then `platform/docs/11-database-load.md`.
> Continue Skeuos from that handoff on branch `claude/waystock-auction-aggregator-66n8dv`
> (draft PR #1). Re-run the live-state queries in §4 of the handoff before
> changing anything, and tell me what changed since 2026-10-09 02:00 UTC.

A new session may be handed a different working branch name. The work lives on
`claude/waystock-auction-aggregator-66n8dv`, and Vercel deploys and PR #1 point
at it. Check that branch out and keep pushing to it unless the owner says
otherwise.

---

## 2. Identifiers

| Thing | Value |
|---|---|
| Product | **Skeuos**, an auction aggregator PWA for the owner's Wisconsin resale business. The app never explains its name. |
| Live site | https://www.waystock.org |
| Repository | `HellersTown/BOTO-deeda`. Everything is under `platform/`; the repository root is an unrelated app (AgentHQ, Netlify). |
| Branch / PR | `claude/waystock-auction-aggregator-66n8dv`, draft PR #1. Head at writing: the commit that adds this file. |
| Supabase project | `sfolywzqtxcdorjwnmsz`: Postgres 17.6, **Micro** compute (1 GB RAM, 224 MB shared_buffers), database ~410 MB |
| Vercel | team `team_UECdYAtzcZcLm1VYYP6QFcOL`, project `waystock` (`prj_kMg0pZIzFg7Hkqu2jj4kqxAAq5U2`); root directory `platform/web` |
| Crawler identity | `WaystockBot/0.1 (+https://waystock.org/bot)` |

### Edge Functions deployed (2026-10-09)

| Function | Version | Notes |
|---|---|---|
| crawl-private | v15 | BidWrangler houses (the price watch) |
| crawl-public | v4 | AuctionGuide, Dane County, WI DOR, and Wisconsin Surplus (held) |
| crawl-worker | v4 | GSA, IRS |
| probe-sources | v6 | robots/terms/access probe |
| inspect-page | v7 | robots-first single-page inspector |
| appraise-lots | v1 | Off until `ANTHROPIC_API_KEY` is set |
| look-at-lots | v1 | Off until `ANTHROPIC_API_KEY` is set (reports `configured:false`) |
| load-gazetteer, egress-check, gsa-sample | v3, v2, v2 | Utilities |

---

## 3. Standing rules

### Owner directives

- **Commit and push without asking.** The owner said: "finish all these and stop asking me to commit. just do it".
- **Never explain the name inside the app.** The owner said: "donty explain the name ithin the app".
- **Full permission for Supabase.** The owner said: "you have full permissions for supabase". Destructive SQL (DELETE, DROP, TRUNCATE) still needs the owner's confirmation, and is never disguised to get past a check.
- **Watch every listing hourly.** Every listing's price and bids are watched at least hourly. This is enforced by the `sources_hourly_floor` CHECK (0010: `crawl_cadence_min between 1 and 60`) and by 0064. Only the owner relaxes it.
- **The owner sends permission letters personally.** They stay in `docs/10`, and nothing goes to Gmail unless the owner asks.
- **Wisconsin Surplus is the first priority** (2026-10-01). See §7.

### Safety and legal limits

These are hard limits, and a new session must not try to get around any of them.

- **Never read env files.** Never read `platform/web/.env.production`, `.env.example` or any env file, and never pull built JS bundles to recover keys from them. Never decrypt Vercel env values or secrets (`GSA_API_KEY`, the Anthropic key). Read env metadata only, with `decrypt: false`.
- **Never turn on a held source without written permission.** Wisconsin Surplus and every other source held on its terms (`ingest_allowed = false`) stays off until the operator's written permission is in hand. That covers any route, including a "private use only" switch.
- **Facebook Marketplace and Craigslist are deep-link only.** Nothing is ever fetched from them.
- **Never log in to scrape, and never bypass bot protection.** A block (403, CAPTCHA, WAF) is an answer. The lawful routes are deep links, licensed data and partnerships.
- **Hold sources whose terms forbid automated collection.** These include HiBid, Wisconsin Surplus, Public Surplus, Municibid, BidSpotter, Purple Wave, ShopGoodwill and others (`docs/08`, `docs/03`). Don't fetch HiBid pages.
- **Read robots.txt and the terms before reading a new site** (`inspect-page`). If robots.txt is unreachable, treat it as a disallow.
- **Never read server files from SQL.** No `pg_ls_dir`, `pg_ls_waldir`, `pg_read_file`, `COPY ... FROM` a file or program, or `lo_import`.
- **Keep the owner's email address out of the repository** and out of anything sent to third parties.

---

## 4. Live state (2026-10-09 01:57 UTC)

### The database

- The last cron failure was at **20:48 UTC on 10-08**. From 21:00 to 01:57, **0 of 555** cron runs failed, and the breaker count is 0 of the last 40 runs.
- The 40–50-minute waves of 10-08 (19:24, 19:50, 20:40; `docs/11`) stopped once the hunt matcher and probe-sources were paused at 20:45. Night-time traffic is also lower, so the pause is not proven to be the cause. The first daytime hours on Micro will show whether it was.

Breaker check:

```sql
select count(*) from (select status, return_message from cron.job_run_details
                       order by runid desc limit 40) r
 where r.status = 'failed' and r.return_message ilike '%timeout%';  -- 2 or more = crawlers held
```

### Cron jobs

| Job | Schedule | Active |
|---|---|---|
| crawl-worker | `*/5` | yes, behind the 0071 breaker |
| crawl-public | `1-59/5` | yes, behind the 0071 breaker |
| crawl-private | `2-59/5` | yes, behind the 0071 breaker |
| watch-alerts | every minute | yes |
| close-expired | `*/10` | yes |
| reclassify-lots | `3-59/15` | yes |
| sleeper-refresh | `8-59/15` | yes |
| look-at-lots | `41 * * * *` | yes (does nothing until the key is set) |
| housekeeping | `23 3 * * *` | yes |
| **hunt-matcher** | `4-59/5` | **paused at 20:45 UTC on 10-08**. Saved hunts are not matched against new lots while it is off. |
| **probe-sources** | `7 * * * *` | **paused at 20:45 UTC on 10-08** |
| build-seen-tsv-idx | every minute | inactive leftover; dropping it needs owner OK (§8) |

Resume one job at a time, and check the breaker query and the app's latency
between steps:

```sql
select cron.alter_job(jobid, active := true) from cron.job where jobname = 'hunt-matcher';
```

### Sources being read (`ingest_allowed = true` and reachable)

| Source | Platform | Cadence (min) |
|---|---|---|
| hansen-auction-group | bidwrangler | **10**. It has ~6,400 open lots and a run re-reads ~2,400, so it needs runs ~15 minutes apart to see each listing hourly. |
| bennett-auction-service, hansen-and-young, hueckman-auction, north-central-sales-auction, peoples-company, premier-machinery-auctions | bidwrangler | 50 |
| gsa-auctions, irs-auctions | gsa, irs-auctions | 50 |
| auctionguide, dane-county-tax-deed, wi-dor-auctions | html | 50 |

Allowed but blocked or unreachable (no lots): auctionzip, govdeals, gotoauction, propertyroom (refusing us since 10-02), and uw-swap. eBay is waiting on the owner's production keyset.

### Freshness at 01:57 UTC: open lots seen within 60 minutes

| Source | Open lots | Seen ≤ 60 min |
|---|---:|---:|
| hansen-auction-group | 6,406 | 5,716 (89%), with a run in progress |
| bennett-auction-service | 2,090 | 100% |
| hansen-and-young | 1,646 | 100% |
| gsa-auctions | 1,360 | 100% |
| hueckman-auction | 1,167 | 100% |
| north-central-sales-auction | 1,151 | 100% |
| premier-machinery-auctions | 254 | 100% |
| auctionguide | 240 | 100% |
| irs-auctions, peoples-company, wi-dor-auctions | 3, 3, 1 | 100% |
| public-surplus | 11 | 0%: lots stored before its 09-30 hold (§8) |

The freshness query and the reasoning behind it are in `docs/11` under "What to watch".

### Crawl runs, 21:00–01:57

- Every run was `ok`, except **two Hansen Auction Group runs that ended `failed` with no error recorded.** They ran 23:58→00:27 and 01:13→01:42, each about 28 minutes, and each closed when the next Hansen run started.
- That fits a worker that died mid-run (for example at the Edge Function's wall-clock limit) and was reaped when the next run claimed the source. Lots written before it died are kept.
- **Not yet investigated.** Start with the Edge Function logs for `crawl-private` around 00:00–00:27 and 01:14–01:42.
- Typical run times: Hansen ~154 s, Bennett ~113 s, Hansen & Young ~102 s, the others under 80 s.

---

## 5. How work was done here (patterns to keep)

### Migrations

Migrations are in `platform/supabase/migrations/`, numbered `0001`–`0071`. The last two applied:

- **0070** `seen_without_rewrite`. An unchanged re-read writes a ~60-byte row to `public.lot_seen` instead of rewriting `lots`. Every reader uses `greatest(lots.last_seen_at, lot_seen.seen_at)`. This cut `lots` row rewrites by ~86–91%.
- **0071** `bidwrangler_backs_off_on_micro`. A circuit breaker in `invoke_crawler_if_due`: a crawler gate skips while 2 or more of the last 40 cron runs failed on a timeout. The six smaller BidWrangler houses moved to cadence 50.
  - A first version of 0071 (commit `574436e`, cadence 120) violated `sources_hourly_floor` and was rolled back. Never apply it.

Steps to apply a migration:

1. Commit and push the file.
2. Fetch it from Supabase with `net.http_get('https://raw.githubusercontent.com/HellersTown/BOTO-deeda/<sha>/platform/supabase/migrations/<file>')` and read `net._http_response.content`.
3. Check its md5 and `execute` it inside one `DO` block, which makes it one atomic transaction.
4. Record it in `supabase_migrations.schema_migrations` (version, name, statements). The versions used here are `20261008066000` to `20261008071000` for 0066–0071.

For a dry run, use the same `DO` block, run the checks after the `execute`, then `raise exception 'DRYRUN %', <results>` so everything rolls back.

Start each migration with `set local lock_timeout = '4s'`. On Micro, keep anything heavy out of daytime hours.

### Edge Functions

- **Shared code.** It lives in `platform/packages/ingest/src`, where it is unit-tested. Each function's `lib/` holds generated copies.
- **After changing that code,** run `node platform/scripts/sync-function-libs.mjs`. `test/function-libs.test.ts` fails if a copy drifts.
- **Deploy** with the Supabase connector's `deploy_edge_function`. The deployed `index.ts` is a stub that imports the repository file at a pinned commit, so the running code matches the repository byte for byte:

  ```ts
  import 'https://raw.githubusercontent.com/HellersTown/BOTO-deeda/<sha>/platform/supabase/functions/<name>/index.ts';
  ```

### The web app

- `platform/web` is Vite + React, a PWA. It bundles `packages/query` (the search parser and vocabulary) and `packages/strategy`.
- **Production is at commit `2d70e4f`**, deployment `dpl_HBFzqYPHndSFcXAvR4HuVsprTxhc`, READY.
- **Four commits since then are not yet in the client bundle.** `3c84d91`, `1e903ea`, `5e088c6` and `22f5771` (search vocabulary v5) change `packages/query`. The SQL side of v5 is live (0059, 0060); the client's copy of the parser is one release behind.
- **When last checked, the Vercel project's Git link still pointed at the old `HellersTown/waystock` repository,** so production is deployed by hand. Use the Vercel connector's `create_deployment` with:
  - team `team_UECdYAtzcZcLm1VYYP6QFcOL`
  - project `prj_kMg0pZIzFg7Hkqu2jj4kqxAAq5U2`
  - `target: production`
  - `gitSource` = `{type: github, org: HellersTown, repo: BOTO-deeda, ref: claude/waystock-auction-aggregator-66n8dv, sha: <head>}`
- Then poll `get_deployment` until it is READY and fetch https://www.waystock.org to confirm.
- Once the owner relinks Git (§8), pushes deploy on their own.
- **Never let a build inline `VITE_` variables wholesale.** The project still carries the old app's `VITE_ANTHROPIC_KEY`. Commit `9d84101` made the web read only the two Supabase variables by name, because reading `import.meta.env` whole had inlined every `VITE_` variable into the bundle.

### Tests

```sh
cd platform/packages/ingest   && npm test   # node --test (adapters, gates, crawl-gates vs migrations)
cd platform/packages/query    && npm test   # search parser
cd platform/packages/strategy && npm test   # bidding / profit engine
cd platform/web && npm ci && npm test && npm run build
```

`packages/ingest/test/crawl-gates.test.ts` checks the cron gates against the
**last** `invoke_crawler_if_due('<fn>', array[...])` call across all migrations.
Re-run it after any migration that touches the gates.

### Differential testing of SQL changes

Before 0070, the old and new functions were run side by side on a local
Postgres 16 cluster:

- Start it with `pg_ctlcluster 16 main start` and run commands with `runuser -u postgres`.
- Load the old functions into schema `o` and the new ones into schema `n`.
- Feed identical batches through both and diff the tables.

Repeat this for any change to `ingest_batch`, `crawl_run_finish` or `crawl_known_state`.

### Commits and the PR

Commit messages name the area and the change, for example `docs/11: ...` or
`0071: ...`. Keep model names out of commits, PR text and code. Update PR #1's
description when a status in `docs/09` changes.

---

## 6. Why Micro struggles (short version; full account in `docs/11`)

- **Memory and disk, not CPU.** `lots` (~152 MB with TOAST and indexes) and `lot_images` (~164 MB) together exceed the 224 MB of shared_buffers. Cold reads fall back to Micro's disk baseline: one count of open lots took 3.4 s cold and 12 ms warm.
- **What fills it is the BidWrangler watch.** It makes ~10 runs an hour of ~2,000 lots each, and Hansen Auction Group's cadence of 10 is most of that.
- **The ways out are owner decisions:**
  - Small compute: 2 GB RAM, about $5/month more. This is recommended.
  - Hansen seen every ~3 hours instead of hourly.
  - Pausing BidWrangler.
- **The next engineering lever** if the owner picks none: send unchanged lots to `ingest_batch` as ~250-byte price-only rows instead of ~5.7 KB each. That cuts each run's parsing by ~90%; it is a crawler change and redeploy (`crawl-private`).
- **The probes:**
  - CPU: `select count(*) from generate_series(1, 1e6)`. ~200–240 ms is normal.
  - Memory: the open-lots count, run twice. A large first-versus-second gap means cold pages.

---

## 7. Wisconsin Surplus (the owner's first priority)

**Status: built, deployed and held.**

- **Adapter:** `packages/ingest/src/adapters/wisconsin-surplus.ts`, 825 lines, 33 of 33 tests pass. The deployed copy is in `supabase/functions/crawl-public/lib/adapters/` (crawl-public v4).
- **Output:** each auction becomes a sale card with its name and what it holds. Street addresses and phone numbers are removed (`listingText.ts`).
- **Held:** `sources.wisconsin-surplus` is `active`, `ingest_allowed = false`, and holds 0 lots. Its terms (Legal 21) require prior written permission.
- **Not built:** single items, which need a session cookie and permission.
- **Unblocking it:** the owner sends the letter in `docs/10` §1, to `bid@wisconsinsurplus.com` / 608-437-2001 (the contact published on the City of Janesville's surplus page).
- **On a yes:** one migration sets `ingest_allowed = true` and the sale cards appear within the hour. Single items follow only if the reply allows them, under the letter's cap of 30 requests an hour.
- **Still wanted from the owner:**
  - Whether the letter has gone out, and any reply.
  - One example search URL from bid.wisconsinsurplus.com, so `sources.search_template` can give it a "search elsewhere" link (`web/src/lib/elsewhere.ts`).

---

## 8. Waiting on the owner

1. **Compute size.** The choices are Small (recommended), Hansen every ~3 hours, pausing BidWrangler, or keeping things as they are. See §6 and `docs/11` "Pending owner decisions".
2. **The Wisconsin Surplus letter** (§7) and any reply.
3. **Confirmation to drop the leftovers.** There are 16 invalid, never-ready indexes on `lots` (`lots_seen_tsv_idx`, `lots_seen_tsv_idx_ccnew` through `_ccnew14`) and an inactive cron job, `build-seen-tsv-idx`. The statements are in 0067. This is destructive, so it waits for the owner's yes.
4. **`ANTHROPIC_API_KEY`** as a Supabase Edge Function secret. Revoke the old, leaked key first. The new key turns on `appraise-lots` (Finds) and `look-at-lots` (photo matching).
5. **Vercel Git relink.** In project `waystock` → Settings → Git, disconnect `HellersTown/waystock` and connect `HellersTown/BOTO-deeda`. Then set the Production branch to `claude/waystock-auction-aggregator-66n8dv`, and switch it to `main` once PR #1 merges.
6. **Supabase Auth redirect URLs.** Add `https://www.waystock.org` so magic-link sign-in returns to the live site. Password sign-in already works.
7. **HiBid.** Decide on its terms, or send the letter in `docs/10` §4. It is the largest remaining source of Wisconsin volume.
8. **PropertyRoom** has refused the crawler since 10-02. Ask them for permission or a feed, or accept deep links.
9. **Public Surplus** has been held since 09-30, and 11 of its lots stored before the hold are still open. The decision is whether to delete them (destructive) or let them close out.
10. **Keys and accounts still to set up:**
    - the eBay production keyset;
    - a GSA API key to replace the shared demo key;
    - an email provider key;
    - a Skeuos domain for the crawler's identity.

---

## 9. Suggested next steps for the new session

1. Re-run the §4 queries: breaker, cron failures by hour, freshness, and crawl runs.
2. If the first daytime hours stay clean, resume **hunt-matcher** first, because hunts are user-facing, then **probe-sources**. Keep an eye on the breaker after each. If the waves come back, pause them again and take it to the owner as the compute decision.
3. Investigate the two Hansen runs that ended `failed` with no error (§4).
4. Redeploy the web app so the client's search parser carries vocabulary v5 (§5, "The web app"). Run `npm test` and `npm run build` in `platform/web` first.
5. If the owner keeps Micro and won't relax Hansen's hourly watch, build the price-only rows change (§6) in `packages/ingest` with tests, sync the function libs, and redeploy `crawl-private`.
6. Re-arm an hourly check-in in the new account if the owner wants one. The old session's `send_later` routine does not move across accounts.

---

## 10. Where things are documented

| Doc | Contents |
|---|---|
| `docs/00-architecture.md` | How the system works |
| `docs/01-sources.md`, `docs/07-wisconsin-sources.md` | Source inventory |
| `docs/03-legal-and-tos.md`, `docs/08-platform-access.md` | What may be crawled and why each source is on, held or blocked |
| `docs/09-requirements-traceability.md` | Every owner instruction with its status: the to-do list of record |
| `docs/10-permission-requests.md` | Letters for the owner to send (§1 Wisconsin Surplus, §4 HiBid, ...) |
| `docs/11-database-load.md` | The 10-08 starvation: timeline, causes, runbook, probes |
| `docs/12-session-handoff.md` | This file |
