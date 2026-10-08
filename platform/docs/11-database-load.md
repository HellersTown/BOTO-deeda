# 11. Database load: the 2026-10-08 starvation and how to keep it away

The project runs on Supabase's Micro compute: 1 GB RAM, a shared 2-core ARM CPU,
and disk I/O that can burst above a baseline only until a budget runs out. On
2026-10-08 that budget ran out. This is what happened, what was changed, and
what to watch.

## What happened

| Time (UTC) | |
|---|---|
| 04:00 | Statements begin to time out in waves, as they had at 20:15–20:45 the day before. |
| 06:13 | The last crawl run starts. After this nothing new is stored. |
| 06:30 | Every `/rest/v1` request answers 503. PostgREST could not load its schema cache: the query ran as `authenticator` with an 8 s statement_timeout and never finished. |
| 09:29 | The schema cache loads (0069). The API answers again. |
| 09:58 | Crawlers and the source probe are paused so the instance can recover. |
| 10:57 | Postgres is nearly idle (4 connections), yet a count over 2,478 auctions from shared buffers takes 7.4 s. The host itself is starved, not a query. |
| 11:56 | Probe at 280 ms. lots_seen_tsv_gin is built; hunts come back on. |
| 11:58–12:45 | Crawlers are resumed one at a time. Every run is `ok` and there are no timeouts. |
| 12:30 | crawl-private (BidWrangler) resumes and re-reads its 7,705 stale lots in 12 minutes. |
| 12:55–14:30 | Timeouts return: 89 cron startup timeouts and 18 statement timeouts in the first hour, in crawl_run_finish, crawl_known_state, ingest_batch, the hunt matcher and the exporter. |
| 13:58 | crawl-private is paused again. Timeouts continue for another 32 minutes while the backlog drains. |
| 14:35 | No timeouts from here on, with every other job running. |
| 15:38 | 0070 applied (one transaction). The BidWrangler houses are staggered 5 minutes apart, Hansen Auction Group first, and crawl-private resumes. |
| 15:38–16:29 | No timeouts. Every house finishes a run `ok` (Hansen Auction Group 2,495 lots in 3.2 minutes). By 16:12, 8,678 unchanged re-reads went to `lot_seen` and lots took 1,454 updates (real changes plus the other jobs): about 86% fewer row rewrites. |
| 16:29 | Timeouts return anyway, about 50 minutes after the resume, during Hansen Auction Group's catch-up runs. Supabase's own `pg_stat_statements` report query took 12–48 s in the same minutes. |
| 16:40 | crawl-private is paused again. |
| 16:40–17:15 | The instance does not recover this time: cron startup timeouts in every 5 minutes, and the app's own requests fail. Ten searches average 53 s and 6 of them return 5xx; sources, postal codes and profiles take 30–40 s. |
| 17:15 | crawl-worker, crawl-public, probe-sources and the hunt matcher are paused too (step 1 below, plus the hunt matcher, whose searches over cold pages compete with the app's). |
| 17:20 | The last timeout. App requests average 0.9 s with no errors. |
| 17:47 | 0071 applied. crawl-worker and crawl-public resume behind its circuit breaker; crawl-private, the hunt matcher and probe-sources follow one at a time. |
| 17:50 | The breaker lets go as the 17:19 failures age out. GSA (1,341 lots in 6 s), IRS, the Department of Revenue and Dane County all run `ok`. |
| 18:08 | No timeouts since 17:20. crawl-private resumes, its houses staggered 5 minutes apart from 18:08 (Hansen Auction Group) to 18:38. |
| 18:37 | Clean since 18:05: no timeouts, 0 of 60 cron runs failed, and all 7 BidWrangler runs `ok` (Hansen Auction Group twice, 1,810 and 2,291 lots in 2.4 minutes each). The hunt matcher resumes; probe-sources follows. |
| 18:59 | Clean since 18:35 (51 cron runs, none failed; the hunt matcher 1.5 s a run). probe-sources resumes: every job is back on. |
| 19:24–19:28 | A short wave: three BidWrangler runs in consecutive 5-minute ticks (Bennett 2,095 lots at 19:12, Hansen Auction Group 2,220 at 19:17, Hansen & Young at 19:22), a checkpoint and the hunt matcher. For about two minutes even a one-line `pg_settings` query took 10 s; 3 statements and 6 cron starts timed out. 0071's breaker held every crawler, and the instance was clean again from 19:30. |

| 19:50–20:09, 20:40– | The waves recur. Each begins when the breaker lets go and the BidWrangler houses that came due while it held all run: 19 minutes of timeouts from 19:50 (11 statements, 26 cron starts), clean from 20:10 to 20:40, then again from 20:40. `ingest_batch` and `crawl_run_finish` calls reached 170 s. At 20:45 the hunt matcher and probe-sources (no breaker) are paused per step 1. |

### Where it stands (19:40)

- With 0070 and 0071 in, a starvation episode lasts minutes, not hours: the
  breaker holds the crawlers and lets them go once the failures age out (about
  25 minutes of cron). The app answered every request without errors outside
  those minutes.
- The cost is freshness: houses that come due while the breaker holds wait
  for it. At 19:40, BidWrangler houses ranged from 100% (Bennett) to 0% (North
  Central, Hueckman, held since 19:26) of open lots seen within the hour.
- **Update 20:45:** the breaker caps each wave but cannot stop them; on
  Micro, with every listing watched hourly, the instance cycles every 40–50
  minutes between clean and starved.
- Micro carries the app and the light crawlers, but not about ten BidWrangler
  runs an hour of ~2,000 lots each. Either of these ends the episodes: Small
  (recommended), or Hansen Auction Group seen every ~3 hours instead of
  hourly. The next engineering lever, if neither, is sending unchanged lots to
  `ingest_batch` as ~250-byte price-only rows instead of ~5.7 KB each (a
  crawler change and redeploy), which cuts each run's parsing by about 90%.

## Why

The database is small: 405 MB, 20k lots. The load was waste.

- **Every lot re-read rewrote the whole row.** `lots.search_tsv` was a STORED
  GENERATED column, and `lots` has BEFORE UPDATE triggers. With a BEFORE trigger,
  Postgres recomputes every stored generated column on every UPDATE. So each
  watch-mode price check ran four `to_tsvector` calls, rewrote the tsvector to
  TOAST, and could never be HOT. That meant inserting into all 17 lots indexes.
  Result: 1.52M updates on 20k rows, 60% of them non-HOT, and one TOAST write per
  update.
- **Pages had no room for HOT updates.** fillfactor was 100.
- **refresh_sleeper_scores rewrote up to 5,000 unchanged rows every 15 minutes.**
  That was 346 MB of WAL a day.
- **Every search read every open lot.** From 0057 on, the candidate filter ORed in
  `seen_tsv`, which had no index, so the BitmapOr plan was lost. Each hunt run
  became a full scan and timed out after two minutes.
- **ingest_batch spilled to disk.** It parsed each batch three times at 2 MB
  work_mem: 30 GB of temp files. It also rewrote every auction on every run
  (88k updates for 2.5k auctions).
- **Jobs ran more often than their data changes.** The hunt matcher and watch
  alerts ran every 30 s, but lots change every 5 minutes. The crawlers were woken
  about 500 times a day with nothing due. look-at-lots ran every 3 minutes with
  no API key.

### After 0070: writes are down, and memory is still the limit

0070 removed most of the write load, and the instance still starved within an
hour of full-rate BidWrangler crawling. What is left is reading: every run reads
its house's lot list and up to 48 MB of JSON, and lots and lot_images do not stay
in 1 GB. **On Micro, the hourly BidWrangler watch does not fit. It needs Small.**

While crawl-private is paused, BidWrangler prices are not refreshed. Search's
watched-only filter (0061) hides a lot its source has not shown for 6 hours, so
after 6 paused hours the 13,000 BidWrangler lots (two thirds of the catalogue)
drop out of search until crawling resumes.

### Why it came back at 12:55: memory, not CPU

With 0066–0069 in, everything fit except the BidWrangler watch.

- **The watch rewrote rows that had not changed.** BidWrangler has 13,042 open
  lots and the watch re-reads each one about every 40 minutes. In the 3 hours
  before the pause it re-read 9,219 lots, and 586 of them (6.4%) had changed. The
  other 94% still got a full new version of a 2.4 KB lots row, only to move
  `last_seen_at`. That is about 20,000 row rewrites an hour. Each one costs WAL
  (`wal_level` is logical, so the whole tuple is logged), a full-page image of
  each touched page after every 5-minute checkpoint, and dead rows that send
  autovacuum through lots, its TOAST and 18 indexes (384 autovacuums so far).
- **The instance is short of memory, not CPU.** A pure CPU test
  (`count(*)` over a 1,000,000-row `generate_series`) took about 200 ms, which
  is normal for this hardware. Memory told a different story. In a fresh
  session, the first count of open lots took 3,425 ms; the same count right
  after took 12.7 ms. lots had been pushed out of RAM and came back at Micro's
  disk baseline. lots (152 MB with TOAST and indexes) and lot_images (164 MB)
  together exceed the 224 MB of shared buffers on a 1 GB machine. Everything
  that churns pages pushes the rest out. The 7.4 s for 693 reads that Postgres
  counted as in-memory hits at 10:57 most likely means the operating system had
  paged out shared memory itself.

## What changed

| Migration | Change |
|---|---|
| 0066 | Cron cadences: watch alerts every minute; hunt matcher every 5 minutes; reclassify and sleeper every 15 minutes. ingest_batch gets work_mem 16 MB. |
| 0067 | search_tsv is kept by a trigger that recomputes only when its inputs change. lots fillfactor is 70. lots_seen_tsv_gin is added. ingest_batch parses each batch once and skips unchanged auctions. crawl_run_finish reads a source's lots once. The gazetteer skips unchanged pickups. The sleeper rescores only what the clock moved. Watch alerts, reclassify and look-at-lots exit early when there is nothing to do. |
| 0068 | Each crawl job wakes its worker only when one of that worker's sources is due. |
| 0069 | authenticator statement_timeout is 60 s, so PostgREST's own schema-cache load can finish under load. Request timeouts are unchanged. |
| 0071 | Every crawler's cron gate holds its worker while 2 or more of the last 40 cron runs failed on a timeout, so a starving instance sheds its crawlers by itself and takes them back once the failures age out (about 15 minutes of cron). The six smaller BidWrangler houses run every 50 minutes instead of 15; each run re-reads all their lots, so every listing is still seen within the hour. Hansen Auction Group keeps 10. A first version that set them to 120 minutes was rejected by the `sources_hourly_floor` constraint (the owner's hourly requirement) and rolled back. |
| 0070 | A re-read that changes nothing is recorded in a 60-byte `lot_seen` row instead of rewriting the lot. Every reader of `last_seen_at` (the watch planner, crawl_run_finish, search's watched-only filter, v_lot_detail) uses the later of the two times. Crawl cadence is unchanged: a run re-reads at most about 2,400 known lots (the 48 MB byte budget), so Hansen Auction Group (6,700 open lots) must stay at 10 minutes to go round within the hour. |

Measured after the fixes, across 8,989 lot updates that included all seven
BidWrangler houses:

- HOT updates: 60%, up from 39%. This keeps rising as rows move onto pages with
  room.
- TOAST writes: 0.02 per update, down from 1.0.
- Hunt matcher: 1.1–1.5 s per run. Before, it timed out after 2 minutes.
- A full BidWrangler pass of 7,705 lots finished in 12 minutes, with every run
  `ok`.
- Statement and cron timeouts: none since 11:45.

## What to watch

In Dashboard → Observability, watch CPU and **Disk IO % consumed**. Supabase's
docs say anything above 1% means the workload went over its baseline that day.

Probe from SQL, in one session:

```sql
-- CPU: about 200 ms is normal on Micro; seconds means the CPU is starved.
explain analyze select count(*) from generate_series(1, 1000000);
-- Memory: run this twice. Fast both times (tens of ms): lots is in memory.
-- Slow the first time and fast the second: lots had been pushed out of RAM.
-- Slow both times: the instance is starved.
explain (analyze, buffers) select count(*) from public.lots where closes_at > now();
```

Price-watch freshness, per source. After 0070, a lot was last seen at the later
of `lots.last_seen_at` and `lot_seen.seen_at`; `lots.last_seen_at` alone moves
only when something changed.

```sql
select s.slug, count(*) as open_lots,
       count(*) filter (where greatest(l.last_seen_at, ls.seen_at) > now() - interval '60 minutes') as seen_60m
  from public.lots l
  join public.sources s on s.id = l.source_id
  left join public.lot_seen ls on ls.lot_id = l.id
 where not l.closed and l.closes_at > now()
 group by s.slug order by s.slug;
```

The earlier probe, a single `count(*)` over auctions, mostly measures whether
those pages happen to be cached. On 2026-10-08 it read 273 ms cold and 1 ms
warm a minute apart.

**Decision rule:**

- Waves return while the fixes are in → move to **Small** (2 GB RAM, about
  $15/month). Every measurement points at memory, and on Small the whole
  410 MB database fits beside shared buffers.
- CPU stays pinned at 100% even on Small → move to **Large**, the first size
  with a dedicated CPU. Nothing measured so far points there.

## If it happens again

1. Pause the write-heavy jobs and keep them paused until the probe is healthy:

   ```sql
   select cron.alter_job(jobid, active := false) from cron.job
    where jobname in ('crawl-worker','crawl-public','crawl-private','probe-sources');
   ```

2. Resume them one at a time, in the order crawl-worker, crawl-public,
   crawl-private, probe-sources. Before each resume, check that the previous
   job's crawl runs finished `ok`.
3. If `/rest/v1` answers 503 with "Could not query the database for the schema
   cache", run `notify pgrst, 'reload schema';` after load drops.
4. Since 0071 the crawlers stop themselves while 2 or more of the last 40 cron
   runs failed on a timeout. To see whether the breaker is holding them:

   ```sql
   select count(*) from (select status, return_message from cron.job_run_details
                          order by runid desc limit 40) r
    where r.status = 'failed' and r.return_message ilike '%timeout%';
   ```

   2 or more means the gates are holding. The hunt matcher and probe-sources
   have no breaker; pause them by hand as in step 1.
5. After a long pause, every BidWrangler lot is stale at once, and the first
   runs re-read all of them. Spread the catch-up by staggering the houses before
   resuming crawl-private:

   ```sql
   update public.sources s
      set next_due_at = now() + (o.n * interval '5 minutes')
     from (select id, row_number() over (order by slug) - 1 as n
             from public.sources where platform = 'bidwrangler' and active) o
    where s.id = o.id;
   ```

## Pending owner decisions

- **Compute size.** Small is recommended; see the decision rule. On Micro the
  hourly watch of every BidWrangler listing does not fit: Hansen Auction Group
  alone (6,700 open lots, ~2,400 re-read a run) needs a run every ~15 minutes to
  see each listing within the hour.
- **If not Small: Hansen Auction Group's pace.** Seeing its listings every ~3
  hours instead of hourly (cadence 50) would roughly halve the remaining watch
  load. That relaxes the hourly requirement, so it is the owner's call.
- **Leftover indexes.** The interrupted CONCURRENTLY builds left 16 invalid,
  never-ready indexes: `lots_seen_tsv_idx` and `_ccnew` through `_ccnew14`. There
  is also an inactive cron job, `build-seen-tsv-idx`. None of these holds data or
  is maintained. Dropping them needs the owner's confirmation; the statements are
  in 0067.
