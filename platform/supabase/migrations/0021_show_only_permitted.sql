-- 0021: search and hunts show a source's lots only while we may ingest it.
--
-- search_lots and match_lots_by_image filtered on sources.active alone, so a
-- source held on its terms (ingest_allowed = false, 0019 and 0020) kept its
-- already-stored lots in search results, and the hunt matcher, which runs
-- through search_lots, would keep alerting on them. The rule is now one line
-- in both: a lot is shown only while its source is active AND permitted.
-- Nothing is deleted; releasing a hold brings the rows back.
--
-- Patched in place with replace(), as 0018 did, so the rest of each definition
-- stays exactly as it is live. Each replacement must match exactly once.

do $$
declare
  v_def  text;
  v_from text := 'where l.closed = false and s.active';
  v_to   text := 'where l.closed = false and s.active and s.ingest_allowed';
begin
  v_def := pg_get_functiondef('public.search_lots(text, text, integer, boolean, text[], bigint, bigint, bigint[], source_tier[], integer, numeric, text, integer, integer, text)'::regprocedure);
  if position(v_to in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
      raise exception 'search_lots: expected exactly one "%"', v_from;
    end if;
    execute replace(v_def, v_from, v_to);
  end if;

  v_from := 'where h.rn = 1 and l.closed = false and s.active';
  v_to   := 'where h.rn = 1 and l.closed = false and s.active and s.ingest_allowed';
  v_def := pg_get_functiondef('public.match_lots_by_image(vector, numeric, text, integer, boolean, text[], bigint, integer)'::regprocedure);
  if position(v_to in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
      raise exception 'match_lots_by_image: expected exactly one "%"', v_from;
    end if;
    execute replace(v_def, v_from, v_to);
  end if;
end $$;

notify pgrst, 'reload schema';
