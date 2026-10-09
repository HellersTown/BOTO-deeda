-- 0015_function_tokens.sql
--
-- A shared secret for Edge Functions that must not be public.
--
-- Every Edge Function URL accepts the public anon key, so a function that does
-- something sensitive needs its own check. The first such function is
-- inspect-page, which fetches one page from a registered source for adapter
-- development: a proxy in the wrong hands, even with its host allowlist and
-- robots check.
--
-- The token lives in private.function_tokens, which no client role can see. The
-- function checks it through check_function_token() with the service role, and
-- the only caller, public.inspect_url(), reads it inside the database and adds
-- it to the request itself. The token is never printed, logged or committed.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.function_tokens (
  name       text primary key,
  token      text not null,
  created_at timestamptz not null default now()
);

insert into private.function_tokens (name, token)
values ('inspect-page', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (name) do nothing;

create or replace function public.check_function_token(p_name text, p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.function_tokens t
     where t.name = p_name and length(coalesce(p_token, '')) >= 32 and t.token = p_token)
$$;

revoke execute on function public.check_function_token(text, text) from public, anon, authenticated;
grant execute on function public.check_function_token(text, text) to service_role;

-- Developer entry point: select public.inspect_url('https://…', '{"pattern":"/lot/"}');
-- then read net._http_response for the returned id.
create or replace function public.inspect_url(p_url text, p_opts jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_key   text;
  v_token text;
  v_id    bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'edge_functions_anon_key';
  select token into v_token from private.function_tokens where name = 'inspect-page';
  if v_url is null or v_key is null or v_token is null then
    raise exception 'edge function secrets or inspect-page token missing';
  end if;
  select net.http_post(
           url                  := rtrim(v_url, '/') || '/inspect-page',
           body                 := jsonb_build_object('url', p_url) || coalesce(p_opts, '{}'::jsonb),
           headers              := jsonb_build_object('Content-Type', 'application/json',
                                                      'Authorization', 'Bearer ' || v_key,
                                                      'x-inspect-token', v_token),
           timeout_milliseconds := 60000)
    into v_id;
  return v_id;
end $$;

revoke execute on function public.inspect_url(text, jsonb) from public, anon, authenticated;
