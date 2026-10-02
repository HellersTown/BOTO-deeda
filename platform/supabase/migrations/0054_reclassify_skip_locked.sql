-- 0054: the reclassifier never deadlocks with a crawler.
--
-- reclassify-lots (every minute) updated up to 3,000 lots in one statement,
-- locking them in whatever order the join produced, while a crawler's upsert
-- locked an overlapping set in its own order. Twice on 2026-10-02 (04:17 and
-- 04:24 UTC) each waited on the other and Postgres cancelled one of them; it
-- happened to be the reclassifier both times, but nothing made it so. Now the
-- reclassifier claims its rows first, in id order, and skips any row another
-- transaction holds. It never waits on a crawler, so no cycle can form, and a
-- lot it skips is picked up a minute later.
--
-- Applied with execute_sql. Nothing here deletes or drops.

-- As 0048, with the rows claimed FOR UPDATE SKIP LOCKED.
create or replace function public.reclassify_lots(p_limit integer default 2000)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ver integer;
  v_n   integer;
begin
  select vocabulary_version into v_ver from public.search_meta where id;
  with todo as (
    select id from public.lots
     where item_class_v is null or item_class_v < v_ver
     order by closed, id
     limit greatest(coalesce(p_limit, 2000), 1)
       for update skip locked
  ), c as (
    -- A lateral call: (f(x)).* would run the classifier once per column.
    select l.id, x.heads, x.mods, x.mentions, x.head_words,
           public.extract_measures(l.title, l.description) as measures
      from public.lots l join todo using (id)
      cross join lateral public.classify_listing(l.title, l.description) x
  )
  update public.lots l
     set item_heads = c.heads, item_mods = c.mods, item_mentions = c.mentions,
         head_words = c.head_words, measures = c.measures, item_class_v = v_ver
    from c
   where l.id = c.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
