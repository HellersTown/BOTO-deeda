-- 0050: search refinements from the first hour of v2 in production.
--
-- 1. A model number matches with a trim glued to it: "f150" finds "F-150XL"
--    and "F150 XLT" (the number is a prefix), still never "F-250".
-- 2. search_resolve writes the title-weighted form of each required word
--    itself (required_q_ab). 0048 derived it in search_lots with a regular
--    expression, which mangled a fragment holding several quoted words.
-- 3. "featuring" and "depicting" open a modifier like "with": a "Stocking
--    Holder Featuring a Truck" is a stocking holder.
-- 4. A query of brands and model numbers only ("s185", "kubota l3800") is
--    an exact match wherever the title, brand or model names them all.
--
-- Applied with execute_sql. Nothing here deletes or drops.

-- What a listing IS: as 0048, plus "featuring" and "depicting" (3).
create or replace function public.classify_listing(
  p_title text,
  p_description text default null,
  out heads text[],
  out mods text[],
  out mentions text[],
  out head_words text[]
)
language plpgsql stable parallel safe
set search_path = pg_catalog, public
as $$
declare
  v_title  text;
  v_toks   text[];
  n        integer;
  m_st     integer[];
  m_en     integer[];
  m_kind   text[];
  m_con    text[];
  covered  boolean[];
  attrish  boolean[];
  segs     integer[];
  incs     boolean[];
  h_con    text[] := '{}';
  h_en     integer[] := '{}';
  h_inc    boolean[] := '{}';
  v_list   boolean := false;
  v_first  integer;
  s        integer := 1;
  inc      boolean := false;
  i        integer;
  j        integer;
  g        integer;
  w        text;
  -- After these, the words are what the item is FOR or ON, not the item
  -- ("Charger for MacBook Pro" is a charger, "Boat on Trailer" a boat,
  -- "Stocking Holder Featuring a Truck" a stocking holder)...
  c_preps     constant text[] := array['with', 'for', 'on', 'in', 'at', 'from', 'by', 'near', 'fit', 'featur', 'depict'];
  -- ... unless the word before makes them one word with it ("plug in",
  -- "built in", "made in", "stand by", "all in one"), or "in" follows a
  -- number ("21 in." is inches).
  c_particles constant text[] := array['built', 'plug', 'drop', 'slide', 'walk', 'clip', 'add', 'roll', 'bolt', 'screw',
                                       'snap', 'pull', 'slip', 'step', 'hook', 'sit', 'ride', 'stand', 'pop', 'lay',
                                       'made', 'tuck', 'fill', 'pin', 'drive', 'put', 'log', 'sign', 'turn', 'back',
                                       'lean', 'fold', 'hang', 'mount', 'press', 'glue', 'zip', 'tie', 'strap', 'clamp',
                                       'lock', 'stick', 'peel', 'iron', 'sew', 'top', 'carri', 'check', 'all'];
