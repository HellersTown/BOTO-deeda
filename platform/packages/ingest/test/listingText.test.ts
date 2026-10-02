/**
 * Shared listing-text helpers (src/listingText.ts): contact redaction and city
 * tidying, used by the AuctionGuide and Wisconsin Surplus adapters.
 *
 * The redaction has two failure modes and both are tested. A missed street
 * address keeps a family's home in our rows. A false match garbles an item's own
 * words ("4 Wheel Drive" becoming "(address on the sale page)"), which also
 * hides the item from every search and hunt for those words.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_MARK, PHONE_MARK, redactContacts, tidyCity } from '../src/listingText.ts';

test('street addresses and phone numbers are replaced by a pointer to the sale page', () => {
  const cases: [string, string][] = [
    // Street forms, including Wisconsin's rural grid numbers.
    ['Held at N5678 County Road E, Hillsboro.', `Held at ${ADDRESS_MARK}, Hillsboro.`],
    ['Pickup at W1234 Hwy 33 Beaver Dam', `Pickup at ${ADDRESS_MARK} Beaver Dam`],
    ['E3301 County Rd K, Blanchardville', `${ADDRESS_MARK}, Blanchardville`],
    ['LOCATION: 1234 MAIN STREET, BARABOO', `LOCATION: ${ADDRESS_MARK}, BARABOO`],
    ['at 12B Old Mill Rd. Sparta', `at ${ADDRESS_MARK} Sparta`],
    ['Pickup: 400 N Main St, Wautoma.', `Pickup: ${ADDRESS_MARK}, Wautoma.`],
    ['Estate of the late owner, 123 Lakeview Drive, Sparta', `Estate of the late owner, ${ADDRESS_MARK}, Sparta`],
    ['789 Oak Ridge Dr, Sparta', `${ADDRESS_MARK}, Sparta`],
    ['6201 Door Creek Rd, McFarland', `${ADDRESS_MARK}, McFarland`],
    ['2015 Main St Unit 4', `${ADDRESS_MARK} Unit 4`],
    // A guard word is only a guard in its own place: "State" before "Drive",
    // "Hard" before "Drive", "Front" nowhere.
    ['100 State St, Madison', `${ADDRESS_MARK}, Madison`],
    ['Located at 211 Front St', `Located at ${ADDRESS_MARK}`],
    ['at 55 Hard Rock Ln', `at ${ADDRESS_MARK}`],
    // A period after a full street word ends the sentence and stays; after an
    // abbreviation it is the abbreviation's.
    ['Pickup at 456 Prairie Way.', `Pickup at ${ADDRESS_MARK}.`],
    // Wisconsin Surplus, live 2026-09-30 (#26-1418, City of Platteville).
    ['0.14 +/- Acre Lot w/Up-Down Duplex at 60 Ellen St, Platteville, WI', `0.14 +/- Acre Lot w/Up-Down Duplex at ${ADDRESS_MARK}, Platteville, WI`],
    // Phones.
    ['Call (608) 555-1234 or 1-800-555-1234.', `Call ${PHONE_MARK} or ${PHONE_MARK}.`],
    ['Questions: 920-555-0100', `Questions: ${PHONE_MARK}`],
    // Cut short by the site inside the address.
    ['Preview Saturday at 33243 Oxbow Av...', `Preview Saturday at ${ADDRESS_MARK}…`],
  ];
  for (const [input, want] of cases) assert.equal(redactContacts(input), want, input);
  assert.equal(redactContacts(null), null);
  assert.equal(redactContacts(''), '');
});

test('counts, dates, times, prices and ranges are not addresses', () => {
  for (const keep of [
    '421 lots, Greenleaf, WI',
    'Over 700 items including tools, 2 beautiful lake homes.',
    'MONDAY, OCTOBER 5, 2026 - 9:00 A.M. to 2:00 P.M.',
    'Lots 1-200 St. Croix Falls; $5 Street signs',
    'Snap On, Matco, Mac, Fluke, Dewalt',
    'Over 400 lots...',
    'Ends 2026-10-05',
    '50 Ct Box of Gloves',
  ]) {
    assert.equal(redactContacts(keep), keep, keep);
  }
});

test('item descriptions keep their own words: units, drive types, two-way radios, boulevard mowers', () => {
  for (const keep of [
    // Wisconsin Surplus, live 2026-09-30.
    "2020 Hawk 36' Triple Axle Enclosed Mobile Command Trailer",
    '2003 Ford F450 Super Duty Diesel Reg Cab 4WD Baby Dump Truck w/ Plow',
    '126 Lots (2 Pages of Inventory) Including: Trailers, Mowers, Shipping Containers, Attachments, Welders',
    // A unit or a count noun after the number.
    '(4) 16 ft Ag Drive Over Ramps',
    '2010 International 7400 Plow Truck, 10 ft Blvd Mower',
    '2 TB Hard Drive',
    'Dell Latitude 5420 Laptop 256 GB Solid State Drive',
    'Craftsman 42 inch Belt Drive Mower',
    '(2) 48 inch Drive Wheels',
    '2008 Ford F350 4 Wheel Drive',
    '2014 Chevy 2500 HD 4 Wheel Drive w/ 8 ft Boss Plow',
    'Kubota 2 Speed Drive',
    '2 Place Snowmobile Trailer',
    '3 Point Hitch 6 ft Finish Mower',
    // The word before "Drive" or "Way".
    'John Deere 4020 Front Wheel Drive',
    'Toro 22 Self Propelled Rear Wheel Drive Mower',
    'Dell OptiPlex 7010 Hard Drive',
    'Lot of 12 Motorola Two Way Radios',
    'Motorola XTS 2500 Two Way Radio',
    // An item noun after the suffix.
    'Ford 3000 Gear Drive Tractor',
    '2010 Toro Groundsmaster Blvd Mower',
    '2005 Ford Road Tractor',
    '2012 Polaris Ranger Off Road Vehicle',
    '1985 Champion 720 Road Grader',
    '2011 Elgin Pelican Street Sweeper',
    // No street name between the number and the word.
    '2015 Ford Fusion 4 Dr Sedan',
    'Lot of 12 Motorola 2 Way Radios',
    '2 Court Benches and 1 Way Finder Sign',
  ]) {
    assert.equal(redactContacts(keep), keep, keep);
  }
});

test('a city typed in one case is title-cased; mixed case is the source\'s own', () => {
  assert.equal(tidyCity('nekoosa'), 'Nekoosa');
  assert.equal(tidyCity('BALDWIN'), 'Baldwin');
  assert.equal(tidyCity('FOND DU LAC'), 'Fond du Lac');
  assert.equal(tidyCity('prairie du chien'), 'Prairie du Chien');
  assert.equal(tidyCity('LA CROSSE'), 'La Crosse');
  assert.equal(tidyCity('MCFARLAND'), 'McFarland');
  assert.equal(tidyCity("o'dell"), "O'dell");
  assert.equal(tidyCity('DeForest'), 'DeForest');
  assert.equal(tidyCity('St. Croix Falls'), 'St. Croix Falls');
  assert.equal(tidyCity('MOUNT HOREB'), 'Mount Horeb');
  assert.equal(tidyCity(null), null);
});
