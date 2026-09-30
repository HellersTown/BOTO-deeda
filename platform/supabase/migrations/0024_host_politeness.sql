-- 0024: per-host politeness that holds across Edge Function invocations.
--
-- WaystockBot promises to obey robots.txt, Crawl-delay included. The crawl gate
-- paces requests within one run, but two tools kept no memory between calls:
-- inspect-page fetched robots.txt and then the page 0.8 s later on every call
-- (three calls to shopgoodwill.com, whose robots.txt says Crawl-delay: 120,
-- arrived about 20 s apart), and the hourly probe fetched robots.txt and the
-- home page 400 ms apart. Pacing that must hold across invocations needs shared
-- state, so it lives here:
--
--   private.crawl_hosts          one row per host: the last robots.txt fetched
--                                (status and body; headers are not kept) and
--                                when any invocation last sent the host a request.
--   crawl_host_turn(host, gap)   claims a request slot. Under a per-host
--                                advisory lock: if gap seconds have passed since
--                                the last request (or there was none), records
--                                now() and returns 0; otherwise returns the
--                                seconds still to wait and changes nothing.
--   crawl_host_robots(host)      the cached robots.txt and its age in seconds.
--   crawl_host_store_robots(...) replaces the cached robots.txt.
--
-- The private schema is closed to every client role (0015). The functions are
-- SECURITY DEFINER and only service_role, which the Edge Functions use, may
-- execute them.

create table if not exists private.crawl_hosts (
  host              text primary key,
  robots_status     int,
  robots_body       text,
  robots_fetched_at timestamptz,
  last_request_at   timestamptz
);

revoke all on table private.crawl_hosts from public, anon, authenticated;

create or replace function public.crawl_host_turn(p_host text, p_gap_sec numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last timestamptz;
  v_wait numeric;
begin
  if coalesce(p_host, '') = '' then
    raise exception 'crawl_host_turn: host is required';
  end if;

  -- One caller per host at a time, until this transaction ends. Read committed
  -- gives the select below a fresh snapshot, so it sees the previous holder's row.
  perform pg_advisory_xact_lock(hashtextextended(p_host, 0));

  select h.last_request_at into v_last from private.crawl_hosts h where h.host = p_host;
  if v_last is not null then
    v_wait := coalesce(p_gap_sec, 0) - extract(epoch from (now() - v_last));
    if v_wait > 0 then
      return v_wait;
    end if;
  end if;

  insert into private.crawl_hosts as h (host, last_request_at)
  values (p_host, now())
  on conflict (host) do update set last_request_at = excluded.last_request_at;
  return 0;
end $$;

create or replace function public.crawl_host_robots(p_host text)
returns table(robots_status int, robots_body text, age_sec numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select h.robots_status, h.robots_body, extract(epoch from (now() - h.robots_fetched_at))
    from private.crawl_hosts h
   where h.host = p_host and h.robots_fetched_at is not null
$$;

create or replace function public.crawl_host_store_robots(p_host text, p_status int, p_body text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.crawl_hosts as h (host, robots_status, robots_body, robots_fetched_at)
  values (p_host, p_status, p_body, now())
  on conflict (host) do update
     set robots_status     = excluded.robots_status,
         robots_body       = excluded.robots_body,
         robots_fetched_at = excluded.robots_fetched_at
$$;

revoke execute on function public.crawl_host_turn(text, numeric) from public, anon, authenticated;
revoke execute on function public.crawl_host_robots(text) from public, anon, authenticated;
revoke execute on function public.crawl_host_store_robots(text, int, text) from public, anon, authenticated;

grant execute on function public.crawl_host_turn(text, numeric) to service_role;
grant execute on function public.crawl_host_robots(text) to service_role;
grant execute on function public.crawl_host_store_robots(text, int, text) to service_role;

notify pgrst, 'reload schema';
