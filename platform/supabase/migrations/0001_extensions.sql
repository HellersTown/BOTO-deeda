-- 0001_extensions.sql
-- Everything the crawler, geo filter and image search need.
-- All verified available on Postgres 17.6 / Supabase (region us-west-2).
--
-- Why each one earns its place:
--   pg_trgm      fuzzy/typo-tolerant lot titles ("DJI Mavik" -> "DJI Mavic")
--   unaccent     folds accents so "Niño" matches "Nino"
--   vector       pgvector 0.8.0 — CLIP image embeddings + text embeddings
--   postgis      real distance math for zip-radius search
--   btree_gist   lets us put a scalar and a range in one exclusion/index
--   pg_net       async HTTP from inside Postgres, so cron can poke Edge Functions
--   pgmq         durable crawl-job queue; no external broker to host
--   pg_cron      the "runs 24/7 and updates itself" engine
--   cube/earthdistance  cheap fallback distance ops

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto   with schema extensions;
create extension if not exists pg_trgm    with schema extensions;
create extension if not exists unaccent   with schema extensions;
create extension if not exists vector     with schema extensions;
create extension if not exists postgis    with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists cube       with schema extensions;
create extension if not exists earthdistance with schema extensions;
create extension if not exists pg_net     with schema extensions;

-- These two manage their own schemas and must not be given one.
create extension if not exists pgmq;
create extension if not exists pg_cron;
