# @platform/query

Turns what a buyer types ("DJI drone with thermal under $1500 within 50 miles of
53202") into a `hunts` row and `search_lots` arguments. Zero runtime
dependencies; Node 22 runs the `.ts` files directly.

```ts
import { parseQuery } from '@platform/query';

const q = parseQuery('DJI drone with thermal under $1500 within 50 miles of 53202', {
  homePostalCode: '53703',   // for "near me", and when no location is typed
  defaultRadiusMiles: 50,    // for "nearby", "local" and a bare ZIP (default 50)
  now: new Date(),           // optional: pins "ending today" in tests
  timeZone: 'America/Chicago', // optional: the zone "today" is read in (default)
});
await supabase.rpc('search_lots', q.searchParams);
await supabase.from('hunts').insert({ user_id, name, ...q.hunt });
```

`parseQuery` never throws. Anything it would not guess at is left out, listed
in `unparsed`, and explained in `explanation`.

## ParsedQuery

| field | meaning |
|---|---|
| `terms`, `phrases` | What the text search requires: single words, and multi-word units kept together (`"mavic 3"`, `"f-150"`, `"john deere"`). Filler ("cheap", "looking for") is gone. |
| `alternatives` | Either-or choices typed with "or" or "\|", e.g. `[["f-150","silverado"]]`. Not repeated in `terms`/`phrases`. |
| `brands`, `models`, `categories`, `features` | Canonical brand names, model designators read from the query (never from a dictionary), category slugs from `CATEGORIES`, must-have attributes (`thermal`, `4x4`, `14k`). |
| `synonyms` | Per term, the other words that mean the same thing (drone → quadcopter, uav). Used only by `tsquery`. |
| `excludeTerms` | From "no X", "not X", "without X", "-X", "!X", "exclude X". |
| `minPriceCents`, `maxPriceCents` | Integer cents built from digits, never a float. "1.5k" is 150000. |
| `minYear`, `maxYear` | "2015 or newer", "1960s", "pre-1970". Not a search_lots filter yet; kept in `parsed`. |
| `location` | `postalCode` (+ `postalCodeSource` `query`/`home`), `place` `{raw, city, state, ambiguous, needsResolution}`, `radiusMiles` (+ `radiusIsDefault`), `states`, `includeShippable`. |
| `conditions`, `timing`, `sort`, `tiers`, `minSleeperScore` | `new/used/refurbished/parts`; `closingWithinHours` + the phrase; a `p_sort` value; `source_tier` values; a 0-10 floor. |
| `websearchQuery`, `tsquery` | See the decision below. Empty string when there is nothing to match. |
| `hunt`, `searchParams` | Ready-to-use objects, described next. |
| `explanation`, `unparsed`, `confidence`, `outOfScope` | "I read this as ..." lines; what was set aside; 0-1; true for real estate. |

## Mapping

`hunt` has exactly the `hunts` columns:

| column | from |
|---|---|
| `query_text` | the input, verbatim |
| `parsed` | the whole ParsedQuery minus `hunt`/`searchParams` (jsonb) |
| `keywords` | every required text unit (`terms` + `phrases`, in typed order) |
| `required_terms` | `features`: the "must have thermal" subset of `keywords` |
| `exclude_keywords`, `brands` | `excludeTerms`, `brands` |
| `min_price_cents`, `max_price_cents`, `conditions`, `min_sleeper_score` | as parsed |
| `postal_code`, `radius_miles`, `states`, `include_shippable` | `location` (`include_shippable` defaults to true, like the column) |
| `tiers_only` | `tiers` |
| `category_ids` | always `[]` (see limitations) |

An either-or choice cannot be written as a `text[]` of required words, so
alternatives live only in `parsed` and in both query strings. A hunt matcher
should use `parsed.websearchQuery` (or `parsed.tsquery`) as the authoritative
text predicate.

`searchParams` has exactly the listed `search_lots` parameters (`p_query`,
`p_postal_code`, `p_radius_miles`, `p_include_shippable`, `p_states`,
`p_min_cents`, `p_max_cents`, `p_tiers`, `p_closing_within_hours`,
`p_min_sleeper`, `p_sort`). Two details matter:

- `p_states` and `p_tiers` are `null`, never `[]`: `= any('{}')` is false, so an
  empty array turns "no filter" into "no results".
- `p_radius_miles`, `p_include_shippable` and `p_sort` are never `null`: an
  explicit null overrides the parameter default instead of falling back to it.

`p_query` is `websearchQuery`, or `null` when empty.

## websearch_to_tsquery versus to_tsquery

Verified against Postgres 16, not from memory:

- `websearch_to_tsquery` has **no grouping**. Parentheses are discarded as
  punctuation and AND binds tighter than `or`, so
  `dji (drone or quadcopter) thermal` becomes `(dji & drone) | (quadcopt & thermal)`.
- It **never throws**, so wrong syntax fails silently: `(drone | uav) & thermal
  & !toy` becomes `drone & uav & thermal & toy`, turning the exclusion into a
  requirement.
- A query made only of stop words becomes an **empty** tsquery, and
  `search_tsv @@ <empty>` is false for every row: it returns nothing, not everything.

So the package produces two strings:

- **`websearchQuery`** is what `search_lots` gets. It has no synonym groups. It
  is rebuilt from sanitised words only (`[a-z0-9]` with inner `.`, `-`, and `/`
  inside fractions), bare words, balanced `"phrases"`, `-exclusions`, and never
  an all-stop-word atom. The buyer's own "or" is honoured the only exact way the
  syntax allows: spelled out one clause per choice (`diesel "f-150" or diesel
  silverado`, exclusions repeated per clause), capped at 16 clauses.
- **`tsquery`** is for `to_tsquery('english', ...)`: every operand quoted, each
  unit an OR group of its synonyms, brand spellings and model variants (`( 'f-150'
  | 'f150' | 'f 150' )`), exclusions as `!( ... )`. `:*` is used only on a model
  designator ending in a digit (`'d6':*`, `'mavic' <-> '3':*`), where makers
  append variant letters; never on dictionary words, because the English stemmer
  plus a prefix over-matches (`coin:*` matches "coincidence"). `search_lots`
  cannot take this string today: it needs a `to_tsquery` caller, such as the hunt
  matcher or a future `p_tsquery` parameter.

Both forms respect how Postgres parses the same text in lot titles: `F-150` is
indexed as `'f' <-> '-150'` (a signed number), so model names keep their hyphen;
`mid-century` is split into the phrase `"mid century"` (which matches both
spellings); `Can-Am` stays hyphenated because "can" and "am" are both stop words;
`Black & Decker` becomes two words because "and" occupies a position.

Every string the test suite generates (examples plus 1,500 fuzz queries) was also
run through Postgres 16's `websearch_to_tsquery` and `to_tsquery`: no errors, and
none reduced to an empty query.

## Places and categories are resolved in the database

The parser never turns a town into a ZIP. `location.place` comes back with
`needsResolution: true`; "Beloit" without a state also has `ambiguous: true`
because the name exists in several states. Resolve against `postal_codes`, and
ask the buyer when more than one state matches:

```sql
select postal_code, state from postal_codes
 where lower(city) = lower($1) and ($2::text is null or state = $2)
 order by population desc nulls last;
```

`category_ids` is left empty on purpose: `lots.category_id` is assigned
heuristically and is missing on many lots, so a hard category filter would hide
matches, while the text query already carries the category's words. To opt in:
`select coalesce(array_agg(id), '{}') from categories where slug = any($1)` with
`parsed.categories`. `CATEGORIES` (synonyms, negative terms) is shaped to seed
`categories.match_terms` and `negative_terms`.

## Known limitations

- Rule-based, English, US. No spelling correction beyond listed aliases.
- Brand words that are ordinary English ("case", "ram", "apple") count as brands
  only when the query gives context; otherwise they stay plain words, with a note.
- Model years, mileage, engine hours, quantity and drive time are recognised but
  cannot be filtered by `search_lots`; they are explained, not applied.
- A town with no cue word is read as a place only when a state follows it
  ("fond du lac wi"). One place per query.
- "Today" and "this weekend" are computed in one zone (default Central).

## Tests

```sh
npm test
tsc --ignoreConfig --noEmit --strict --target ES2022 --module ESNext \
  --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck src/*.ts
```

TypeScript 6 finds the repository's root `tsconfig.json` and refuses file
arguments without `--ignoreConfig`.
