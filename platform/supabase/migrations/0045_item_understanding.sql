-- 0045: search understands what a listing IS.
--
-- Until now search matched words. A hunt for "computer" asked for
-- ( 'computer' | 'pc' ) anywhere in a listing and returned five "All Steel
-- Computer Chair" lots, a computer speaker system, and every socket set whose
-- description said "32 pc." (pieces). It missed every laptop, MacBook,
-- Chromebook and iMac in range, because their titles never say "computer".
--
-- Now every lot is classified by its head noun, the last item its title names
-- (English puts the thing last: a computer chair is a chair), against the item
-- vocabulary in search_concepts / search_terms (0046, generated from
-- packages/query/src/taxonomy.ts). A query is read the same way, and
-- search_lots ranks lots in three tiers:
--
--   1  the lot IS what was asked for, or a kind of it ("computer" finds
--      laptops, desktops, all-in-ones, MacBooks, Chromebooks), and every
--      other word typed appears in it;
--   2  a close match: a related kind (tablets and monitors beside computers),
--      one of the other things the query names, or a lot whose description
--      says it includes the thing;
--   3  a mention: the words appear, but the lot is something else (the
--      computer chair).
--
-- Hunts alert on tier 1 by default (hunts.match_scope), so a hunt for a
-- computer never again alerts on a chair.
--
-- Applied with execute_sql, statement by statement, because apply_migration
-- times out on this project (as for 0037 onward). Nothing here deletes or
-- drops: a vocabulary reload switches old terms off rather than deleting
-- them, and the old search_lots is renamed out of the way, not dropped, so
-- nothing calling it ever finds it missing.

-- ------------------------------------------------------------ vocabulary
create table if not exists public.search_concepts (
  id          text primary key,
  label       text not null,
  parent      text references public.search_concepts(id) on delete cascade,
  related     text[] not null default '{}',
  ancestors   text[] not null default '{}',
  descendants text[] not null default '{}',
  active      boolean not null default true
);

create table if not exists public.search_terms (
  id         bigint generated always as identity primary key,
  term       text not null,
  norm       text not null,
  kind       text not null check (kind in ('item', 'brand', 'attr')),
  concept    text references public.search_concepts(id) on delete cascade,
  cues       text[] not null default '{}',
  is_default boolean not null default true,
  specific   boolean not null default false,
  active     boolean not null default true,
  check ((kind = 'item') = (concept is not null))
);
create unique index if not exists search_terms_key on public.search_terms (norm, kind, concept) nulls not distinct;
create index if not exists search_terms_norm_idx on public.search_terms (norm);

-- The vocabulary's version. Lots classified under an older one are
-- re-classified in the background (reclassify_lots, every minute).
create table if not exists public.search_meta (
  id                 boolean primary key default true check (id),
  vocabulary_version integer not null default 0,
  loaded_at          timestamptz
);
insert into public.search_meta (id) values (true) on conflict (id) do nothing;

alter table public.search_concepts enable row level security;
alter table public.search_terms enable row level security;
alter table public.search_meta enable row level security;
revoke all on public.search_concepts, public.search_terms, public.search_meta from anon, authenticated;

-- ------------------------------------------------------------ words
-- Words, lowercased and stemmed the way lots.search_tsv is ('english'), so
-- "Laptops" and "laptop" are one word. A stop word stays as written: it holds
-- its place inside a phrase ("chest of drawers", "all in one"). "32 pc." and
-- "60pcs" are pieces, never personal computers.
create or replace function public.search_tokens(p_text text)
returns text[]
language sql stable parallel safe
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(coalesce(nullif((ts_lexize('english_stem', w))[1], ''), w) order by o), '{}')
    from regexp_split_to_table(
           btrim(regexp_replace(
             regexp_replace(lower(coalesce(p_text, '')), '([0-9])\s*-?\s*pcs?\M\.?', '\1 piece', 'g'),
             '[^a-z0-9]+', ' ', 'g')),
           ' ') with ordinality as x(w, o)
   where w <> ''
