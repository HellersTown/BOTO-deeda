-- 0052: a word ending in -ed that describes an item is not the item.
--
-- search_tokens() stems every word, and the English stemmer folds a past
-- participle into the noun it comes from. "wooded" became "wood", so "20 acres
-- wooded" was read as lumber; "caged" was a cage, "plated" plates,
-- "engineered" an engine, "weighted" fitness weights, "signed" a sign,
-- "mounted" a TV mount. Such a word now keeps its own form wherever names are
-- matched, in listings and queries alike, so it only ever matches a term that
-- says it ("stuffed animal", "enclosed trailer"). Nouns ending in -bed, -shed,
-- -sled or -eed ("flatbed", "daybed", "woodshed", "birdseed") stem as before.
--
-- The text index (lots.search_tsv) still holds the stem, so where a word turns
-- into a tsquery (required and excluded words) search_ts_word() gives it back:
-- "wooded land" asks for land whose listing mentions wood or wooded.
--
-- Every term's norm depends on search_tokens(), so the vocabulary is loaded
-- again right after this (0053), which also moves reclassify_lots on to every
-- lot.
--
-- Applied with execute_sql. Nothing here deletes or drops.

-- ------------------------------------------------------------ words
-- As 0045, except that a past participle keeps its form (see above).
create or replace function public.search_tokens(p_text text)
returns text[]
language sql stable parallel safe
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(case
                              when w ~ '^[a-z]{3,}ed$' and w !~ '(bed|shed|sled|eed)$' then w
                              else coalesce(nullif((ts_lexize('english_stem', w))[1], ''), w)
                            end order by o), '{}')
    from regexp_split_to_table(
           btrim(regexp_replace(
             regexp_replace(lower(coalesce(p_text, '')), '([0-9])\s*-?\s*pcs?\M\.?', '\1 piece', 'g'),
             '[^a-z0-9]+', ' ', 'g')),
           ' ') with ordinality as x(w, o)
   where w <> ''
$$;

-- A token as the text index keeps it: the stem of a participle search_tokens()
-- left whole, any other token as it is (it is a stem already).
create or replace function public.search_ts_word(p_tok text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select case
           when p_tok ~ '^[a-z]{3,}ed$' and p_tok !~ '(bed|shed|sled|eed)$'
             then coalesce(nullif((ts_lexize('english_stem', p_tok))[1], ''), p_tok)
           else p_tok
         end
$$;
revoke all on function public.search_ts_word(text) from public;
grant execute on function public.search_ts_word(text) to anon, authenticated;

-- What a listing IS: as 0050, with "assorted" among the words that make a
-- title a list (it no longer stems to "assort").
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

    v_list := v_list or v_toks && array['bulk', 'lot', 'assort', 'assorted', 'assortment', 'misc', 'miscellan',
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

-- What a query asks for: as 0050, with required and excluded words given back
-- the stems the text index holds (search_ts_word).
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
    from (select array_to_string(array(select quote_literal(public.search_ts_word(w)) from unnest(public.search_tokens(m[2])) w), ' <-> ') as q
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
    -- The text index keeps a participle's stem: "wooded" is asked for as 'wood'.
    v_f := coalesce(mfrag[i], quote_literal(public.search_ts_word(v_toks[i])));
    v_fb := coalesce(mfrag_b[i], quote_literal(public.search_ts_word(v_toks[i])) || ':AB');
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
