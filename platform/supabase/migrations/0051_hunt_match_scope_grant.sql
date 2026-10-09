-- 0051: a member chooses how widely a hunt matches.
--
-- 0045 added hunts.match_scope ('exact', 'related' or 'all') and the hunt
-- matcher reads it. 0009 grants UPDATE on hunts column by column, so a member
-- could choose the scope when creating a hunt (INSERT is granted on the whole
-- table) but never change it afterwards. This grants that one column; the
-- check constraint from 0045 still bounds its values.
--
-- Applied with execute_sql. Nothing here deletes or drops.

grant update (match_scope) on public.hunts to authenticated;