$$;

create or replace function public.search_norm(p_text text)
returns text
language sql stable parallel safe
set search_path = pg_catalog, public
as $$ select array_to_string(public.search_tokens(p_text), ' ') $$;

-- Every vocabulary term found in a token list: its span, kind and concept.
-- The longest match wins: "computer chair" swallows "computer" and "chair".
-- Where a term means two things ("router": a woodworking tool or a network
-- box), the meaning whose cue words appear in the same text wins, else the
-- default one. A query (p_all_meanings) keeps every meaning its own words do
-- not rule out: "router" alone asks for both kinds.
--
-- plpgsql so its plan is cached: it runs twice for every lot classified. The
-- candidate phrases are built first and looked up by index, never by
-- scanning the vocabulary.
create or replace function public.search_match(p_toks text[], p_all_meanings boolean default false)
returns table (st integer, en integer, kind text, concept text, cue_hit boolean, specific boolean)
language plpgsql stable parallel safe
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  n      integer := coalesce(cardinality(p_toks), 0);
  v_st   integer[] := '{}';
  v_en   integer[] := '{}';
  v_norm text[] := '{}';
  a      integer;
  b      integer;
begin
  -- Every run of one to five words that crosses no separator and neither
  -- starts nor ends with "and".
  for a in 1 .. n loop
    continue when p_toks[a] in ('zzsep', 'zzwith', 'and');
    for b in a .. least(a + 4, n) loop
      exit when p_toks[b] in ('zzsep', 'zzwith');
      continue when p_toks[b] = 'and';
      v_st := v_st || a;
      v_en := v_en || b;
      v_norm := v_norm || array_to_string(p_toks[a:b], ' ');
    end loop;
  end loop;
  if cardinality(v_norm) = 0 then
    return;
  end if;

  return query
  with terms as materialized (
    select t.norm, t.kind, t.concept, t.cues, t.is_default, t.specific
      from public.search_terms t
     where t.norm = any(v_norm) and t.active
  ), hits as (
    select g.st, g.en, t.kind, t.concept, t.cues, t.is_default, t.specific
      from unnest(v_st, v_en, v_norm) as g(st, en, norm)
      join terms t on t.norm = g.norm
  ), outer_hits as (
    select h.*
      from hits h
     where not exists (select 1 from hits h2
                        where h2.st <= h.st and h2.en >= h.en
                          and (h2.en - h2.st) > (h.en - h.st))
  ), ranked as (
    select o.*, (o.cues && p_toks) as hit,
           bool_or(o.cues && p_toks) over (partition by o.st, o.en, o.kind) as any_hit,
           row_number() over (partition by o.st, o.en, o.kind
                              order by (o.cues && p_toks) desc, o.is_default desc, o.concept) as rn
      from outer_hits o
  )
  select r.st, r.en, r.kind, r.concept, r.hit, r.specific
    from ranked r
   where (r.rn = 1 and (r.is_default or r.hit))
      or (p_all_meanings and r.kind = 'item' and (r.hit or not r.any_hit));
end $$;

