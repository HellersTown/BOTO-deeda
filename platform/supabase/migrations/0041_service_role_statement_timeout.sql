-- 0041: a 30 s statement timeout for service_role, the role the crawl workers
-- write as.
--
-- The workers call ingest_batch through PostgREST in chunks of 200 lots. A
-- PostgREST connection logs in as `authenticator`, whose statement_timeout is
-- 8 s, and service_role has no setting of its own, so every chunk ran under
-- 8 s. pg_stat_statements on 2026-10-01: 517 ingest_batch calls, mean 1.2 s,
-- max 5.7 s among those that finished. Three did not: GSA twice and Hueckman
-- once ("ingest_batch chunk 3/4: canceling statement due to statement
-- timeout"). Each came when the chunk overlapped refresh_sleeper_scores (mean
-- 1.1 s, max 3.7 s) or another source's large first ingest (Hansen & Young:
-- 1,231 new lots). The failed run is retried an hour later, but a source that
-- times out every hour would never refresh.
--
-- PostgREST applies an impersonated role's own settings per request, so this
-- raises the ceiling for service_role only. anon (3 s) and authenticated
-- (8 s), the roles the app's users reach, are unchanged. 30 s stays well
-- inside a run's ~225 s budget.

alter role service_role set statement_timeout = '30s';
notify pgrst, 'reload config';
