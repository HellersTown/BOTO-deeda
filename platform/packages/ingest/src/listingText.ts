/**
 * Text helpers shared by the adapters that store a source's own words: privacy
 * redaction and city-name tidying.
 *
 * Used by AuctionGuide (sale summaries) and Wisconsin Surplus (auction
 * descriptions). Both keep a sale's city, state and ZIP; neither keeps a street
 * address or a phone number, wherever in the text it appears.
 */

/** Stands in for a street address a listing's text gave. */
export const ADDRESS_MARK = '(address on the sale page)';
/** Stands in for a phone number a listing's text gave. */
export const PHONE_MARK = '(phone on the sale page)';

const withUpper = (words: string[]) => words.flatMap((w) => [w, w.toUpperCase()]).join('|');
/** "ft" -> "ft|Ft|FT": item text is written in every case. */
const anyCase = (words: string[]) =>
  [...new Set(words.flatMap((w) => [w.toLowerCase(), w[0].toUpperCase() + w.slice(1).toLowerCase(), w.toUpperCase()]))].join('|');

const STREET_SUFFIX = withUpper(['Avenue', 'Ave', 'Street', 'St', 'Lane', 'Ln', 'Boulevard', 'Blvd',
  'Court', 'Ct', 'Circle', 'Cir', 'Place', 'Pl', 'Parkway', 'Pkwy', 'Trail', 'Trl', 'Terrace', 'Ter', 'Pike']);
const ROAD_SUFFIX = withUpper(['Road', 'Rd', 'Highway', 'Hwy', 'Route', 'Rte']);

// Item text is full of numbers and street-suffix words: "4 Wheel Drive",
// "500 GB Hard Drive", "Two Way Radio", "Groundsmaster Blvd Mower". Three
// guards keep it whole.
//
// A unit or a count noun after the number makes it a specification, not a
// house number: "16 ft", "500 GB", "2 Speed", "6 Row".
const SPEC_WORD = anyCase(['ft', 'feet', 'foot', 'in', 'inch', 'inches', 'gal', 'gallon', 'gallons', 'lb', 'lbs',
  'ton', 'tons', 'hp', 'cc', 'cu', 'qt', 'pc', 'pcs', 'pk', 'volt', 'volts', 'v', 'amp', 'amps', 'watt', 'watts',
  'kw', 'mm', 'cm', 'yd', 'yds', 'sq', 'oz', 'psi', 'rpm', 'mph', 'gpm', 'cfm', 'btu', 'gb', 'tb', 'mb', 'ghz',
  'mhz', 'x', 'wheel', 'speed', 'spd', 'row', 'bottom', 'gang', 'blade', 'person', 'passenger', 'seat', 'place']);
// The word before "Drive" or "Way" that makes it a part, not a street:
// "Front Wheel Drive", "Solid State Drive", "Belt Drive", "Two Way".
const DRIVE_MODIFIER = anyCase(['Wheel', 'Speed', 'Gear', 'Belt', 'Chain', 'Shaft', 'Direct', 'Hard', 'State',
  'Flash', 'Disk', 'Disc', 'Track', 'Hydrostatic', 'Hydro', 'Power', 'Final', 'Thumb', 'Optical', 'Tape', 'USB',
  'Friction', 'Hydraulic', 'Electric', 'Variable']);
const WAY_MODIFIER = anyCase(['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Multi']);
// An item noun after the suffix: "Blvd Mower", "Road Tractor", "Drive Shaft".
const ITEM_NOUN = anyCase(['Mower', 'Mowers', 'Tractor', 'Tractors', 'Truck', 'Trucks', 'Trailer', 'Trailers',
  'Vehicle', 'Vehicles', 'Sedan', 'Radio', 'Radios', 'Valve', 'Valves', 'Motor', 'Motors', 'Pump', 'Pumps', 'Saw',
  'Saws', 'Plow', 'Plows', 'Grader', 'Train', 'Shaft', 'Belt', 'Belts', 'Chain', 'Chains', 'Gear', 'Axle', 'Wheel',
  'Wheels', 'Tire', 'Tires', 'Cart', 'Carts', 'Sign', 'Signs', 'Sweeper', 'Broom', 'Bike', 'Bikes']);