-- ------------------------------------------------------------ listings
-- What a listing IS. Titles are cut into segments at commas, dashes, "with"
-- and every "and" no term swallowed ("tap and die" is one tool, "saw and
-- router" two), and each segment's rightmost item is its head; a more
-- specific kind named in the same segment wins ("Dell Chromebook 5190
-- Laptop" is a Chromebook). The first segment's head is the lot; later
-- segments add heads only when the title is a list ("Mice, Adapters And Power
-- Banks Bulk Lot"), never for trailing attributes ("44mm Aluminum Case, Band").
--
-- heads: what the lot is. mods: other things the title names (the computer in
-- "computer chair"). mentions: things the description names. head_words: the
-- head word itself, so an unknown "anvil" is still told from an anvil-shaped
-- paperweight.
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
      elsif v_toks[i] = 'zzwith' then
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

-- ------------------------------------------------------------ queries
-- What a query asks for. Within a phrase the last item is the thing wanted
-- ("tractor tire" wants tires); commas, "or" and a free "and" separate things
-- wanted side by side, and so does a run of three or more items, which is a
-- list ("thermal drone sensors controller"). Every word outside the wanted
-- items' own terms must appear in a match: brands, colours, model numbers,
-- "thermal", "tractor"; and so must a specific product's own name ("iphone",
-- "rolex"), so "rolex" finds Rolex watches, not every watch. Two kinds of
-- word need not: one that only chose a meaning ("wifi" in "wifi router"),
-- and a number that measures ("20" in "20 acres"). Model numbers match
-- however a listing writes them ("f150", "F-150", "F 150").
--
-- required_q and words_q hold each required word, and each word, as a
-- tsquery over the stemmed words, for search_lots.
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
  v_wrd_q text[] := '{}';
  mfrag   text[];
  mdisp   text[];
  taken   boolean[];
  ml      text;
  mn      text;
  v_w     text;
  v_f     text;
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
  v_toks := public.search_tokens(v);
  n := coalesce(cardinality(v_toks), 0);
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

  segs := array_fill(0, array[n]);
  for i in 1 .. n loop
    if v_toks[i] in ('zzsep', 'zzwith') or (v_toks[i] = 'and' and not covered[i]) then
      s := s + 1;
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
    continue when m_en[j] <> h_en[g] and n_items[g] < 3;
    if not (m_con[j] = any(v_prim)) then v_prim := v_prim || m_con[j]; end if;
    -- A specific product's own words stay required ("iphone", "rolex").
    continue when m_spec[j];
    for i in m_st[j] .. m_en[j] loop inprim[i] := true; end loop;
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
  -- is left out of the phrase.
  mfrag := array_fill(null::text, array[n]);
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
      mfrag[i] := format('%1$s | %2$s | %3$s', quote_literal(mn), quote_literal('-' || mn), quote_literal(ml || mn));
    else
      mfrag[i] := format('%1$s <-> %2$s | %1$s <-> %3$s | %4$s',
                         quote_literal(ml), quote_literal(mn), quote_literal('-' || mn), quote_literal(ml || mn));
    end if;
    mdisp[i] := ml || mn;
  end loop;

  for i in 1 .. n loop
    continue when segs[i] = 0 or taken[i] or (mfrag[i] is null and (ts_lexize('english_stem', v_toks[i])) = '{}');
    v_w := coalesce(mdisp[i], v_toks[i]);
    v_f := coalesce(mfrag[i], quote_literal(v_toks[i]));
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
    if not (v_w = any(v_req)) then v_req := v_req || v_w; v_req_q := v_req_q || v_f; end if;
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
    'words', to_jsonb(v_words),
    'words_q', to_jsonb(v_wrd_q),
    'excluded', to_jsonb(v_excl),
    'brand_only', v_brand,
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

-- What the app shows under the search box: the kinds a query was read as,
-- what each includes, and what counts as a close match.
create or replace function public.search_explain(p_query text)
returns jsonb
language sql stable
security definer
set search_path = pg_catalog, public
as $$
  with r as (select public.search_resolve(p_query) as j)
  select case when r.j is null then null else jsonb_build_object(
    'concepts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'label', c.label,
               'includes', coalesce((select jsonb_agg(k.label order by k.label)
                                       from public.search_concepts k
                                      where k.parent = c.id and k.active), '[]'::jsonb)) order by c.label)
        from public.search_concepts c
       where c.active and c.id in (select jsonb_array_elements_text(r.j -> 'primary'))), '[]'::jsonb),
    'related', coalesce((
      select jsonb_agg(c.label order by c.label)
        from public.search_concepts c
       where c.active and c.id in (select jsonb_array_elements_text(r.j -> 'related'))
         and not exists (select 1 from jsonb_array_elements_text(r.j -> 'related') p
                          where p = c.parent)), '[]'::jsonb),
    'required', r.j -> 'required',
    'brand_only', r.j -> 'brand_only') end
  from r
