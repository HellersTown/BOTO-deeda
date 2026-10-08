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
| 0070 | A re-read that changes nothing is recorded in a 60-byte `lot_seen` row instead of rewriting the lot. Every reader of `last_seen_at` (the watch planner, crawl_run_finish, search's watched-only filter, v_lot_detail) uses the later of the two times. BidWrangler houses move to a 20-minute cadence: runs about 25 minutes apart, each lot re-read about every 50 minutes. |

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
4. After a long pause, every BidWrangler lot is stale at once, and the first
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

- **Compute size.** Small is recommended; see the decision rule.
- **Leftover indexes.** The interrupted CONCURRENTLY builds left 16 invalid,
  never-ready indexes: `lots_seen_tsv_idx` and `_ccnew` through `_ccnew14`. There
  is also an inactive cron job, `build-seen-tsv-idx`. None of these holds data or
  is maintained. Dropping them needs the owner's confirmation; the statements are
  in 0067.
