/**
 * @platform/query: turn what a buyer types into a hunt row and search_lots
 * arguments. See README.md for the shape and the websearch-versus-tsquery
 * decision.
 */
export { parseQuery, normalizeKey } from './parse.ts';
export type {
  HuntInsert,
  ParseOptions,
  ParsedLocation,
  ParsedQuery,
  ParsedSnapshot,
  ParsedTiming,
  PlaceRef,
  SearchLotsParams,
} from './parse.ts';
export * from './lexicon.ts';
