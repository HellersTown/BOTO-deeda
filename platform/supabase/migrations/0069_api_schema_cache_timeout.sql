-- 0069: give PostgREST's own schema-cache load room to finish.
--
-- From 06:30 to 09:26 UTC on 2026-10-08 every /rest/v1 request answered 503
-- "Could not query the database for the schema cache. Retrying." So the app,
-- the crawlers' claim_due_sources and every RPC were down. No crawl run started
-- after 06:13.
--
-- PostgREST loads its schema cache, and before that pg_timezone_names, as the
-- authenticator role, whose statement_timeout was 8s. Healthy, the schema
-- query averaged 1.4 s with a 7.8 s maximum, already near the limit. On the
-- CPU-starved instance it took longer than 8 s every time: every authenticator
-- statement logged from 06:00 on was a statement timeout, about 40 an hour,
-- each burning 8 s of CPU and retried forever. pg_timezone_names alone took
-- 33 s at 09:27.
--
-- Requests are not affected: PostgREST applies the impersonated role's own
-- statement_timeout to each request (anon 3s, authenticated 8s, service_role
-- 30s). Only PostgREST's own queries (schema cache, timezone names, role
-- settings) run under authenticator's. With 60s, the next load committed at
-- 09:29 after a NOTIFY pgrst.
--
-- Applied with execute_sql.

alter role authenticator set statement_timeout = '60s';

notify pgrst, 'reload schema';
