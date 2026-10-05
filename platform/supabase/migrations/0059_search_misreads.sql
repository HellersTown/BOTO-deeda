-- 0059: three misreads of a title's words.
--
-- 1. "ATS Power ATS-ME18 Mini Excavator" was no excavator: "ATS" stems to
--    "at", which classify_listing took for the preposition, so everything
--    after it read as what the item is AT. "3” EMT FITTINGS" lost its head the
--    same way ("fittings" stems to "fit"). Prepositions are now matched on the
--    words as typed, aligned one to one with the stems.
-- 2. "Wardrobe Organizers" was an organ (Pianos & keyboards): "organizer"
--    stems to "organ". Like 0052's participles, a word ending in -izer keeps
--    its form in search_tokens ("organizers" is "organizer"), so the
--    vocabulary can name it; search_ts_word re-stems it for the text index,
--    which still holds "organ".
-- 3. Lexicon names that end in the item ("PJ Trailer", "Barber Dime",
--    "Kennedy Half Dollar") swallowed it, leaving the lot with no kind. The
--    vocabulary that follows (0060) lists each as an item of its kind too.
--
-- 0060 loads vocabulary v5, which moves the version on: every lot is then
-- re-classified in the background with these functions (reclassify_lots).
--
-- Applied with execute_sql. Nothing here deletes or drops.

-- As 0052, with -izer words kept whole.
create or replace function public.search_tokens(p_text text)
returns text[]
language sql stable parallel safe
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(case
                              when w ~ '^[a-z]{3,}ed$' and w !~ '(bed|shed|sled|eed)$' then w
                              when w ~ '^[a-z]{3,}izers?$' then regexp_replace(w, 's$', '')
                              else coalesce(nullif((ts_lexize('english_stem', w))[1], ''), w)
                            end order by o), '{}')
    from regexp_split_to_table(
           btrim(regexp_replace(
             regexp_replace(lower(coalesce(p_text, '')), '([0-9])\s*-?\s*pcs?\M\.?', '\1 piece', 'g'),
             '[^a-z0-9]+', ' ', 'g')),
           ' ') with ordinality as x(w, o)
   where w <> ''
$$;

-- As 0052, re-stemming -izer words for the text index too.
create or replace function public.search_ts_word(p_tok text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select case
           when (p_tok ~ '^[a-z]{3,}ed$' and p_tok !~ '(bed|shed|sled|eed)$') or p_tok ~ '^[a-z]{3,}izer$'
             then coalesce(nullif((ts_lexize('english_stem', p_tok))[1], ''), p_tok)
           else p_tok
         end
$$;

-- As 0052, with prepositions matched on the words as typed.
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
  v_raw    text[];
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
  -- These are words as typed, not stems (0059): "ATS" stems to "at" and
  -- "Fittings" to "fit", and neither is a preposition.
  c_preps     constant text[] := array['with', 'for', 'on', 'in', 'at', 'from', 'by', 'near', 'fit', 'fits',
                                       'featuring', 'features', 'depicting', 'depicts'];
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
  -- The same words as typed, one per token (search_tokens splits the same way).
  select coalesce(array_agg(x.w order by x.o), '{}') into v_raw
    from regexp_split_to_table(
           btrim(regexp_replace(
             regexp_replace(v_title, '([0-9])\s*-?\s*pcs?\M\.?', '\1 piece', 'g'),
             '[^a-z0-9]+', ' ', 'g')),
           ' ') with ordinality as x(w, o)
   where x.w <> '';
  if coalesce(cardinality(v_raw), 0) <> coalesce(cardinality(v_toks), 0) then
    v_raw := v_toks;
  end if;
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
            or (i > 1 and not covered[i] and v_raw[i] = any(c_preps) and not (v_toks[i - 1] = any(c_particles))
                and not (v_raw[i] = 'in' and v_toks[i - 1] ~ '^[0-9]+$')) then
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
