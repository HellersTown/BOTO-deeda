-- 0018_search_tsquery.sql
--
-- Let search use the parser's grouped query, and say how each distance was found.
--
-- 1. search_lots gains p_tsquery. The query package (packages/query) produces
--    two strings. websearchQuery is plain words, safe for websearch_to_tsquery,
--    which has no grouping. tsquery has synonym and model-variant groups, for
--    example ('f-150' | 'f150') & diesel, or generator | genset. Until now only
--    websearchQuery was searchable, so a hunt for an "F-150" missed a lot titled
--    "F150". p_tsquery is used when given. If it does not parse, or holds only
--    stop words, search falls back to p_query exactly as before.
--
-- 2. search_lots returns pickup_geo_source (0016), so the app can mark a
--    distance measured from a city centroid as approximate.
--
-- 3. run_hunt_matcher passes each hunt's parsed tsquery.
--
-- Both functions are edited from their live definitions, one exact text
-- replacement at a time. If any expected text is not found, the migration
-- raises and nothing changes. The full bodies are in 0006 (search_lots) and
-- 0013 (run_hunt_matcher).

do $$
declare
  d text;
begin
  d := pg_get_functiondef('public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer)'::regprocedure);

  d := replace(d, 'p_offset integer DEFAULT 0)',
                  'p_offset integer DEFAULT 0, p_tsquery text DEFAULT NULL::text)');
  d := replace(d, 'relevance numeric, match_basis text)',
                  'relevance numeric, match_basis text, pickup_geo_source text)');
  d := replace(d,
    E'  if p_query is not null and length(trim(p_query)) > 0 then\n    v_tsq := websearch_to_tsquery(''english'', p_query);\n  end if;',
    E'  -- The parser''s grouped query first (synonyms, model variants). If it does\n' ||
    E'  -- not parse, or holds only stop words, fall back to the plain string.\n' ||
    E'  if p_tsquery is not null and length(trim(p_tsquery)) > 0 then\n' ||
    E'    begin\n' ||
    E'      v_tsq := to_tsquery(''english'', p_tsquery);\n' ||
    E'    exception when others then\n' ||
    E'      v_tsq := null;\n' ||
    E'    end;\n' ||
    E'    if v_tsq is not null and numnode(v_tsq) = 0 then\n' ||
    E'      v_tsq := null;\n' ||
    E'    end if;\n' ||
    E'  end if;\n' ||
    E'  if v_tsq is null and p_query is not null and length(trim(p_query)) > 0 then\n' ||
    E'    v_tsq := websearch_to_tsquery(''english'', p_query);\n' ||
    E'  end if;');
  d := replace(d, E'         sc.basis\n    from scored sc',
                  E'         sc.basis,\n         sc.pickup_geo_source\n    from scored sc');

  if position('p_tsquery text DEFAULT' in d) = 0
     or position('pickup_geo_source text)' in d) = 0
     or position('to_tsquery(''english'', p_tsquery)' in d) = 0
     or position('sc.pickup_geo_source' in d) = 0 then
    raise exception 'search_lots did not match the expected definition; nothing changed';
  end if;

  drop function public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer);
  execute d;

  d := pg_get_functiondef('public.run_hunt_matcher(integer,uuid,boolean)'::regprocedure);
  d := replace(d, E'               p_query              => v_query,\n',
                  E'               p_query              => v_query,\n' ||
                  E'               p_tsquery            => nullif(h.parsed ->> ''tsquery'', ''''),\n');
  if position('p_tsquery' in d) = 0 then
    raise exception 'run_hunt_matcher did not match the expected definition; nothing changed';
  end if;
  execute d;
end $$;

grant execute on function public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text)
  to anon, authenticated, service_role;

comment on function public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text) is
  'Location-first lot search. p_tsquery (the parser''s grouped query) is preferred over p_query when it parses. Returns pickup_geo_source so callers can mark approximate distances.';

notify pgrst, 'reload schema';
