-- 0043: profiles for the accounts made before the sign-up trigger existed.
--
-- on_auth_user_created (0003) gives every new account its profiles row. Two
-- accounts in this project predate it: the earlier Waystock app, on the same
-- Supabase project, made them in June 2026, months before 0003 was applied.
-- Neither has a profile (checked 2026-10-01). The app reads a missing profile
-- as null, but onboarding saves the home ZIP with an update that expects
-- exactly one row (.single()), and the tier behind hunt and watchlist limits
-- lives on the profile. Signing in with either account would stall at
-- onboarding.
--
-- This inserts exactly what handle_new_user() inserts for a new account, and
-- nothing for an account that already has a profile.
--
-- APPLIED BY HAND with execute_sql, like 0037 to 0042, and recorded in
-- supabase_migrations.schema_migrations with created_by 'execute_sql'.

insert into public.profiles (id, display_name)
select u.id, coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;