const DRIVE_SUFFIX = String.raw`(?<!\b(?:${DRIVE_MODIFIER})\s+)(?:Drive|DRIVE|Dr|DR)`;
const WAY_SUFFIX = String.raw`(?<!\b(?:${WAY_MODIFIER})\s+)(?:Way|WAY)`;
const NOT_ITEM = String.raw`(?!\s+(?:${ITEM_NOUN})\b)`;

// A house number: "33243", "12B", or a Wisconsin rural grid number, "N5678".
// Never the tail of a time, date, price or range ("2:00", "1-200", "$5").
const HOUSE = String.raw`(?<![\w:.,$#/-])(?:[NSEW]\d{1,6}|\d{1,6}[A-Za-z]?)(?!\s+(?:${SPEC_WORD})\b)`;
const WORD = String.raw`[A-Za-z][A-Za-z.'-]*`;
// "County Road E", "Hwy 33": a road's letter or number designator.
const DESIGNATOR = String.raw`(?:[A-Z]{1,2}|\d{1,4})\b`;
const STREET_ADDRESS = new RegExp(
  `${HOUSE}\\s+(?:(?:${WORD}\\s+){1,4}?` +
  `(?:(?:${STREET_SUFFIX}|${DRIVE_SUFFIX}|${WAY_SUFFIX})\\b\\.?${NOT_ITEM}|(?:${ROAD_SUFFIX})\\b\\.?(?:\\s+${DESIGNATOR})?${NOT_ITEM})` +
  `|(?:${ROAD_SUFFIX})\\b\\.?\\s+${DESIGNATOR}${NOT_ITEM})`,
  'g',
);
// Text the source cut short inside an address: "... at 33243 Oxbow Av...".
const CUT_ADDRESS = new RegExp(String.raw`((?:^|[\s(])(?:at|AT|@|[Ll]ocation:?|LOCATION:?|[Aa]ddress:?|ADDRESS:?)\s+)${HOUSE}\s+(?:${WORD}\s*){0,4}(?:\.{3}|…)\s*$`);
const PHONE = /(?<![\d-])(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?![\d-])/g;
// A full street word ends no abbreviation, so a period after it ends the sentence.
const FULL_WORD_PERIOD = /(?:avenue|street|drive|lane|boulevard|court|circle|way|place|parkway|trail|terrace|pike|road|highway|route)\.$/i;

/**
 * A listing's text with street addresses and phone numbers replaced by a
 * pointer to the sale page. Rows keep a sale's city, state and ZIP only: a
 * summary often names the preview address, which for an estate sale is a
 * family's home. Errs toward redacting.
 */
export function redactContacts(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text
    .replace(PHONE, PHONE_MARK)
    .replace(STREET_ADDRESS, (m) => (FULL_WORD_PERIOD.test(m) ? `${ADDRESS_MARK}.` : ADDRESS_MARK))
    .replace(CUT_ADDRESS, `$1${ADDRESS_MARK}…`);
}

const SMALL_CITY_WORDS = new Set(['de', 'du', 'la', 'le', 'of', 'the', 'on', 'in']);

/**
 * "nekoosa" -> "Nekoosa", "FOND DU LAC" -> "Fond du Lac", "MCFARLAND" ->
 * "McFarland". Only a city typed all in one case is changed: mixed case is
 * the source's own and is kept.
 */
export function tidyCity(city: string | null | undefined): string | null {
  if (!city) return city ?? null;
  const letters = city.replace(/[^A-Za-z]/g, '');
  if (!letters || (letters !== letters.toLowerCase() && letters !== letters.toUpperCase())) return city;
  return city.toLowerCase().replace(/[a-z][a-z']*/g, (w, at: number) => {
    if (at > 0 && SMALL_CITY_WORDS.has(w)) return w;
    if (w.length > 2 && w.startsWith('mc')) return `Mc${w[2].toUpperCase()}${w.slice(3)}`;
    return w[0].toUpperCase() + w.slice(1);
  });
}
