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

## What changed

| Migration | Change |
|---|---|
| 0066 | Cron cadences: watch alerts every minute; hunt matcher every 5 minutes; reclassify and sleeper every 15 minutes. ingest_batch gets work_mem 16 MB. |
| 0067 | search_tsv is kept by a trigger that recomputes only when its inputs change. lots fillfactor is 70. lots_seen_tsv_gin is added. ingest_batch parses each batch once and skips unchanged auctions. crawl_run_finish reads a source's lots once. The gazetteer skips unchanged pickups. The sleeper rescores only what the clock moved. Watch alerts, reclassify and look-at-lots exit early when there is nothing to do. |
| 0068 | Each crawl job wakes its worker only when one of that worker's sources is due. |
| 0069 | authenticator statement_timeout is 60 s, so PostgREST's own schema-cache load can finish under load. Request timeouts are unchanged. |

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

Probe from SQL:

```sql
explain (analyze, buffers) select count(*) from public.auctions;
```

Healthy is under 50 ms. At 280 ms or more the instance is throttled. Seconds
means it is starved.

**Decision rule:**

- Waves return while the fixes are in → move to **Small** (2 GB RAM, about
  $15/month). The whole database then fits in memory.
- CPU stays pinned at 100% even on Small → move to **Large**, the first size
  with a dedicated CPU.

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

## Pending owner decisions

- **Compute size.** Small is recommended; see the decision rule.
- **Leftover indexes.** The interrupted CONCURRENTLY builds left 16 invalid,
  never-ready indexes: `lots_seen_tsv_idx` and `_ccnew` through `_ccnew14`. There
  is also an inactive cron job, `build-seen-tsv-idx`. None of these holds data or
  is maintained. Dropping them needs the owner's confirmation; the statements are
  in 0067.