begin
  heads := '{}'; mods := '{}'; mentions := '{}'; head_words := '{}';
  v_title := lower(coalesce(p_title, ''));
  -- Codes and asides in brackets ("(CW)", "(GPS + LTE)") never name the item.
  v_title := regexp_replace(v_title, '\([^)]*\)|\[[^\]]*\]', ' ', 'g');
  v_title := regexp_replace(v_title, '\s+(w/|with|includes|including|incl\.?)\s+', ' zzwith ', 'g');
  v_title := regexp_replace(v_title, '\s*[,;|]\s*|\s+[-–—]+\s+', ' zzsep ', 'g');
  v_title := regexp_replace(v_title, '\s*[&+]\s*', ' and ', 'g');
  v_toks := public.search_tokens(v_title);
  n := coalesce(cardinality(v_toks), 0);

  if n > 0 then
    select coalesce(array_agg(m.st order by m.st, m.en), '{}'), coalesce(array_agg(m.en order by m.st, m.en), '{}'),
           coalesce(array_agg(m.kind order by m.st, m.en), '{}'), coalesce(array_agg(m.concept order by m.st, m.en), '{}')
      into m_st, m_en, m_kind, m_con
      from public.search_match(v_toks) m;

    covered := array_fill(false, array[n]);
    attrish := array_fill(false, array[n]);
    for j in 1 .. coalesce(cardinality(m_st), 0) loop
      for g in m_st[j] .. m_en[j] loop
        covered[g] := true;
        if m_kind[j] <> 'item' then attrish[g] := true; end if;
      end loop;
    end loop;

    segs := array_fill(0, array[n]);
    incs := array_fill(false, array[n]);
    for i in 1 .. n loop
      if v_toks[i] = 'zzsep' then
        s := s + 1; inc := false;
      elsif v_toks[i] = 'zzwith'
            or (i > 1 and not covered[i] and v_toks[i] = any(c_preps) and not (v_toks[i - 1] = any(c_particles))
                and not (v_toks[i] = 'in' and v_toks[i - 1] ~ '^[0-9]+$')) then
        s := s + 1; inc := true;
      elsif v_toks[i] = 'and' and not covered[i] then
        s := s + 1; v_list := true;
      else
        segs[i] := s; incs[i] := inc;
      end if;
    end loop;

    v_list := v_list or v_toks && array['bulk', 'lot', 'assort', 'assortment', 'misc', 'miscellan',
                                        'more', 'mix', 'mixed', 'various', 'varieti', 'collect', 'pallet'];

    -- The rightmost item of each segment.
    h_con := array_fill(null::text, array[s]);
    h_en := array_fill(0, array[s]);
    h_inc := array_fill(false, array[s]);
    for j in 1 .. coalesce(cardinality(m_st), 0) loop
      continue when m_kind[j] <> 'item' or segs[m_en[j]] = 0;
      g := segs[m_en[j]];
      if m_en[j] >= h_en[g] then
        h_con[g] := m_con[j]; h_en[g] := m_en[j]; h_inc[g] := incs[m_en[j]];
      end if;
    end loop;
    -- A more specific kind of the head named in the same segment wins.
    for j in 1 .. coalesce(cardinality(m_st), 0) loop
      continue when m_kind[j] <> 'item' or segs[m_en[j]] = 0;
      g := segs[m_en[j]];
      if h_con[g] is not null and m_con[j] <> h_con[g]
         and exists (select 1 from public.search_concepts c
                      where c.id = m_con[j] and h_con[g] = any(c.ancestors)) then
        h_con[g] := m_con[j];
      end if;
    end loop;

    for g in 1 .. s loop
      if h_con[g] is not null and not h_inc[g] then
        if v_first is null then
          v_first := g;
          heads := array[h_con[g]];
        elsif v_list and not (h_con[g] = any(heads)) then
          heads := heads || h_con[g];
        end if;
      end if;
    end loop;

    for j in 1 .. coalesce(cardinality(m_st), 0) loop
      if m_kind[j] = 'item' and not (m_con[j] = any(heads)) and not (m_con[j] = any(mods)) then
        mods := mods || m_con[j];
      end if;
    end loop;

    -- The head word: the rightmost plain word of each head segment (or of the
    -- first segment when no known item is named), outside brands and attributes.
    for g in 1 .. s loop
      continue when not (g = coalesce(v_first, 1) or (v_list and h_con[g] is not null and not h_inc[g]));
      for i in reverse n .. 1 loop
        continue when segs[i] <> g or incs[i] or attrish[i];
        w := v_toks[i];
        continue when w !~ '^[a-z]{3,}$' or (ts_lexize('english_stem', w)) = '{}';
        if not (w = any(head_words)) then head_words := head_words || w; end if;
        exit;
      end loop;
    end loop;
  end if;

  if p_description is not null and length(p_description) > 0 then
    select coalesce(array_agg(distinct m.concept), '{}') into mentions
      from public.search_match(public.search_tokens(left(p_description, 4000))) m
     where m.kind = 'item' and not (m.concept = any(heads));
  end if;
end $$;

