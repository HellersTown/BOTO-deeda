/**
 * Search results in the three groups search_lots ranks them in (0045):
 *
 *   1  exact     the lot is the thing asked for ("computer": a laptop, a
 *                desktop, a MacBook), with every other word typed;
 *   2  close     a related kind (a monitor, a laptop charger), a coarser kind
 *                the lot may be, or a lot whose description includes one;
 *   3  mentions  the words appear, but the lot is something else (a
 *                "computer chair").
 *
 * The headline counts the exact group. The other two are offered below it,
 * folded, each with the kinds it holds, so a buyer sees why they are apart.
 */
import type { MatchTier, SearchExplanation, SearchLotRow } from '../data/database.types';

export type MatchGroupKey = 'exact' | 'close' | 'mentions';

export interface MatchGroups<T> {
  readonly exact: readonly T[];
  readonly close: readonly T[];
  readonly mentions: readonly T[];
}

type Tiered = Pick<SearchLotRow, 'match_tier'>;

/** A row without a tier (a server before 0045) counts as exact: that is how every row was shown then. */
export function tierOf(row: Tiered): MatchTier {
  return row.match_tier === 2 || row.match_tier === 3 ? row.match_tier : 1;
}

const GROUP_OF: Readonly<Record<MatchTier, MatchGroupKey>> = { 1: 'exact', 2: 'close', 3: 'mentions' };

/** Rows split by tier, each group keeping the server's order. */
export function groupByMatch<T extends Tiered>(rows: readonly T[]): MatchGroups<T> {
  const groups: Record<MatchGroupKey, T[]> = { exact: [], close: [], mentions: [] };
  for (const row of rows) groups[GROUP_OF[tierOf(row)]].push(row);
  return groups;
}

/**
 * The group search_lots' row cap cut short, if any. Rows come exact first, so
 * when the cap is reached it is the last row's group that may hold more. Null
 * when the list is under the cap.
 */
export function truncatedGroup(rows: readonly Tiered[], cap: number): MatchGroupKey | null {
  const last = rows[rows.length - 1];
  if (rows.length < cap || !last) return null;
  return GROUP_OF[tierOf(last)];
}

export interface KindCount {
  readonly label: string;
  readonly count: number;
}

/** The kinds a group holds, most first. Rows search_lots could not name a kind for are left out. */
export function kindsIn(rows: readonly Pick<SearchLotRow, 'match_label'>[]): KindCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = row.match_label?.trim();
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * "Monitors · Computer parts & storage · 3 more kinds": the commonest few, the
 * rest counted. Middots, not commas, because labels hold commas ("Keyboards,
 * mice & webcams"). Null when no row has a kind.
 */
export function kindsText(rows: readonly Pick<SearchLotRow, 'match_label'>[], max = 3): string | null {
  const kinds = kindsIn(rows);
  if (kinds.length === 0) return null;
  const shown = kinds.slice(0, max).map((k) => k.label);
  const rest = kinds.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} · ${rest} more ${rest === 1 ? 'kind' : 'kinds'}` : shown.join(' · ');
}

/** A query word as a key: lowercase letters and digits ("F-150" and "f150" are one). */
function wordKey(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The word the buyer typed that a required word came from. search_explain
 * returns words as the text index keeps them, stemmed ("batteri", "deer") and
 * with model numbers joined ("f150"); the line should quote the buyer
 * ("batteries", "Deere", "F-150"). A word typed with a minus is excluded, never
 * required, so it is never the source. Falls back to the stem itself.
 */
export function typedWord(stem: string, query: string): string {
  const words = query
    .split(/\s+/)
    .filter((w) => w !== '' && !w.startsWith('-'))
    .map((w) => w.replace(/^["“”'(]+|["“”'),.;:!?]+$/g, ''))
    .filter((w) => wordKey(w) !== '');
  const exact = words.find((w) => wordKey(w) === stem);
  if (exact) return exact;
  const longer = words.filter((w) => wordKey(w).startsWith(stem)).sort((a, b) => wordKey(a).length - wordKey(b).length);
  if (longer[0]) return longer[0];
  // Stems that are not prefixes of their word ("happi" from "happy"): the word
  // sharing all but the stem's last letter.
  const near = words.find((w) => stem.length >= 4 && wordKey(w).startsWith(stem.slice(0, -1)));
  return near ?? stem;
}

/** “thermal”, “socket” and “set”, “a”, “b” and “c”. */
function quoteList(words: readonly string[]): string {
  const quoted = words.map((w) => `“${w}”`);
  return andList(quoted);
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Kinds named for a brand keep their capital ("Chromebooks"); the rest read as plain words mid-sentence. */
const NAMED_KINDS: ReadonlySet<string> = new Set(['Chromebooks']);

/** "Desktop computers" mid-sentence is "desktop computers"; "MacBooks", "SUVs" and "3D printers" stay as they are. */
export function inSentence(label: string): string {
  const first = label.split(/\s/)[0] ?? '';
  if (NAMED_KINDS.has(first) || /[A-Z0-9]/.test(first.slice(1)) || /^[0-9]/.test(first)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** A run of the explanation line; `strong` runs are what the search hinges on. */
export interface ExplainPart {
  readonly text: string;
  readonly strong?: boolean;
}

/**
 * The line that says what a search looks for, from search_explain:
 *
 *   Looking for Computers, including desktop computers, laptops and workstations & servers
 *   Looking for Drones that mention “thermal”
 *   Looking for anything by “dewalt”
 *   Looking for listings that name “kubota” and “L3800”
 *
 * Null when there is nothing to say (no query, or nothing understood).
 */
export function explainParts(ex: SearchExplanation | null | undefined, query: string): ExplainPart[] | null {
  if (!ex) return null;
  const words = (ex.required ?? []).map((w) => typedWord(w, query));
  const concepts = ex.concepts ?? [];
  if (concepts.length > 0) {
    const parts: ExplainPart[] = [{ text: 'Looking for ' }];
    concepts.forEach((c, i) => {
      if (i > 0) parts.push({ text: i === concepts.length - 1 ? ' or ' : ', ' });
      parts.push({ text: c.label, strong: true });
    });
    const only = concepts.length === 1 ? concepts[0] : undefined;
    const includes = only?.includes ?? [];
    if (includes.length > 0) parts.push({ text: `, including ${andList(includes.map(inSentence))}` });
    if (words.length > 0) {
      parts.push({ text: `${includes.length > 0 ? ',' : ''} that mention ` }, { text: quoteList(words), strong: true });
    }
    return parts;
  }
  if (words.length === 0) return null;
  if (ex.brand_only) return [{ text: 'Looking for anything by ' }, { text: quoteList(words), strong: true }];
  return [{ text: 'Looking for listings that name ' }, { text: quoteList(words), strong: true }];
}

/** The parts as one string, for a status line or a test. */
export function explainText(parts: readonly ExplainPart[] | null): string | null {
  return parts ? parts.map((p) => p.text).join('') : null;
}
