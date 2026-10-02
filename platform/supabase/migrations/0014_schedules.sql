-- 0014_schedules.sql
--
-- The timetable: what runs, how often, and why that often.
--
--   job              schedule       what
--   ---------------  -------------  ----------------------------------------------
--   probe-sources    :07 hourly     Contact every monitored site as WaystockBot and
--                                   record robots/bot-manager/structured-data
--                                   evidence. This is the owner's "ping every
--                                   monitored site at least once an hour". The
--                                   function's own 30-minute floor caps any site at
--                                   two probes an hour, whoever calls it.
--   crawl-worker     every 5 min    Ingest whatever claim_due_sources says is due.
--                                   Calling often cannot crawl faster than a
--                                   source's cadence; a call with nothing due makes
--                                   no outbound request.
--   hunt-matcher     every 30 s     Match hunts. Tier latency is enforced inside
--                                   run_hunt_matcher, so a free hunt still runs at
--                                   most hourly; 30 s is the Dealer tier's promise.
--   watch-alerts     every 30 s     Closing-soon, outbid and closed notices.
--   close-expired    every 10 min   Close lots 3 h past their close time.
--   sleeper-refresh  every 15 min   Re-score lots whose urgency changed.
--   housekeeping     03:23 daily    Keep a week of cron run history.
--
-- Edge Functions are called with pg_net. The URL and the anon key are read from
-- Supabase Vault at call time, so neither lives in this file or in git. Create
-- them once per project (the anon key is the public one; nothing here needs the
-- service role):
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'edge_functions_url');
--   select vault.create_secret('<anon key>', 'edge_functions_anon_key');

create or replace function public.invoke_edge_function(p_name text, p_query text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
  v_id  bigint;
begin
  -- Only our own function names, so this can never become a general HTTP client.
  if p_name !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'invalid function name %', p_name;
  end if;
  if p_query is not null and p_query !~ '^[A-Za-z0-9_=&.-]{1,200}$' then
    raise exception 'invalid query string %', p_query;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'edge_functions_anon_key';
  if v_url is null or v_key is null then
    raise exception 'Vault secrets edge_functions_url and edge_functions_anon_key must be set (see 0014_schedules.sql)';
  end if;

  select net.http_post(
           url                  := rtrim(v_url, '/') || '/' || p_name || coalesce('?' || p_query, ''),
           body                 := '{}'::jsonb,
           headers              := jsonb_build_object('Content-Type', 'application/json',
                                                      'Authorization', 'Bearer ' || v_key),
           timeout_milliseconds := 150000)
    into v_id;
  return v_id;
end $$;

revoke execute on function public.invoke_edge_function(text, text) from public, anon, authenticated;

-- Idempotent: drop any earlier version of these jobs, then (re)create them.
do $$
declare
  j record;
begin
  for j in select jobid from cron.job
            where jobname in ('probe-sources', 'crawl-worker', 'hunt-matcher', 'watch-alerts',
                              'close-expired', 'sleeper-refresh', 'housekeeping') loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('probe-sources',   '7 * * * *',    $$select public.invoke_edge_function('probe-sources', 'limit=50')$$);
select cron.schedule('crawl-worker',    '*/5 * * * *',  $$select public.invoke_edge_function('crawl-worker')$$);
select cron.schedule('hunt-matcher',    '30 seconds',   $$select public.run_hunt_matcher()$$);
select cron.schedule('watch-alerts',    '30 seconds',   $$select public.queue_watch_alerts()$$);
select cron.schedule('close-expired',   '*/10 * * * *', $$select public.close_expired_lots()$$);
select cron.schedule('sleeper-refresh', '*/15 * * * *', $$select public.refresh_sleeper_scores(5000)$$);
select cron.schedule('housekeeping',    '23 3 * * *',   $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