-- What a query asks for: as 0048, with prefix model numbers (1), required_q_ab (2) and identifiers_only (4).
create or replace function public.search_resolve(p_query text)
returns jsonb
language plpgsql stable parallel safe
set search_path = pg_catalog, public
as $$
declare
  v       text;
  v_toks  text[];
  n       integer;
  m_st    integer[];
  m_en    integer[];
  m_kind  text[];
  m_con   text[];
  m_spec  boolean[];
  covered boolean[];
  inprim  boolean[];
  segs    integer[];
  h_en    integer[];
  v_cues  text[] := '{}';
  n_items integer[];
  brandc  boolean[];
  v_prim  text[] := '{}';
  v_mods  text[] := '{}';
  v_req   text[] := '{}';
  v_words text[] := '{}';
  v_plain boolean := false;
  v_brand boolean := false;
  v_excl  text[] := '{}';
  v_req_q text[] := '{}';
  v_req_b text[] := '{}';
  v_wrd_q text[] := '{}';
  mfrag   text[];
  mfrag_b text[];
  mdisp   text[];
  taken   boolean[];
  ml      text;
  mn      text;
  v_w     text;
  v_f     text;
  v_fb    text;
  v_ident boolean := true;
  seg_mod boolean[];
  v_meas  jsonb;
  c_preps     constant text[] := array['with', 'for', 'on', 'in', 'at', 'from', 'by', 'near', 'fit', 'featur', 'depict'];
  c_particles constant text[] := array['built', 'plug', 'drop', 'slide', 'walk', 'clip', 'add', 'roll', 'bolt', 'screw',
                                       'snap', 'pull', 'slip', 'step', 'hook', 'sit', 'ride', 'stand', 'pop', 'lay',
                                       'made', 'tuck', 'fill', 'pin', 'drive', 'put', 'log', 'sign', 'turn', 'back',
                                       'lean', 'fold', 'hang', 'mount', 'press', 'glue', 'zip', 'tie', 'strap', 'clamp',
                                       'lock', 'stick', 'peel', 'iron', 'sew', 'top', 'carri', 'check', 'all'];
  -- Units a number measures in, stemmed as search_tokens() leaves them.
  c_units constant text[] := array['acr', 'acre', 'ft', 'foot', 'feet', 'inch', 'in', 'gallon', 'gal', 'lb', 'lbs',
                                   'pound', 'ton', 'hp', 'cc', 'mm', 'cm', 'gb', 'tb', 'ghz', 'mhz', 'watt', 'w', 'volt',
                                   'v', 'amp', 'ah', 'oz', 'qt', 'quart', 'liter', 'psi', 'cfm', 'gpm', 'rpm', 'btu',
                                   'cu', 'yard', 'yd', 'mile', 'mi', 'hour', 'hr', 'k', 'sq', 'squar'];
  s       integer := 1;
  i       integer;
  j       integer;
  g       integer;