$$;
revoke all on function public.search_explain(text) from public;
grant execute on function public.search_explain(text) to anon, authenticated;

-- ancestors and descendants (self included) for every active concept.
create or replace function public.refresh_search_concepts()
returns void
language sql
set search_path = pg_catalog, public
as $$
  with recursive up as (
    select id, id as anc, 0 as depth from public.search_concepts where active
    union all
    select up.id, c.parent, up.depth + 1
      from up join public.search_concepts c on c.id = up.anc and c.active
     where c.parent is not null and up.depth < 20
  ), anc as (
    select id, array_agg(anc order by depth) as ancestors from up group by id
  ), des as (
    select anc as id, array_agg(id order by id) as descendants from up group by anc
  )
  update public.search_concepts c
     set ancestors = a.ancestors, descendants = d.descendants
    from anc a join des d using (id)
   where c.id = a.id;
$$;

-- A new vocabulary: every lot is out of date until reclassify_lots reaches it.
create or replace function public.search_vocabulary_loaded()
returns integer
language sql
set search_path = pg_catalog, public
as $$
  update public.search_meta
     set vocabulary_version = vocabulary_version + 1, loaded_at = now()
   where id
  returning vocabulary_version;
$$;

-- Replace the whole vocabulary from one document (0046 and its successors are
-- generated from taxonomy.ts by scripts/gen-search-taxonomy.mjs):
--
--   concepts  [[id, label, parent, [related...]], ...], parents first
--   items     {concept: [term, ...]}. A term is a string, "!" in front when
--             a query for it needs its words ("!iphone", "!socket set"), or
--             an object {"t": term, "c": [cue words, or "#year" for any
--             model year], "f": true when it is the fallback meaning, "s":
--             true when its words are needed}
--   brands    [name, ...]
--   attrs     [word, ...]
--
-- Spellings that stem alike merge into one row per (norm, kind, concept),
-- keeping every cue and the strongest flags. Rows the document no longer
-- holds are switched off, not deleted; one it holds again comes back on. The
-- switch is one transaction, so a search sees the old vocabulary or the new,
-- never a mix.
create or replace function public.search_load_vocabulary(p_vocab jsonb)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  update public.search_concepts set active = false where active;
  insert into public.search_concepts (id, label, parent, related, active)
  select c ->> 0, c ->> 1, c ->> 2, array(select jsonb_array_elements_text(c -> 3)), true
    from jsonb_array_elements(p_vocab -> 'concepts') c
  on conflict (id) do update
     set label = excluded.label, parent = excluded.parent, related = excluded.related, active = true;

  perform public.refresh_search_concepts();

  update public.search_terms set active = false where active;
  insert into public.search_terms (term, norm, kind, concept, cues, is_default, specific, active)
  select min(s.term), s.norm, s.kind, s.concept,
         coalesce(array_agg(distinct s.cue order by s.cue) filter (where s.cue is not null), '{}'),
         bool_or(s.is_default), bool_or(s.specific), true
    from (
      select v.term, public.search_norm(v.term) as norm, v.kind, v.concept, v.is_default, v.specific, x.cue
        from (
          select case when jsonb_typeof(t) = 'string' then ltrim(t #>> '{}', '!') else t ->> 't' end as term,
                 'item'::text as kind, e.key as concept,
                 case when jsonb_typeof(t) = 'object'
                      then array(select jsonb_array_elements_text(coalesce(t -> 'c', '[]'))) else '{}' end as cues,
                 not (jsonb_typeof(t) = 'object' and coalesce((t ->> 'f')::boolean, false)) as is_default,
                 case when jsonb_typeof(t) = 'string' then left(t #>> '{}', 1) = '!'
                      else coalesce((t ->> 's')::boolean, false) end as specific
            from jsonb_each(p_vocab -> 'items') e
            cross join jsonb_array_elements(e.value) t
          union all
          select b, 'brand', null, '{}', true, true from jsonb_array_elements_text(p_vocab -> 'brands') b
          union all
          select a, 'attr', null, '{}', true, false from jsonb_array_elements_text(p_vocab -> 'attrs') a
        ) v
        -- A cue is a word that, beside the term, picks this meaning. "#year"
        -- stands for any model year. A term's own words never count: they
        -- are always beside it.
        left join lateral (select w as cue
                             from unnest(v.cues) c
                             cross join unnest(case when c = '#year'
                                                    then array(select y::text from generate_series(1900, 2035) y)
                                                    else public.search_tokens(c) end) w
                            where w <> all(public.search_tokens(v.term))) x on true
    ) s
   where s.norm <> ''
   group by s.norm, s.kind, s.concept
  on conflict (norm, kind, concept) do update
     set term = excluded.term, cues = excluded.cues, is_default = excluded.is_default,
         specific = excluded.specific, active = true;

  return public.search_vocabulary_loaded();
end $$;

revoke all on function public.refresh_search_concepts() from public, anon, authenticated;
revoke all on function public.search_vocabulary_loaded() from public, anon, authenticated;
revoke all on function public.search_load_vocabulary(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ lots
alter table public.lots
  add column if not exists item_heads    text[] not null default '{}',
  add column if not exists item_mods     text[] not null default '{}',
  add column if not exists item_mentions text[] not null default '{}',
  add column if not exists head_words    text[] not null default '{}',
  add column if not exists item_class_v  integer;

create index if not exists lots_item_heads_idx    on public.lots using gin (item_heads);
create index if not exists lots_item_mods_idx     on public.lots using gin (item_mods);
create index if not exists lots_item_mentions_idx on public.lots using gin (item_mentions);
create index if not exists lots_head_words_idx    on public.lots using gin (head_words);
create index if not exists lots_item_class_v_idx  on public.lots (item_class_v);

-- Classify on insert, and on update when the words change. Ingest upserts
-- every lot it sees on every run (insert ... on conflict do update), so:
-- an insert of a lot we already have is about to become an update, whose own
-- trigger decides; and an update that leaves the title and description as
-- they were, under the current vocabulary, keeps its classification.
create or replace function public.lots_classify()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ver integer;
  c     record;
begin
  select vocabulary_version into v_ver from public.search_meta where id;
  if tg_op = 'UPDATE' then
    if new.title is not distinct from old.title
       and new.description is not distinct from old.description
       and old.item_class_v is not distinct from v_ver then
      return new;
    end if;
  elsif exists (select 1 from public.lots l
                 where l.source_id = new.source_id and l.external_id = new.external_id) then
    return new;
  end if;
  select * into c from public.classify_listing(new.title, new.description);
  new.item_heads := c.heads;
  new.item_mods := c.mods;
  new.item_mentions := c.mentions;
  new.head_words := c.head_words;
  new.item_class_v := v_ver;
  return new;
end $$;

create or replace trigger lots_classify
  before insert or update of title, description on public.lots
  for each row execute function public.lots_classify();

-- Re-classify lots the vocabulary has moved past: open lots first. Run every
-- minute by pg_cron; once everything is current it touches nothing.
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
  ), c as (
    -- A lateral call: (f(x)).* would run the classifier once per column.
    select l.id, x.heads, x.mods, x.mentions, x.head_words
      from public.lots l join todo using (id)
      cross join lateral public.classify_listing(l.title, l.description) x
  )
  update public.lots l
     set item_heads = c.heads, item_mods = c.mods, item_mentions = c.mentions,
         head_words = c.head_words, item_class_v = v_ver
    from c
   where l.id = c.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.reclassify_lots(integer) from public, anon, authenticated;

select cron.schedule('reclassify-lots', '* * * * *', 'select public.reclassify_lots(3000)');

-- ------------------------------------------------------------ search
-- search_lots gains p_scope and three result columns, which create or replace
-- cannot add. The 0023 function steps aside under another name (callers
-- reach the new one by the same name and arguments) and can be dropped once
-- this has shipped.
alter function public.search_lots(text, text, integer, boolean, text[], bigint, bigint, bigint[], source_tier[],
                                  integer, numeric, text, integer, integer, text)
  rename to search_lots_before_0045;
revoke all on function public.search_lots_before_0045(text, text, integer, boolean, text[], bigint, bigint, bigint[],
                                                      source_tier[], integer, numeric, text, integer, integer, text)
  from public, anon, authenticated;

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
    -- Each required word is a tsquery over stemmed words ('f' <-> '-150' |
    -- 'f150' for a model number); :AB asks for it in the title, brand or model.
    if jsonb_array_length(coalesce(v_res -> 'required_q', '[]')) > 0 then
      v_req := to_tsquery('simple', array_to_string(array(
                 select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'required_q') q), ' & '));
      v_req_ab := to_tsquery('simple', array_to_string(array(
                    select '(' || regexp_replace(q, '(''[^'']*'')', '\1:AB', 'g') || ')'
                      from jsonb_array_elements_text(v_res -> 'required_q') q), ' & '));
    end if;
    if jsonb_array_length(coalesce(v_res -> 'words_q', '[]')) > 0 then
      v_any := to_tsquery('simple', array_to_string(array(
                 select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'words_q') q), ' & '));
    end if;
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
  ), tiered as (
    select c.*,
      case
        when v_res is null then 1
        when v_items then
          case
            -- It IS one, and everything else typed is there.
            when (c.item_heads && v_exp or (c.sale_level and c.item_mentions && v_exp))
                 and (v_req is null or c.search_tsv @@ v_req) then 1
            -- A close match: another thing the query names, a related kind, a
            -- coarser kind it may be, or a lot whose description says it
            -- includes the thing.
            when c.item_heads && (v_all || v_rel || v_brd) or c.item_mentions && v_exp then 2
            else 3
          end
        when v_brand then
          case when (v_req_ab is not null and c.search_tsv @@ v_req_ab) or c.sale_level then 1 else 3 end
        else
          case
            when c.sale_level and (v_req is null or c.search_tsv @@ v_req) then 1
            when v_req_ab is not null and c.search_tsv @@ v_req_ab and c.head_words && v_reqw then 1
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
    from candidate c
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

revoke all on function public.search_lots(text, text, integer, boolean, text[], bigint, bigint, bigint[], source_tier[],
                                          integer, numeric, text, integer, integer, text, text) from public;
grant execute on function public.search_lots(text, text, integer, boolean, text[], bigint, bigint, bigint[], source_tier[],
                                             integer, numeric, text, integer, integer, text, text) to anon, authenticated;

-- ------------------------------------------------------------ hunts
-- What a hunt alerts on: 'exact' (tier 1, the default), 'related' (tiers 1
-- and 2) or 'all'.
alter table public.hunts
  add column if not exists match_scope text not null default 'exact'
  check (match_scope in ('exact', 'related', 'all'));

-- The matcher passes the hunt's scope to search_lots. Patched in place with
-- replace(), as 0018 and 0021 did, so the rest stays exactly as it is live.
do $$
declare
  v_def  text;
  v_from text := 'p_offset             => 0) f';
  v_to   text := 'p_offset             => 0,
               p_scope              => coalesce(h.match_scope, ''exact'')) f';
begin
  v_def := pg_get_functiondef('public.run_hunt_matcher(integer, uuid, boolean)'::regprocedure);
  if position('p_scope' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
      raise exception 'run_hunt_matcher: expected exactly one "%"', v_from;
    end if;
    execute replace(v_def, v_from, v_to);
  end if;
end $$;

notify pgrst, 'reload schema';
