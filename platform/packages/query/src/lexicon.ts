/**
 * The query parser's vocabulary.
 *
 * Everything here is DATA, deliberately, in the same spirit as
 * categories.match_terms in the schema: the parser should get better by editing
 * these tables, not by editing parse.ts. Three rules keep it honest.
 *
 * 1. NO MODEL NUMBERS. A brand may list a product line that buyers type as a
 *    word ("Mavic", "Silverado"), but never a model number. Model numbers are
 *    read from the query itself. An invented one would quietly match nothing, or
 *    match the wrong thing, and nobody would notice.
 *
 * 2. WORDS THAT ARE ALSO ORDINARY ENGLISH ARE MARKED. "Case", "Ram", "Apple",
 *    "Cat" and "Lincoln" are brands only in context: "case tractor" is a brand,
 *    "phone case" is not. Marking them lets the parser say "I kept 'case' as a
 *    plain word" instead of silently deciding.
 *
 * 3. POSTGRES DECIDES WHAT A WORD MEANS TO THE INDEX. The stop list below is
 *    Postgres's own english.stop, copied verbatim, so the query builder can
 *    predict exactly what websearch_to_tsquery will throw away.
 */

// --------------------------------------------------------------------- types

/** Mirrors the source_tier enum in 0002_core_schema.sql. */
export type SourceTier =
  | 'federal' | 'state' | 'county' | 'municipal' | 'school'
  | 'private' | 'estate' | 'wholesale' | 'marketplace' | 'dealer';

/** The four values lots.condition is normalised to. */
export type Condition = 'new' | 'used' | 'refurbished' | 'parts';

/** The p_sort values search_lots understands. Anything else means relevance. */
export type SortKey = 'relevance' | 'nearest' | 'cheapest' | 'closing' | 'newest' | 'sleeper';

export interface Brand {
  /** Canonical name, the way a catalogue would print it. */
  name: string;
  /** Category slug this brand usually sells under. A hint, never a filter. */
  category: string;
  /** Other ways buyers type it. Case and punctuation are ignored when matching. */
  aliases?: readonly string[];
  /**
   * Product lines buyers type as plain words ("mavic", "silverado"). Seeing one
   * identifies the brand. These are names, never model numbers (rule 1).
   */
  families?: readonly string[];
  /**
   * Forms (the canonical name or an alias) that are ordinary words or places as
   * often as they are this brand. They count as the brand only when the query
   * also names a category in `context`, contains one of the `cues`, or is
   * followed by a model number ("ram 1500").
   */
  ambiguous?: readonly string[];
  /** Category slugs that confirm an ambiguous form. Defaults to [category]. */
  context?: readonly string[];
  /** Words elsewhere in the query that confirm an ambiguous form. */
  cues?: readonly string[];
}

export interface Category {
  slug: string;
  label: string;
  parent?: string;
  /** Words and phrases that put a query into this category (categories.match_terms). */
  synonyms: readonly string[];
  /** Words that mean a LOT is not in this category (categories.negative_terms). */
  negativeTerms: readonly string[];
  /**
   * Generic labels that rarely appear in a lot title. Nobody catalogues a ring
   * as "jewelry", so "14k gold jewelry" must not require the word "jewelry".
   * They are dropped from the text query whenever a more specific word remains.
   */
  broad?: readonly string[];
  /** Matched so the parser can say so, but not something PaddleUp lists. */
  outOfScope?: boolean;
}

export interface Feature {
  /** Canonical label, as reported in ParsedQuery.features. */
  name: string;
  /** How buyers type it. */
  forms: readonly string[];
}

// -------------------------------------------------------- Postgres stop words

/**
 * /usr/share/postgresql/16/tsearch_data/english.stop, verbatim (127 words).
 *
 * Postgres removes these from BOTH the indexed lot text and the query. Two
 * consequences the builder has to respect: a query made only of stop words
 * becomes an EMPTY tsquery, and `lots.search_tsv @@ <empty tsquery>` is false
 * for every row, so it returns nothing rather than everything. And "Can-Am"
 * split into "can am" disappears entirely, because both halves are stop words.
 */
export const PG_ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
  'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
  'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
  'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now',
]);