begin
  v := lower(coalesce(p_query, ''));
  v := regexp_replace(v, '[“”]', '"', 'g');
  -- Excluded words and phrases ("-parts", -"power steering"), as tsquery
  -- terms over the stemmed words: a match must contain none of them.
  select coalesce(array_agg(x.q), '{}') into v_excl
    from (select array_to_string(array(select quote_literal(w) from unnest(public.search_tokens(m[2])) w), ' <-> ') as q
            from regexp_matches(v, '(^|\s)-("[^"]*"|\S+)', 'g') m) x
   where x.q <> '';
  v := regexp_replace(v, '(^|\s)-("[^"]*"|\S+)', ' ', 'g');
  v := regexp_replace(v, '"', ' ', 'g');
  v := regexp_replace(v, '\s+or\s+|\s*[,;/|]\s*', ' zzsep ', 'g');
  v := regexp_replace(v, '\s*[&+]\s*', ' and ', 'g');
  v := regexp_replace(v, '(^|\s)w/\s*', '\1with ', 'g');
  v_toks := public.search_tokens(v);
  n := coalesce(cardinality(v_toks), 0);
  -- Measures asked for ("20 acres", "25 hp", "65 inch"), read as listings are.
  v_meas := public.extract_measures(v);
  if n = 0 and cardinality(v_excl) = 0 then
    return null;
  end if;

  select coalesce(array_agg(m.st order by m.st, m.en), '{}'), coalesce(array_agg(m.en order by m.st, m.en), '{}'),
         coalesce(array_agg(m.kind order by m.st, m.en), '{}'), coalesce(array_agg(m.concept order by m.st, m.en), '{}'),
         coalesce(array_agg(m.specific order by m.st, m.en), '{}')
    into m_st, m_en, m_kind, m_con, m_spec
    from public.search_match(v_toks, true) m;

  select coalesce(array_agg(distinct cue), '{}') into v_cues
    from public.search_match(v_toks, true) m
    join public.search_terms t on t.concept = m.concept and t.kind = 'item' and t.active and m.cue_hit
    cross join unnest(t.cues) cue
   where cue = any(v_toks);

  covered := array_fill(false, array[n]);
  brandc := array_fill(false, array[n]);
  for j in 1 .. coalesce(cardinality(m_st), 0) loop
    for g in m_st[j] .. m_en[j] loop
      covered[g] := true;
      if m_kind[j] = 'brand' then brandc[g] := true; end if;
    end loop;
  end loop;

  -- Segments. One that "with", "for", "on" (and the like) opens says what the
  -- thing is for or comes with ("charger for macbook", "boat with trailer"): its
  -- items are modifiers, never the thing wanted; an "and" inside it continues it.
  segs := array_fill(0, array[n]);
  seg_mod := array[false];
  for i in 1 .. n loop
    if v_toks[i] = 'zzsep' or (v_toks[i] = 'and' and not covered[i]) then
      s := s + 1;
      seg_mod := seg_mod || (v_toks[i] = 'and' and seg_mod[s - 1]);
    elsif v_toks[i] = 'zzwith'
          or (i > 1 and not covered[i] and v_toks[i] = any(c_preps) and not (v_toks[i - 1] = any(c_particles))
              and not (v_toks[i] = 'in' and v_toks[i - 1] ~ '^[0-9]+$')) then
      s := s + 1;
      seg_mod := seg_mod || true;
    else
      segs[i] := s;
    end if;
  end loop;

  -- The rightmost item span of each segment; every meaning that span keeps.
  -- A segment naming three or more items is a list: each is wanted.
  h_en := array_fill(0, array[s]);
  n_items := array_fill(0, array[s]);
  for j in 1 .. coalesce(cardinality(m_st), 0) loop
    continue when m_kind[j] <> 'item' or segs[m_en[j]] = 0;
    g := segs[m_en[j]];
    if m_en[j] > h_en[g] then h_en[g] := m_en[j]; n_items[g] := n_items[g] + 1; end if;
  end loop;

  inprim := array_fill(false, array[n]);
  for j in 1 .. coalesce(cardinality(m_st), 0) loop
    continue when m_kind[j] <> 'item' or segs[m_en[j]] = 0;
    g := segs[m_en[j]];
    continue when seg_mod[g];
    continue when m_en[j] <> h_en[g] and n_items[g] < 3;
    if not (m_con[j] = any(v_prim)) then v_prim := v_prim || m_con[j]; end if;
    -- A term that names the thing ("computer", "cell phone") need not appear.
    -- A narrower kind keeps its own words ("socket set"), and so does a
    -- product's name ("iphone"), except a word that alone names the thing
    -- ("laptop" in "gaming laptop": a gaming notebook is one).
    for i in m_st[j] .. m_en[j] loop
      if not m_spec[j] or exists (select 1 from public.search_terms t
                                   where t.norm = v_toks[i] and t.concept = m_con[j] and t.kind = 'item'
                                     and t.active and not t.specific) then
        inprim[i] := true;
      end if;
    end loop;
  end loop;

  for j in 1 .. coalesce(cardinality(m_st), 0) loop
    if m_kind[j] = 'item' and not (m_con[j] = any(v_prim)) and not (m_con[j] = any(v_mods)) then
      v_mods := v_mods || m_con[j];
    end if;
  end loop;

  -- Model numbers: a few letters then digits, together or apart ("f150",
  -- "F-150", "F 150", "ms250", "AR-15"). The text index keeps "F-150" as 'f'
  -- and '-150' and "F150" as 'f150', so each is asked for in every form. A
  -- letter the index drops as a stop word ("S-185" is kept as '-185' alone)
  -- is left out of the phrase. The number matches as a prefix, so a trim
  -- glued to it still counts ("F-150XL"). mfrag_b is the same asked of the
  -- title, brand and model (weights A and B).
  mfrag := array_fill(null::text, array[n]);
  mfrag_b := array_fill(null::text, array[n]);
  mdisp := array_fill(null::text, array[n]);
  taken := array_fill(false, array[n]);
  for i in 1 .. n loop
    continue when taken[i] or inprim[i] or segs[i] = 0;
    if v_toks[i] ~ '^[a-z]{1,3}$' and i < n and segs[i + 1] = segs[i]
       and v_toks[i + 1] ~ '^[0-9]+[a-z0-9]*$' then
      ml := v_toks[i]; mn := v_toks[i + 1]; taken[i + 1] := true;
    elsif v_toks[i] ~ '^[a-z]{1,3}[0-9]+[a-z0-9]*$' then
      ml := substring(v_toks[i] from '^[a-z]+'); mn := substring(v_toks[i] from '^[a-z]+(.*)$');
    else
      continue;
    end if;
    if (ts_lexize('english_stem', ml)) = '{}' then
      mfrag[i] := format('%1$s | %2$s:* | %3$s:*', quote_literal(mn), quote_literal('-' || mn), quote_literal(ml || mn));
      mfrag_b[i] := format('%1$s:AB | %2$s:*AB | %3$s:*AB', quote_literal(mn), quote_literal('-' || mn), quote_literal(ml || mn));
    else
      mfrag[i] := format('%1$s <-> %2$s:* | %1$s <-> %3$s:* | %4$s:*',
                         quote_literal(ml), quote_literal(mn), quote_literal('-' || mn), quote_literal(ml || mn));
      mfrag_b[i] := format('%1$s:AB <-> %2$s:*AB | %1$s:AB <-> %3$s:*AB | %4$s:*AB',
                           quote_literal(ml), quote_literal(mn), quote_literal('-' || mn), quote_literal(ml || mn));
    end if;
    mdisp[i] := ml || mn;
  end loop;

  for i in 1 .. n loop
    continue when segs[i] = 0 or taken[i] or (mfrag[i] is null and (ts_lexize('english_stem', v_toks[i])) = '{}');
    v_w := coalesce(mdisp[i], v_toks[i]);
    v_f := coalesce(mfrag[i], quote_literal(v_toks[i]));
    v_fb := coalesce(mfrag_b[i], quote_literal(v_toks[i]) || ':AB');
    if not (v_w = any(v_words)) then v_words := v_words || v_w; v_wrd_q := v_wrd_q || v_f; end if;
    continue when inprim[i];
    -- A cue that only chose a meaning is not required; a brand always is, and
    -- so is a number ("2017" in "2017 audi").
    continue when v_toks[i] = any(v_cues) and not brandc[i] and v_toks[i] !~ '^[0-9]+$';
    -- A number with its unit measures ("20 acres", "7500 watt"): the listing
    -- may say 18 acres or 8000 watts. So does one written without the space
    -- ("256gb", "20acres"), which a listing may well write as "256 GB".
    continue when v_toks[i] ~ '^[0-9]+$' and i < n and v_toks[i + 1] = any(c_units);
    continue when v_toks[i] = any(c_units) and i > 1 and v_toks[i - 1] ~ '^[0-9]+$';
    continue when v_toks[i] ~ ('^[0-9]+(acr|acre|ft|in|gallon|gal|lb|lbs|ton|hp|cc|mm|cm|gb|tb|ghz|mhz|watt|w|volt|v|'
                               'amp|ah|oz|qt|liter|psi|cfm|gpm|rpm|btu|yd|mi|hr|k)$');
    if not (v_w = any(v_req)) then v_req := v_req || v_w; v_req_q := v_req_q || v_f; v_req_b := v_req_b || v_fb; end if;
    -- Is every word asked for a brand or a model number ("kubota l3800")?
    if not (brandc[i] or v_w ~ '[0-9]') then v_ident := false; end if;
    -- A word no brand or attribute explains makes this more than a brand search.
    if not covered[i] then v_plain := true; end if;
  end loop;

  v_brand := cardinality(v_prim) = 0 and cardinality(v_mods) = 0 and not v_plain
             and 'brand' = any(m_kind);

  return jsonb_build_object(
    'primary', to_jsonb(v_prim),
    'modifiers', to_jsonb(v_mods),
    'required', to_jsonb(v_req),
    'required_q', to_jsonb(v_req_q),
    'required_q_ab', to_jsonb(v_req_b),
    'words', to_jsonb(v_words),
    'words_q', to_jsonb(v_wrd_q),
    'excluded', to_jsonb(v_excl),
    'measures', v_meas,
    'brand_only', v_brand,
    -- Only brands and model numbers, no item: the title naming them is the match.
    'identifiers_only', v_ident and cardinality(v_req) > 0 and cardinality(v_prim) = 0,
    'expanded', to_jsonb(coalesce((select array_agg(distinct d) from public.search_concepts c, unnest(c.descendants) d
                                    where c.id = any(v_prim)), '{}')),
    'expanded_all', to_jsonb(coalesce((select array_agg(distinct d) from public.search_concepts c, unnest(c.descendants) d
                                        where c.id = any(v_prim || v_mods)), '{}')),
    'related', to_jsonb(coalesce((select array_agg(distinct d)
                                    from public.search_concepts c
                                    cross join unnest(c.related) r
                                    join public.search_concepts rc on rc.id = r
                                    cross join unnest(rc.descendants) d
                                   where c.id = any(v_prim)), '{}')),
    -- Coarser kinds a lot may have been filed under: a "2017 Audi Q7" known
    -- only as a vehicle may well be the car asked for.
    'broader', to_jsonb(coalesce((select array_agg(distinct a)
                                    from public.search_concepts c
                                    cross join unnest(c.ancestors) a
                                   where c.id = any(v_prim) and a <> all(v_prim)), '{}'))
  );
