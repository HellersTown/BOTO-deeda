import { describe, expect, it } from 'vitest';
import { elsewhereLinks, elsewhereWords, nearestCraigslist, siteRadius, type ElsewhereSource } from './elsewhere';

// The three templates production holds (sources.search_template).
const SOURCES: ElsewhereSource[] = [
  {
    slug: 'facebook-marketplace',
    name: 'Facebook Marketplace',
    searchTemplate: 'https://www.facebook.com/marketplace/{location}/search?query={query}&maxPrice={max_price}',
  },
  {
    slug: 'craigslist',
    name: 'Craigslist',
    searchTemplate: 'https://{region}.craigslist.org/search/sss?query={query}&max_price={max_price}',
  },
  { slug: 'hibid', name: 'HiBid', searchTemplate: 'https://hibid.com/lots?q={query}&zip={postal}&miles={radius:25,50,100,250,500}' },
];

// 53916, Beaver Dam WI, at its gazetteer centroid.
const BEAVER_DAM = { zip: '53916', lat: 43.4578, lon: -88.8373 };

describe('the same search on other sites', () => {
  it('fills each template with the words, the price cap and the nearest Craigslist site', () => {
    const links = elsewhereLinks(SOURCES, { words: 'computer', maxCents: 50000, origin: BEAVER_DAM, radiusMiles: 100 });
    expect(links.map((l) => l.href)).toEqual([
      'https://www.facebook.com/marketplace/search?query=computer&maxPrice=500',
      'https://madison.craigslist.org/search/sss?query=computer&max_price=500&postal=53916&search_distance=100',
      'https://hibid.com/lots?q=computer&zip=53916&miles=100',
    ]);
    expect(links.map((l) => l.place)).toEqual([null, 'Madison', null]);
  });

  it('drops the price parameter when there is no cap, and encodes the words', () => {
    const links = elsewhereLinks(SOURCES, { words: 'john deere 3032e', maxCents: null, origin: BEAVER_DAM, radiusMiles: 60 });
    expect(links[0]?.href).toBe('https://www.facebook.com/marketplace/search?query=john+deere+3032e');
    expect(links[1]?.href).toBe(
      'https://madison.craigslist.org/search/sss?query=john+deere+3032e&postal=53916&search_distance=60',
    );
  });

  it('leaves Craigslist out when the search has no place, and leaves out the distance when it is "anywhere"', () => {
    const none = elsewhereLinks(SOURCES, { words: 'generator', maxCents: null, origin: null, radiusMiles: null });
    expect(none.map((l) => l.key)).toEqual(['facebook-marketplace', 'hibid']);
    const anywhere = elsewhereLinks(SOURCES, { words: 'generator', maxCents: null, origin: BEAVER_DAM, radiusMiles: null });
    expect(anywhere[1]?.href).toBe('https://madison.craigslist.org/search/sss?query=generator');
    // HiBid keeps the place and searches every distance.
    expect(anywhere[2]?.href).toBe('https://hibid.com/lots?q=generator&zip=53916');
    expect(none[1]?.href).toBe('https://hibid.com/lots?q=generator');
  });

  it("rounds the radius up to a distance the site offers, and drops it beyond the widest", () => {
    const at = (radiusMiles: number) =>
      elsewhereLinks(SOURCES, { words: 'bookshelf', maxCents: null, origin: BEAVER_DAM, radiusMiles })[2]?.href;
    expect(at(50)).toBe('https://hibid.com/lots?q=bookshelf&zip=53916&miles=50');
    expect(at(60)).toBe('https://hibid.com/lots?q=bookshelf&zip=53916&miles=100');
    expect(at(10)).toBe('https://hibid.com/lots?q=bookshelf&zip=53916&miles=25');
    expect(at(800)).toBe('https://hibid.com/lots?q=bookshelf&zip=53916');
    expect(siteRadius(37.6, '{radius}')).toBe(38);
    expect(siteRadius(50, '{radius:x}')).toBeNull();
    expect(siteRadius(null, '{radius:25,50}')).toBeNull();
  });

  it("fills an eBay local-pickup search around the buyer's ZIP", () => {
    const ebay: ElsewhereSource = {
      slug: 'ebay',
      name: 'eBay',
      searchTemplate:
        'https://www.ebay.com/sch/i.html?_nkw={query}&_udhi={max_price}&LH_LPickup=1&_stpos={postal}&_sadis={radius}&LH_PrefLoc=99&_fspt=1',
    };
    const [link] = elsewhereLinks([ebay], { words: 'oak bookshelf', maxCents: 7500, origin: BEAVER_DAM, radiusMiles: 50 });
    expect(link?.href).toBe(
      'https://www.ebay.com/sch/i.html?_nkw=oak+bookshelf&_udhi=75&LH_LPickup=1&_stpos=53916&_sadis=50&LH_PrefLoc=99&_fspt=1',
    );
  });

  it('makes no links without words, and skips a template it cannot fill', () => {
    expect(elsewhereLinks(SOURCES, { words: '  ', maxCents: null, origin: BEAVER_DAM, radiusMiles: 50 })).toEqual([]);
    const odd: ElsewhereSource[] = [
      { slug: 'a', name: 'No query', searchTemplate: 'https://example.com/search' },
      { slug: 'b', name: 'Not https', searchTemplate: 'http://example.com/?q={query}' },
      { slug: 'c', name: 'In the path', searchTemplate: 'https://example.com/s/{query}' },
    ];
    expect(elsewhereLinks(odd, { words: 'a b', maxCents: null, origin: null, radiusMiles: null }).map((l) => l.href)).toEqual([
      'https://example.com/s/a%20b',
    ]);
  });

  it('picks the Craigslist site by distance, and none far from every listed site', () => {
    expect(nearestCraigslist({ lat: 44.52, lon: -88.02 })?.slug).toBe('greenbay');
    expect(nearestCraigslist({ lat: 43.04, lon: -87.91 })?.slug).toBe('milwaukee');
    expect(nearestCraigslist({ lat: 46.8, lon: -92.1 })?.slug).toBe('duluth');
    expect(nearestCraigslist({ lat: 39.74, lon: -104.99 })).toBeNull(); // Denver
    expect(nearestCraigslist(null)).toBeNull();
  });

  it('hands over the words without exclusions or quotes', () => {
    expect(elsewhereWords('ford "f-150" 4x4 -parts')).toBe('ford f-150 4x4');
    expect(elsewhereWords('truck -"power steering" -rust')).toBe('truck');
    expect(elsewhereWords('"john deere" 3032e')).toBe('john deere 3032e');
    expect(elsewhereWords('')).toBe('');
  });
});