/**
 * Words people put in a search box that describe their mood, not the item.
 * Postgres would keep most of these, and every one of them would then have to
 * appear in a lot title: "cheap welder" would only find welders whose seller
 * wrote the word "cheap".
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'with', 'a', 'an', 'the', 'for', 'looking', 'look', 'need', 'needs', 'needed',
  'want', 'wants', 'wanted', 'cheap', 'cheaper', 'good', 'deal', 'deals', 'great',
  'nice', 'best', 'bargain', 'bargains', 'find', 'finding', 'search', 'searching',
  'show', 'get', 'got', 'buy', 'buying', 'please', 'pls', 'plz', 'thanks', 'thank',
  'hey', 'hi', 'hello', 'anything', 'something', 'stuff', 'things', 'thing',
  'item', 'items', 'auction', 'auctions', 'listing', 'listings', 'sale', 'sales',
  'available', 'im', 'ive', 'id', 'like', 'would', 'love', 'really', 'kind',
  'kinds', 'lot', 'lots', 'surplus', 'quality', 'decent', 'affordable',
  'inexpensive', 'budget', 'cheapo', 'w', 'w/', 'also', 'maybe', 'possibly',
  'preferably', 'ideally', 'etc', 'misc', 'miscellaneous', 'must', 'selling',
  'sell', 'sold', 'bid', 'bids', 'bidding', 'price', 'priced', 'cost', 'costs',
  'type', 'sort', 'sorted', 'order', 'ordered', 'showing', 'see', 'seen', 'condition',
  'shape',
]);

// ------------------------------------------------------------------ US states

export interface UsState { code: string; name: string }

/** All 50 states plus DC, USPS codes. */
export const US_STATES: readonly UsState[] = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' }, { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' }, { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

/** Extra spellings that mean a state. Lowercase. */
export const STATE_NAME_ALIASES: Readonly<Record<string, string>> = {
  'washington dc': 'DC',
  'washington d c': 'DC',
  'd c': 'DC',
  'washington state': 'WA',
  'mass': 'MA',
  'calif': 'CA',
  'wisc': 'WI',
  'minn': 'MN',
  'penn': 'PA',
};

/**
 * Two-letter codes that are also everyday words: "near ME", "f-150 OR
 * silverado", "IN stock", "OH well", "OK condition". These are never read as
 * a state on their own; only right after a city with a comma ("Portland, OR").
 */
export const FUNCTION_WORD_STATE_CODES: ReadonlySet<string> = new Set([
  'in', 'or', 'me', 'hi', 'ok', 'oh',
]);

/**
 * Codes that collide with units, abbreviations or names: "50 MI" is miles,
 * "12 GA" is gauge, "SD card", "CA 1920" is circa, "10 CT" is a count. These
 * count as a state only in a place construct: after a city, after "in", or
 * before "only".
 */
export const OVERLOADED_STATE_CODES: ReadonlySet<string> = new Set([
  'al', 'ar', 'ca', 'co', 'ct', 'dc', 'de', 'fl', 'ga', 'id', 'la', 'ma', 'md',
  'mi', 'mo', 'ms', 'mt', 'ne', 'pa', 'sc', 'sd', 'ut', 'va', 'wa', 'nd', 'nc',
]);

/**
 * Full state names that are also common as something else at auction
 * ("George Washington" memorabilia, "Indiana Jones", "Hannah Montana"). Read as
 * a state only in a place construct, never standing alone.
 */
export const AMBIGUOUS_STATE_NAMES: ReadonlySet<string> = new Set([
  'washington', 'georgia', 'indiana', 'montana', 'virginia', 'nevada', 'jersey',
]);

// ---------------------------------------------------------- category taxonomy

/**
 * About forty categories: the ones that actually move at US government surplus,
 * estate and equipment auctions. Slugs are what categories.slug will hold, and
 * synonyms/negativeTerms are shaped to seed categories.match_terms and
 * negative_terms, so the lot classifier and the query parser share one
 * vocabulary.
 *
 * Singular forms are enough: plurals are generated when the index is built.
 */
function category(
  slug: string,
  label: string,
  synonyms: readonly string[],
  negativeTerms: readonly string[],
  extra: Partial<Pick<Category, 'parent' | 'broad' | 'outOfScope'>> = {},
): Category {
  return { slug, label, synonyms, negativeTerms, ...extra };
}

export const CATEGORIES: readonly Category[] = [
  category('drones', 'Drones', [
    'drone', 'quadcopter', 'uav', 'uas', 'multirotor', 'multicopter',
    'unmanned aircraft', 'unmanned aerial vehicle',
  ], ['bee', 'hive', 'beekeeping', 'toy drone']),

  category('vehicles', 'Cars & SUVs', [
    'car', 'automobile', 'sedan', 'suv', 'van', 'minivan', 'coupe', 'convertible',
    'hatchback', 'station wagon', 'passenger car', 'vehicle', 'classic car',
    'muscle car', 'police car', 'squad car',
  ], ['toy', 'diecast', 'die cast', 'model car', 'car seat', 'car cover', 'car wash'],
  { broad: ['vehicle', 'vehicles', 'auto', 'autos'] }),

  category('trucks', 'Trucks', [
    'truck', 'pickup', 'pickup truck', 'box truck', 'dump truck', 'semi truck',
    'semi', 'flatbed truck', 'bucket truck', 'plow truck', 'service truck',
    'utility truck', 'tow truck', 'wrecker', 'fire truck', 'stake bed',
    'cab and chassis', 'garbage truck', 'refuse truck', 'day cab',
  ], ['toy', 'hand truck', 'pallet truck', 'truck cap', 'truck parts', 'tonka'],
  { parent: 'vehicles' }),

  category('motorcycles', 'Motorcycles', [
    'motorcycle', 'motorbike', 'dirt bike', 'scooter', 'moped', 'chopper',
    'street bike', 'sport bike', 'trike', 'dual sport',
  ], ['toy', 'motorcycle jacket', 'motorcycle helmet', 'mobility scooter', 'kick scooter'],
  { parent: 'vehicles' }),

  category('atv-utv', 'ATVs & UTVs', [
    'atv', 'utv', 'four wheeler', '4 wheeler', 'quad', 'side by side', 'sxs',
    'golf cart', 'golf car', 'go kart', 'go cart', 'gokart', 'dune buggy',
  ], ['toy', 'power wheels', 'kids atv'], { parent: 'vehicles' }),

  category('snowmobiles', 'Snowmobiles', [
    'snowmobile', 'snow machine', 'snowmobile trailer',
  ], ['toy', 'snowmobile suit'], { parent: 'vehicles' }),

  category('rvs-campers', 'RVs & campers', [
    'rv', 'camper', 'motorhome', 'motor home', 'travel trailer', 'fifth wheel',
    '5th wheel', 'pop up camper', 'popup camper', 'toy hauler', 'truck camper',
    'camper trailer',
  ], ['rv antifreeze', 'rv parts', 'camper shell'], { parent: 'vehicles' }),

  category('boats', 'Boats & marine', [
    'boat', 'pontoon', 'kayak', 'canoe', 'jon boat', 'john boat', 'fishing boat',
    'bass boat', 'sailboat', 'jet ski', 'personal watercraft', 'pwc', 'outboard',
    'outboard motor', 'trolling motor', 'boat lift', 'boat dock', 'waverunner',
    'wave runner', 'runabout', 'deck boat',
  ], ['toy', 'model boat', 'gravy boat', 'boat shoes', 'boat trailer']),

  category('trailers', 'Trailers', [
    'trailer', 'utility trailer', 'flatbed trailer', 'enclosed trailer',
    'cargo trailer', 'car hauler', 'dump trailer', 'gooseneck',
    'equipment trailer', 'boat trailer', 'horse trailer', 'livestock trailer',
    'tilt trailer', 'tag along trailer', 'semi trailer', 'landscape trailer',
  ], ['trailer hitch', 'trailer park', 'movie trailer', 'trailer jack']),

  category('auto-parts', 'Auto parts & accessories', [
    'auto parts', 'car parts', 'truck parts', 'tire', 'tyre', 'rim',
    'wheels and tires', 'truck cap', 'topper', 'camper shell', 'tonneau cover',
    'running boards', 'car engine', 'truck engine', 'transmission',
    'catalytic converter', 'headlight', 'bumper', 'truck bed', 'hitch receiver',
  ], ['toy', 'bicycle tire', 'bike tire'], { parent: 'vehicles' }),

  category('heavy-equipment', 'Heavy equipment', [
    'excavator', 'mini excavator', 'backhoe', 'bulldozer', 'dozer', 'skid steer',
    'skidsteer', 'track loader', 'compact track loader', 'wheel loader', 'loader',
    'telehandler', 'grader', 'motor grader', 'compactor', 'roller', 'crane',
    'trencher', 'boom lift', 'scissor lift', 'man lift', 'aerial lift',
    'heavy equipment', 'construction equipment', 'equipment', 'trackhoe',
    'track hoe', 'crawler', 'articulated dump truck', 'paver',
  ], ['toy', 'diecast', 'die cast', 'ertl', 'model', 'scale model'],
  { broad: ['equipment', 'heavy equipment', 'construction equipment'] }),

  category('farm', 'Farm equipment', [
    'tractor', 'farm tractor', 'compact tractor', 'utility tractor', 'baler',
    'hay baler', 'combine', 'planter', 'grain drill', 'sprayer', 'grain bin',
    'grain cart', 'auger', 'brush hog', 'rotary cutter', 'manure spreader',
    'hay rake', 'tedder', 'cultivator', 'disc harrow', 'moldboard plow',
    'chisel plow', 'field cultivator', 'livestock', 'cattle gate', 'feeder',
    'hay', 'round bales', 'square bales', 'gravity wagon', 'farm equipment',
    'ag equipment', 'farm machinery', 'farm', 'haybine', 'disc mower',
  ], ['toy', 'ertl', 'diecast', 'die cast', 'pedal tractor', 'lawn tractor', 'garden tractor'],
  { broad: ['farm', 'farm equipment', 'ag equipment', 'farm machinery'] }),

  category('lawn-garden', 'Lawn & garden', [
    'lawn mower', 'lawnmower', 'mower', 'riding mower', 'riding lawn mower',
    'lawn tractor', 'garden tractor', 'zero turn', 'zero turn mower', 'push mower',
    'string trimmer', 'weed eater', 'weedeater', 'weed whacker', 'trimmer',
    'leaf blower', 'backpack blower', 'chainsaw', 'chain saw', 'tiller',
    'rototiller', 'snowblower', 'snow blower', 'snowthrower', 'snow thrower',
    'pressure washer', 'power washer', 'hedge trimmer', 'edger', 'log splitter',
    'wood splitter', 'wood chipper', 'chipper', 'chipper shredder', 'pole saw',
    'lawn sweeper', 'aerator', 'dethatcher', 'lawn and garden', 'lawn equipment',
    'outdoor power equipment', 'garden tools', 'wheelbarrow',
  ], ['toy', 'toy mower'],
  { broad: ['lawn and garden', 'lawn equipment', 'outdoor power equipment'] }),

  category('tools', 'Tools', [
    'tool', 'toolbox', 'tool box', 'tool chest', 'tool cabinet', 'roll cabinet',
    'rolling tool box', 'wrench', 'socket set', 'socket', 'ratchet', 'pliers',
    'screwdriver', 'hammer', 'hand tools', 'mechanics tools', 'tap and die',
    'vise', 'vice', 'torque wrench', 'air tools', 'impact socket', 'creeper',
    'floor jack', 'jack stands', 'engine hoist', 'cherry picker', 'tool set',
    'tool kit', 'wrench set', 'clamps', 'tape measure', 'multimeter',
  ], ['toy', 'tool belt'], { broad: ['tool', 'tools'] }),

  category('power-tools', 'Power tools', [
    'drill', 'cordless drill', 'impact driver', 'impact wrench', 'circular saw',
    'miter saw', 'mitre saw', 'chop saw', 'table saw', 'band saw', 'bandsaw',
    'jigsaw', 'reciprocating saw', 'sawzall', 'grinder', 'angle grinder',
    'sander', 'router', 'planer', 'jointer', 'nail gun', 'nailer', 'brad nailer',
    'framing nailer', 'drill press', 'rotary hammer', 'hammer drill',
    'oscillating tool', 'multi tool', 'heat gun', 'power tool', 'combo kit',
    'scroll saw', 'wood lathe', 'dust collector', 'track saw',
  ], ['toy', 'wifi router', 'network router'],
  { parent: 'tools', broad: ['power tool', 'power tools'] }),

  category('welding', 'Welding', [
    'welder', 'welding', 'mig welder', 'tig welder', 'stick welder', 'arc welder',
    'welding machine', 'plasma cutter', 'plasma torch', 'welding helmet',
    'welding hood', 'welding table', 'cutting torch', 'torch set',
    'oxy acetylene', 'oxyacetylene', 'welder generator', 'spool gun',
  ], ['toy'], { parent: 'tools' }),

  category('industrial', 'Industrial & machinery', [
    'lathe', 'metal lathe', 'milling machine', 'cnc', 'cnc machine',
    'air compressor', 'compressor', 'generator', 'standby generator', 'pallet jack',
    'pallet racking', 'pallet rack', 'racking', 'industrial shelving',
    'hydraulic press', 'shop press', 'conveyor', 'electric motor', 'trash pump',
    'water pump', 'transformer', 'forklift', 'fork lift', 'lift truck',
    'material handling', 'parts washer', 'sandblaster', 'sand blaster',
    'blast cabinet', 'machinery', 'industrial', 'industrial equipment',
    'shop equipment', 'genset', 'phase converter', 'surface grinder',
  ], ['toy', 'model', 'dollhouse'],
  { broad: ['industrial', 'machinery', 'industrial equipment', 'shop equipment'] }),

  category('building-materials', 'Building materials', [
    'lumber', 'timber', 'plywood', 'drywall', 'shingles', 'roofing', 'siding',
    'insulation', 'tile', 'flooring', 'hardwood flooring', 'brick', 'pavers',
    'concrete', 'concrete blocks', 'steel beam', 'i beam', 'rebar', 'steel pipe',
    'trusses', 'metal roofing', 'sheet metal', 'replacement windows',
    'exterior door', 'interior door', 'kitchen cabinets', 'vanity', 'sink',
    'toilet', 'faucet', 'bathtub', 'countertop', 'pole barn', 'pole building',
    'steel building', 'storage shed', 'building materials',
    'construction materials', 'building supplies', 'shipping container',
    'conex', 'conex box', 'sea can', 'cargo container',
  ], ['toy', 'dollhouse', 'miniature'],
  { broad: ['building materials', 'construction materials', 'building supplies'] }),

  category('hvac', 'Heating & cooling', [
    'hvac', 'furnace', 'air conditioner', 'ac unit', 'central air', 'heat pump',
    'boiler', 'water heater', 'hot water heater', 'mini split', 'minisplit',
    'ductless', 'condenser', 'air handler', 'thermostat', 'window ac',
    'window air conditioner', 'portable ac', 'dehumidifier', 'humidifier',
    'space heater', 'wood stove', 'pellet stove', 'kerosene heater',
    'unit heater', 'outdoor wood boiler', 'ac',
  ], ['car ac', 'auto ac', 'ac adapter', 'ac charger']),

  category('computers', 'Computers & IT', [
    'computer', 'laptop', 'notebook computer', 'notebook', 'desktop', 'macbook', 'imac', 'thinkpad',
    'desktop computer', 'pc', 'gaming pc', 'chromebook', 'server', 'rack server',
    'computer workstation', 'monitor', 'computer monitor', 'printer',
    'laser printer', 'scanner', 'network switch', 'wifi router', 'network router',
    'hard drive', 'ssd', 'graphics card', 'gpu', 'computer keyboard',
    'thin client', 'docking station', 'nas', 'battery backup', 'copier',
    'computer equipment', 'it equipment',
  ], ['computer desk', 'computer chair', 'computer cart', 'computer bag', 'baby monitor'],
  { broad: ['computer equipment', 'it equipment'] }),

  category('phones-tablets', 'Phones & tablets', [
    'phone', 'cell phone', 'cellphone', 'smartphone', 'mobile phone', 'tablet', 'iphone', 'ipad',
    'kindle', 'e reader', 'ereader', 'flip phone', 'android phone',
  ], ['phone case', 'phone charger', 'rotary phone', 'telephone pole', 'tablet case']),

  category('cameras', 'Cameras & optics', [
    'camera', 'dslr', 'mirrorless camera', 'lens', 'camera lens', 'camcorder',
    'video camera', 'film camera', '35mm camera', 'security camera',
    'trail camera', 'game camera', 'dash cam', 'tripod', 'thermal camera',
    'action camera', 'instant camera', 'thermal imager', 'infrared camera',
  ], ['camera bag', 'toy camera', 'camera strap']),

  category('electronics', 'Electronics', [
    'electronics', 'tv', 'television', 'smart tv', 'stereo', 'receiver',
    'speaker', 'amplifier', 'subwoofer', 'headphones', 'earbuds', 'headset',
    'soundbar', 'sound bar', 'home theater', 'projector', 'ham radio', 'cb radio',
    'two way radio', 'radio', 'turntable', 'record player', 'cd player',
    'cassette deck', 'reel to reel', 'tube amp', 'vacuum tube', 'game console',
    'video game', 'vcr', 'dvd player', 'oscilloscope', 'test equipment', 'airpods', 'playstation', 'xbox',
    'electronic equipment', 'consumer electronics',
  ], ['tv stand', 'tv cabinet', 'tv tray', 'tv mount'],
  { broad: ['electronics', 'electronic', 'electronic equipment', 'consumer electronics'] }),

  category('appliances', 'Appliances', [
    'appliance', 'refrigerator', 'fridge', 'freezer', 'chest freezer',
    'upright freezer', 'washer', 'washing machine', 'dryer', 'washer and dryer',
    'dishwasher', 'range', 'stove', 'oven', 'wall oven', 'cooktop', 'microwave',
    'stand mixer', 'blender', 'vacuum cleaner', 'shop vac', 'wine cooler',
    'mini fridge', 'ice maker', 'trash compactor', 'range hood', 'toaster',
    'coffee maker', 'espresso machine', 'air fryer', 'slow cooker', 'crock pot',
    'grill', 'smoker', 'pellet grill', 'gas grill', 'sewing machine',
    'kitchen appliances', 'home appliances',
  ], ['toy', 'appliance dolly', 'play kitchen', 'dollhouse'],
  { broad: ['appliance', 'appliances', 'kitchen appliances', 'home appliances'] }),

  category('kitchenware', 'Kitchenware & tableware', [
    'cookware', 'cast iron skillet', 'skillet', 'dutch oven', 'cast iron',
    'bakeware', 'mixing bowl', 'dishes', 'dinnerware', 'fine china', 'china set',
    'glassware', 'crystal stemware', 'stemware', 'flatware', 'silverware',
    'sterling flatware', 'tea set', 'teapot', 'punch bowl', 'cake stand',
    'casserole', 'depression glass', 'milk glass', 'jadeite', 'carnival glass',
    'crock', 'stoneware', 'cookie jar', 'canister set', 'pots and pans',
    'kitchenware', 'housewares', 'kitchen items',
  ], ['toy', 'dollhouse', 'play kitchen'],
  { broad: ['kitchenware', 'housewares', 'kitchen items'] }),

  category('restaurant-equipment', 'Restaurant equipment', [
    'restaurant equipment', 'commercial kitchen', 'commercial fryer', 'fryer',
    'deep fryer', 'walk in cooler', 'walk in freezer', 'prep table',
    'steam table', 'commercial refrigerator', 'reach in', 'reach in cooler',
    'ice machine', 'pizza oven', 'griddle', 'flat top', 'commercial mixer',
    'meat slicer', 'deli slicer', 'slicer', 'convection oven', 'combi oven',
    'hood system', 'exhaust hood', 'stainless table', 'stainless steel table',
    'bar equipment', 'beer cooler', 'kegerator', 'keg cooler', 'draft system',
    'soft serve machine', 'ice cream machine', 'dish machine',
    'commercial dishwasher', 'bun pan rack', 'sheet pan rack', 'food warmer',
    'warming cabinet', 'popcorn machine', 'cotton candy machine',
    'commercial kitchen equipment', 'restaurant supplies',
    'food service equipment',
  ], ['toy', 'play kitchen'],
  { broad: ['restaurant equipment', 'commercial kitchen equipment', 'restaurant supplies', 'food service equipment'] }),

  category('medical', 'Medical & mobility', [
    'medical equipment', 'hospital bed', 'wheelchair', 'wheel chair',
    'power wheelchair', 'lift chair', 'rollator', 'rolling walker',
    'mobility scooter', 'power scooter', 'patient lift', 'stethoscope',
    'exam table', 'dental chair', 'autoclave', 'ultrasound', 'cpap',
    'oxygen concentrator', 'blood pressure monitor', 'shower chair', 'commode',
    'stair lift', 'stairlift', 'medical supplies', 'medical',
  ], ['toy', 'doctor kit', 'medical costume'],
  { broad: ['medical', 'medical equipment', 'medical supplies'] }),

  category('furniture', 'Furniture', [
    'furniture', 'chair', 'table', 'sofa', 'couch', 'loveseat', 'sectional',
    'dresser', 'chest of drawers', 'bureau', 'nightstand', 'bed', 'bed frame',
    'headboard', 'bunk bed', 'mattress', 'curio cabinet', 'china cabinet',
    'display cabinet', 'bookcase', 'bookshelf', 'armoire', 'wardrobe',
    'sideboard', 'buffet', 'hutch', 'credenza', 'recliner', 'rocker',
    'rocking chair', 'ottoman', 'bench', 'stool', 'bar stool', 'dining table',
    'dining set', 'dining room set', 'kitchen table', 'coffee table',
    'end table', 'side table', 'console table', 'desk', 'writing desk',
    'roll top desk', 'secretary desk', 'cedar chest', 'hope chest',
    'blanket chest', 'futon', 'daybed', 'glider', 'patio furniture', 'patio set',
    'outdoor furniture', 'chaise', 'settee', 'hall tree', 'coat rack',
    'furnishings', 'home furnishings',
  ], ['dollhouse', 'toy', 'miniature', 'doll furniture'],
  { broad: ['furniture', 'furnishings', 'home furnishings'] }),

  category('office-furniture', 'Office furniture', [
    'office chair', 'office desk', 'desk chair', 'task chair', 'executive chair',
    'filing cabinet', 'file cabinet', 'lateral file', 'cubicle',
    'office cubicle', 'conference table', 'standing desk', 'sit stand desk',
    'office furniture', 'reception desk', 'workstation desk',
    'office workstation',
  ], ['toy'], { parent: 'furniture', broad: ['office furniture'] }),

  category('home-decor', 'Home decor', [
    'lamp', 'table lamp', 'floor lamp', 'chandelier', 'area rug', 'rug',
    'oriental rug', 'persian rug', 'mirror', 'wall mirror', 'vase',
    'throw pillow', 'curtains', 'home decor', 'decor', 'wall decor',
    'candle holder', 'candlesticks', 'wall clock',
  ], ['car mirror', 'side mirror', 'rearview mirror', 'lamp oil'],
  { broad: ['home decor', 'decor', 'decorations', 'home accents'] }),

  category('antiques', 'Antiques', [
    'antique', 'primitive', 'grandfather clock', 'mantel clock', 'oil lamp',
    'kerosene lamp', 'hit and miss engine', 'butter churn', 'spinning wheel',
    'washboard', 'cast iron bank', 'still bank', 'mechanical bank',
    'treadle sewing machine', 'victrola', 'phonograph', 'gramophone',
    'barber chair', 'apothecary', 'stained glass', 'slag glass', 'steamer trunk',
    'tiffany lamp', 'wagon wheel', 'crank phone',
  ], ['reproduction', 'replica', 'repro']),

  category('collectibles', 'Collectibles', [
    'collectible', 'collectable', 'memorabilia', 'sports memorabilia',
    'trading cards', 'baseball cards', 'sports cards', 'football cards',
    'basketball cards', 'hockey cards', 'figurine', 'die cast', 'diecast',
    'beer sign', 'neon sign', 'advertising sign', 'tin sign', 'porcelain sign',
    'breweriana', 'beer stein', 'stein', 'slot machine', 'pinball machine',
    'pinball', 'jukebox', 'arcade game', 'arcade machine', 'stamps',
    'stamp collection', 'postcards', 'vinyl records', 'lp records',
    'record collection', 'political pin', 'campaign button', 'military medals',
    'war relics', 'pocket knife', 'pocketknife', 'knife collection',
    'zippo lighter', 'snow globe', 'christmas ornaments', 'arrowheads',
    'mineral specimens', 'fossil', 'military surplus',
  ], ['reproduction', 'replica'],
  { broad: ['collectible', 'collectibles', 'collectable', 'collectables', 'memorabilia'] }),

  category('coins', 'Coins & currency', [
    'coin', 'penny', 'pennies', 'cent', 'nickel', 'dime', 'quarter',
    'half dollar', 'dollar', 'proof set', 'mint set', 'proof coin',
    'uncirculated set', 'coin collection', 'coin set', 'numismatic',
    'numismatics', 'paper money', 'silver certificate', 'gold certificate',
    'banknote', 'bank note', 'red seal', 'large cent', 'wheat penny',
    'wheat pennies', 'steel penny', 'commemorative coin', 'state quarters',
    'coin album', 'coin lot', 'currency',
  ], ['replica', 'copy', 'reproduction', 'token', 'coin purse', 'coin bank', 'coin op', 'coin operated']),

  category('bullion', 'Bullion & precious metals', [
    'bullion', 'silver bar', 'gold bar', 'silver round', 'gold round', 'ingot',
    'troy oz', 'troy ounce', 'junk silver', 'precious metals', 'scrap gold',
    'scrap silver', 'gold scrap', 'silver scrap', 'sterling scrap',
    'constitutional silver',
  ], ['plated', 'silver plate', 'silverplate', 'gold plated', 'gold filled', 'replica', 'copy', 'clad'],
  { broad: ['precious metals'] }),

  category('jewelry', 'Jewelry', [
    'jewelry', 'jewellery', 'ring', 'necklace', 'bracelet', 'earrings', 'earring',
    'pendant', 'brooch', 'gold chain', 'silver chain', 'bangle',
    'engagement ring', 'wedding band', 'wedding ring', 'diamond ring',
    'diamond earrings', 'loose diamond', 'gemstone', 'costume jewelry',
    'estate jewelry', 'cufflinks', 'tennis bracelet', 'locket',
    'charm bracelet',
  ], ['jewelry box', 'jewelry armoire', 'jewelry display', 'ring light'],
  { broad: ['jewelry', 'jewellery'] }),

  category('watches', 'Watches', [
    'watch', 'wristwatch', 'pocket watch', 'timepiece', 'chronograph',
    'smart watch', 'smartwatch', 'watch lot',
  ], ['watch box', 'watch band', 'watch winder', 'watch parts']),

  category('art', 'Art', [
    'art', 'painting', 'oil painting', 'watercolor', 'print', 'lithograph',
    'serigraph', 'giclee', 'etching', 'engraving', 'sculpture',
    'bronze sculpture', 'statue', 'signed print', 'artwork', 'framed art',
    'wall art', 'original art', 'drawing', 'folk art', 'fine art',
  ], ['art supplies', 'art deco', 'art nouveau', 'clip art'],
  { broad: ['art', 'artwork', 'fine art'] }),

  category('books', 'Books & comics', [
    'book', 'first edition', 'rare book', 'comic book', 'comic', 'bible',
    'family bible', 'atlas', 'book collection', 'book lot', 'encyclopedia',
    'cookbook', 'manuscript', 'leather bound', 'graphic novel',
  ], ['book case', 'bookcase', 'bookshelf', 'book ends', 'bookends']),

  category('toys', 'Toys & games', [
    'toy', 'action figure', 'model train', 'train set', 'toy train', 'doll',
    'dollhouse', 'doll house', 'stuffed animal', 'plush', 'board game',
    'puzzle', 'tin toy', 'pedal car', 'rocking horse', 'toy truck', 'slot cars',
    'rc car', 'remote control car', 'model kit', 'play set', 'playset',
    'toy tractor', 'teddy bear',
  ], ['dog toy', 'cat toy', 'pet toy']),

  category('musical-instruments', 'Musical instruments', [
    'guitar', 'electric guitar', 'acoustic guitar', 'bass guitar', 'piano',
    'upright piano', 'baby grand', 'grand piano', 'digital piano',
    'electric keyboard', 'drums', 'drum set', 'drum kit', 'violin', 'fiddle',
    'cello', 'viola', 'trumpet', 'trombone', 'saxophone', 'sax', 'clarinet',
    'flute', 'tuba', 'french horn', 'banjo', 'mandolin', 'ukulele', 'harmonica',
    'accordion', 'organ', 'guitar amp', 'guitar amplifier', 'bass amp',
    'pa system', 'microphone', 'mixing board', 'effects pedal', 'guitar pedal',
    'synthesizer', 'synth', 'musical instrument', 'instrument',
  ], ['toy', 'music box', 'instrument cluster', 'surveying instrument'],
  { broad: ['musical instrument', 'musical instruments', 'instrument', 'instruments'] }),

  category('sporting-goods', 'Sporting goods & fitness', [
    'sporting goods', 'bicycle', 'bike', 'mountain bike', 'road bike',
    'exercise bike', 'stationary bike', 'spin bike', 'treadmill', 'elliptical',
    'rowing machine', 'weight set', 'weight bench', 'dumbbells', 'barbell',
    'squat rack', 'home gym', 'kettlebell', 'golf clubs', 'golf club',
    'golf bag', 'golf balls', 'fishing rod', 'fishing pole', 'fishing reel',
    'tackle box', 'fishing tackle', 'tent', 'camping gear', 'sleeping bag',
    'skis', 'snowboard', 'ice skates', 'hockey equipment', 'baseball glove',
    'tree stand', 'deer stand', 'ladder stand', 'hunting blind', 'ground blind',
    'crossbow', 'compound bow', 'hunting bow', 'archery', 'decoys',
    'duck decoys', 'ice fishing', 'ice auger', 'ice shanty', 'fish house',
    'ice house', 'ice shack', 'pool table', 'ping pong table', 'foosball',
    'air hockey', 'dart board', 'trampoline', 'basketball hoop',
    'paddleboard', 'paddle board', 'sports equipment', 'fitness equipment',
    'exercise equipment', 'outdoor gear',
  ], ['toy'],
  { broad: ['sporting goods', 'sports equipment', 'fitness equipment', 'exercise equipment', 'outdoor gear'] }),

  category('firearms-accessories', 'Firearms accessories & optics', [
    'scope', 'rifle scope', 'riflescope', 'optic', 'optics', 'binoculars',
    'binos', 'rangefinder', 'range finder', 'spotting scope', 'red dot',
    'red dot sight', 'gun safe', 'rifle safe', 'firearm safe', 'gun cabinet',
    'holster', 'ammo can', 'ammo box', 'ammunition can', 'gun case',
    'rifle case', 'gun cleaning kit', 'reloading press', 'reloading equipment',
    'reloading', 'shooting bench', 'shooting rest', 'gun rack', 'night vision',
    'thermal scope', 'bipod', 'firearms accessories', 'gun accessories',
    'shooting accessories', 'hunting accessories',
  ], ['toy', 'airsoft', 'nerf', 'water gun', 'glue gun', 'nail gun', 'heat gun'],
  { broad: ['firearms accessories', 'gun accessories', 'shooting accessories', 'hunting accessories'] }),

  category('clothing-shoes', 'Clothing, shoes & bags', [
    'clothing', 'clothes', 'apparel', 'shoes', 'boots', 'sneakers',
    'tennis shoes', 'jacket', 'coat', 'fur coat', 'leather jacket', 'dress',
    'jeans', 'shirt', 't shirt', 'tshirt', 'hat', 'handbag', 'purse',
    'designer bag', 'wallet', 'scarf', 'work boots', 'cowboy boots',
    'winter coat', 'parka', 'hoodie', 'sweatshirt', 'sweater',
    'vintage clothing', 'designer clothing', 'sunglasses',
  ], ['doll clothes', 'shoe rack', 'boot tray'],
  { broad: ['clothing', 'clothes', 'apparel'] }),

  category('wholesale-lots', 'Pallets & bulk lots', [
    'pallet', 'pallet lot', 'truckload', 'customer returns', 'returns pallet',
    'overstock', 'shelf pulls', 'bulk lot', 'wholesale lot', 'box lot',
    'mystery box', 'liquidation pallet',
  ], ['pallet jack', 'pallet racking', 'pallet rack', 'pallet wood', 'pallet forks']),

  category('real-estate', 'Real estate (not covered)', [
    'real estate', 'house', 'land', 'acreage', 'acres', 'acre', 'farmland',
    'vacant land', 'hunting land', 'recreational land', 'parcel', 'condo',
    'mobile home', 'manufactured home', 'commercial property',
    'rental property', 'duplex', 'lake lot', 'building lot',
    'investment property', 'tax sale', 'foreclosure', 'lake home', 'lake house',
    'homestead',
  ], ['dollhouse', 'doll house', 'bird house', 'birdhouse', 'dog house', 'doghouse', 'house paint', 'house plant'],
  { outOfScope: true }),
];

// ------------------------------------------------------------------- brands

function brand(
  name: string,
  category: string,
  aliases: readonly string[] = [],
  extra: Partial<Pick<Brand, 'families' | 'ambiguous' | 'context' | 'cues'>> = {},
): Brand {
  return { name, category, aliases, ...extra };
}

/** Cue words shared by brands that are only brands in a workshop. */
const WELD_CUES = ['welder', 'welders', 'welding', 'mig', 'tig', 'stick', 'arc', 'plasma'];
const SHOP_CUES = ['saw', 'lathe', 'jointer', 'planer', 'bandsaw', 'drill', 'mill', 'milling', 'sander', 'machine'];
const EQUIPMENT_CUES = [
  'tractor', 'backhoe', 'skid', 'steer', 'loader', 'dozer', 'bulldozer', 'excavator',
  'combine', 'grader', 'forklift', 'telehandler', 'equipment', 'attachment', 'bucket',
];
const VEHICLE_CUES = ['car', 'truck', 'pickup', 'sedan', 'suv', 'coupe', 'convertible', 'van', 'wagon'];

/**
 * Brands common at US surplus, estate and equipment auctions. Aliases are the
 * spellings buyers actually type, including the misspellings that recur
 * ("volkswagon", "john deer"); multi-word names also match run together
 * ("snapon", "johndeere") without being listed.
 */
export const BRANDS: readonly Brand[] = [
  // ---- hand tools and tool trucks
  brand('Snap-on', 'tools', ['snap on']),
  brand('Mac Tools', 'tools', ['mac tool']),
  brand('Matco Tools', 'tools', ['matco']),
  brand('Cornwell Tools', 'tools', ['cornwell']),
  brand('Blue-Point', 'tools', ['blue point']),
  brand('Craftsman', 'tools', ['sears craftsman']),
  brand('Stanley', 'tools', ['stanley tools']),
  brand('Kobalt', 'tools'),
  brand('Husky', 'tools', [], { ambiguous: ['husky'], context: ['tools', 'power-tools'], cues: ['tool', 'tools', 'toolbox', 'wrench', 'socket', 'chest', 'cabinet'] }),
  brand('Klein Tools', 'tools', ['klein']),
  brand('Knipex', 'tools'),
  brand('Wera', 'tools'),
  brand('Wiha', 'tools'),
  brand('Proto', 'tools', ['proto tools']),
  brand('GearWrench', 'tools', ['gear wrench']),
  brand('Channellock', 'tools', ['channel lock']),
  brand('Vise-Grip', 'tools', ['vise grips', 'vice grip', 'vice grips']),
  brand('Irwin', 'tools'),
  brand('Estwing', 'tools'),
  brand('Starrett', 'tools'),
  brand('Mitutoyo', 'tools'),
  brand('Chicago Pneumatic', 'tools'),
  brand('Greenlee', 'tools'),
  brand('Wright Tool', 'tools'),
  brand('SK Tools', 'tools', ['sk hand tool']),
  brand('Harbor Freight', 'tools', ['harbor freight tools']),
  brand('Leatherman', 'tools'),
  // ---- power tools and woodworking machines
  brand('Milwaukee', 'power-tools', [], {
    ambiguous: ['milwaukee'], context: ['power-tools', 'tools'],
    cues: ['m18', 'm12', 'fuel', 'sawzall', 'packout', 'drill', 'impact', 'cordless', 'tool', 'tools', 'battery', 'saw'],
  }),
  brand('DeWalt', 'power-tools', ['de walt']),
  brand('Makita', 'power-tools'),
  brand('Hilti', 'power-tools'),
  brand('Festool', 'power-tools'),
  brand('Bosch', 'power-tools'),
  brand('Ryobi', 'power-tools'),
  brand('Ridgid', 'power-tools'),
  brand('Porter-Cable', 'power-tools', ['porter cable']),
  brand('Black & Decker', 'power-tools', ['black and decker', 'black decker']),
  brand('Metabo', 'power-tools'),
  brand('Metabo HPT', 'power-tools', ['hitachi power tools']),
  brand('Fein', 'power-tools'),
  brand('Senco', 'power-tools'),
  brand('Paslode', 'power-tools'),
  brand('Bostitch', 'power-tools', ['stanley bostitch']),
  brand('Kreg', 'power-tools'),
  brand('Dremel', 'power-tools'),
  brand('Powermatic', 'power-tools'),
  brand('Delta', 'power-tools', [], { ambiguous: ['delta'], context: ['power-tools', 'industrial'], cues: SHOP_CUES }),
  brand('Jet', 'power-tools', [], { ambiguous: ['jet'], context: ['power-tools', 'industrial'], cues: SHOP_CUES }),
  brand('Grizzly', 'industrial', [], { ambiguous: ['grizzly'], context: ['power-tools', 'industrial'], cues: SHOP_CUES }),
  brand('Graco', 'power-tools', [], { ambiguous: ['graco'], context: ['power-tools', 'industrial'], cues: ['sprayer', 'paint', 'airless'] }),
  // ---- welding
  brand('Lincoln Electric', 'welding', ['lincoln'], { ambiguous: ['lincoln'], context: ['welding'], cues: WELD_CUES }),
  brand('Miller Electric', 'welding', ['miller'], { ambiguous: ['miller'], context: ['welding'], cues: WELD_CUES }),
  brand('Hobart', 'welding', [], {
    ambiguous: ['hobart'], context: ['welding', 'restaurant-equipment'],
    cues: [...WELD_CUES, 'mixer', 'slicer', 'dishwasher'],
  }),
  brand('ESAB', 'welding'),
  brand('Hypertherm', 'welding'),
  brand('Victor', 'welding', [], { ambiguous: ['victor'], context: ['welding'], cues: ['torch', 'cutting', 'oxy', 'acetylene', 'regulator', 'regulators'] }),
  // ---- heavy equipment
  brand('Caterpillar', 'heavy-equipment', ['cat'], {
    ambiguous: ['cat'], context: ['heavy-equipment', 'industrial', 'farm'],
    cues: [...EQUIPMENT_CUES, 'generator', 'engine', 'diesel'],
  }),
  brand('Case', 'heavy-equipment', ['case construction'], { ambiguous: ['case'], context: ['heavy-equipment', 'farm'], cues: EQUIPMENT_CUES }),
  brand('Case IH', 'farm', ['case international', 'case international harvester']),
  brand('Bobcat', 'heavy-equipment', [], { ambiguous: ['bobcat'], context: ['heavy-equipment'], cues: [...EQUIPMENT_CUES, 'toolcat', 'mower'] }),
  brand('Komatsu', 'heavy-equipment'),
  brand('JCB', 'heavy-equipment'),
  brand('Takeuchi', 'heavy-equipment'),
  brand('Kobelco', 'heavy-equipment'),
  brand('Doosan', 'heavy-equipment'),
  brand('Develon', 'heavy-equipment'),
  brand('Hitachi', 'heavy-equipment'),
  brand('Gehl', 'heavy-equipment'),
  brand('Terex', 'heavy-equipment'),
  brand('Manitou', 'heavy-equipment'),
  brand('Link-Belt', 'heavy-equipment', ['link belt']),
  brand('Liebherr', 'heavy-equipment'),
  brand('Wacker Neuson', 'heavy-equipment', ['wacker']),
  brand('Vermeer', 'heavy-equipment'),
  brand('Ditch Witch', 'heavy-equipment'),
  brand('Volvo Construction Equipment', 'heavy-equipment', ['volvo ce']),
  brand('Genie', 'industrial', [], { ambiguous: ['genie'], context: ['industrial', 'heavy-equipment'], cues: ['lift', 'boom', 'scissor', 'manlift', 'telehandler'] }),
  brand('JLG', 'industrial'),
  brand('Skyjack', 'industrial'),
  // ---- farm
  brand('John Deere', 'farm', ['deere', 'john deer']),
  brand('Kubota', 'farm'),
  brand('New Holland', 'farm'),
  brand('Massey Ferguson', 'farm', ['massey']),
  brand('Massey-Harris', 'farm', ['massey harris']),
  brand('International Harvester', 'farm', ['ih']),
  brand('Farmall', 'farm'),
  brand('Allis-Chalmers', 'farm', ['allis chalmers', 'allis']),
  brand('Minneapolis-Moline', 'farm', ['minneapolis moline']),
  brand('Oliver', 'farm', [], { ambiguous: ['oliver'], context: ['farm'], cues: EQUIPMENT_CUES }),
  brand('Mahindra', 'farm'),
  brand('Kioti', 'farm'),
  brand('Yanmar', 'farm'),
  brand('AGCO', 'farm'),
  brand('Fendt', 'farm'),
  brand('Claas', 'farm'),
  brand('Gleaner', 'farm'),
  brand('Kinze', 'farm'),
  brand('Land Pride', 'farm'),
  brand('Bush Hog', 'farm'),
  brand('Kuhn', 'farm'),
  brand('Krone', 'farm'),
  brand('Hesston', 'farm'),
  // ---- lawn and outdoor power
  brand('Toro', 'lawn-garden'),
  brand('Husqvarna', 'lawn-garden'),
  brand('Stihl', 'lawn-garden'),
  brand('Gravely', 'lawn-garden'),
  brand('Scag', 'lawn-garden'),
  brand('Exmark', 'lawn-garden'),
  brand('Cub Cadet', 'lawn-garden'),
  brand('Troy-Bilt', 'lawn-garden', ['troy bilt']),
  brand('Ariens', 'lawn-garden'),
  brand('Snapper', 'lawn-garden', [], { ambiguous: ['snapper'], context: ['lawn-garden'], cues: ['mower', 'rider', 'tractor', 'snowblower'] }),
  brand('Simplicity', 'lawn-garden', [], { ambiguous: ['simplicity'], context: ['lawn-garden'], cues: ['mower', 'tractor', 'snowblower', 'rider'] }),
  brand('Briggs & Stratton', 'lawn-garden', ['briggs and stratton', 'briggs stratton', 'briggs']),
  brand('Echo', 'lawn-garden', [], { ambiguous: ['echo'], context: ['lawn-garden'], cues: ['chainsaw', 'trimmer', 'blower', 'saw', 'edger'] }),
  brand('Poulan', 'lawn-garden', ['poulan pro']),
  brand('EGO', 'lawn-garden', ['ego power'], { ambiguous: ['ego'], context: ['lawn-garden'], cues: ['mower', 'blower', 'trimmer', 'chainsaw', '56v', 'battery'] }),
  brand('Greenworks', 'lawn-garden'),
  brand('Dixie Chopper', 'lawn-garden'),
  brand('Ferris', 'lawn-garden', [], { ambiguous: ['ferris'], context: ['lawn-garden'], cues: ['mower', 'zero', 'turn'] }),
  brand('Swisher', 'lawn-garden'),
  // ---- engines, power generation, compressors
  brand('Kohler', 'industrial'),
  brand('Generac', 'industrial'),
  brand('Cummins', 'industrial'),
  brand('Onan', 'industrial', ['cummins onan']),
  brand('Westinghouse', 'industrial'),
  brand('Ingersoll Rand', 'industrial', ['ingersoll-rand', 'ingersoll']),
  brand('Campbell Hausfeld', 'industrial'),
  brand('Atlas Copco', 'industrial'),
  brand('Sullair', 'industrial'),
  brand('Kaeser', 'industrial'),
  brand('Quincy', 'industrial', [], { ambiguous: ['quincy'], context: ['industrial'], cues: ['compressor', 'pump'] }),
  // ---- vehicles
  brand('Ford', 'vehicles', [], { families: ['mustang', 'bronco', 'thunderbird', 'excursion', 'superduty', 'super duty'] }),
  brand('Chevrolet', 'vehicles', ['chevy', 'chev'], { families: ['silverado', 'corvette', 'camaro', 'tahoe', 'suburban', 'impala', 'malibu', 'equinox', 'avalanche', 'el camino'] }),
  brand('GMC', 'trucks', [], { families: ['yukon', 'savana'] }),
  brand('Dodge', 'vehicles', [], { families: ['charger', 'challenger', 'durango'] }),
  brand('Ram', 'trucks', ['ram trucks'], { ambiguous: ['ram'], context: ['trucks', 'vehicles'], cues: ['truck', 'pickup', 'promaster', 'cummins', 'hemi', 'dodge', 'diesel', '4x4', 'crew'] }),
  brand('Toyota', 'vehicles', [], { families: ['tacoma', 'tundra', 'camry', 'corolla', 'prius', 'rav4'] }),
  brand('Honda', 'vehicles', [], { families: ['civic'] }),
  brand('Nissan', 'vehicles', [], { families: ['altima', 'maxima'] }),
  brand('Jeep', 'vehicles'),
  brand('Chrysler', 'vehicles'),
  brand('Buick', 'vehicles'),
  brand('Cadillac', 'vehicles', [], { families: ['escalade'] }),
  brand('Lincoln', 'vehicles', ['lincoln motor company'], { ambiguous: ['lincoln'], context: ['vehicles'], cues: ['navigator', 'continental', 'town car', ...VEHICLE_CUES] }),
  brand('Pontiac', 'vehicles', [], { families: ['firebird'] }),
  brand('Oldsmobile', 'vehicles', ['olds']),
  brand('Plymouth', 'vehicles', [], { ambiguous: ['plymouth'], context: ['vehicles'], cues: ['barracuda', 'fury', 'duster', ...VEHICLE_CUES] }),
  brand('Subaru', 'vehicles', [], { families: ['impreza'] }),
  brand('Mazda', 'vehicles', [], { families: ['miata'] }),
  brand('Hyundai', 'vehicles'),
  brand('Kia', 'vehicles'),
  brand('Volkswagen', 'vehicles', ['vw', 'volkswagon'], { families: ['jetta', 'passat'] }),
  brand('Audi', 'vehicles'),
  brand('BMW', 'vehicles'),
  brand('Mercedes-Benz', 'vehicles', ['mercedes', 'benz']),
  brand('Porsche', 'vehicles'),
  brand('Volvo', 'vehicles'),
  brand('Tesla', 'vehicles'),
  brand('Lexus', 'vehicles'),
  brand('Acura', 'vehicles'),
  brand('Infiniti', 'vehicles'),
  brand('Mitsubishi', 'vehicles'),
  brand('Land Rover', 'vehicles', [], { families: ['range rover'] }),
  brand('Jaguar', 'vehicles', [], { ambiguous: ['jaguar'], context: ['vehicles'], cues: VEHICLE_CUES }),
  brand('Freightliner', 'trucks'),
  brand('Peterbilt', 'trucks'),
  brand('Kenworth', 'trucks'),
  brand('International', 'trucks', ['international trucks', 'navistar'], { ambiguous: ['international'], context: ['trucks'], cues: ['truck', 'dump', 'semi', 'bus', 'tractor'] }),
  brand('Mack', 'trucks', ['mack trucks'], { ambiguous: ['mack'], context: ['trucks'], cues: ['truck', 'dump', 'semi', 'tractor'] }),
  brand('Western Star', 'trucks'),
  brand('Isuzu', 'trucks'),
  brand('Hino', 'trucks'),
  brand('Blue Bird', 'vehicles', ['bluebird'], { ambiguous: ['blue bird', 'bluebird'], context: ['vehicles'], cues: ['bus', 'school'] }),
  // ---- powersports, RVs, boats and trailers
  brand('Harley-Davidson', 'motorcycles', ['harley']),
  brand('Indian Motorcycle', 'motorcycles', ['indian motorcycles', 'indian'], { ambiguous: ['indian'], context: ['motorcycles'], cues: ['motorcycle', 'chief', 'scout', 'bike'] }),
  brand('Polaris', 'atv-utv', [], { families: ['rzr'] }),
  brand('Can-Am', 'atv-utv'),
  brand('Arctic Cat', 'snowmobiles'),
  brand('Ski-Doo', 'snowmobiles', ['ski doo']),
  brand('Sea-Doo', 'boats', ['sea doo']),
  brand('Yamaha', 'motorcycles'),
  brand('Kawasaki', 'motorcycles'),
  brand('Suzuki', 'motorcycles'),
  brand('Ducati', 'motorcycles'),
  brand('Triumph', 'motorcycles', [], { ambiguous: ['triumph'], context: ['motorcycles'], cues: ['motorcycle', 'bonneville', 'bike'] }),
  brand('KTM', 'motorcycles'),
  brand('Club Car', 'atv-utv'),
  brand('E-Z-GO', 'atv-utv', ['ez go', 'ezgo']),
  brand('Winnebago', 'rvs-campers'),
  brand('Airstream', 'rvs-campers'),
  brand('Jayco', 'rvs-campers'),
  brand('Forest River', 'rvs-campers'),
  brand('Coachmen', 'rvs-campers'),
  brand('Fleetwood', 'rvs-campers'),
  brand('Lund', 'boats'),
  brand('Bayliner', 'boats'),
  brand('Sea Ray', 'boats'),
  brand('Boston Whaler', 'boats', ['whaler']),
  brand('Crestliner', 'boats'),
  brand('Alumacraft', 'boats'),
  brand('Bennington', 'boats'),
  brand('Tracker', 'boats', ['bass tracker'], { ambiguous: ['tracker'], context: ['boats'], cues: ['boat', 'bass', 'pontoon', 'marine', 'mercury'] }),
  brand('Mercury Marine', 'boats', ['mercury', 'mercruiser'], { ambiguous: ['mercury'], context: ['boats'], cues: ['outboard', 'motor', 'boat', 'prop', 'propeller'] }),
  brand('Evinrude', 'boats'),
  brand('Johnson', 'boats', [], { ambiguous: ['johnson'], context: ['boats'], cues: ['outboard', 'motor', 'boat', 'seahorse'] }),
  brand('Minn Kota', 'boats'),
  brand('Lowrance', 'boats'),
  brand('Humminbird', 'boats'),
  brand('Old Town', 'boats', [], { ambiguous: ['old town'], context: ['boats'], cues: ['canoe', 'kayak'] }),
  brand('Big Tex', 'trailers', ['big tex trailers']),
  brand('PJ Trailers', 'trailers', ['pj trailer']),
  brand('Featherlite', 'trailers'),
  brand('Load Trail', 'trailers'),
  brand('Sure-Trac', 'trailers', ['sure trac']),
  brand('Carry-On Trailer', 'trailers', ['carry on trailer']),
  // ---- drones, computers, phones, cameras, electronics
  brand('DJI', 'drones', [], { families: ['mavic', 'phantom', 'matrice', 'inspire', 'avata', 'agras', 'osmo', 'ronin'] }),
  brand('Autel Robotics', 'drones', ['autel']),
  brand('Skydio', 'drones'),
  brand('Yuneec', 'drones'),
  brand('Parrot', 'drones', [], { ambiguous: ['parrot'], context: ['drones'], cues: ['drone', 'anafi', 'bebop'] }),
  brand('Apple', 'computers', ['apple computer'], {
    ambiguous: ['apple'], context: ['computers', 'phones-tablets', 'electronics', 'watches'],
    cues: ['iphone', 'ipad', 'macbook', 'imac', 'airpods', 'mac', 'ipod', 'laptop', 'computer', 'watch', 'tablet', 'phone'],
    families: ['iphone', 'ipad', 'macbook', 'imac', 'airpods', 'ipod'],
  }),
  brand('Dell', 'computers', [], { families: ['optiplex', 'poweredge', 'alienware', 'inspiron'] }),
  brand('HP', 'computers', ['hewlett packard', 'hpe'], { families: ['elitebook', 'probook', 'proliant', 'laserjet', 'officejet'] }),
  brand('Lenovo', 'computers', [], { families: ['thinkpad', 'thinkcentre', 'ideapad'] }),
  brand('Microsoft', 'computers', [], { families: ['xbox'] }),
  brand('Asus', 'computers'),
  brand('Acer', 'computers'),
  brand('Toshiba', 'computers'),
  brand('IBM', 'computers'),
  brand('Cisco', 'computers'),
  brand('Ubiquiti', 'computers', ['unifi']),
  brand('Netgear', 'computers'),
  brand('Synology', 'computers'),
  brand('Intel', 'computers'),
  brand('Nvidia', 'computers'),
  brand('Epson', 'computers'),
  brand('Xerox', 'computers'),
  brand('Ricoh', 'computers'),
  brand('Kyocera', 'computers'),
  brand('Konica Minolta', 'computers', ['konica', 'minolta']),
  brand('Zebra', 'computers', ['zebra technologies'], { ambiguous: ['zebra'], context: ['computers'], cues: ['printer', 'label', 'scanner', 'barcode'] }),
  brand('Brother', 'computers', [], { ambiguous: ['brother'], context: ['computers', 'appliances'], cues: ['printer', 'label', 'sewing', 'typewriter', 'embroidery'] }),
  brand('Samsung', 'electronics'),
  brand('Sony', 'electronics', [], { families: ['playstation', 'walkman', 'bravia', 'handycam'] }),
  brand('LG', 'electronics', ['lg electronics']),
  brand('Panasonic', 'electronics', [], { families: ['lumix', 'toughbook'] }),
  brand('Vizio', 'electronics'),
  brand('TCL', 'electronics'),
  brand('Hisense', 'electronics'),
  brand('Philips', 'electronics'),
  brand('Bose', 'electronics'),
  brand('Klipsch', 'electronics'),
  brand('Marantz', 'electronics'),
  brand('McIntosh', 'electronics', ['mcintosh labs']),
  brand('Pioneer', 'electronics', [], { ambiguous: ['pioneer'], context: ['electronics'], cues: ['receiver', 'speakers', 'speaker', 'stereo', 'turntable', 'amplifier', 'cd', 'dj'] }),
  brand('Technics', 'electronics'),
  brand('Denon', 'electronics'),
  brand('Onkyo', 'electronics'),
  brand('JBL', 'electronics'),
  brand('Sonos', 'electronics'),
  brand('Harman Kardon', 'electronics'),
  brand('Polk Audio', 'electronics', ['polk']),
  brand('Nintendo', 'electronics', [], { families: ['gameboy', 'game boy', 'wii'] }),
  brand('Garmin', 'electronics'),
  brand('Motorola', 'phones-tablets'),
  brand('Google', 'phones-tablets'),
  brand('Fluke', 'electronics'),
  brand('Tektronix', 'electronics'),
  brand('Keysight', 'electronics'),
  brand('Agilent', 'electronics'),
  brand('Trimble', 'electronics'),
  brand('Topcon', 'electronics'),
  brand('Canon', 'cameras', [], { families: ['powershot'] }),
  brand('Nikon', 'cameras', [], { families: ['coolpix'] }),
  brand('FLIR', 'cameras', ['teledyne flir', 'flir systems']),
  brand('Seek Thermal', 'cameras'),
  brand('Fujifilm', 'cameras', ['fuji']),
  brand('Olympus', 'cameras'),
  brand('Pentax', 'cameras'),
  brand('Leica', 'cameras'),
  brand('Hasselblad', 'cameras'),
  brand('GoPro', 'cameras', ['go pro']),
  brand('Polaroid', 'cameras'),
  // ---- appliances
  brand('Whirlpool', 'appliances'),
  brand('KitchenAid', 'appliances', ['kitchen aid']),
  brand('Vitamix', 'appliances', ['vita mix']),
  brand('Maytag', 'appliances'),
  brand('GE Appliances', 'appliances', ['ge', 'general electric', 'ge profile', 'ge monogram']),
  brand('Frigidaire', 'appliances'),
  brand('Kenmore', 'appliances'),
  brand('Sub-Zero', 'appliances', ['sub zero']),
  brand('Wolf', 'appliances', [], { ambiguous: ['wolf'], context: ['appliances', 'restaurant-equipment'], cues: ['range', 'oven', 'stove', 'cooktop'] }),
  brand('Viking', 'appliances', [], { ambiguous: ['viking'], context: ['appliances'], cues: ['range', 'oven', 'stove', 'refrigerator', 'cooktop'] }),
  brand('Thermador', 'appliances'),
  brand('Miele', 'appliances'),
  brand('Electrolux', 'appliances'),
  brand('Amana', 'appliances'),
  brand('Speed Queen', 'appliances'),
  brand('Dyson', 'appliances'),
  brand('Hoover', 'appliances'),
  brand('Kirby', 'appliances', [], { ambiguous: ['kirby'], context: ['appliances'], cues: ['vacuum', 'sentria', 'avalir'] }),
  brand('Singer', 'appliances'),
  brand('Cuisinart', 'appliances'),
  brand('Breville', 'appliances'),
  brand('Keurig', 'appliances'),
  brand('Hamilton Beach', 'appliances'),
  brand('Sunbeam', 'appliances'),
  brand('Blendtec', 'appliances'),
  brand('Traeger', 'appliances'),
  brand('Weber', 'appliances'),
  brand('Big Green Egg', 'appliances', ['green egg']),
  // ---- restaurant equipment
  brand('True Manufacturing', 'restaurant-equipment', ['true refrigeration']),
  brand('Vulcan', 'restaurant-equipment', [], { ambiguous: ['vulcan'], context: ['restaurant-equipment'], cues: ['range', 'fryer', 'oven', 'griddle'] }),
  brand('Garland', 'restaurant-equipment', [], { ambiguous: ['garland'], context: ['restaurant-equipment'], cues: ['range', 'oven', 'griddle', 'broiler'] }),
  brand('Manitowoc', 'restaurant-equipment', [], {
    ambiguous: ['manitowoc'], context: ['restaurant-equipment', 'heavy-equipment'], cues: ['ice', 'crane', 'machine'],
  }),
  brand('Scotsman', 'restaurant-equipment'),
  brand('Hoshizaki', 'restaurant-equipment'),
  brand('TurboChef', 'restaurant-equipment', ['turbo chef']),
  brand('Rational', 'restaurant-equipment', [], { ambiguous: ['rational'], context: ['restaurant-equipment'], cues: ['combi', 'oven'] }),
  brand('Frymaster', 'restaurant-equipment'),
  brand('Pitco', 'restaurant-equipment'),
  brand('Beverage-Air', 'restaurant-equipment', ['beverage air']),
  brand('Traulsen', 'restaurant-equipment'),
  brand('Bunn', 'restaurant-equipment'),
  brand('Berkel', 'restaurant-equipment'),
  brand('Waring', 'restaurant-equipment'),
  brand('Robot Coupe', 'restaurant-equipment'),
  brand('Vollrath', 'restaurant-equipment'),
  brand('Cambro', 'restaurant-equipment'),
  // ---- kitchenware, glass, pottery, figurines
  brand('Lodge', 'kitchenware', [], { ambiguous: ['lodge'], context: ['kitchenware'], cues: ['skillet', 'cast', 'iron', 'dutch', 'pan', 'griddle'] }),
  brand('Griswold', 'kitchenware'),
  brand('Wagner Ware', 'kitchenware', ['wagner'], { ambiguous: ['wagner'], context: ['kitchenware'], cues: ['skillet', 'cast', 'iron', 'pan'] }),
  brand('Le Creuset', 'kitchenware'),
  brand('Staub', 'kitchenware'),
  brand('All-Clad', 'kitchenware', ['all clad']),
  brand('Calphalon', 'kitchenware'),
  brand('Revere Ware', 'kitchenware', ['revereware']),
  brand('CorningWare', 'kitchenware', ['corning ware']),
  brand('Pyrex', 'kitchenware'),
  brand('Fiestaware', 'kitchenware', ['fiesta ware', 'fiesta dinnerware', 'fiesta'], {
    ambiguous: ['fiesta'], context: ['kitchenware'], cues: ['dish', 'dishes', 'plate', 'plates', 'bowl', 'pitcher', 'mug', 'dinnerware', 'platter'],
  }),
  brand('Fire-King', 'kitchenware', ['fire king']),
  brand('Anchor Hocking', 'kitchenware'),
  brand('Tupperware', 'kitchenware'),
  brand('Lenox', 'kitchenware'),
  brand('Waterford', 'kitchenware'),
  brand('Wedgwood', 'kitchenware', ['wedgewood']),
  brand('Noritake', 'kitchenware'),
  brand('Spode', 'kitchenware'),
  brand('Mikasa', 'kitchenware'),
  brand('Corelle', 'kitchenware'),
  brand('Homer Laughlin', 'kitchenware'),
  brand('Royal Doulton', 'collectibles'),
  brand('Royal Copenhagen', 'collectibles'),
  brand('Roseville Pottery', 'collectibles', ['roseville'], { ambiguous: ['roseville'], context: ['collectibles', 'antiques'], cues: ['pottery', 'vase', 'planter', 'jardiniere'] }),
  brand('Rookwood', 'collectibles'),
  brand('Weller Pottery', 'collectibles', ['weller'], { ambiguous: ['weller'], context: ['collectibles', 'antiques'], cues: ['pottery', 'vase'] }),
  brand('McCoy Pottery', 'collectibles', ['mccoy'], { ambiguous: ['mccoy'], context: ['collectibles', 'antiques', 'kitchenware'], cues: ['pottery', 'cookie', 'vase', 'planter'] }),
  brand('Red Wing', 'collectibles', [], {
    ambiguous: ['red wing'], context: ['collectibles', 'antiques', 'kitchenware', 'clothing-shoes'],
    cues: ['crock', 'stoneware', 'jug', 'pottery', 'boots', 'shoes'],
  }),
  brand('Fenton', 'collectibles'),
  brand('Blenko', 'collectibles'),
  brand('Longaberger', 'collectibles'),
  brand('Hummel', 'collectibles', ['goebel hummel', 'mi hummel', 'm i hummel']),
  brand('Goebel', 'collectibles'),
  brand('Lladro', 'collectibles'),
  brand('Precious Moments', 'collectibles'),
  brand('Department 56', 'collectibles', ['dept 56']),
  brand('Swarovski', 'jewelry'),
  brand('Franklin Mint', 'collectibles'),
  // ---- optics, safes and firearms makers (accessories category)
  brand('Leupold', 'firearms-accessories'),
  brand('Vortex', 'firearms-accessories', ['vortex optics']),
  brand('Bushnell', 'firearms-accessories'),
  brand('Burris', 'firearms-accessories'),
  brand('Zeiss', 'firearms-accessories', ['carl zeiss']),
  brand('Trijicon', 'firearms-accessories'),
  brand('Aimpoint', 'firearms-accessories'),
  brand('EOTech', 'firearms-accessories', ['eo tech']),
  brand('Holosun', 'firearms-accessories'),
  brand('Nightforce', 'firearms-accessories', ['night force']),
  brand('Steiner', 'firearms-accessories'),
  brand('Liberty Safe', 'firearms-accessories', ['liberty safes', 'liberty'], { ambiguous: ['liberty'], context: ['firearms-accessories'], cues: ['safe', 'safes', 'vault'] }),
  brand('Cannon Safe', 'firearms-accessories', ['cannon safes']),
  brand('Stack-On', 'firearms-accessories', ['stack on']),
  brand('RCBS', 'firearms-accessories'),
  brand('Hornady', 'firearms-accessories'),
  brand('Browning', 'firearms-accessories'),
  brand('Remington', 'firearms-accessories'),
  brand('Winchester', 'firearms-accessories'),
  brand('Ruger', 'firearms-accessories', ['sturm ruger']),
  brand('Smith & Wesson', 'firearms-accessories', ['smith and wesson', 'smith wesson', 's&w']),
  brand('Marlin', 'firearms-accessories', [], { ambiguous: ['marlin'], context: ['firearms-accessories'], cues: ['rifle', 'lever', 'scope'] }),
  brand('Mossberg', 'firearms-accessories'),
  brand('Savage Arms', 'firearms-accessories'),
  brand('Henry Repeating Arms', 'firearms-accessories', ['henry repeating', 'henry'], { ambiguous: ['henry'], context: ['firearms-accessories'], cues: ['rifle', 'lever', 'repeating'] }),
  brand('Colt', 'firearms-accessories'),
  brand('Sig Sauer', 'firearms-accessories', ['sig']),
  brand('Pelican', 'sporting-goods', [], { ambiguous: ['pelican'], context: ['sporting-goods', 'firearms-accessories'], cues: ['case', 'cases', 'cooler', 'kayak'] }),
  // ---- coins, bullion and grading services
  brand('US Mint', 'coins', ['united states mint', 'u s mint']),
  brand('Royal Canadian Mint', 'bullion', ['rcm']),
  brand('Perth Mint', 'bullion'),
  brand('PAMP Suisse', 'bullion', ['pamp']),
  brand('Engelhard', 'bullion'),
  brand('Johnson Matthey', 'bullion'),
  brand('Sunshine Minting', 'bullion', ['sunshine mint']),
  brand('Valcambi', 'bullion'),
  brand('PCGS', 'coins'),
  brand('NGC', 'coins'),
  brand('ANACS', 'coins'),
  brand('CAC', 'coins'),
  // Morgan and Peace are coin designs, but numismatists use them exactly like
  // brands ("a Morgan"). They are single words on purpose: "morgan dollar" as a
  // phrase would miss "Morgan Silver Dollar", so the other words stay separate.
  brand('Morgan', 'coins', [], {
    ambiguous: ['morgan'], context: ['coins', 'bullion'],
    cues: ['dollar', 'dollars', 'silver', 'coin', 'coins', 'pcgs', 'ngc', 'anacs', 'cac', 'proof', 'unc', 'bu', 'carson'],
  }),
  brand('Peace', 'coins', [], {
    ambiguous: ['peace'], context: ['coins', 'bullion'],
    cues: ['dollar', 'dollars', 'silver', 'coin', 'coins', 'pcgs', 'ngc', 'anacs', 'cac', 'proof', 'unc', 'bu'],
  }),
  brand('Walking Liberty', 'coins', ['walking liberty half']),
  brand('Mercury Dime', 'coins', ['mercury dimes']),
  brand('Buffalo Nickel', 'coins', ['buffalo nickels']),
  brand('Indian Head Cent', 'coins', ['indian head penny', 'indian head pennies', 'indian head']),
  brand('Standing Liberty Quarter', 'coins', ['standing liberty']),
  brand('Seated Liberty', 'coins'),
  brand('Barber Coinage', 'coins', ['barber dime', 'barber quarter', 'barber half']),
  brand('Kennedy Half Dollar', 'coins', ['kennedy half', 'kennedy halves']),
  brand('Franklin Half Dollar', 'coins', ['franklin half', 'franklin halves']),
  brand('Eisenhower Dollar', 'coins', ['ike dollar', 'ike dollars']),
  brand('American Silver Eagle', 'bullion', ['silver eagle', 'silver eagles']),
  brand('American Gold Eagle', 'bullion', ['gold eagle', 'gold eagles']),
  brand('American Gold Buffalo', 'bullion', ['gold buffalo']),
  brand('Krugerrand', 'bullion'),
  brand('Canadian Maple Leaf', 'bullion', ['maple leaf', 'silver maple', 'gold maple']),
  brand('Britannia', 'bullion', ['britannia coin']),
  brand('Vienna Philharmonic', 'bullion', ['philharmonic']),
  // ---- furniture
  brand('Stickley', 'furniture', ['l and jg stickley', 'gustav stickley', 'stickley brothers']),
  brand('Herman Miller', 'furniture'),
  brand('Ethan Allen', 'furniture'),
  brand('Knoll', 'furniture'),
  brand('Eames', 'furniture', ['charles eames']),
  brand('Nakashima', 'furniture', ['george nakashima']),
  brand('Steelcase', 'office-furniture'),
  brand('Haworth', 'office-furniture'),
  brand('HON', 'office-furniture', ['hon company']),
  brand('Humanscale', 'office-furniture'),
  brand('Kimball', 'office-furniture'),
  brand('La-Z-Boy', 'furniture', ['la z boy', 'lazy boy', 'lay z boy']),
  brand('Broyhill', 'furniture'),
  brand('Thomasville', 'furniture'),
  brand('Drexel', 'furniture', ['drexel heritage']),
  brand('Bassett', 'furniture'),
  brand('Henredon', 'furniture'),
  brand('Lane Furniture', 'furniture', ['lane'], { ambiguous: ['lane'], context: ['furniture'], cues: ['cedar', 'chest', 'table', 'recliner'] }),
  brand('Hitchcock Chair', 'furniture', ['hitchcock'], { ambiguous: ['hitchcock'], context: ['furniture'], cues: ['chair', 'chairs', 'rocker', 'bench'] }),
  brand('Kittinger', 'furniture'),
  brand('Heywood-Wakefield', 'furniture', ['heywood wakefield']),
  brand('Pottery Barn', 'furniture'),
  brand('Crate & Barrel', 'furniture', ['crate and barrel', 'crate barrel']),
  brand('Restoration Hardware', 'furniture'),
  brand('Room & Board', 'furniture', ['room and board']),
  brand('Pennsylvania House', 'furniture'),
  brand('Flexsteel', 'furniture'),
  brand('Hooker Furniture', 'furniture'),
  brand('Baker Furniture', 'furniture'),
  brand('Widdicomb', 'furniture'),
  brand('Sligh', 'furniture'),
  // ---- toys, trains, cards, advertising and knives
  brand('Lionel', 'toys'),
  brand('American Flyer', 'toys'),
  brand('Marx Toys', 'toys', ['marx'], { ambiguous: ['marx'], context: ['toys'], cues: ['toy', 'tin', 'train', 'playset'] }),
  brand('Tonka', 'toys'),
  brand('Hot Wheels', 'toys', ['redline hot wheels']),
  brand('Matchbox', 'toys', [], { ambiguous: ['matchbox'], context: ['toys', 'collectibles'], cues: ['car', 'cars', 'diecast', 'die', 'lesney'] }),
  brand('Lego', 'toys', ['legos']),
  brand('Barbie', 'toys'),
  brand('Mattel', 'toys'),
  brand('Hasbro', 'toys'),
  brand('Kenner', 'toys'),
  brand('Fisher-Price', 'toys', ['fisher price']),
  brand('Ertl', 'toys'),
  brand('Buddy L', 'toys'),
  brand('Nylint', 'toys'),
  brand('Radio Flyer', 'toys'),
  brand('Steiff', 'toys'),
  brand('Madame Alexander', 'toys'),
  brand('Ty Beanie Babies', 'toys', ['beanie babies', 'beanie baby', 'ty beanie']),
  brand('Funko', 'toys', ['funko pop']),
  brand('Topps', 'collectibles'),
  brand('Upper Deck', 'collectibles'),
  brand('Panini', 'collectibles'),
  brand('Fleer', 'collectibles'),
  brand('Donruss', 'collectibles'),
  brand('Bowman', 'collectibles'),
  brand('Pokemon', 'collectibles', ['pokemon cards']),
  brand('Marvel', 'collectibles'),
  brand('Star Wars', 'collectibles'),
  brand('Disney', 'collectibles'),
  brand('Coca-Cola', 'collectibles', ['coca cola', 'coke'], { ambiguous: ['coke'], context: ['collectibles', 'antiques'], cues: ['sign', 'bottle', 'machine', 'cooler', 'tray', 'vintage'] }),
  brand('Pepsi', 'collectibles', ['pepsi cola']),
  brand('Budweiser', 'collectibles'),
  brand('Anheuser-Busch', 'collectibles', ['anheuser busch']),
  brand("Hamm's", 'collectibles', ["hamm's beer"]),
  brand('Miller Brewing', 'collectibles', ['miller lite', 'miller high life', 'miller beer']),
  brand('Pabst', 'collectibles', ['pabst blue ribbon', 'pbr']),
  brand('Schlitz', 'collectibles'),
  brand('Leinenkugel', 'collectibles', ["leinenkugel's", 'leinies', "leinie's"]),
  brand('Blatz', 'collectibles'),
  brand('Zippo', 'collectibles'),
  brand('Case XX', 'collectibles', ['case knife', 'case knives', 'w r case', 'wr case']),
  brand('Buck Knives', 'collectibles', ['buck'], { ambiguous: ['buck'], context: ['collectibles'], cues: ['knife', 'knives', 'folding', 'pocketknife'] }),
  brand('Schrade', 'collectibles'),
  brand('Ka-Bar', 'collectibles', ['ka bar']),
  brand('Victorinox', 'collectibles', ['swiss army']),
  brand('Benchmade', 'collectibles'),
  brand('Spyderco', 'collectibles'),
  brand('Kershaw', 'collectibles'),
  // ---- watches and jewelry
  brand('Rolex', 'watches'),
  brand('Omega', 'watches'),
  brand('Seiko', 'watches'),
  brand('Citizen', 'watches', [], { ambiguous: ['citizen'], context: ['watches'], cues: ['watch', 'eco', 'drive', 'chronograph'] }),
  brand('Timex', 'watches'),
  brand('Bulova', 'watches'),
  brand('Hamilton', 'watches', [], { ambiguous: ['hamilton'], context: ['watches'], cues: ['watch', 'pocket', 'khaki'] }),
  brand('Elgin', 'watches', [], { ambiguous: ['elgin'], context: ['watches'], cues: ['watch', 'pocket'] }),
  brand('Waltham', 'watches', [], { ambiguous: ['waltham'], context: ['watches'], cues: ['watch', 'pocket'] }),
  brand('TAG Heuer', 'watches', ['heuer']),
  brand('Breitling', 'watches'),
  brand('Cartier', 'watches'),
  brand('Movado', 'watches'),
  brand('Longines', 'watches'),
  brand('Patek Philippe', 'watches', ['patek']),
  brand('Audemars Piguet', 'watches', ['audemars']),
  brand('Tudor', 'watches', [], { ambiguous: ['tudor'], context: ['watches'], cues: ['watch', 'black', 'bay'] }),
  brand('Fossil', 'watches', [], { ambiguous: ['fossil'], context: ['watches'], cues: ['watch', 'purse', 'bag', 'wallet'] }),
  brand('Tiffany & Co.', 'jewelry', ['tiffany and co', 'tiffany co', 'tiffany'], {
    ambiguous: ['tiffany'], context: ['jewelry', 'watches'],
    cues: ['ring', 'necklace', 'bracelet', 'sterling', 'silver', 'pendant', 'earrings'],
  }),
  brand('Pandora', 'jewelry', [], { ambiguous: ['pandora'], context: ['jewelry'], cues: ['charm', 'charms', 'bracelet', 'bead', 'beads'] }),
  // ---- musical instruments
  brand('Gibson', 'musical-instruments'),
  brand('Fender', 'musical-instruments'),
  brand('C.F. Martin', 'musical-instruments', ['martin'], {
    ambiguous: ['martin'], context: ['musical-instruments'], cues: ['guitar', 'acoustic', 'ukulele'],
  }),
  brand('Taylor', 'musical-instruments', [], { ambiguous: ['taylor'], context: ['musical-instruments'], cues: ['guitar', 'acoustic'] }),
  brand('Gretsch', 'musical-instruments'),
  brand('Epiphone', 'musical-instruments'),
  brand('Ibanez', 'musical-instruments'),
  brand('Rickenbacker', 'musical-instruments'),
  brand('PRS', 'musical-instruments', ['paul reed smith']),
  brand('Steinway & Sons', 'musical-instruments', ['steinway', 'steinway and sons']),
  brand('Baldwin', 'musical-instruments', [], { ambiguous: ['baldwin'], context: ['musical-instruments'], cues: ['piano', 'organ', 'grand', 'upright'] }),
  brand('Kawai', 'musical-instruments'),
  brand('Roland', 'musical-instruments'),
  brand('Korg', 'musical-instruments'),
  brand('Ludwig', 'musical-instruments'),
  brand('Zildjian', 'musical-instruments'),
  brand('Selmer', 'musical-instruments'),
  brand('Marshall', 'musical-instruments', [], { ambiguous: ['marshall'], context: ['musical-instruments'], cues: ['amp', 'amplifier', 'head', 'cabinet', 'stack'] }),
  brand('Peavey', 'musical-instruments'),
  brand('Mesa/Boogie', 'musical-instruments', ['mesa boogie']),
  brand('Hammond', 'musical-instruments', [], { ambiguous: ['hammond'], context: ['musical-instruments'], cues: ['organ', 'b3', 'leslie'] }),
  brand('Wurlitzer', 'musical-instruments'),
  // ---- sporting goods and fitness
  brand('Yeti', 'sporting-goods'),
  brand('Coleman', 'sporting-goods'),
  brand('Schwinn', 'sporting-goods'),
  brand('Trek', 'sporting-goods', [], { ambiguous: ['trek'], context: ['sporting-goods'], cues: ['bike', 'bicycle', 'mountain'] }),
  brand('Cannondale', 'sporting-goods'),
  brand('Huffy', 'sporting-goods'),
  brand('Peloton', 'sporting-goods'),
  brand('NordicTrack', 'sporting-goods', ['nordic track']),
  brand('Bowflex', 'sporting-goods'),
  brand('Life Fitness', 'sporting-goods'),
  brand('Precor', 'sporting-goods'),
  brand('Rogue Fitness', 'sporting-goods'),
  brand('Callaway', 'sporting-goods'),
  brand('TaylorMade', 'sporting-goods', ['taylor made']),
  brand('Titleist', 'sporting-goods'),
  brand('Ping', 'sporting-goods', [], { ambiguous: ['ping'], context: ['sporting-goods'], cues: ['golf', 'irons', 'putter', 'driver', 'clubs', 'club', 'wedge'] }),
  brand('Mizuno', 'sporting-goods'),
  brand('Rawlings', 'sporting-goods'),
  brand('Louisville Slugger', 'sporting-goods'),
  brand('Shimano', 'sporting-goods'),
  brand('Abu Garcia', 'sporting-goods'),
  brand('Orvis', 'sporting-goods'),
  // ---- clothing, boots and bags
  brand('Carhartt', 'clothing-shoes'),
  brand("Levi's", 'clothing-shoes', ['levi', 'levi strauss']),
  brand('Nike', 'clothing-shoes'),
  brand('Adidas', 'clothing-shoes'),
  brand('Under Armour', 'clothing-shoes', ['under armor']),
  brand('The North Face', 'clothing-shoes', ['north face', 'tnf']),
  brand('Patagonia', 'clothing-shoes'),
  brand('Columbia Sportswear', 'clothing-shoes', ['columbia'], { ambiguous: ['columbia'], context: ['clothing-shoes'], cues: ['jacket', 'coat', 'fleece', 'parka', 'boots'] }),
  brand('Filson', 'clothing-shoes'),
  brand('L.L.Bean', 'clothing-shoes', ['ll bean', 'l l bean']),
  brand('Pendleton', 'clothing-shoes'),
  brand('Woolrich', 'clothing-shoes'),
  brand('Wolverine', 'clothing-shoes', [], { ambiguous: ['wolverine'], context: ['clothing-shoes'], cues: ['boots', 'boot', 'shoes'] }),
  brand('Timberland', 'clothing-shoes'),
  brand('Dr. Martens', 'clothing-shoes', ['doc martens']),
  brand('Ariat', 'clothing-shoes'),
  brand('Tony Lama', 'clothing-shoes'),
  brand('Lucchese', 'clothing-shoes'),
  brand('Coach', 'clothing-shoes', [], { ambiguous: ['coach'], context: ['clothing-shoes'], cues: ['purse', 'handbag', 'bag', 'wallet', 'leather', 'tote'] }),
  brand('Louis Vuitton', 'clothing-shoes', ['vuitton']),
  brand('Gucci', 'clothing-shoes'),
  brand('Chanel', 'clothing-shoes'),
  brand('Hermes', 'clothing-shoes'),
  brand('Prada', 'clothing-shoes'),
  brand('Burberry', 'clothing-shoes'),
  brand('Michael Kors', 'clothing-shoes'),
  brand('Kate Spade', 'clothing-shoes'),
  brand('Dooney & Bourke', 'clothing-shoes', ['dooney and bourke', 'dooney']),
  brand('Vera Bradley', 'clothing-shoes'),
  // ---- medical and mobility
  brand('Hill-Rom', 'medical', ['hill rom']),
  brand('Stryker', 'medical'),
  brand('Invacare', 'medical'),
  brand('Drive Medical', 'medical'),
  brand('Pride Mobility', 'medical'),
  brand('Medline', 'medical'),
  brand('Welch Allyn', 'medical'),
  brand('ResMed', 'medical'),
  brand('Respironics', 'medical', ['philips respironics']),
  brand('Midmark', 'medical'),
  brand('Zoll', 'medical'),
  brand('Hoyer', 'medical'),
  // ---- HVAC, electrical, material handling, machine tools, building
  brand('Trane', 'hvac'),
  brand('Carrier', 'hvac', [], { ambiguous: ['carrier'], context: ['hvac'], cues: ['furnace', 'ac', 'conditioner', 'pump', 'condenser', 'hvac'] }),
  brand('Lennox', 'hvac'),
  brand('Rheem', 'hvac'),
  brand('Goodman', 'hvac'),
  brand('Daikin', 'hvac'),
  brand('Honeywell', 'hvac'),
  brand('Siemens', 'industrial'),
  brand('Square D', 'industrial'),
  brand('Eaton', 'industrial'),
  brand('Allen-Bradley', 'industrial', ['allen bradley']),
  brand('Baldor', 'industrial'),
  brand('Hyster', 'industrial'),
  brand('Yale', 'industrial', [], { ambiguous: ['yale'], context: ['industrial'], cues: ['forklift', 'lift', 'pallet'] }),
  brand('Clark', 'industrial', [], { ambiguous: ['clark'], context: ['industrial'], cues: ['forklift', 'lift'] }),
  brand('Crown', 'industrial', [], { ambiguous: ['crown'], context: ['industrial'], cues: ['forklift', 'pallet', 'reach', 'lift'] }),
  brand('Haas', 'industrial'),
  brand('Mazak', 'industrial'),
  brand('Okuma', 'industrial'),
  brand('Clausing', 'industrial'),
  brand('Hardinge', 'industrial'),
  brand('Bridgeport', 'industrial', [], { ambiguous: ['bridgeport'], context: ['industrial'], cues: ['mill', 'milling', 'machine'] }),
  brand('South Bend', 'industrial', [], { ambiguous: ['south bend'], context: ['industrial'], cues: ['lathe', 'mill'] }),
  brand('Andersen', 'building-materials', [], { ambiguous: ['andersen'], context: ['building-materials'], cues: ['window', 'windows', 'door', 'patio'] }),
  brand('Pella', 'building-materials', [], { ambiguous: ['pella'], context: ['building-materials'], cues: ['window', 'windows', 'door'] }),
  brand('Marvin', 'building-materials', [], { ambiguous: ['marvin'], context: ['building-materials'], cues: ['window', 'windows', 'door', 'doors'] }),
  brand('Owens Corning', 'building-materials'),
  brand('Moen', 'building-materials'),
];

// ----------------------------------------------------------------- features

/**
 * Attributes a buyer insists on: they become hunts.required_terms ("must have
 * thermal"). Precious-metal grades live here too. "14k" is not a brand; it is
 * the single most important word in a gold listing.
 */
export const FEATURES: readonly Feature[] = [
  { name: 'thermal', forms: ['thermal', 'thermal imaging', 'infrared', 'radiometric'] },
  { name: '4x4', forms: ['4x4', '4wd', 'four wheel drive', '4 wheel drive', '4x4s'] },
  { name: 'awd', forms: ['awd', 'all wheel drive'] },
  { name: 'cordless', forms: ['cordless', 'battery powered', 'battery operated'] },
  { name: 'diesel', forms: ['diesel', 'powerstroke', 'power stroke', 'duramax', 'tdi', 'turbodiesel'] },
  { name: 'gas', forms: ['gas', 'gas powered', 'gasoline', 'gas engine'] },
  { name: 'electric', forms: ['electric', 'electric powered'] },
  { name: 'electric start', forms: ['electric start', 'e start'] },
  { name: 'propane', forms: ['propane'] },
  { name: 'hydraulic', forms: ['hydraulic', 'hydraulics', 'hydrostatic'] },
  { name: 'pto', forms: ['pto', 'power take off'] },
  { name: '3 point hitch', forms: ['3 point', 'three point', '3 point hitch', 'three point hitch', '3pt'] },
  { name: 'turbo', forms: ['turbo', 'turbocharged'] },
  { name: 'v8', forms: ['v8'] },
  { name: 'v6', forms: ['v6'] },
  { name: 'hemi', forms: ['hemi'] },
  { name: 'manual transmission', forms: ['manual transmission', 'stick shift'] },
  { name: 'automatic transmission', forms: ['automatic transmission'] },
  { name: 'crew cab', forms: ['crew cab', 'crewcab', 'quad cab', 'double cab', 'supercrew', 'super crew'] },
  { name: 'extended cab', forms: ['extended cab', 'ext cab', 'supercab', 'super cab', 'king cab', 'access cab'] },
  { name: 'regular cab', forms: ['regular cab', 'single cab'] },
  { name: 'long bed', forms: ['long bed', 'longbed'] },
  { name: 'short bed', forms: ['short bed', 'shortbed'] },
  { name: 'plow', forms: ['plow', 'snow plow', 'snowplow'] },
  { name: 'tow package', forms: ['tow package', 'towing package', 'tow hitch'] },
  { name: 'hitch', forms: ['hitch'] },
  { name: 'winch', forms: ['winch'] },
  { name: 'lift kit', forms: ['lift kit', 'lifted'] },
  { name: 'leather', forms: ['leather', 'leather seats'] },
  { name: 'sunroof', forms: ['sunroof', 'moonroof', 'sun roof', 'moon roof'] },
  { name: 'heated seats', forms: ['heated seats'] },
  { name: 'backup camera', forms: ['backup camera', 'back up camera', 'rear camera'] },
  { name: 'gps', forms: ['gps'] },
  { name: 'rtk', forms: ['rtk'] },
  { name: 'zoom', forms: ['zoom', 'optical zoom'] },
  { name: '4k', forms: ['4k', 'uhd', 'ultra hd'] },
  { name: '8k', forms: ['8k'] },
  { name: 'oled', forms: ['oled'] },
  { name: 'bluetooth', forms: ['bluetooth'] },
  { name: 'wifi', forms: ['wifi', 'wi fi', 'wireless'] },
  { name: 'touchscreen', forms: ['touchscreen', 'touch screen'] },
  { name: 'brushless', forms: ['brushless'] },
  { name: 'lithium', forms: ['lithium', 'li ion', 'lithium ion'] },
  { name: 'enclosed', forms: ['enclosed', 'enclosed cab', 'heated cab'] },
  { name: 'tandem axle', forms: ['tandem axle', 'dual axle', 'double axle', 'tandem'] },
  { name: 'cab', forms: ['cab'] },
  { name: 'mower deck', forms: ['mower deck', 'belly mower'] },
  { name: 'air ride', forms: ['air ride'] },
  { name: 'sleeper cab', forms: ['sleeper', 'sleeper cab'] },
  { name: 'no reserve', forms: ['no reserve', 'absolute auction', 'absolute'] },
  { name: 'runs and drives', forms: ['runs and drives', 'runs drives', 'runs', 'running', 'drives'] },
  { name: 'low miles', forms: ['low miles', 'low mileage'] },
  { name: 'low hours', forms: ['low hours'] },
  { name: 'one owner', forms: ['one owner', '1 owner', 'single owner'] },
  { name: 'garage kept', forms: ['garage kept'] },
  { name: 'barn find', forms: ['barn find'] },
  { name: 'restored', forms: ['restored', 'restoration'] },
  { name: 'original paint', forms: ['original paint'] },
  { name: 'numbers matching', forms: ['numbers matching', 'matching numbers'] },
  // materials
  { name: 'gold', forms: ['gold'] },
  { name: 'silver', forms: ['silver'] },
  { name: 'platinum', forms: ['platinum'] },
  { name: 'palladium', forms: ['palladium'] },
  { name: 'brass', forms: ['brass'] },
  { name: 'copper', forms: ['copper'] },
  { name: 'bronze', forms: ['bronze'] },
  { name: 'pewter', forms: ['pewter'] },
  { name: 'stainless', forms: ['stainless', 'stainless steel'] },
  { name: 'aluminum', forms: ['aluminum', 'aluminium'] },
  { name: 'titanium', forms: ['titanium'] },
  { name: 'carbon fiber', forms: ['carbon fiber', 'carbon fibre'] },
  { name: 'oak', forms: ['oak', 'solid oak'] },
  { name: 'quartersawn oak', forms: ['quartersawn', 'quarter sawn', 'quarter sawn oak', 'quartersawn oak'] },
  { name: 'walnut', forms: ['walnut'] },
  { name: 'cherry', forms: ['cherry'] },
  { name: 'mahogany', forms: ['mahogany'] },
  { name: 'teak', forms: ['teak'] },
  { name: 'pine', forms: ['pine'] },
  { name: 'maple', forms: ['maple', 'birdseye maple'] },
  { name: 'solid wood', forms: ['solid wood', 'hardwood'] },
  { name: 'marble', forms: ['marble'] },
  { name: 'granite', forms: ['granite'] },
  { name: 'porcelain', forms: ['porcelain'] },
  { name: 'diamond', forms: ['diamond', 'diamonds'] },
  { name: 'diamond plate', forms: ['diamond plate'] },
  { name: 'jade', forms: ['jade'] },
  { name: 'turquoise', forms: ['turquoise'] },
  { name: 'pearl', forms: ['pearl', 'pearls'] },
  // styles and provenance
  { name: 'vintage', forms: ['vintage'] },
  { name: 'retro', forms: ['retro'] },
  { name: 'mid century', forms: ['mid century', 'midcentury', 'mid century modern', 'mcm'] },
  { name: 'art deco', forms: ['art deco', 'deco'] },
  { name: 'art nouveau', forms: ['art nouveau'] },
  { name: 'victorian', forms: ['victorian'] },
  { name: 'arts and crafts', forms: ['arts and crafts'] },
  { name: 'mission', forms: ['mission', 'mission style'] },
  { name: 'farmhouse', forms: ['farmhouse'] },
  { name: 'rustic', forms: ['rustic'] },
  { name: 'danish modern', forms: ['danish modern'] },
  { name: 'amish', forms: ['amish', 'amish made'] },
  { name: 'handmade', forms: ['handmade', 'hand made', 'handcrafted', 'hand crafted'] },
  { name: 'signed', forms: ['signed', 'autographed', 'autograph'] },
  { name: 'first edition', forms: ['first edition', '1st edition'] },
  { name: 'graded', forms: ['graded', 'slabbed', 'certified'] },
  { name: 'proof', forms: ['proof'] },
  { name: 'uncirculated', forms: ['uncirculated', 'unc', 'bu', 'brilliant uncirculated'] },
  { name: 'limited edition', forms: ['limited edition', 'numbered'] },
  { name: 'original box', forms: ['original box', 'with box', 'box and papers', 'with papers'] },
  // precious-metal grades
  { name: '10k', forms: ['10k', '10kt', '10 karat'] },
  { name: '14k', forms: ['14k', '14kt', '14 karat'] },
  { name: '18k', forms: ['18k', '18kt', '18 karat'] },
  { name: '22k', forms: ['22k', '22kt', '22 karat'] },
  { name: '24k', forms: ['24k', '24kt', '24 karat'] },
  { name: 'sterling', forms: ['sterling', 'sterling silver', '.925'] },
  { name: '.999', forms: ['.999', '.9999', 'fine silver', 'fine gold'] },
  { name: 'gold filled', forms: ['gold filled', 'gf'] },
  { name: 'plated', forms: ['plated', 'silver plate', 'silverplate', 'silver plated', 'gold plate', 'gold plated', 'goldplated', 'electroplated'] },
  { name: 'junk silver', forms: ['90% silver', '90 silver', 'junk silver'] },
];

/**
 * Precious-metal grades and the other ways the same purity is stamped. These
 * feed the tsquery expansion: 14k gold is also stamped "585", sterling "925".
 * Kept separate from SYNONYMS because a bare "585" or "925" typed by a user is
 * more likely a model number than a hallmark, so these are one-way expansions.
 */
export const METAL_GRADES: Readonly<Record<string, readonly string[]>> = {
  '10k': ['10kt', '10 karat', '417'],
  '14k': ['14kt', '14 karat', '585'],
  '18k': ['18kt', '18 karat', '750'],
  '22k': ['22kt', '22 karat', '916'],
  '24k': ['24kt', '24 karat'],
  sterling: ['925', 'sterling silver'],
  '.999': ['999', '0.999', 'fine silver'],
};

// ----------------------------------------------------------------- synonyms

/**
 * Equivalence groups for auction vocabulary. Every member expands to all the
 * others in the tsquery form, so "drone" also finds a lot catalogued as
 * "quadcopter". They are deliberately NOT used in the websearch form: see the
 * README for why websearch_to_tsquery cannot express a synonym group safely.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['drone', 'quadcopter', 'uav', 'uas', 'multirotor'],
  ['tv', 'television'],
  ['fridge', 'refrigerator'],
  ['couch', 'sofa'],
  ['laptop', 'notebook'],
  ['phone', 'cellphone', 'cell phone', 'smartphone'],
  ['atv', 'four wheeler', '4 wheeler', 'quad'],
  ['utv', 'side by side', 'sxs'],
  ['skid steer', 'skidsteer', 'skid loader'],
  ['excavator', 'trackhoe', 'track hoe'],
  ['bulldozer', 'dozer', 'crawler'],
  ['forklift', 'fork lift', 'lift truck'],
  ['lawn tractor', 'riding mower', 'riding lawn mower', 'garden tractor'],
  ['lawn mower', 'lawnmower', 'mower'],
  ['snowblower', 'snow blower', 'snowthrower', 'snow thrower'],
  ['chainsaw', 'chain saw'],
  ['toolbox', 'tool box', 'tool chest', 'tool cabinet', 'roll cabinet'],
  ['welder', 'welding machine'],
  ['generator', 'genset'],
  ['pressure washer', 'power washer'],
  ['motorhome', 'motor home', 'rv'],
  ['camper', 'travel trailer'],
  ['motorcycle', 'motorbike'],
  ['bicycle', 'bike'],
  ['pickup', 'pickup truck'],
  ['car', 'automobile'],
  ['dresser', 'chest of drawers', 'bureau'],
  ['armoire', 'wardrobe'],
  ['hutch', 'china cabinet'],
  ['watch', 'wristwatch', 'timepiece'],
  ['computer', 'pc'],
  ['headphones', 'headset', 'earbuds'],
  ['ac', 'air conditioner'],
  ['stove', 'range', 'oven'],
  ['washer', 'washing machine'],
  ['grill', 'bbq', 'barbecue'],
  ['jet ski', 'personal watercraft', 'pwc', 'waverunner', 'wave runner'],
  ['snowmobile', 'snow machine'],
  ['truck cap', 'topper', 'camper shell', 'bed cap'],
  ['rims', 'wheels'],
  ['scope', 'riflescope', 'rifle scope'],
  ['binoculars', 'binos'],
  ['rangefinder', 'range finder'],
  ['gun safe', 'rifle safe', 'firearm safe'],
  ['ammo can', 'ammo box', 'ammunition can'],
  ['replica', 'reproduction', 'repro', 'copy', 'counterfeit', 'fake'],
  ['signed', 'autographed', 'autograph'],
  ['lithograph', 'litho'],
  ['comic', 'comic book'],
  ['4x4', '4wd', 'four wheel drive', '4 wheel drive'],
  ['awd', 'all wheel drive'],
  ['thermal', 'infrared', 'thermal imaging', 'radiometric'],
  ['cordless', 'battery powered', 'battery operated'],
  ['diesel', 'powerstroke', 'duramax', 'cummins', 'tdi'],
  ['mid century', 'midcentury', 'mcm', 'mid century modern'],
  ['penny', 'cent', 'pennies'],
  ['uncirculated', 'unc', 'brilliant uncirculated'],
  ['golf cart', 'golf car'],
  ['go kart', 'go cart', 'gokart'],
  ['sax', 'saxophone'],
  ['fiddle', 'violin'],
  ['pontoon', 'pontoon boat'],
  ['jon boat', 'john boat'],
  ['log splitter', 'wood splitter'],
  ['wood chipper', 'chipper', 'chipper shredder'],
  ['weed eater', 'string trimmer', 'weed whacker', 'weedeater'],
  ['leaf blower', 'backpack blower'],
  ['air compressor', 'compressor'],
  ['pallet jack', 'pallet truck'],
  ['hunting blind', 'ground blind'],
  ['tree stand', 'deer stand', 'ladder stand'],
  ['fish house', 'ice shanty', 'ice house', 'ice shack'],
  ['junk silver', '90 silver', 'constitutional silver'],
  ['flatware', 'silverware', 'cutlery'],
  ['dinnerware', 'dishes'],
  ['record player', 'turntable', 'phonograph'],
  ['ipad', 'tablet'],
  ['hospital bed', 'medical bed'],
  ['wheelchair', 'wheel chair'],
  ['walker', 'rollator'],
  ['mobility scooter', 'power scooter'],
  ['ice machine', 'ice maker'],
  ['fryer', 'deep fryer'],
  ['meat slicer', 'deli slicer'],
  ['reach in', 'reach in cooler'],
  ['kegerator', 'keg cooler'],
  ['lumber', 'timber'],
  ['water heater', 'hot water heater'],
  ['mini split', 'minisplit', 'ductless'],
  ['baler', 'hay baler'],
  ['brush hog', 'bush hog', 'rotary cutter'],
  ['tiller', 'rototiller'],
  ['welding helmet', 'welding hood'],
  ['plasma cutter', 'plasma torch'],
  ['miter saw', 'chop saw', 'mitre saw'],
  ['reciprocating saw', 'sawzall'],
  ['nail gun', 'nailer'],
  ['engine hoist', 'cherry picker', 'engine crane'],
  ['shop press', 'hydraulic press'],
  ['vise', 'vice'],
  ['model train', 'train set', 'toy train'],
  ['doll house', 'dollhouse'],
  ['guitar amp', 'guitar amplifier'],
  ['drum set', 'drum kit'],
  ['exercise bike', 'stationary bike', 'spin bike'],
  ['golf clubs', 'golf club set'],
  ['fishing rod', 'fishing pole'],
  ['wedding ring', 'wedding band'],
  ['painting', 'oil painting'],
  ['sculpture', 'statue'],
  ['first edition', '1st edition'],
  ['collectible', 'collectable'],
  ['jewelry', 'jewellery'],
  ['sneakers', 'tennis shoes'],
  ['purse', 'handbag'],
  ['shipping container', 'conex', 'sea can', 'cargo container'],
  ['pole barn', 'pole building'],
  ['tonneau cover', 'tonneau', 'bed cover'],
  ['tires', 'tyres'],
];

// ------------------------------------------------------------- conditions

/** Phrases that set a condition filter. Multi-word phrases win over single words. */
export const CONDITION_PHRASES: Readonly<Record<Condition, readonly string[]>> = {
  new: [
    'new', 'brand new', 'new in box', 'nib', 'nos', 'new old stock', 'sealed',
    'factory sealed', 'unopened', 'never used', 'unused', 'new with tags', 'nwt',
  ],
  used: ['used', 'pre owned', 'preowned', 'second hand', 'secondhand', 'gently used', 'lightly used'],
  refurbished: [
    'refurbished', 'refurb', 'reconditioned', 'renewed', 'remanufactured', 'reman',
    'rebuilt', 'certified refurbished',
  ],
  parts: [
    'for parts', 'parts only', 'for parts only', 'parts or repair', 'for parts or repair',
    'for repair', 'needs repair', 'needs work', 'not working', 'non working', 'nonworking',
    'doesnt work', 'does not work', 'as is', 'asis', 'broken',
  ],
};

/**
 * Condition words that express a wish but make a bad filter. Sellers do not
 * write "like new" or "working" consistently, so requiring the words would hide
 * good lots, and lots.condition has no value for them. They are acknowledged in
 * the explanation and otherwise ignored.
 */
export const CONDITION_PREFERENCES: readonly string[] = [
  'like new', 'near new', 'near mint', 'mint condition', 'excellent condition',
  'good condition', 'great condition', 'working', 'works', 'tested', 'tested working',
  'fully functional', 'in working order', 'good shape', 'great shape', 'excellent',
];

/**
 * "no X" usually means exclude X, but not for defects: listings that brag "no
 * rust" contain the word rust, so excluding it would hide exactly the lots the
 * buyer wants. These are reported instead of filtered.
 */
export const DEFECT_WORDS: ReadonlySet<string> = new Set([
  'rust', 'damage', 'damages', 'dents', 'dent', 'scratches', 'scratch', 'cracks',
  'crack', 'chips', 'chip', 'stains', 'stain', 'leaks', 'leak', 'issues', 'issue',
  'problems', 'problem', 'rot', 'mold', 'smoke', 'pets', 'odor', 'odors', 'tears',
]);

// ------------------------------------------------------------ source tiers

const GOVERNMENT: readonly SourceTier[] = ['federal', 'state', 'county', 'municipal', 'school'];

/**
 * Seller types. "Government" is not an enum value: it is every public tier.
 * Bare "county", "city", "state" and "school" are too often part of a place or
 * an item ("Door County", "school bus", "state of the art") to count alone.
 */
export const TIER_PHRASES: readonly { phrase: string; tiers: readonly SourceTier[] }[] = [
  { phrase: 'government surplus', tiers: GOVERNMENT },
  { phrase: 'government auction', tiers: GOVERNMENT },
  { phrase: 'government auctions', tiers: GOVERNMENT },
  { phrase: 'government', tiers: GOVERNMENT },
  { phrase: 'govt', tiers: GOVERNMENT },
  { phrase: 'gov', tiers: GOVERNMENT },
  { phrase: 'public agency', tiers: GOVERNMENT },
  { phrase: 'federal surplus', tiers: ['federal'] },
  { phrase: 'federal', tiers: ['federal'] },
  { phrase: 'gsa', tiers: ['federal'] },
  { phrase: 'gsa auctions', tiers: ['federal'] },
  { phrase: 'state surplus', tiers: ['state'] },
  { phrase: 'state agency', tiers: ['state'] },
  { phrase: 'state auction', tiers: ['state'] },
  { phrase: 'state auctions', tiers: ['state'] },
  { phrase: 'state owned', tiers: ['state'] },
  { phrase: 'county surplus', tiers: ['county'] },
  { phrase: 'county auction', tiers: ['county'] },
  { phrase: 'county auctions', tiers: ['county'] },
  { phrase: 'county owned', tiers: ['county'] },
  { phrase: 'county sale', tiers: ['county'] },
  { phrase: 'municipal', tiers: ['municipal'] },
  { phrase: 'municipal surplus', tiers: ['municipal'] },
  { phrase: 'municipality', tiers: ['municipal'] },
  { phrase: 'city surplus', tiers: ['municipal'] },
  { phrase: 'city auction', tiers: ['municipal'] },
  { phrase: 'city auctions', tiers: ['municipal'] },
  { phrase: 'village surplus', tiers: ['municipal'] },
  { phrase: 'town surplus', tiers: ['municipal'] },
  { phrase: 'school surplus', tiers: ['school'] },
  { phrase: 'school district', tiers: ['school'] },
  { phrase: 'school auction', tiers: ['school'] },
  { phrase: 'school auctions', tiers: ['school'] },
  { phrase: 'estate sale', tiers: ['estate'] },
  { phrase: 'estate sales', tiers: ['estate'] },
  { phrase: 'estate auction', tiers: ['estate'] },
  { phrase: 'estate auctions', tiers: ['estate'] },
  { phrase: 'estate liquidation', tiers: ['estate'] },
  { phrase: 'tag sale', tiers: ['estate'] },
  { phrase: 'estate', tiers: ['estate'] },
  { phrase: 'private auction', tiers: ['private'] },
  { phrase: 'private auctions', tiers: ['private'] },
  { phrase: 'private sale', tiers: ['private'] },
  { phrase: 'auction house', tiers: ['private'] },
  { phrase: 'private', tiers: ['private'] },
  { phrase: 'liquidation', tiers: ['wholesale'] },
  { phrase: 'liquidations', tiers: ['wholesale'] },
  { phrase: 'liquidator', tiers: ['wholesale'] },
  { phrase: 'wholesale', tiers: ['wholesale'] },
];

// ---------------------------------------------------------------- sorting

export const SORT_PHRASES: readonly { phrase: string; sort: Exclude<SortKey, 'relevance'> }[] = [
  { phrase: 'closest', sort: 'nearest' },
  { phrase: 'closest first', sort: 'nearest' },
  { phrase: 'nearest', sort: 'nearest' },
  { phrase: 'nearest first', sort: 'nearest' },
  { phrase: 'sort by distance', sort: 'nearest' },
  { phrase: 'by distance', sort: 'nearest' },
  { phrase: 'cheapest', sort: 'cheapest' },
  { phrase: 'cheapest first', sort: 'cheapest' },
  { phrase: 'lowest price', sort: 'cheapest' },
  { phrase: 'lowest priced', sort: 'cheapest' },
  { phrase: 'least expensive', sort: 'cheapest' },
  { phrase: 'price low to high', sort: 'cheapest' },
  { phrase: 'low to high', sort: 'cheapest' },
  { phrase: 'sort by price', sort: 'cheapest' },
  { phrase: 'ending soonest', sort: 'closing' },
  { phrase: 'ends soonest', sort: 'closing' },
  { phrase: 'closing soonest', sort: 'closing' },
  { phrase: 'closes soonest', sort: 'closing' },
  { phrase: 'ending first', sort: 'closing' },
  { phrase: 'closing first', sort: 'closing' },
  { phrase: 'ending next', sort: 'closing' },
  { phrase: 'soonest', sort: 'closing' },
  { phrase: 'newest', sort: 'newest' },
  { phrase: 'newest first', sort: 'newest' },
  { phrase: 'newest listings', sort: 'newest' },
  { phrase: 'newly listed', sort: 'newest' },
  { phrase: 'just listed', sort: 'newest' },
  { phrase: 'recently listed', sort: 'newest' },
  { phrase: 'latest', sort: 'newest' },
  { phrase: 'latest listings', sort: 'newest' },
  { phrase: 'new listings', sort: 'newest' },
  { phrase: 'recently added', sort: 'newest' },
  { phrase: 'new arrivals', sort: 'newest' },
  { phrase: 'hidden gems', sort: 'sleeper' },
  { phrase: 'hidden gem', sort: 'sleeper' },
  { phrase: 'sleepers', sort: 'sleeper' },
  { phrase: 'sleeper deals', sort: 'sleeper' },
  { phrase: 'sleeper picks', sort: 'sleeper' },
  { phrase: 'sleeper lots', sort: 'sleeper' },
  { phrase: 'undervalued', sort: 'sleeper' },
  { phrase: 'overlooked', sort: 'sleeper' },
  { phrase: 'under the radar', sort: 'sleeper' },
  { phrase: 'diamond in the rough', sort: 'sleeper' },
  { phrase: 'diamonds in the rough', sort: 'sleeper' },
];

// ------------------------------------------------------------------ timing

export type TimingWindow = 'today' | 'soon' | 'tomorrow' | 'weekend' | 'week';

/** Closing-time phrases. How each window becomes hours is decided in parse.ts. */
export const TIMING_PHRASES: Readonly<Record<TimingWindow, readonly string[]>> = {
  today: [
    'ending today', 'ends today', 'closing today', 'closes today', 'ending tonight',
    'ends tonight', 'closing tonight', 'closes tonight', 'today', 'tonight',
  ],
  soon: [
    'ending soon', 'ends soon', 'closing soon', 'closes soon', 'about to end',
    'about to close', 'almost over', 'last chance',
  ],
  tomorrow: [
    'ending tomorrow', 'ends tomorrow', 'closing tomorrow', 'closes tomorrow',
    'tomorrow', 'by tomorrow',
  ],
  weekend: [
    'this weekend', 'ending this weekend', 'ends this weekend', 'closing this weekend',
    'closes this weekend', 'by the weekend', 'by this weekend', 'over the weekend', 'weekend',
  ],
  week: ['this week', 'ending this week', 'ends this week', 'closing this week', 'closes this week'],
};

/**
 * Words that follow "in" without naming a place: "in box", "in stock", "in
 * good condition", "in oak". A lowercase word after "in" is only a place
 * candidate when it is none of these.
 */
export const NOT_PLACE_AFTER_IN: ReadonlySet<string> = new Set([
  'box', 'boxes', 'stock', 'hand', 'person', 'store', 'good', 'great', 'excellent',
  'working', 'original', 'new', 'used', 'fair', 'poor', 'mint', 'perfect', 'use',
  'service', 'storage', 'package', 'packaging', 'case', 'bulk', 'pieces', 'pairs',
  'pair', 'color', 'colour', 'black', 'white', 'red', 'blue', 'green', 'yellow',
  'brown', 'gray', 'grey', 'pink', 'purple', 'orange', 'tan', 'beige', 'silver',
  'gold', 'size', 'sizes', 'xl', 'xxl', 'large', 'medium', 'small', 'sm', 'md',
  'lg', 'my', 'our', 'your', 'the', 'a', 'an', 'it', 'there', 'here', 'town',
  'area', 'state', 'stock', 'budget', 'range', 'time', 'shape', 'condition',
  'order', 'person', 'house', 'home', 'garage', 'barn', 'shop', 'transit',
]);

/** Words that may appear inside a place name even though they are stop words. */
export const PLACE_PARTICLES: ReadonlySet<string> = new Set([
  'du', 'de', 'la', 'le', 'les', 'st', 'ste', 'saint', 'fort', 'ft', 'mount',
  'mt', 'port', 'el', 'des', 'lac', 'eau', 'san', 'santa', 'los', 'las',
]);