end $$;

-- search_lots: as 0048, reading required_q_ab (2) and identifiers_only (4).
create or replace function public.search_lots(
  p_query                text default null,
  p_postal_code          text default null,
  p_radius_miles         integer default 50,
  p_include_shippable    boolean default true,
  p_states               text[] default null,
  p_min_cents            bigint default null,
  p_max_cents            bigint default null,
  p_category_ids         bigint[] default null,
  p_tiers                source_tier[] default null,
  p_closing_within_hours integer default null,
  p_min_sleeper          numeric default null,
  p_sort                 text default 'relevance',
  p_limit                integer default 50,
  p_offset               integer default 0,
  p_tsquery              text default null,
  p_scope                text default 'all'
)
returns table (
  lot_id uuid, title text, lot_number text, url text, primary_image_url text, image_count integer,
  current_bid_cents bigint, next_bid_cents bigint, estimate_low_cents bigint, bid_count integer,
  closes_at timestamptz, auction_title text, auctioneer text, source_name text, source_tier source_tier,
  pickup_city text, pickup_state text, pickup_postal_code text, ships boolean, distance_miles numeric,
  sleeper_score numeric, sleeper_reasons jsonb, relevance numeric, match_basis text, pickup_geo_source text,
  sale_level boolean, sale_lot_count integer, match_tier integer, match_concept text, match_label text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_origin   extensions.geography;
  v_meters   double precision;
  v_tsq      tsquery;
  v_res      jsonb;
  v_items    boolean := false;
  v_brand    boolean := false;
  v_exp      text[] := '{}';
  v_all      text[] := '{}';
  v_rel      text[] := '{}';
  v_brd      text[] := '{}';
  v_reqw     text[] := '{}';
  v_req      tsquery;
  v_req_ab   tsquery;
  v_any      tsquery;
  v_excl     tsquery;
  v_meas     jsonb;
  v_ident    boolean := false;
  v_max_tier integer;
begin
  v_origin := resolve_origin(p_postal_code);
  v_meters := greatest(coalesce(p_radius_miles, 50), 1) * 1609.344;
  v_max_tier := case p_scope when 'exact' then 1 when 'related' then 2 else 3 end;

  -- The parser's grouped query first (synonyms, model variants). If it does
  -- not parse, or holds only stop words, fall back to the plain string.
  if p_tsquery is not null and length(trim(p_tsquery)) > 0 then
    begin
      v_tsq := to_tsquery('english', p_tsquery);
    exception when others then
      v_tsq := null;
    end;
    if v_tsq is not null and numnode(v_tsq) = 0 then
      v_tsq := null;
    end if;
  end if;
  if v_tsq is null and p_query is not null and length(trim(p_query)) > 0 then
    v_tsq := websearch_to_tsquery('english', p_query);
    if numnode(v_tsq) = 0 then v_tsq := null; end if;
  end if;

  if p_query is not null and length(btrim(p_query)) > 0 then
    v_res := search_resolve(p_query);
  end if;
  if v_res is not null then
    v_items := jsonb_array_length(v_res -> 'primary') > 0;
    v_brand := coalesce((v_res ->> 'brand_only')::boolean, false);
    v_exp := array(select jsonb_array_elements_text(v_res -> 'expanded'));
    v_all := array(select jsonb_array_elements_text(v_res -> 'expanded_all'));
    v_rel := array(select jsonb_array_elements_text(v_res -> 'related'));
    v_brd := array(select jsonb_array_elements_text(coalesce(v_res -> 'broader', '[]')));
    v_reqw := array(select jsonb_array_elements_text(v_res -> 'required'));
    -- Each required word is a tsquery over stemmed words ('f' <-> '-150':* |
    -- 'f150':* for a model number); required_q_ab asks the same of the title,
    -- brand and model.
    if jsonb_array_length(coalesce(v_res -> 'required_q', '[]')) > 0 then
      v_req := to_tsquery('simple', array_to_string(array(
                 select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'required_q') q), ' & '));
      v_req_ab := to_tsquery('simple', array_to_string(array(
                    select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'required_q_ab') q), ' & '));
    end if;
    if jsonb_array_length(coalesce(v_res -> 'words_q', '[]')) > 0 then
      v_any := to_tsquery('simple', array_to_string(array(
                 select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'words_q') q), ' & '));
    end if;
    v_meas := nullif(v_res -> 'measures', '{}'::jsonb);
    v_ident := coalesce((v_res ->> 'identifiers_only')::boolean, false);
    if jsonb_array_length(coalesce(v_res -> 'excluded', '[]')) > 0 then
      v_excl := to_tsquery('simple', array_to_string(array(
                  select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'excluded') q), ' | '));
    end if;
  end if;

  return query
  with candidate as (
    select l.*, a.title as a_title, a.auctioneer as a_auctioneer, a.lot_count as a_lot_count,
           s.name as s_name, s.tier as s_tier,
           case when v_origin is not null and l.pickup_geom is not null
                then (extensions.st_distance(l.pickup_geom, v_origin) / 1609.344)::numeric end as dist_miles
      from lots l
      join sources s on s.id = l.source_id
      left join auctions a on a.id = l.auction_id
     where l.closed = false and s.active and s.ingest_allowed
       and (
             v_res is null
          or (v_items and (l.item_heads && (v_all || v_rel || v_brd) or l.item_mods && (v_all || v_rel)
                           or l.item_mentions && (v_all || v_rel)))
          or (v_any is not null and l.search_tsv @@ v_any)
          or (not v_items and v_tsq is not null and l.search_tsv @@ v_tsq)
       )
       and (v_excl is null or not l.search_tsv @@ v_excl)
       and (p_min_cents is null
            or coalesce(l.current_bid_cents, l.starting_bid_cents, 0) >= p_min_cents)
       and (p_max_cents is null
            or coalesce(l.next_bid_cents, l.current_bid_cents, l.starting_bid_cents, 0) <= p_max_cents)
       and (p_category_ids is null or l.category_id = any(p_category_ids))
       and (p_tiers is null or s.tier = any(p_tiers))
       and (p_closing_within_hours is null
            or (l.closes_at is not null and l.closes_at <= now() + make_interval(hours => p_closing_within_hours)))
       and (p_min_sleeper is null or coalesce(l.sleeper_score, 0) >= p_min_sleeper)
       and (
             (v_origin is null and p_states is null)
          or (v_origin is not null and l.pickup_geom is not null
              and extensions.st_dwithin(l.pickup_geom, v_origin, v_meters))
          or (p_states is not null and l.pickup_state = any(p_states))
          or (coalesce(p_include_shippable, true) and l.ships)
       )
  ), measured as (
    -- A measure asked for ("20 acres") must be met within its unit's give:
    -- acreage 0.75 to 1.5 times, screens to 5%, capacity exactly, hours and
    -- miles at most, most others a fifth either way.
    select c.*,
      (v_meas is null or not exists (
         select 1 from jsonb_each(v_meas) q(u, qv)
          where not exists (
            select 1 from jsonb_array_elements_text(coalesce(c.measures -> q.u, '[]'::jsonb)) lv(x)
             where lv.x::numeric
                   between (qv ->> 0)::numeric * (case q.u when 'acre' then 0.75 when 'inch' then 0.95 when 'gb' then 0.99
                                                           when 'volt' then 0.99 when 'ft' then 0.9 when 'cc' then 0.9
                                                           when 'yard' then 0.9 when 'mile' then 0 when 'hour' then 0
                                                           else 0.8 end)
                       and (qv ->> 0)::numeric * (case q.u when 'acre' then 1.5 when 'inch' then 1.05 when 'gb' then 1.01
                                                           when 'volt' then 1.01 when 'ft' then 1.1 when 'cc' then 1.1
                                                           when 'yard' then 1.1 when 'mile' then 1.1 when 'hour' then 1.1
                                                           else 1.25 end)))) as meas_ok
      from candidate c
  ), tiered as (
    select c.*,
      case
        when v_res is null then 1
        when v_items then
          case
            -- It IS one, and everything else typed is there.
            when (c.item_heads && v_exp or (c.sale_level and c.item_mentions && v_exp))
                 and (v_req is null or c.search_tsv @@ v_req) and c.meas_ok then 1
            -- A close match: another thing the query names, a related kind, a
            -- coarser kind it may be, or a lot whose description says it
            -- includes the thing.
            when c.item_heads && (v_all || v_rel || v_brd) or c.item_mentions && v_exp then 2
            else 3
          end
        when v_brand then
          case when ((v_req_ab is not null and c.search_tsv @@ v_req_ab) or c.sale_level) and c.meas_ok then 1 else 3 end
        else
          case
            when c.sale_level and (v_req is null or c.search_tsv @@ v_req) and c.meas_ok then 1
            when v_req_ab is not null and c.search_tsv @@ v_req_ab and (c.head_words && v_reqw or v_ident)
                 and c.meas_ok then 1
            when v_meas is not null and c.meas_ok and (v_req is null or c.search_tsv @@ v_req) then 1
            when v_req_ab is not null and c.search_tsv @@ v_req_ab then 2
            when v_req is null and v_tsq is not null and c.search_tsv @@ v_tsq then 2
            else 3
          end
      end as tier,
      coalesce(
        (select h from unnest(c.item_heads) h where h = any(v_exp) limit 1),
        (select h from unnest(c.item_heads) h where h = any(v_all || v_rel) limit 1),
        c.item_heads[1]
      ) as concept
    from measured c
  ), scored as (
    select t.*,
      -- ts_rank, NOT ts_rank_cd: cover density is for prose, and an auction
      -- title is an unordered bag of attributes.
      case when v_tsq is null then 0::numeric else ts_rank(t.search_tsv, v_tsq)::numeric end as r_text,
      -- Smooth decay, no cliff at the radius. Null distance means "location
      -- irrelevant" (shippable), not "infinitely far".
      case when t.dist_miles is null then 0.35::numeric
           else (1.0 / (1.0 + (t.dist_miles / greatest(p_radius_miles, 1)))) end as r_prox,
      case when t.closes_at is null or t.closes_at <= now() then 0::numeric
           else greatest(0::numeric, 1 - (extract(epoch from (t.closes_at - now())) / (72 * 3600))::numeric) end as r_urgency,
      (coalesce(t.sleeper_score, 0) / 10.0)::numeric as r_sleeper,
      case when t.primary_image_url is not null then 1::numeric else 0::numeric end as r_photo,
      case when t.dist_miles is not null and t.dist_miles <= p_radius_miles then 'nearby'
           when p_states is not null and t.pickup_state = any(p_states) then 'in_state'
           when t.ships then 'ships_to_you' else 'other' end as basis
    from tiered t
    where t.tier <= v_max_tier
  )
  select sc.id, sc.title, sc.lot_number, sc.url, sc.primary_image_url, sc.image_count,
         sc.current_bid_cents, sc.next_bid_cents, sc.estimate_low_cents, sc.bid_count,
         sc.closes_at, sc.a_title, sc.a_auctioneer, sc.s_name, sc.s_tier,
         sc.pickup_city, sc.pickup_state, sc.pickup_postal_code, sc.ships,
         round(sc.dist_miles, 1), sc.sleeper_score, sc.sleeper_reasons,
         round(2.0 * sc.r_text + 1.5 * sc.r_prox + 0.8 * sc.r_urgency
             + 0.6 * sc.r_sleeper + 0.15 * sc.r_photo, 4) as relevance,
         sc.basis,
         sc.pickup_geo_source,
         sc.sale_level,
         sc.a_lot_count,
         sc.tier,
         sc.concept,
         (select k.label from search_concepts k where k.id = sc.concept)
    from scored sc
   order by
     sc.tier,
     case when p_sort = 'closing'  then sc.closes_at end asc nulls last,
     case when p_sort = 'nearest'  then sc.dist_miles end asc nulls last,
     case when p_sort = 'cheapest' then coalesce(sc.current_bid_cents, sc.starting_bid_cents) end asc nulls last,
     case when p_sort = 'sleeper'  then sc.sleeper_score end desc nulls last,
     case when p_sort = 'newest'   then sc.first_seen_at end desc nulls last,
     case when p_sort not in ('closing', 'nearest', 'cheapest', 'sleeper', 'newest')
          then (2.0 * sc.r_text + 1.5 * sc.r_prox + 0.8 * sc.r_urgency
              + 0.6 * sc.r_sleeper + 0.15 * sc.r_photo) end desc nulls last,
     sc.id
   limit greatest(least(coalesce(p_limit, 50), 200), 1)
   offset greatest(coalesce(p_offset, 0), 0);
end $$;

notify pgrst, 'reload schema';
