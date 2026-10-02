# 07 — Wisconsin source inventory

Every public auction and estate-sale seller we could tie to a platform, for Wisconsin plus the border. Adapters are written **per platform**, so the key facts for each seller are *which platform it lists on* and *its identifier there*.

- **Data file:** `platform/supabase/seed/wisconsin_sources.json` — 181 rows: **171 seller entities** plus **10 platform-scope entry points** (one per platform: the platform's Wisconsin landing page, not a seller). Fields are exactly `name, tier, platform, platform_id, website, city, state, zip, evidence_url, confidence`.
- **Researched:** 2026-09-27. Scope: federal, state, county, municipal, school, private and estate. Wholesale is parked (see §9).
- **Nothing here authorises crawling.** Load these rows the way `sources.sql` loads its rows: robots unchecked and `verified = false`. Promote each row by hand.

---

## 1. Read this first: how the evidence was gathered

- **No page could be loaded directly.** WebFetch was refused by the egress proxy for every domain tried: hibid.com, auctionzip.com, estatesales.net, publicsurplus.com, wisconsinsurplus.com, doa.wi.gov, gotoauction.com, tractorzoom.com, wisconsinauctioneers.org and govauctions.app. Every relationship below therefore comes from **web-search results**: the result's URL and title, plus the search tool's summary of that page.
- **The search budget ran out.** The session-wide WebSearch cap (200 calls, shared with other work in this session) was reached after about 46 queries for this task. Research stopped there. That is why the private, estate, non-GSA federal and border sections are thin. §8 lists exactly what is missing and what to unblock.
- **Confidence levels:**
  - `high`: a platform URL that itself identifies the seller (a seller page, an orgid listing, a company page, a named subdomain, or an auction titled with the seller's name), or the seller's own website naming the platform.
  - `medium`: the relationship comes from a summary of a page (the Public Surplus agency list, or the seller list of a multi-seller auction); or a slug was seen but its display name was not; or the earlier session confirmed it in `01-sources.md` and it was not re-checked.
  - `low`: **not confirmed this session.** Do not activate a low row without checking it first.
- **Location rule.** `city`/`state`/`zip` are filled only where the evidence showed them, or where the place is the entity's own jurisdiction (a county's seat, a village's own name). Names such as *Titletown* or *Wausau Auctioneers* were **not** used to infer a city. This is the Beloit-WI versus Beloit-KS trap from `01-sources.md`. For federal and platform-scope rows, `state` is the pickup scope (WI), not a headquarters.

## 2. Summary

### Seller entities by tier

| Tier | Entities | high | medium | low |
|---|---|---|---|---|
| federal | 9 | 1 | 2 | 6 |
| state | 20 | 14 | 4 | 2 |
| county | 38 | 29 | 7 | 2 |
| municipal | 45 | 11 | 32 | 2 |
| school | 26 | 18 | 7 | 1 |
| private | 30 | 7 | 9 | 14 |
| estate | 3 | 0 | 0 | 3 |
| **total** | **171** | **80** | **61** | **30** |

`school` covers K-12 districts and the 16 Wisconsin Technical College System districts, which are local special-purpose districts. UW System campuses are state agencies, so they are counted under `state`. Sheriffs and highway departments are `county`. Fire, police and library departments are `municipal`.

### Seller entities by platform

| Platform | Entities | high | medium | low | Tiers served |
|---|---|---|---|---|---|
| Wisconsin Surplus | 62 | 44 | 15 | 3 | state, county, municipal, school, private |
| Public Surplus | 48 | 11 | 34 | 3 | state, county, municipal, school |
| HiBid | 21 | 5 | 6 | 10 | private |
| GovDeals | 16 | 15 | 0 | 1 | state, county, municipal, school |
| custom | 13 | 2 | 4 | 7 | federal, state, county, private |
| GSA Auctions | 3 | 1 | 0 | 2 | federal |
| K-BID | 3 | 0 | 2 | 1 | private, estate |
| Proxibid | 2 | 2 | 0 | 0 | county, private |
| MaxSold | 2 | 0 | 0 | 2 | estate |
| AuctionZip | 1 | 0 | 0 | 1 | private |

No seller entities were found for: Municibid, AllSurplus, BidSpotter, Purple Wave, EstateSales.net, EstateSales.org, AuctionNinja, CTBids. Of these, Municibid, AllSurplus, Purple Wave, EstateSales.net and EstateSales.org appear only as platform-scope rows (§6.8).

### Key findings

1. **The State of Wisconsin uses three channels, not one.** (a) **GovDeals**: the DOA Surplus Property Program page says *"the state has a contract for online auctions with GovDeals"*, and DNR sells there as `widnr`. (b) **Wisconsin Surplus**: it calls itself a contracted vendor of DOA, and runs the recurring *State & Municipal Vehicle* auctions plus sales for DNR, Revenue (unclaimed and seized property), Corrections, DHS, two UW campuses and six technical colleges. (c) **Public Surplus**: a *State of Wisconsin Group* account (orgid 994864) plus five UW campuses and two technical colleges. UW-Madison SWAP also runs its own auction site. See §5.
2. **Wisconsin Surplus (a private company in Mount Horeb) is the de facto county channel.** 11 county sheriff's offices, 10 county highway departments and the Kewaunee and Waukesha county purchasing offices sell there: **22 counties in all**. So do the cities of Milwaukee, Madison, Janesville and Kenosha, and 6 school districts. Auction numbers such as `#25-1882` imply roughly 1,900 sale events in 2025 across WI, IL, MI, IA and MN.
3. **Public Surplus is the long tail:** 10 villages, 5 towns, 7 school districts, 9 county agencies, 8 city agencies and a fire department (3 of these rows are `low`), plus the state group, 5 UW campuses and 2 technical colleges. It is also the cheapest government adapter, because every agency has an `orgid` list page.
4. **Big local governments split across platforms.** City of Milwaukee: Wisconsin Surplus and Public Surplus. City of Madison: both. Waukesha County: both. Brown County: Wisconsin Surplus and GovDeals. Milwaukee County holds live fleet auctions whose catalog runs on **Proxibid** through Auction Associates Inc. Dane County sells tax-deeded land by sealed bid on its own site. **Dedupe on lots, not on sellers**, because one seller can feed three adapters.
5. **Private houses: HiBid lists 77 Wisconsin companies** in its own Wisconsin company search. Only 21 HiBid tenants were captured before the search budget ran out, and 9 of those still have no confirmed location.
6. **Federal:** GSA (already integrated) carries most federal personal property with WI pickups (18 open WI lots in an aggregator snapshot). HUD and USDA sell real estate only. Treasury, USMS, IRS, USACE and VA are listed but **unverified** (`low`).
7. **Municibid and AllSurplus** both have Wisconsin landing pages, but **no Wisconsin seller was confirmed** on either. Build them last.
8. **Estate sales are essentially unenumerated.** Only MaxSold (owner lead, unverified) and a K-BID estate affiliate are listed. This is the largest gap after the HiBid tail.

## 3. Adapter build order: platforms ranked by Wisconsin coverage

Ranked by the Wisconsin inventory each adapter unlocks: sellers × activity, adjusted for tier breadth. Engineering cost is noted but only breaks ties.

| Rank | Platform | WI sellers in this inventory | Platform-level WI figure (where shown) | Tiers | Seller identifier | Notes |
|---|---|---|---|---|---|---|
| 0 | **GSA Auctions** | 3 (2 are low) | 18 open WI lots (aggregator snapshot) | federal | none needed; filter `PropertyState=WI` | Already integrated. |
| 1 | **HiBid** | 21, plus a scope row | **77 Wisconsin companies** (hibid.com/wisconsin/companysearch) | private (incl. estate-style sales) | tenant subdomain, or `hibid.com/company/{id}`; white-label hosts such as `bids.beloitauction.com` | Largest private coverage and the highest lot volume. One adapter covers every tenant and white-label domain. |
| 2 | **Wisconsin Surplus** | **62** | "hundreds of state & local government agencies" (company); about 1,900 auction events in 2025 (auction numbering) | state, county, municipal, school, private | **none**: sellers appear only in auction titles | Broadest *government* coverage in the state: the DOA contract, 22 counties' sheriff, highway or purchasing offices, Milwaukee and Madison. Harder to build: opaque tokens and multi-seller auctions (see §4). |
| 3 | **GovDeals** | 16, plus a scope row | 93 active WI listings; **116 of 189** open WI government lots (aggregator snapshot) | state, county, municipal, school | slug (`/en/{slug}`) or account id | Holds the statewide DOA contract and has the most active WI government lots of any platform in the aggregator. The code carries over to AllSurplus. |
| 4 | **Public Surplus** | **48**, plus a scope row | 29-30 active WI listings (aggregator snapshot) | state, county, municipal, school | `{slug},wi` plus numeric `orgid` | Most confirmed agencies but fewer live lots. Cheapest government adapter: `list/current?orgid=` per agency. Can be built in parallel with GovDeals. |
| 5 | **K-BID** | 3, plus a scope row | Wisconsin list page exists; count not shown | private, estate | affiliate id | Northwest WI and St. Croix valley, plus Twin Cities border inventory. Household, estate and equipment. |
| 6 | **Proxibid** | 2 | — | county, private | company path segment | Milwaukee County fleet auctions (Auction Associates). Equipment-heavy houses. |
| 7 | **Purple Wave** | scope row only | 11 of 189 open WI government lots (aggregator snapshot) | mixed | — | Ag and construction, no reserve. Consignors are anonymous. |
| 8 | **EstateSales.net** | scope row only | not reached | estate | company id (not captured) | Category leader for estate sales. Its WI directory is the top estate gap. |
| 9 | **MaxSold** | 2 (low) | — | estate | — | Milwaukee and Madison per owner lead; unverified. |
| 10 | **CTBids** | 0 | — | estate | — | Caring Transitions franchises. WI franchises not enumerated. |
| 11 | **EstateSales.org** | scope row only | WI listings confirmed earlier (01-sources.md) | estate | — | |
| 12 | **AllSurplus** | scope row only | WI page exists | private | as GovDeals | Reuse the GovDeals adapter (both are Liquidity Services). |
| 13 | **Municibid** | scope row only | WI region `R3777846` exists | municipal | seller handle | No WI seller found. Its sellers are overwhelmingly in the Northeast. |
| 14 | **BidSpotter, AuctionNinja** | 0 | — | — | — | No Wisconsin evidence found. |
| — | **AuctionZip** | 1 (low), plus a scope row | directory | private | auctioneer id | **Discovery only**: use it to find houses, then ingest from the platform they actually bid on. |
| — | **custom** | 13 | — | all | host/path | One-off sites. The only one worth a bespoke adapter soon is **UW-Madison SWAP** (`swapauction.wisc.edu`, 25+ new listings each weekday). The rest are real estate (HUD, USDA, WisDOT land, Dane County tax deeds) or out-of-enum platforms (Invaluable, LiveAuctioneers, Mecum, GovPlanet). |

**Why this order.**

- **HiBid comes first after GSA** because it has the largest *known* roster of Wisconsin auction companies (77), and their auctions are frequent and lot-dense. It is the main channel for the private tier the product most needs. A single adapter also serves white-label domains.
- **Wisconsin Surplus comes second** because it covers the most *government* tiers at once: state, 22 counties, the two largest cities and schools. It ranks below HiBid only on lot volume and build cost. If government breadth matters more than lot count at launch, swap ranks 1 and 2.
- **GovDeals comes before Public Surplus** on live lots (roughly 4x) and because it holds the state's contract. Public Surplus has more *confirmed* agencies, but those agencies are small, which shows in its low active-lot count. Both are cheap, so build them back to back.
- **K-BID, then Proxibid, then Purple Wave** because each has narrower but real Wisconsin inventory.
- **The estate platforms rank low only because nothing was enumerated.** Enumerating them is the first research job once the budget is raised. EstateSales.net will probably jump to rank 3 or 4 once its WI company count is known.

## 4. `platform_id` conventions

| Platform | Format | Example |
|---|---|---|
| hibid | tenant subdomain; `company:{id}` when only the `hibid.com/company/{id}` id is known; the full host for white-label tenants | `auctionwi`, `company:145740`, `bids.beloitauction.com` |
| govdeals | seller slug from `govdeals.com/en/{slug}`; `acct:{id}` when only the id from `/content/termsandconditions/{id}` is known | `widnr`, `acct:12488` |
| publicsurplus | agency path `{slug},wi`; `orgid:{n}` when only the org id is known. Where both were seen, the orgid is in the evidence URL (`list/current?orgid=`) | `uwmadison,wi`, `orgid:1036892` |
| kbid | `affiliate:{id}` from `/affiliate-profile/detail/{id}` | `affiliate:175007` |
| proxibid | company path segment | `Auction-Associates-Inc` |
| wisconsinsurplus | always `null`. **The platform exposes no seller id.** Sellers appear only as the auction-title prefix (`#25-1618 - Washington County Sheriff's Office - West Bend, Wisconsin`), and multi-seller auctions (`Multi-Municipal`, `UW System/Wisconsin Technical College`) mix sellers within one sale, so the seller must be parsed per lot. This adds to the external_id problem already flagged in `01-sources.md`. | — |
| custom | host or host/path of the seller's own sale site | `swapauction.wisc.edu` |
| scope rows | the platform's own Wisconsin scope key | `wisconsin`, `all,wi`, `R3777846` |

## 5. State of Wisconsin: how each part disposes of surplus

| Unit | Channel(s) found | Confidence | Evidence |
|---|---|---|---|
| DOA Surplus Property Program (statewide) | **GovDeals** statewide online-auction contract; vehicles now sold online only | high | [DOA program page](https://doa.wi.gov/Pages/StateEmployees/SurplusPropProgram.aspx) |
| DOA / state fleet | **Wisconsin Surplus**: recurring *State and Municipal Vehicle* and *State & Municipal Equipment* auctions (#25-642, #25-1122, #25-478) | high | [WS #25-1122](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=EO%2BDha87w6I6FZw4XA/PqA%3D%3D&Title=9PZgamUvKN/uyQscQeNkM0LhGvrob9xRCYrw5gI9MC2r%2BL64wHRujkXrajOzGljgFPQCaRrR3fVpzbAMt0J6Bfzg0JU58TJovDTzndRDRzs%3D&AuctionTypes=k%2BUhcTfuQEhHzOOCDAEwUGYDb0RYwKDxpZrLTeWVdVc%3D&totalItems=eM2qGtWsDERQZRqe0NOHEQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) |
| State agencies (group) | **Public Surplus**: *State of Wisconsin Group*, orgid 994864 | high | [PS orgid 994864](https://m.publicsurplus.com/sms/wisconsindoa,wi/list/current?orgid=994864) |
| DNR | **GovDeals** (`widnr`) **and Wisconsin Surplus** (#25-420; off-road fleet #22-1032, #22-1048) | high | [GovDeals](https://www.govdeals.com/en/widnr), [WS #25-420](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=mwOfOruWf3ovk6GINKsf8A%3D%3D&Title=jCTx95UtqpVdBTG0VHKk8bueBgqvTOuhOwZH5/ebwJy2a8CA96U6xx8Gepo8oSyGfh5kuSkgILf4xqeoMASR5po91egjabFo8b7p1JbAAi4%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) |
| WisDOT | Surplus **land**: per-region pages on wisconsindot.gov. **Fleet and equipment**: not confirmed; presumably the DOA contract vendors | medium / low | [WisDOT land sales (NW)](https://wisconsindot.gov/Pages/doing-bus/real-estate/landsales/landsales-nw.aspx) |
| Revenue (DOR) | **Wisconsin Surplus**: unclaimed-property and seized-items auctions | high | [WS #24-1226](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=1xgeRPsl3ldIOX7Yiu0z0w%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |
| Corrections (DOC) | **Wisconsin Surplus**: Jackson Correctional Institution (#25-1088). Badger State Industries (BCE) items reported there but not confirmed | high / low | [WS #25-1088](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=N6DsSDkgoh5PdBBZl0LSTg%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |
| Health Services (DHS) | **Wisconsin Surplus**: Winnebago Mental Health Institute (in #23-119) | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |
| UW-Madison | **Own site** (SWAP, `swapauction.wisc.edu`) **and Public Surplus** (`uwmadison,wi`) | high | [SWAP auction](https://swapauction.wisc.edu/About), [PS](https://www.publicsurplus.com/sms/uwmadison,wi/list/current?orgid=1015233) |
| UW-Milwaukee | **GovDeals** (`uwmilwaukeesurplus`) | high | [GovDeals](https://www.govdeals.com/uwmilwaukeesurplus) |
| UW-Green Bay, UW-Eau Claire, UW-Parkside, UW-Whitewater | **Public Surplus** | high / medium | [UWGB](https://m.publicsurplus.com/sms/uwgb,wi/list/current?orgid=97512), [UWEC](https://www.publicsurplus.com/sms/uwec,wi/list/current?orgid=83394) |
| UW-Stevens Point, UW-La Crosse | **Wisconsin Surplus**: *UW System/Wisconsin Technical College* multi-location auctions | high | [WS #25-1011](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyTr01VH832WJAz%2BqeNTfw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) |
| Other UW universities (Oshkosh, Platteville, River Falls, Stout, Superior) and branch campuses | not confirmed | — | — |
| WTCS colleges | **Wisconsin Surplus**: MATC, Northwood, WCTC, Gateway, Southwest, Western. **Public Surplus**: NWTC, Fox Valley. Not confirmed: Blackhawk, Chippewa Valley, Lakeshore, Madison College, Mid-State, Moraine Park, Nicolet, Northcentral | high | §6.3 |

The DOA also runs the *federal* surplus donation program (the State Agency for Surplus Property). It donates to eligible organisations and does not sell to the public, so it is excluded.

## 6. Per-tier tables

Rows are sorted by platform, then confidence. `WS` is Wisconsin Surplus, `PS` is Public Surplus and `GD` is GovDeals.

### 6.1 Federal (9)

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | GSA Auctions (federal agencies, Wisconsin pickup lots) | GSA Auctions | — | WI | high | [govauctions.app WI (18 GSA lots)](https://govauctions.app/auctions/wisconsin) | Already integrated through the official API; filter on PropertyState=WI (pickup), not LocationST. An aggregator snapshot showed 18 open WI lots. Army Corps, VA and most civilian agencies sell here. |
| 2 | U.S. Army Corps of Engineers, St. Paul and Detroit Districts (Wisconsin sites) | GSA Auctions | — | WI | low | — | NOT VERIFIED. USACE personal property sells through GSA Auctions, so the GSA adapter should already capture it. St. Paul District runs the Mississippi locks and dams on the WI border; Detroit District runs the WI Great Lakes harbors. |
| 3 | U.S. Department of Veterans Affairs (Milwaukee, Madison, Tomah medical centers) | GSA Auctions | — | WI | low | — | NOT VERIFIED. VA surplus personal property sells through GSA Auctions. VA-acquired homes are sold separately by a contractor; verify which one is current. |
| 4 | GovPlanet (DLA Disposition Services rolling stock and other government surplus) | custom | `govplanet.com` | WI | medium | [govplanet.com WI page](https://www.govplanet.com/Government+Surplus/Wisconsin) | GovPlanet (Ritchie Bros/IronPlanet) keeps a Wisconsin government-surplus page. Ex-military rolling stock from DLA sells here. GovPlanet is not in the platform enum, so it is recorded as 'custom'. |
| 5 | HUD Home Store (HUD-owned homes in Wisconsin) | custom | `hudhomestore.gov` | WI | medium | [govauctions.app Milwaukee County](https://govauctions.app/research/what-your-county-is-selling/wisconsin/milwaukee-county) | Real estate only (out of scope for v1 per 01-sources.md). An aggregator lists HUD as a Milwaukee County seller (5 lots). |
| 6 | IRS Auctions (property seized for unpaid tax) | custom | `irsauctions.gov` | — | low | — | NOT VERIFIED. Nationwide list; Wisconsin items are sporadic. |
| 7 | U.S. Marshals Service asset forfeiture sales | custom | — | — | low | — | NOT VERIFIED. USMS sells through contractors and GSA. Covers the Eastern and Western Districts of Wisconsin. Confirm the current sales page. |
| 8 | U.S. Treasury seized property auctions (TEOAF) | custom | — | — | low | — | NOT VERIFIED this session. Historically run by contractor CWS Marketing & Finance Group. Confirm the current host and whether WI-located lots appear. |
| 9 | USDA Rural Development single-family housing resales | custom | `resales.usda.gov` | WI | low | — | NOT VERIFIED. Real estate only. |

### 6.2 State (20)

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | University of Wisconsin-Milwaukee Surplus | GovDeals | `uwmilwaukeesurplus` | Milwaukee, WI | high | [govdeals.com/uwmilwaukeesurplus](https://www.govdeals.com/uwmilwaukeesurplus) | Largest Milwaukee County seller in the aggregator snapshot (23 lots). |
| 2 | Wisconsin Department of Administration, State Surplus Property Program (statewide online-auction contract) | GovDeals | — | Madison, WI | high | [doa.wi.gov program page](https://doa.wi.gov/Pages/StateEmployees/SurplusPropProgram.aspx) | The DOA program page says the state has a contract for online auctions with GovDeals and that surplus vehicles are now sold exclusively online. Agencies list under their own GovDeals seller accounts (e.g. widnr). VendorNet has an 'Online Auction Services' contract user guide effective 11-25-2024. |
| 3 | Wisconsin Department of Natural Resources / Wildlife | GovDeals | `widnr` | Madison, WI | high | [govdeals.com/en/widnr](https://www.govdeals.com/en/widnr) |  |
| 4 | State of Wisconsin Group | Public Surplus | `wisconsindoa,wi` | Madison, WI | high | [PS orgid 994864](https://m.publicsurplus.com/sms/wisconsindoa,wi/list/current?orgid=994864) | orgid 994864. Group account for state agencies. |
| 5 | University of Wisconsin-Eau Claire | Public Surplus | `uwec,wi` | Eau Claire, WI | high | [PS orgid 83394](https://www.publicsurplus.com/sms/uwec,wi/list/current?orgid=83394) | orgid 83394. |
| 6 | University of Wisconsin-Green Bay | Public Surplus | `uwgb,wi` | Green Bay, WI | high | [PS orgid 97512](https://m.publicsurplus.com/sms/uwgb,wi/list/current?orgid=97512) | orgid 97512. |
| 7 | University of Wisconsin-Madison | Public Surplus | `uwmadison,wi` | Madison, WI | high | [PS orgid 1015233](https://www.publicsurplus.com/sms/uwmadison,wi/list/current?orgid=1015233) | orgid 1015233. |
| 8 | University of Wisconsin-Parkside | Public Surplus | — | Kenosha, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Appears in the Public Surplus Wisconsin agency list; slug not captured. |
| 9 | University of Wisconsin-Whitewater | Public Surplus | — | Whitewater, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Appears in the Public Surplus Wisconsin agency list; slug not captured. |
| 10 | State of Wisconsin DOA fleet: State & Municipal Vehicle and Equipment auctions | Wisconsin Surplus | — | Mount Horeb, WI 53572 | high | [WS #25-1122](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=EO%2BDha87w6I6FZw4XA/PqA%3D%3D&Title=9PZgamUvKN/uyQscQeNkM0LhGvrob9xRCYrw5gI9MC2r%2BL64wHRujkXrajOzGljgFPQCaRrR3fVpzbAMt0J6Bfzg0JU58TJovDTzndRDRzs%3D&AuctionTypes=k%2BUhcTfuQEhHzOOCDAEwUGYDb0RYwKDxpZrLTeWVdVc%3D&totalItems=eM2qGtWsDERQZRqe0NOHEQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) | Recurring 'State and Municipal Vehicle Auction' (#25-642, #25-1122) and 'April State & Municipal Equipment' (#25-478). Wisconsin Surplus describes itself as a contracted vendor of the State of Wisconsin DOA for online auctions (since 2003). |
| 11 | University of Wisconsin-La Crosse | Wisconsin Surplus | — | La Crosse, WI | high | [WS #25-1011](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyTr01VH832WJAz%2BqeNTfw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Seller in the UW System/WTCS multi-location auctions (#25-331, #25-1011). |
| 12 | University of Wisconsin-Stevens Point Surplus Store | Wisconsin Surplus | — | Stevens Point, WI | high | [WS #25-1011](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyTr01VH832WJAz%2BqeNTfw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Seller in the recurring 'UW System/Wisconsin Technical College - Multi-Location' auctions (#25-118, #25-331, #25-885, #25-1011). |
| 13 | Wisconsin Department of Corrections, Jackson Correctional Institution | Wisconsin Surplus | — | Black River Falls, WI | high | [WS #25-1088](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=N6DsSDkgoh5PdBBZl0LSTg%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |  |
| 14 | Wisconsin Department of Natural Resources | Wisconsin Surplus | — | Madison, WI | high | [WS #25-420](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=mwOfOruWf3ovk6GINKsf8A%3D%3D&Title=jCTx95UtqpVdBTG0VHKk8bueBgqvTOuhOwZH5/ebwJy2a8CA96U6xx8Gepo8oSyGfh5kuSkgILf4xqeoMASR5po91egjabFo8b7p1JbAAi4%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) | Titled '#25-420 Wisconsin Department of Natural Resources'; also '#22-1032' and '#22-1048 ... Offroad Fleet Vehicles'. DNR uses both GovDeals and Wisconsin Surplus. |
| 15 | Wisconsin Department of Revenue (unclaimed property and seized items) | Wisconsin Surplus | — | Madison, WI | high | [WS #24-1226](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=1xgeRPsl3ldIOX7Yiu0z0w%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) | Unclaimed-property auctions (#24-1226, #211025) and tax-seized items (#211022). Likely coins and jewelry. |
| 16 | Wisconsin DHS, Winnebago Mental Health Institute | Wisconsin Surplus | — | Winnebago, WI | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | Named as a seller in multi-municipal auction #23-119. |
| 17 | Wisconsin DOC Bureau of Correctional Enterprises (Badger State Industries) | Wisconsin Surplus | — | WI | low | — | A search summary said BCE/Badger State Industries items appear in Wisconsin Surplus sales, but no auction URL was captured. Verify. |
| 18 | Wisconsin Department of Transportation, fleet and equipment | Wisconsin Surplus | — | WI | low | — | Inferred, not confirmed. State fleet disposal runs through the DOA contract vendors, but no WisDOT-titled auction was captured. A WisDOT query surfaced a patrol/dump truck with plow and wing on Wisconsin Surplus (lot 45391) whose seller was not shown. |
| 19 | UW-Madison SWAP (Surplus With A Purpose) online auction | custom | `swapauction.wisc.edu` | Verona, WI | high | [swapauction.wisc.edu](https://swapauction.wisc.edu/About) | Its own auction site, posting 25+ new listings each weekday. SWAP also resells for other UW campuses, state agencies and municipalities. A 7.5% buyer premium applies on its Public Surplus listings. Best single custom target. |
| 20 | Wisconsin Department of Transportation, surplus land and property sales | custom | `wisconsindot.gov/landsales` | WI | medium | [wisconsindot.gov land sales (NW)](https://wisconsindot.gov/Pages/doing-bus/real-estate/landsales/landsales-nw.aspx) | Per-region surplus land sale pages (the Northwest Region page was seen). Real estate only; whether sales are sealed-bid or auction was not confirmed. |

### 6.3 School: technical colleges and K-12 (26)

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Eau Claire Area School District | GovDeals | `acct:3779` | Eau Claire, WI | high | [GovDeals acct 3779](https://www.govdeals.com/content/termsandconditions/3779?companyName=Eau+Claire+Area+School+District%2C+WI) | GovDeals account 3779. |
| 2 | Elmbrook School District | GovDeals | `acct:12488` | Brookfield, WI | high | [GovDeals acct 12488](https://www.govdeals.com/content/termsandconditions/12488?companyName=Elmbrook+School+District,+WI) | GovDeals account 12488 (from its terms page); seller slug not captured. |
| 3 | Montello School District | GovDeals | `montelloschoolswi` | Montello, WI | high | [govdeals.com/montelloschoolswi](https://www.govdeals.com/montelloschoolswi) |  |
| 4 | Wabeno Area School District | GovDeals | `WabenoAreaSchoolDistrict` | Wabeno, WI | high | [govdeals.com/WabenoAreaSchoolDistrict](https://www.govdeals.com/WabenoAreaSchoolDistrict) |  |
| 5 | Milwaukee Public Schools, Facilities and Maintenance | GovDeals | — | Milwaukee, WI | low | [govauctions.app Milwaukee County](https://govauctions.app/research/what-your-county-is-selling/wisconsin/milwaukee-county) | Named as a Milwaukee County seller (3 lots) by an aggregator that indexes both GovDeals and Public Surplus; which of the two was not shown. Verify the platform. |
| 6 | Fox Valley Technical College | Public Surplus | `fvtc,wi` | Appleton, WI | high | [PS fvtc,wi](https://www.publicsurplus.com/sms/fvtc,wi/browse/search) | WTCS district. |
| 7 | Northeast Wisconsin Technical College | Public Surplus | `nwtc,wi` | Green Bay, WI | high | [PS orgid 174687](https://m.publicsurplus.com/sms/list/current?orgid=174687) | orgid 174687. WTCS district. |
| 8 | Oconto Falls Public School District | Public Surplus | — | Oconto Falls, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 9 | Plymouth Joint School District | Public Surplus | — | Plymouth, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 10 | School District of Black River Falls | Public Surplus | — | Black River Falls, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 11 | School District of Janesville | Public Surplus | — | Janesville, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 12 | School District of La Crosse | Public Surplus | — | La Crosse, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 13 | School District of the Menomonie Area | Public Surplus | — | Menomonie, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 14 | West Bend Joint School District No. 1 | Public Surplus | — | West Bend, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 15 | Delavan-Darien School District | Wisconsin Surplus | — | Delavan, WI 53115 | high | [WS lot 12796](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionId=dHhAR/X4YT/0pJzGP6uyJw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pageSize=WddRnDis30ojx01x46RicQ%3D%3D&AuctionItemId=DEvNLPkSPbkTb5ZXrth6FA%3D%3D) | 150 Cummings St. |
| 16 | Gale-Ettrick-Trempealeau School District | Wisconsin Surplus | — | Galesville, WI | high | [WS #24-1114](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=tJZCIS69DVoGcR4WNBee%2BA%3D%3D&Title=Ytscl%2Fqg4njWFz4xKKoA5WRc95szcTqyagPMiQ7V2GR%2FiLxjVCed6lr0fSBRX5iOQe9JwX3tCTyvixpnF9uvF%2BzvhgwKxIJpue0kY061Vgc%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=HVh9vIJKOoMj9lCbFoT%2BeA%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B%2FgnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) | A 31-lot sale. |
| 17 | Gateway Technical College | Wisconsin Surplus | — | Kenosha, WI | high | [WS #25-331](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=xZMf3RaqUBUNXwc6ZXzVRQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |  |
| 18 | Middleton-Cross Plains Area School District | Wisconsin Surplus | — | Middleton, WI 53562 | high | [WS lot 49734](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionItemId=ykKuzfgcNLvrAHwyMEc79A%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D&pageSize=O5OaPaZE1XrTjGtTQItkaw%3D%3D&AuctionId=PAA1m8wixy2DhfXcEieChw%3D%3D&Filter=1WE1m%2BQ3X4xU0sLCbjF7/Q%3D%3D) | 2130 Pinehurst Dr. |
| 19 | Milwaukee Area Technical College | Wisconsin Surplus | — | Milwaukee, WI | high | [WS #25-1011](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyTr01VH832WJAz%2BqeNTfw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | In the UW System/WTCS multi-location auctions (#25-885, #25-1011). |
| 20 | Northwood Technical College | Wisconsin Surplus | — | WI | high | [WS #25-1011](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyTr01VH832WJAz%2BqeNTfw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Formerly WITC; multi-campus in northwest WI, so pickup varies by lot. |
| 21 | School District of Janesville | Wisconsin Surplus | — | Janesville, WI | high | [WS lot 47809](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionId=tECdL95F7uzgguoI1CeU5w%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pageSize=WddRnDis30ojx01x46RicQ%3D%3D&AuctionItemId=reJodo3C9D2cSUQMnOWf4g%3D%3D) | Also on Public Surplus. |
| 22 | Sheboygan Area School District | Wisconsin Surplus | — | Sheboygan, WI | high | [WS #24-1501](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=0bDEjrA9cPeTgY6KeXMKOA%3D%3D&Title=Ex2AE4428e9lUmuaDYPdG05mdS6Rtmdu9ZqJ13qfPfsAHJ%2BIwhnM7Ue1FOFjGRNqLlrUJk7m/6oXeO8Z6MnOM218LOm4v6s0vNnm9t7ufeA%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) |  |
| 23 | Southwest Wisconsin Technical College | Wisconsin Surplus | — | Fennimore, WI | high | [WS #24-652](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=selMWufdS7aC4fijisbRsQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |  |
| 24 | Waukesha County Technical College | Wisconsin Surplus | — | Pewaukee, WI | high | [WS #25-118](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=GqVesPR/2YyU65JpTyiO3Q%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) | #25-118, #25-1011. |
| 25 | Western Technical College | Wisconsin Surplus | — | La Crosse, WI | high | [WS #24-520](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=g/7UzE3yuLY5DH9kvmzFSQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |  |
| 26 | Winneconne Community School District | Wisconsin Surplus | — | Winneconne, WI 54986 | high | [WS lot 93783](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionId=oQ8Cwj0fwjfDtQP4asvyGQ%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D&pageSize=O5OaPaZE1XrTjGtTQItkaw%3D%3D&showFilter=iBcS%2B4ptjknZQtCojbueqQ%3D%3D&sortColumn=C9SY4KX74WJIILYqur0bmw%3D%3D&AuctionItemId=JrwNPlF2Qt8Rz1SST%2BwAqQ%3D%3D&Filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | 233 S Third Ave. |

### 6.4 County, including sheriffs and highway departments (38)

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Brown County | GovDeals | — | Green Bay, WI | high | [browncountywi.gov For Sale/Auction](https://www.browncountywi.gov/departments/administration/purchasing/for-saleauction/) | Seller slug not captured. |
| 2 | Eau Claire County | GovDeals | `eauclairecounty` | Eau Claire, WI | high | [govdeals.com/eauclairecounty](https://www.govdeals.com/eauclairecounty) |  |
| 3 | Racine County Government | GovDeals | `racinecounty` | Racine, WI | high | [govdeals.com/en/racinecounty](https://www.govdeals.com/en/racinecounty) |  |
| 4 | Walworth County | GovDeals | `walworthcounty` | Elkhorn, WI | high | [govdeals.com/en/walworthcounty](https://www.govdeals.com/en/walworthcounty) | GovDeals account 11147. |
| 5 | Waukesha County | Public Surplus | `waukeshaco,wi` | Waukesha, WI | high | [PS orgid 199473](https://m.publicsurplus.com/sms/waukeshaco,wi/list/current?orgid=199473) | orgid 199473. |
| 6 | Winnebago County | Public Surplus | `winnebago,wi` | Oshkosh, WI | high | [PS orgid 17558](https://m.publicsurplus.com/sms/winnebago,wi/list/current?orgid=17558) | orgid 17558. |
| 7 | Green County | Public Surplus | `greencounty,wi` | Monroe, WI | medium | [PS greencounty,wi](https://m.publicsurplus.com/sms/greencounty,wi/browse/cataucs?catid=907) | Agency slug seen; display name not shown in the result. |
| 8 | Sauk County | Public Surplus | — | Baraboo, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 9 | Sawyer County | Public Surplus | — | Hayward, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 10 | Washburn County | Public Surplus | — | Shell Lake, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 11 | Washington County Highway Commission | Public Surplus | — | West Bend, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 12 | Dane County (Public Surplus agency 'danecosw') | Public Surplus | `danecosw,wi` | Madison, WI | low | [PS danecosw,wi](https://publicsurplus.com/sms/danecosw,wi/browse/cataucs?catid=1506) | The agency slug exists; its display name was not shown (possibly a Dane County department). |
| 13 | Racine County | Public Surplus | — | Racine, WI | low | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | The agency list shows 'Racine', which could be the City of Racine. Verify. |
| 14 | Milwaukee County Fleet Management (joint vehicle and equipment auctions) | Proxibid | `Auction-Associates-Inc` | Wauwatosa, WI | high | [Proxibid event 249604](https://www.proxibid.com/Auction-Associates-Inc/Milwaukee-County-Vehicles-and-Equipment-Auction/event-catalog/249604) | Periodic joint live auctions at 10320 Watertown Plank Rd, with the catalog on Proxibid run by Auction Associates Inc. County page: county.milwaukee.gov/EN/Department-of-Transportation/Operations/Fleet/Fleet-Auction. |
| 15 | Adams County Sheriff's Office | Wisconsin Surplus | — | Friendship, WI | high | [WS #22-1329](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=Yjs6wWiE0AX9Z3DVslP8iA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |  |
| 16 | Ashland County Sheriff's Department | Wisconsin Surplus | — | Ashland, WI | high | [WS #24-358](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=6a0YLbpjNCTzhVlZVdwvvA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |  |
| 17 | Barron County Sheriff's Department (and Highway Department) | Wisconsin Surplus | — | Barron, WI | high | [WS #23-392](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=nn50LIaw7FjXaDhcbPfrrw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | The Barron County Highway Department is also reported as a Wisconsin Surplus client. |
| 18 | Bayfield County Highway Department | Wisconsin Surplus | — | Washburn, WI | high | [WS #25-881](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=QmHVtstbMIqqp5zJfnkCXw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |  |
| 19 | Brown County (Purchasing and Sheriff's Office) | Wisconsin Surplus | — | Green Bay, WI | high | [WS #22-732B](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=tz4BTlCMTknW45Vsv//o3Q%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | The county purchasing page says surplus is published on GovDeals and Wisconsin Surplus. Sheriff's Office auction #22-732B. |
| 20 | Columbia County Highway Department and Facilities Management | Wisconsin Surplus | — | Wyocena, WI | high | [WS #24-746](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=nVAFkp7EG%2FRGJ11hNCcRVw%3D%3D&Title=4tYNsOAHVNMMuwyUWpFYTb6djffyyBtyvrgqLIig3hqGm70Y5fIDQK5Yvya3KmXh0TRmZnMUvj1OVZakXXixXG2p%2FN5tDtzgjK1raqf6IZzT98REck7%2BR%2Fva1Z7mqjpY&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B%2FgnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) |  |
| 21 | Dane County Sheriff's Office | Wisconsin Surplus | — | Madison, WI | high | [WS #211273](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HKKcPwQfh3FTyNcrlH%2FVCw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=28iLnyTvLmy8%2FhPPi3DcdQ%3D%3D) |  |
| 22 | Dunn County Highway Department | Wisconsin Surplus | — | Menomonie, WI | high | [WS Dunn Co. Hwy](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=r0uIukI6J8v733JJQWkDTA%3D%3D&Title=Er9xhzTyOhIqt+M%2FXhciX5zqthdFwRKSKT+1v7pyvqfJhHu6wr1qSFZ8JyFLmWuydRbLcjg1OsCwWzIZi6mPMQ%3D%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J+%2FgnxeL3g%3D%3D&filter=1WE1m+Q3X4xU0sLCbjF7%2FQ%3D%3D&pageNumber=pf6Q+hJtdeleDd9FfYpy9w%3D%3D) |  |
| 23 | Florence County Sheriff's Office | Wisconsin Surplus | — | Florence, WI | high | [WS #22-1337](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=htMaYFJLWWLH17ioPtkHQg%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |  |
| 24 | Fond du Lac County Highway Department | Wisconsin Surplus | — | Fond du Lac, WI | high | [WS #24-1305](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=w0V5irGS29vhMTEIKOCekw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |  |
| 25 | Green County Sheriff's Office | Wisconsin Surplus | — | Monroe, WI | high | [WS #24-553B](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=NClKgKZMouIIx1ghqmn2/w%3D%3D&Title=iYiN/eQ3%2BmZxO6s7zxzeLTcWFlFba7qq5ezG27oS81hDgh35E0py8ntfc4uaexODcInA0xYrrkfCSgp5VT6mbDjyxnpbx4eur1r5EhHAwck%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) | Auction #24-553B was picked up in New Glarus. |
| 26 | Kewaunee County | Wisconsin Surplus | — | Kewaunee, WI | high | [kewauneeco.org WS page](https://www.kewauneeco.org/government/page/wisconsin-surplus-online-auction/) | The county page says most county property and equipment sales go through Wisconsin Surplus. |
| 27 | Oconto County (Sheriff's Office and tax-deeded land sales) | Wisconsin Surplus | — | Oconto, WI | high | [ocontocountywi.gov land sales](https://www.ocontocountywi.gov/417/Land-Sales---Wisconsin-Surplus-Online-Au) | The county land-sales page names Wisconsin Surplus; Sheriff's Office auction #24-1523 also ran there. |
| 28 | Oneida County Highway Department | Wisconsin Surplus | — | Rhinelander, WI | high | [WS #25-1882](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=jK5WeCcGQT5yXe769lGn8g%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) | Auction number #25-1882 implies roughly 1,900 Wisconsin Surplus auction events in 2025. |
| 29 | Pierce County Highway Department | Wisconsin Surplus | — | Ellsworth, WI | high | [WS #211204](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=YDiLotCga5wsvmsrKQe1qw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |  |
| 30 | Vernon County Highway Department | Wisconsin Surplus | — | Viroqua, WI | high | [WS #24-640](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=ymj%2Bh38biV5mIqehfq/EPQ%3D%3D&Title=rdjH7S0TA/ot5KNVcP7E6qWhOuR3CTHOBp5fRNoLoND6RAfWgJye/KzQydMtRxQsKzxd5zFQWCwZnrPBGWyd8g%3D%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) |  |
| 31 | Vilas County Sheriff's Office | Wisconsin Surplus | — | Eagle River, WI | high | [WS Vilas Co. Sheriff](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=K1LNKkKgTwT%2FRjxiAucC7g%3D%3D&Title=BD03pCcIRk%2FQXyOztkiiJ3mToNolgyPOP0vW65myyX06nxwebEpqXQOcegMYYOZFRm%2FnfHKyoVExc7u8EMvyYwQr4qdsMwgIfgQcaqJjFmg%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J+%2FgnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q+hJtdeleDd9FfYpy9w%3D%3D) |  |
| 32 | Washington County Sheriff's Office | Wisconsin Surplus | — | West Bend, WI | high | [WS #25-1618](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=g6piVT9gELJkRHQVKmrfhA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |  |
| 33 | Waukesha County | Wisconsin Surplus | — | Waukesha, WI | high | [WS #25-1478](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=8lZ8OTVmLJoFnfftu7tpWQ%3D%3D&Title=VafaKbVCzgynzRUexoUPMl/yYMhTjNytYUvhOCxzG15/Srje8ptVEPTJgczgKVy%2B&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=1tHrkRQUPQb1fXo8rPLthQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) | Also on Public Surplus (waukeshaco,wi). County surplus page: waukeshacounty.gov/administration/purchasing/surplus-property/. |
| 34 | Waupaca County Sheriff's Office | Wisconsin Surplus | — | Waupaca, WI | high | [WS #22-180](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=9bp0Q0k7GUDmJLeSlrU0xQ%3D%3D&Title=IHCqsvNz85PDkNmbCXPXavHyUqPyhNccqI0Bw6GA9IKvH7LU2g0igxfeyklXNkZtKrTUEmlqNevs3EuK%2BjacxA%3D%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=y3NfkhOYLpmaMNzLut1/wA%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) |  |
| 35 | Waushara County Highway Department | Wisconsin Surplus | — | Wautoma, WI | high | [WS #25-1085](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=qkmaixBCY8h766avgHE01Q%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) |  |
| 36 | Central Wisconsin Airport (Marathon and Portage counties) | Wisconsin Surplus | — | Mosinee, WI | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | Named in multi-municipal auction #23-119. |
| 37 | Dodge County Highway Department | Wisconsin Surplus | — | Juneau, WI | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | Named in multi-municipal auction #23-119. |
| 38 | Dane County Treasurer, tax deed auction | custom | `treasurer.danecounty.gov/taxdeedauction` | Madison, WI | high | [treasurer.danecounty.gov](https://treasurer.danecounty.gov/taxdeedauction) | Sealed-bid sales of tax-deeded parcels; the next bid opening is Oct 7, 2026. Real estate only. |

### 6.5 Municipal: cities, villages, towns, fire and police (45)

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | City of Appleton | GovDeals | `AppletonWI` | Appleton, WI | high | [govdeals.com/AppletonWI](https://www.govdeals.com/AppletonWI) | The aggregator snapshot shows Appleton among the top WI pickup cities. |
| 2 | City of Eau Claire | GovDeals | — | Eau Claire, WI | high | [eauclairewi.gov](https://www.eauclairewi.gov/government/our-divisions/purchasing/on-line-auction) | The City posts used computers and other items on GovDeals; seller slug not captured. |
| 3 | Village of Combined Locks | GovDeals | `acct:8619` | Combined Locks, WI | high | [GovDeals acct 8619](https://www.govdeals.com/content/termsandconditions/8619?companyName=Combined+Locks+Village,+WI) | GovDeals account 8619. |
| 4 | Wautoma Police Department | GovDeals | `acct:22035` | Wautoma, WI | high | [GovDeals acct 22035](https://www.govdeals.com/content/termsandconditions/22035?companyName=Wautoma+Police+Department%2C+WI) | GovDeals account 22035. |
| 5 | City of Madison | Public Surplus | `madison,wi` | Madison, WI | high | [PS madison,wi](https://www.publicsurplus.com/sms/madison,wi/browse/home) |  |
| 6 | City of Milwaukee DPW Fleet Services | Public Surplus | `orgid:1036892` | Milwaukee, WI | high | [PS orgid 1036892](https://m.publicsurplus.com/sms/list/current?orgid=1036892) | The City uses both Public Surplus and Wisconsin Surplus. |
| 7 | City of Wausau | Public Surplus | — | Wausau, WI | high | [wausauwi.gov](https://www.wausauwi.gov/your-government/public-works/surplus-auction) | The City's surplus page sends bidders to publicsurplus.com; slug not captured. |
| 8 | City of Brookfield | Public Surplus | `brookfield,wi` | Brookfield, WI | medium | [PS brookfield,wi](https://publicsurplus.com/sms/brookfield,wi/browse/home) | Slug seen; display name not shown (a Town of Brookfield also exists). |
| 9 | City of St. Croix Falls | Public Surplus | — | St. Croix Falls, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) |  |
| 10 | City of Waukesha | Public Surplus | `waukesha,wi` | Waukesha, WI | medium | [PS waukesha,wi](https://publicsurplus.com/sms/waukesha,wi/browse/cataucs?catid=614) | The slug 'waukesha,wi' is distinct from the county's 'waukeshaco,wi'; name inferred. |
| 11 | City of Wauwatosa | Public Surplus | — | Wauwatosa, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Also has its own surplus page (wauwatosa.net/government/departments/purchasing/surplus-equipment-for-sale). |
| 12 | Crescent Fire Department (Town of Crescent) | Public Surplus | — | WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Oneida County. |
| 13 | Town of Dunkirk | Public Surplus | — | Dunkirk, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 14 | Town of Lawrence | Public Surplus | — | Lawrence, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 15 | Town of Rib Mountain | Public Surplus | — | Rib Mountain, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 16 | Town of Sheboygan Falls | Public Surplus | — | Sheboygan Falls, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 17 | Town of Somerset | Public Surplus | — | Somerset, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 18 | Village of Ashwaubenon | Public Surplus | — | Ashwaubenon, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 19 | Village of Cottage Grove | Public Surplus | — | Cottage Grove, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 20 | Village of Elm Grove | Public Surplus | — | Elm Grove, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 21 | Village of Greenville | Public Surplus | — | Greenville, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 22 | Village of McFarland | Public Surplus | — | McFarland, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 23 | Village of Necedah | Public Surplus | — | Necedah, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 24 | Village of Osceola | Public Surplus | — | Osceola, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 25 | Village of Paddock Lake | Public Surplus | — | Paddock Lake, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 26 | Village of Pewaukee | Public Surplus | — | Pewaukee, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 27 | Village of Wales | Public Surplus | — | Wales, WI | medium | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Named in the Public Surplus Wisconsin agency list; slug not captured. |
| 28 | City of Racine | Public Surplus | — | Racine, WI | low | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | Ambiguous with Racine County. Verify. |
| 29 | City of Janesville | Wisconsin Surplus | — | Janesville, WI | high | [janesvillewi.gov](https://www.janesvillewi.gov/departments-services/public-works/operations-division/vehicle-operations-maintenance-vom/online-auctions-for-surplus-property-other-assets) | The City contracts with Wisconsin Surplus for surplus equipment and vehicles. |
| 30 | City of Madison | Wisconsin Surplus | — | Madison, WI | high | [WS #23-303](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=wf2CnhUvzhwpg8TjVHq6EQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | #22-271B, #23-303. Also on Public Surplus. |
| 31 | City of Milwaukee (Fleet Services, Water Utility, surplus) | Wisconsin Surplus | — | Milwaukee, WI | high | [city.milwaukee.gov/Purchasing](https://city.milwaukee.gov/Purchasing) | The Purchasing Division says the City uses wisconsinsurplus.com. Auction #23-400 is 'City of Milwaukee - Fleet Services & Water Utility'. Inspection at 2142 W Canal St by appointment. |
| 32 | Village of Germantown, Department of Public Works | Wisconsin Surplus | — | Germantown, WI 53022 | high | [WS #25-1599](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=VcManhkdCH9e2N02QYyf7w%3D%3D&Title=0z9QIjQBt/NpgD9BtYapsr9R8OpM5uoe6YLIEfs6WAOVnEJeAbwBQSbysuGcnEqYpFZjTmvWLzhYkBkJ8upY1OpfCSqf%2B5MkBWxUYzW17sg%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D) |  |
| 33 | Chemung Township Highway Department (McHenry County, IL) | Wisconsin Surplus | — | Harvard, IL | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | A border-area seller (just south of the WI line) in multi-municipal auction #23-119, showing Wisconsin Surplus carries northern Illinois sellers. |
| 34 | City of Cudahy | Wisconsin Surplus | — | Cudahy, WI | medium | [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Named in multi-municipal auction #25-475. |
| 35 | City of Dodgeville | Wisconsin Surplus | — | Dodgeville, WI | medium | [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Named in multi-municipal auction #25-475. |
| 36 | City of Kenosha | Wisconsin Surplus | — | Kenosha, WI | medium | [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Named in multi-municipal auction #25-475. |
| 37 | City of Platteville | Wisconsin Surplus | — | Platteville, WI | medium | [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Named in multi-municipal auction #25-475. |
| 38 | City of St. Francis | Wisconsin Surplus | — | St. Francis, WI | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | Named in multi-municipal auction #23-119. |
| 39 | City of Wauwatosa Public Library | Wisconsin Surplus | — | Wauwatosa, WI | medium | [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Named in multi-municipal auction #25-475. |
| 40 | Tess Corners Volunteer Fire Department | Wisconsin Surplus | — | Muskego, WI | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | Named in multi-municipal auction #23-119. |
| 41 | Village of Bayside | Wisconsin Surplus | — | Bayside, WI | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | Named in multi-municipal auction #23-119. |
| 42 | Village of Darien | Wisconsin Surplus | — | Darien, WI | medium | [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D) | Named in multi-municipal auction #23-119. |
| 43 | Village of Suamico | Wisconsin Surplus | — | Suamico, WI | medium | [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Named in multi-municipal auction #25-475. |
| 44 | Village of Waunakee | Wisconsin Surplus | — | Waunakee, WI | medium | [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D) | Named in multi-municipal auction #25-475. |
| 45 | Hazelhurst, WI (seller not named in the title; probably the Town of Hazelhurst) | Wisconsin Surplus | — | Hazelhurst, WI | low | [WS #25-1395](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=FeHYcmPEmBoA%2FSgltF3iDg%3D%3D&Title=R8zSX34UPFZZe6faoUp5YGl+CWGpE3QjZvYIDbgJnc9GzYoZ92J13k78+aiDyrq4BKA2y8X5PdbN065C4hdlfoxLB1%2F7ceHaU2sQRVsE7AKXelSFMIoAsbG1c+h7LvfsYn78DK672XLKAObZ2rmK8Q%3D%3D&AuctionTypes=EZYuYbOBLD7HCiN+4vVIHEU1VP441IqXynnIdEtvD%2FvQJN6k%2FL6bh7QNvRZpihvG&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J+%2FgnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q+hJtdeleDd9FfYpy9w%3D%3D) | Auction #25-1395 is titled only 'Hazelhurst, WI'. Verify the seller. |

### 6.6 Private auction houses (30)

No border-area private house was confirmed. Wisconsin Surplus itself sells in IL, MI, IA and MN, and K-BID is Minnesota-based; see gap 12.

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Hamele Auction Service LLC | HiBid | `hameleauctions` | WI | high | [hameleauctions.hibid.com](https://hameleauctions.hibid.com/) | Central WI. 10% online buyer premium plus 3.5% for card payment (01-sources.md). |
| 2 | Sheboygan Discount Warehouse (WI) | HiBid | `sheboygandiscountwarehousewi` | Sheboygan, WI 53081 | high | [hibid.com/company/146891](https://hibid.com/company/146891/sheboygan-discount-warehouse--wi-) | HiBid company 146891; 2836 S Business Dr. Sells returns and overstock item by item to consumers, so it borders on liquidation; kept in scope as a retail auction. |
| 3 | Wilkinson Auction & Realty Co., LLC | HiBid | `company:145740` | Muscoda, WI 53573 | high | [hibid.com/company/145740](https://hibid.com/company/145740/wilkinson-auction-and-realty-co---llc) | 105 N. Wisconsin Ave. |
| 4 | Wisconsin Auction Company | HiBid | `auctionwi` | Green Bay, WI 54304 | high | [hibid.com/company/114623](https://hibid.com/company/114623/wisconsin-auction-company) | HiBid company 114623; 1000 Centennial St, Unit B9. |
| 5 | Wise Owl Auctions of Madison LLC | HiBid | `woamadison` | Madison, WI | high | [woamadison.hibid.com](https://woamadison.hibid.com/) |  |
| 6 | Beloit Auction & Realty | HiBid | `bids.beloitauction.com` | Beloit, WI | medium | [bids.beloitauction.com](https://bids.beloitauction.com) | White-label HiBid on a custom domain (01-sources.md; not re-checked). Do NOT confuse with Hansen Auction & Realty of Beloit, KANSAS (hansenonlineauction.hibid.com). |
| 7 | Major Wisconsin Auctions | HiBid | `wisauction` | WI | medium | [wisauction.hibid.com](https://wisauction.hibid.com/) | Location not captured. |
| 8 | Thiel & Thiel Auctions | HiBid | `thielandthielauctions` | WI | medium | [thielandthielauctions catalog 400444](https://thielandthielauctions.hibid.com/catalog/400444) | Ran a Janesville, WI online real-estate auction (catalog 400444). Home base not captured. |
| 9 | Titletown Auction Company | HiBid | `titletownauctions` | WI | medium | [titletownauctions.hibid.com](https://titletownauctions.hibid.com/) | The name suggests Green Bay, but location is not confirmed; city left blank on purpose. |
| 10 | Wausau Auctioneers | HiBid | `wausauauctioneers` | WI | medium | [wausauauctioneers.hibid.com](https://wausauauctioneers.hibid.com/) | City not confirmed; left blank on purpose. |
| 11 | Wise Owl Auctions (La Crosse) | HiBid | `woalacrosse` | La Crosse, WI | medium | [woalacrosse.hibid.com](https://woalacrosse.hibid.com/) | The page title is generic; a search summary places Wise Owl in La Crosse and Sparta. |
| 12 | Bid City Auction Company, LLC | HiBid | `bidcityauctioncompany` | — | low | [bidcityauctioncompany.hibid.com](https://bidcityauctioncompany.hibid.com/) | Surfaced in a Wisconsin ZIP-prefix HiBid search; location not confirmed. |
| 13 | Dairyland Auction, LLC | HiBid | — | Elroy, WI | low | [hibid.com/wisconsin/companysearch](https://hibid.com/wisconsin/companysearch) | A search summary reports it on HiBid with sales at 501 Madison Ave, Tomah. Subdomain not captured. |
| 14 | Ferris Auction | HiBid | `ferrisauction` | — | low | [ferrisauction.hibid.com](https://ferrisauction.hibid.com/) | Surfaced in a Madison/Janesville HiBid search; location not confirmed. |
| 15 | George Auction | HiBid | `georgeauction` | — | low | [georgeauction.hibid.com](https://georgeauction.hibid.com/) | Surfaced in a Madison/Janesville HiBid search; location not confirmed. |
| 16 | HBA Sales (High Bid Auction) | HiBid | `highbidauction` | — | low | [highbidauction.hibid.com](https://highbidauction.hibid.com/) | Surfaced repeatedly in Wisconsin-scoped HiBid searches; location not confirmed. |
| 17 | Jones Auction & Realty | HiBid | `jonesauctionservice` | — | low | [jonesauctionservice.hibid.com](https://jonesauctionservice.hibid.com/) | Generic name; location not confirmed. Could be out of state. |
| 18 | Ramblin' Rose Auction Co. & Gallery | HiBid | — | — | low | [hibid.com/wisconsin/auctions](https://hibid.com/wisconsin/auctions) | A family-owned consignment and charity auction house (35+ years) that surfaced in a Wisconsin HiBid search. Subdomain and location not captured. |
| 19 | Ryan's Relics Estate & Auction Company LLC | HiBid | `rrauctionsales` | — | low | [rrauctionsales.hibid.com](https://rrauctionsales.hibid.com/) | Surfaced in a Chippewa Valley/Wausau HiBid search; location not confirmed. |
| 20 | Smith Sales LLC | HiBid | `smithauctions` | — | low | [smithauctions.hibid.com](https://smithauctions.hibid.com/) | Generic name; location not confirmed. Could be out of state. |
| 21 | Wagner's Auction and Real Estate | HiBid | `wagnersauctionandrealestate` | — | low | [wagnersauctionandrealestate.hibid.com](https://wagnersauctionandrealestate.hibid.com/) | Surfaced in a Sheboygan/Fond du Lac HiBid search; location not confirmed. |
| 22 | Badger Corporation and Equipment Auctions | K-BID | — | WI | medium | [k-bid.com blog 215](https://www.k-bid.com/blog/215/Welcome+Aboard+Wisconsin's+Badger+Corporation+and+Equipment+Auctions) | K-BID's blog welcomes this Wisconsin affiliate. The post is undated here, so confirm it is still active. Affiliate id not captured. |
| 23 | K-BID Ag & Iron Auctions | K-BID | — | WI | medium | [tractorzoom.com](https://tractorzoom.com/auctioneer/midwest/wisconsin/k-bid-ag-iron-auctions) | K-BID's farm and equipment division, listed as a Wisconsin auctioneer on Tractor Zoom. |
| 24 | Auction Associates Inc. | Proxibid | `Auction-Associates-Inc` | — | high | [Proxibid event 249604](https://www.proxibid.com/Auction-Associates-Inc/Milwaukee-County-Vehicles-and-Equipment-Auction/event-catalog/249604) | Runs the Milwaukee County vehicle and equipment auctions. Home base not captured. |
| 25 | Krueger Real Estate Auction Service | AuctionZip | — | Montello, WI | low | — | 01-sources.md: found via AuctionZip. Not re-checked. Its actual bidding platform is unknown. |
| 26 | Wisconsin Surplus Online Auction (the company: private consignments) | Wisconsin Surplus | — | Mount Horeb, WI 53572 | high | [WS #25-1472](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=SbU7lYbOZi3L0dGtAGuzFA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D) | A private family company (Richard and Matthew Lust) at 2600 State Hwy 78 S. It runs 'General Public Vehicle Auction' consignment sales (#25-1472) alongside government sales and covers WI, IL, MI, IA and MN. |
| 27 | Hansen Auction Group | custom | `hansenauctiongroup.com` | WI | medium | [hansenauctiongroup.com](https://www.hansenauctiongroup.com) | Equipment, farm, business and real estate (01-sources.md; not re-checked). NOT the Kansas 'Hansen Auction & Realty'. |
| 28 | Krueger & Krueger LLC | custom | — | WI | low | — | 01-sources.md says it lists on LiveAuctioneers. Not re-checked. LiveAuctioneers is not in the platform enum. |
| 29 | Mecum Auctions | custom | `mecum.com` | Walworth, WI | low | — | A collector-car auction house headquartered in Walworth, WI, with its own bidding platform. Not verified this session. |
| 30 | Schrager Auction Galleries | custom | — | Milwaukee, WI | low | — | 01-sources.md says it lists on Invaluable, at 2915 N Sherman Blvd. Not re-checked. Invaluable is not in the platform enum. |

### 6.7 Estate sale companies (3)

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | K-BID Estate Sales | K-BID | `affiliate:175007` | — | low | [k-bid.com affiliate 175007](https://www.k-bid.com/affiliate-profile/detail/175007) | K-BID's own estate-sale affiliate; home base not captured (K-BID is Minnesota-based). K-BID also carries WI 'Household & Estate' auctions in Hudson (auction 63988) and River Falls (61393) whose affiliates were not captured. |
| 2 | MaxSold, Madison market | MaxSold | — | Madison, WI | low | — | An owner-supplied lead, not verified this session. |
| 3 | MaxSold, Milwaukee market | MaxSold | — | Milwaukee, WI | low | — | An owner-supplied lead, not verified this session. MaxSold runs online estate and downsizing auctions itself. |

### 6.8 Platform-scope entry points (10)

These are not sellers. Each row is a platform's Wisconsin landing page: the place an adapter or a discovery crawler starts. They are kept in the JSON so every platform with Wisconsin presence has a row.

| # | Name | Platform | platform_id | Location | Conf. | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | GovDeals: all Wisconsin sellers (platform scope) | GovDeals | `wisconsin` | WI | high | [govdeals.com/en/wisconsin](https://www.govdeals.com/en/wisconsin) | 93 active WI listings, and 116 of 189 open WI government lots, in the aggregator snapshot. |
| 2 | Public Surplus: all Wisconsin agencies (platform scope) | Public Surplus | `all,wi` | WI | high | [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=) | The WI agency list. 29-30 active WI listings in the aggregator snapshot. |
| 3 | Municibid: Wisconsin region (platform scope) | Municibid | `R3777846` | WI | medium | [municibid.com R3777846](https://municibid.com/Browse/R3777846/Wisconsin) | The region page exists, but no Wisconsin seller was confirmed. |
| 4 | AllSurplus: Wisconsin (platform scope) | AllSurplus | `wisconsin` | WI | medium | [allsurplus.com/wisconsin](https://www.allsurplus.com/wisconsin) | Liquidity Services' commercial and industrial sister site to GovDeals. No WI seller confirmed. |
| 5 | HiBid: all Wisconsin auctioneers (platform scope) | HiBid | `wisconsin` | WI | high | [hibid.com/wisconsin/companysearch](https://hibid.com/wisconsin/companysearch) | 77 companies in the WI company search. State portals: wisconsin.hibid.com, wisconsin-s.hibid.com, wisconsin-b.hibid.com; regional: midwest.hibid.com. |
| 6 | K-BID: all Wisconsin auctions (platform scope) | K-BID | `wisconsin` | WI | high | [k-bid.com/auction/list/wisconsin](https://www.k-bid.com/auction/list/wisconsin) | Also /auction/list/south-wisconsin. Affiliates have numeric ids (/affiliate-profile/detail/{id}); directory at /affiliate-directory. |
| 7 | AuctionZip: Wisconsin auctioneer directory (discovery only) | AuctionZip | `wi` | WI | medium | [auctionzip.com/wi.html](https://www.auctionzip.com/wi.html) | Confirmed in 01-sources.md by an earlier session; blocked this session. Use it to discover houses, not to ingest lots. |
| 8 | Purple Wave: Wisconsin listings (platform scope) | Purple Wave | — | WI | medium | [govauctions.app WI (11 Purple Wave lots)](https://govauctions.app/auctions/wisconsin) | 11 of 189 open WI government lots in the aggregator snapshot; consignors not named. |
| 9 | EstateSales.net: Wisconsin (platform scope) | EstateSales.net | `WI` | WI | low | — | The category leader. The WI company directory was not reached (blocked, and the search budget ran out). |
| 10 | EstateSales.org: Wisconsin (platform scope) | EstateSales.org | `wi` | WI | medium | [estatesales.org/estate-sales/wi](https://www.estatesales.org/estate-sales/wi) | WI listings confirmed in 01-sources.md; companies not enumerated. |

## 7. All 72 counties: coverage matrix

**31 of 72** counties have a confirmed county-government channel, and **46 of 72** have at least one confirmed public seller of any kind. "Top-20 pop." marks the 20 most populous counties (2020 census). 8 of the top 20 still lack a county-government channel: Jefferson, Kenosha, La Crosse, Outagamie, Ozaukee, Rock, St. Croix, Sheboygan.

| County | Top-20 pop. | County government channel(s) | Other public sellers located in the county |
|---|---|---|---|
| Adams |  | Adams County Sheriff's Office (WS) | — |
| Ashland |  | Ashland County Sheriff's Department (WS) | — |
| Barron |  | Barron County Sheriff's Department (and Highway Department) (WS) | — |
| Bayfield |  | Bayfield County Highway Department (WS) | — |
| Brown | yes | Brown County (GD); Brown County (Purchasing and Sheriff's Office) (WS) | Northeast Wisconsin Technical College (PS); Town of Lawrence (PS); University of Wisconsin-Green Bay (PS); Village of Ashwaubenon (PS); Village of Suamico (WS) |
| Buffalo |  | **none confirmed** | — |
| Burnett |  | **none confirmed** | — |
| Calumet |  | **none confirmed** | — |
| Chippewa |  | **none confirmed** | — |
| Clark |  | **none confirmed** | — |
| Columbia |  | Columbia County Highway Department and Facilities Management (WS) | — |
| Crawford |  | **none confirmed** | — |
| Dane | yes | Dane County (Public Surplus agency 'danecosw') (PS, low); Dane County Sheriff's Office (WS); Dane County Treasurer, tax deed auction (own site) | City of Madison (PS); City of Madison (WS); Middleton-Cross Plains Area School District (WS); Town of Dunkirk (PS); UW-Madison SWAP (Surplus With A Purpose) online auction (own site); University of Wisconsin-Madison (PS); Village of Cottage Grove (PS); Village of McFarland (PS); Village of Waunakee (WS); Wisconsin Department of Natural Resources / Wildlife (GD) |
| Dodge | yes | Dodge County Highway Department (WS) | — |
| Door |  | **none confirmed** | — |
| Douglas |  | **none confirmed** | — |
| Dunn |  | Dunn County Highway Department (WS) | School District of the Menomonie Area (PS) |
| Eau Claire | yes | Eau Claire County (GD) | City of Eau Claire (GD); Eau Claire Area School District (GD); University of Wisconsin-Eau Claire (PS) |
| Florence |  | Florence County Sheriff's Office (WS) | — |
| Fond du Lac | yes | Fond du Lac County Highway Department (WS) | — |
| Forest |  | **none confirmed** | Wabeno Area School District (GD) |
| Grant |  | **none confirmed** | City of Platteville (WS); Southwest Wisconsin Technical College (WS) |
| Green |  | Green County (PS); Green County Sheriff's Office (WS) | — |
| Green Lake |  | **none confirmed** | — |
| Iowa |  | **none confirmed** | City of Dodgeville (WS) |
| Iron |  | **none confirmed** | — |
| Jackson |  | **none confirmed** | School District of Black River Falls (PS); Wisconsin Department of Corrections, Jackson Correctional Institution (WS) |
| Jefferson | yes | **none confirmed** | — |
| Juneau |  | **none confirmed** | Village of Necedah (PS) |
| Kenosha | yes | **none confirmed** | City of Kenosha (WS); Gateway Technical College (WS); University of Wisconsin-Parkside (PS); Village of Paddock Lake (PS) |
| Kewaunee |  | Kewaunee County (WS) | — |
| La Crosse | yes | **none confirmed** | School District of La Crosse (PS); University of Wisconsin-La Crosse (WS); Western Technical College (WS) |
| Lafayette |  | **none confirmed** | — |
| Langlade |  | **none confirmed** | — |
| Lincoln |  | **none confirmed** | — |
| Manitowoc |  | **none confirmed** | — |
| Marathon | yes | Central Wisconsin Airport (Marathon and Portage counties) (WS) | City of Wausau (PS); Town of Rib Mountain (PS) |
| Marinette |  | **none confirmed** | — |
| Marquette |  | **none confirmed** | Montello School District (GD) |
| Menominee |  | **none confirmed** | — |
| Milwaukee | yes | Milwaukee County Fleet Management (joint vehicle and equipment auctions) (Proxibid) | City of Cudahy (WS); City of Milwaukee (Fleet Services, Water Utility, surplus) (WS); City of Milwaukee DPW Fleet Services (PS); City of St. Francis (WS); City of Wauwatosa (PS); City of Wauwatosa Public Library (WS); Milwaukee Area Technical College (WS); Milwaukee Public Schools, Facilities and Maintenance (GD, low); University of Wisconsin-Milwaukee Surplus (GD); Village of Bayside (WS) |
| Monroe |  | **none confirmed** | — |
| Oconto |  | Oconto County (Sheriff's Office and tax-deeded land sales) (WS) | Oconto Falls Public School District (PS) |
| Oneida |  | Oneida County Highway Department (WS) | Crescent Fire Department (Town of Crescent) (PS); Hazelhurst, WI (seller not named in the title; probably the Town of Hazelhurst) (WS, low) |
| Outagamie | yes | **none confirmed** | City of Appleton (GD); Fox Valley Technical College (PS); Village of Combined Locks (GD); Village of Greenville (PS) |
| Ozaukee | yes | **none confirmed** | — |
| Pepin |  | **none confirmed** | — |
| Pierce |  | Pierce County Highway Department (WS) | — |
| Polk |  | **none confirmed** | City of St. Croix Falls (PS); Village of Osceola (PS) |
| Portage |  | **none confirmed** | University of Wisconsin-Stevens Point Surplus Store (WS) |
| Price |  | **none confirmed** | — |
| Racine | yes | Racine County (PS, low); Racine County Government (GD) | City of Racine (PS, low) |
| Richland |  | **none confirmed** | — |
| Rock | yes | **none confirmed** | City of Janesville (WS); School District of Janesville (PS); School District of Janesville (WS) |
| Rusk |  | **none confirmed** | — |
| St. Croix | yes | **none confirmed** | Town of Somerset (PS) |
| Sauk |  | Sauk County (PS) | — |
| Sawyer |  | Sawyer County (PS) | — |
| Shawano |  | **none confirmed** | — |
| Sheboygan | yes | **none confirmed** | Plymouth Joint School District (PS); Sheboygan Area School District (WS); Town of Sheboygan Falls (PS) |
| Taylor |  | **none confirmed** | — |
| Trempealeau |  | **none confirmed** | Gale-Ettrick-Trempealeau School District (WS) |
| Vernon |  | Vernon County Highway Department (WS) | — |
| Vilas |  | Vilas County Sheriff's Office (WS) | — |
| Walworth | yes | Walworth County (GD) | Delavan-Darien School District (WS); University of Wisconsin-Whitewater (PS); Village of Darien (WS) |
| Washburn |  | Washburn County (PS) | — |
| Washington | yes | Washington County Highway Commission (PS); Washington County Sheriff's Office (WS) | Village of Germantown, Department of Public Works (WS); West Bend Joint School District No. 1 (PS) |
| Waukesha | yes | Waukesha County (PS); Waukesha County (WS) | City of Brookfield (PS); City of Waukesha (PS); Elmbrook School District (GD); Tess Corners Volunteer Fire Department (WS); Village of Elm Grove (PS); Village of Pewaukee (PS); Village of Wales (PS); Waukesha County Technical College (WS) |
| Waupaca |  | Waupaca County Sheriff's Office (WS) | — |
| Waushara |  | Waushara County Highway Department (WS) | Wautoma Police Department (GD) |
| Winnebago | yes | Winnebago County (PS) | Winneconne Community School District (WS); Wisconsin DHS, Winnebago Mental Health Institute (WS) |
| Wood |  | **none confirmed** | — |

## 8. Gaps

**Research blockers (fix these first):**

1. **Search budget exhausted.** Raise `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`, or give a follow-up session its own budget.
2. **WebFetch blocked for every domain.** Allowlisting these would replace dozens of searches with a handful of directory page loads: `hibid.com`, `bid.wisconsinsurplus.com`, `publicsurplus.com`, `govdeals.com`, `k-bid.com`, `estatesales.net`, `estatesales.org`, `auctionzip.com`, `wisconsinauctioneers.org`, `maxsold.com`, `ctbids.com`.

**Coverage gaps:**

3. **HiBid:** about 56 of the 77 Wisconsin companies are not captured. Of the 21 captured, 9 have no confirmed location (Ryan's Relics Estate & Auction Company LLC; HBA Sales (High Bid Auction); Smith Sales LLC; Ferris Auction; George Auction; Jones Auction & Realty; Bid City Auction Company, LLC; Wagner's Auction and Real Estate; Ramblin' Rose Auction Co. & Gallery). Some may be out of state, so they must be checked before activation. Subdomains are missing for Dairyland Auction and Ramblin' Rose.
4. **Wisconsin Auctioneers Association member directory:** not reached.
5. **AuctionZip WI directory:** not reached.
6. **Estate sales:** no EstateSales.net or EstateSales.org company enumerated. No Caring Transitions (CTBids) franchise confirmed. AuctionNinja has no WI evidence. MaxSold markets are unverified.
7. **Federal:** Treasury (TEOAF/CWS), U.S. Marshals, IRS, Army Corps and VA are all `low`. The current hosts and whether any lots are WI-located both need confirming.
8. **Counties:** 41 of 72 have no confirmed county-government channel: Buffalo, Burnett, Calumet, Chippewa, Clark, Crawford, Door, Douglas, Forest, Grant, Green Lake, Iowa, Iron, Jackson, Jefferson, Juneau, Kenosha, La Crosse, Lafayette, Langlade, Lincoln, Manitowoc, Marinette, Marquette, Menominee, Monroe, Outagamie, Ozaukee, Pepin, Polk, Portage, Price, Richland, Rock, Rusk, St. Croix, Shawano, Sheboygan, Taylor, Trempealeau, Wood.
9. **Large cities with no platform confirmed:** Green Bay, Oshkosh, West Allis, La Crosse, Sheboygan, Fond du Lac, New Berlin, Greenfield, Beloit, Franklin, Oak Creek, Manitowoc, West Bend, Sun Prairie, Superior, Stevens Point, Neenah, Fitchburg, Muskego, Watertown, De Pere and Mequon. For Racine, it is unclear whether the Public Surplus listing is the city or the county.
10. **Large school districts with no platform confirmed:** Madison Metropolitan, Kenosha Unified, Green Bay Area, Racine Unified, Appleton Area, Waukesha. Milwaukee Public Schools sells, but it is unclear whether on GovDeals or Public Surplus.
11. **Sheriffs:** only 11 found, all on Wisconsin Surplus. The Milwaukee, Waukesha, Racine, Kenosha, Outagamie and Rock county sheriffs' seized-property channels are unconfirmed.
12. **Border area (about 50 miles):** the Twin Cities metro, Rockford, Dubuque and the Upper Peninsula were not enumerated. Found so far: Chemung Township, IL (via Wisconsin Surplus), and a Winnebago County, IL surplus page whose platform was not identified (wincoil.gov).
13. **Farm and equipment:** EquipmentFacts/AuctionTime, Tractor Zoom's WI directory, BidSpotter and Proxibid houses were not enumerated.
14. **Missing identifiers:** GovDeals slugs for Brown County, City of Eau Claire, Elmbrook SD, Eau Claire Area SD, Combined Locks and Wautoma PD (account ids only). Public Surplus slugs for 30+ agencies named only in the agency list. Two Public Surplus WI slugs with unknown agencies, `wca,wi` and `odcinc,wi`. K-BID affiliate ids for Badger Corporation and K-BID Ag & Iron.
15. **The state contract picture is unresolved.** DOA names GovDeals; Wisconsin Surplus claims a DOA contract; Public Surplus has a state group account. Read the VendorNet *Online Auction Services* contract (user guide effective 11-25-2024) to settle which vendor holds what.
16. **Excluded on purpose:** private and nonprofit sellers seen inside government auctions (Madison Area Sheet Metal Training Center, Cedar Community), and a `swshdwi.gov` "Surplus Sales" page whose owner was not identified.

## 9. ON-HOLD: wholesale and liquidation (not researched)

Parked per the owner's instruction (*"hold off on wholesaling for now"*). Not researched and **not in the JSON**. `sources.sql` already supports `tier = 'wholesale'`.

| Source | URL | Note |
|---|---|---|
| B-Stock | bstock.com | Retailer returns and overstock, B2B |
| Liquidation.com | liquidation.com | Liquidity Services, B2B lots |
| Direct Liquidation | directliquidation.com | |
| BULQ | bulq.com | |
| Nellis Auction | nellisauction.com | Already seeded as `wholesale` in `sources.sql` |
| Copart / IAA | copart.com, iaai.com | Salvage vehicles, largely dealer-oriented. A Copart *Milwaukee South* yard turned up in a search |

A borderline case: **Sheboygan Discount Warehouse** on HiBid sells returns and overstock *item by item to consumers*. That is retail auctioning, so it is kept in §6.6. Move it here if the owner counts returns liquidators as wholesale.

## 10. What this changes in `01-sources.md` (that file was not edited)

- *"WI DOA / DNR / DOT surplus — largely routed through Wisconsin Surplus"* → only partly right. There are three channels: GovDeals (DOA contract), Wisconsin Surplus (DOA vendor) and Public Surplus (state group). See §5.
- *"UW–Madison SWAP — verify the current bidding host"* → `swapauction.wisc.edu` (own site) **plus** Public Surplus `uwmadison,wi` (orgid 1015233).
- *Wisconsin Surplus* → it is still a private company and still critical. **New:** it has no seller ids, and multi-seller auctions require per-lot seller parsing. The external_id warning stands.
- *K-BID, AllSurplus, GovPlanet* → Wisconsin URLs are now confirmed: `k-bid.com/auction/list/wisconsin`, `allsurplus.com/wisconsin`, `govplanet.com/Government+Surplus/Wisconsin`.
- *Municibid* → a Wisconsin region exists, but no Wisconsin seller was found. Deprioritise it.

## 11. Sources

Every evidence URL in the JSON, plus the context pages cited above. All were found through web search on 2026-09-27; none were loaded directly (see §1).

- [govauctions.app WI (18 GSA lots)](https://govauctions.app/auctions/wisconsin)
- [govauctions.app Milwaukee County](https://govauctions.app/research/what-your-county-is-selling/wisconsin/milwaukee-county)
- [govplanet.com WI page](https://www.govplanet.com/Government+Surplus/Wisconsin)
- [doa.wi.gov program page](https://doa.wi.gov/Pages/StateEmployees/SurplusPropProgram.aspx)
- [PS orgid 994864](https://m.publicsurplus.com/sms/wisconsindoa,wi/list/current?orgid=994864)
- [WS #25-1122](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=EO%2BDha87w6I6FZw4XA/PqA%3D%3D&Title=9PZgamUvKN/uyQscQeNkM0LhGvrob9xRCYrw5gI9MC2r%2BL64wHRujkXrajOzGljgFPQCaRrR3fVpzbAMt0J6Bfzg0JU58TJovDTzndRDRzs%3D&AuctionTypes=k%2BUhcTfuQEhHzOOCDAEwUGYDb0RYwKDxpZrLTeWVdVc%3D&totalItems=eM2qGtWsDERQZRqe0NOHEQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [govdeals.com/en/widnr](https://www.govdeals.com/en/widnr)
- [WS #25-420](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=mwOfOruWf3ovk6GINKsf8A%3D%3D&Title=jCTx95UtqpVdBTG0VHKk8bueBgqvTOuhOwZH5/ebwJy2a8CA96U6xx8Gepo8oSyGfh5kuSkgILf4xqeoMASR5po91egjabFo8b7p1JbAAi4%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS #24-1226](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=1xgeRPsl3ldIOX7Yiu0z0w%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #25-1088](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=N6DsSDkgoh5PdBBZl0LSTg%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #23-119](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=P26EppgRtQ6qVTYDzND9Hw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [wisconsindot.gov land sales (NW)](https://wisconsindot.gov/Pages/doing-bus/real-estate/landsales/landsales-nw.aspx)
- [swapauction.wisc.edu](https://swapauction.wisc.edu/About)
- [PS orgid 1015233](https://www.publicsurplus.com/sms/uwmadison,wi/list/current?orgid=1015233)
- [govdeals.com/uwmilwaukeesurplus](https://www.govdeals.com/uwmilwaukeesurplus)
- [PS orgid 97512](https://m.publicsurplus.com/sms/uwgb,wi/list/current?orgid=97512)
- [PS orgid 83394](https://www.publicsurplus.com/sms/uwec,wi/list/current?orgid=83394)
- [PS WI agency list](https://m.publicsurplus.com/sms/all,wi/mobile/browse/agency?catid=)
- [WS #25-1011](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyTr01VH832WJAz%2BqeNTfw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D)
- [PS orgid 174687](https://m.publicsurplus.com/sms/list/current?orgid=174687)
- [PS fvtc,wi](https://www.publicsurplus.com/sms/fvtc,wi/browse/search)
- [WS #25-118](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=GqVesPR/2YyU65JpTyiO3Q%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #25-331](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=xZMf3RaqUBUNXwc6ZXzVRQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #24-652](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=selMWufdS7aC4fijisbRsQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [WS #24-520](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=g/7UzE3yuLY5DH9kvmzFSQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [GovDeals acct 12488](https://www.govdeals.com/content/termsandconditions/12488?companyName=Elmbrook+School+District,+WI)
- [govdeals.com/WabenoAreaSchoolDistrict](https://www.govdeals.com/WabenoAreaSchoolDistrict)
- [GovDeals acct 3779](https://www.govdeals.com/content/termsandconditions/3779?companyName=Eau+Claire+Area+School+District%2C+WI)
- [govdeals.com/montelloschoolswi](https://www.govdeals.com/montelloschoolswi)
- [WS #24-1501](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=0bDEjrA9cPeTgY6KeXMKOA%3D%3D&Title=Ex2AE4428e9lUmuaDYPdG05mdS6Rtmdu9ZqJ13qfPfsAHJ%2BIwhnM7Ue1FOFjGRNqLlrUJk7m/6oXeO8Z6MnOM218LOm4v6s0vNnm9t7ufeA%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS #24-1114](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=tJZCIS69DVoGcR4WNBee%2BA%3D%3D&Title=Ytscl%2Fqg4njWFz4xKKoA5WRc95szcTqyagPMiQ7V2GR%2FiLxjVCed6lr0fSBRX5iOQe9JwX3tCTyvixpnF9uvF%2BzvhgwKxIJpue0kY061Vgc%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=HVh9vIJKOoMj9lCbFoT%2BeA%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B%2FgnxeL3g%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS lot 12796](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionId=dHhAR/X4YT/0pJzGP6uyJw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pageSize=WddRnDis30ojx01x46RicQ%3D%3D&AuctionItemId=DEvNLPkSPbkTb5ZXrth6FA%3D%3D)
- [WS lot 93783](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionId=oQ8Cwj0fwjfDtQP4asvyGQ%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D&pageSize=O5OaPaZE1XrTjGtTQItkaw%3D%3D&showFilter=iBcS%2B4ptjknZQtCojbueqQ%3D%3D&sortColumn=C9SY4KX74WJIILYqur0bmw%3D%3D&AuctionItemId=JrwNPlF2Qt8Rz1SST%2BwAqQ%3D%3D&Filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D)
- [WS lot 47809](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionId=tECdL95F7uzgguoI1CeU5w%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pageSize=WddRnDis30ojx01x46RicQ%3D%3D&AuctionItemId=reJodo3C9D2cSUQMnOWf4g%3D%3D)
- [WS lot 49734](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItemDetail?AuctionItemId=ykKuzfgcNLvrAHwyMEc79A%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D&pageSize=O5OaPaZE1XrTjGtTQItkaw%3D%3D&AuctionId=PAA1m8wixy2DhfXcEieChw%3D%3D&Filter=1WE1m%2BQ3X4xU0sLCbjF7/Q%3D%3D)
- [WS #25-1478](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=8lZ8OTVmLJoFnfftu7tpWQ%3D%3D&Title=VafaKbVCzgynzRUexoUPMl/yYMhTjNytYUvhOCxzG15/Srje8ptVEPTJgczgKVy%2B&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=1tHrkRQUPQb1fXo8rPLthQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS Dunn Co. Hwy](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=r0uIukI6J8v733JJQWkDTA%3D%3D&Title=Er9xhzTyOhIqt+M%2FXhciX5zqthdFwRKSKT+1v7pyvqfJhHu6wr1qSFZ8JyFLmWuydRbLcjg1OsCwWzIZi6mPMQ%3D%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J+%2FgnxeL3g%3D%3D&filter=1WE1m+Q3X4xU0sLCbjF7%2FQ%3D%3D&pageNumber=pf6Q+hJtdeleDd9FfYpy9w%3D%3D)
- [WS #25-881](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=QmHVtstbMIqqp5zJfnkCXw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #24-640](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=ymj%2Bh38biV5mIqehfq/EPQ%3D%3D&Title=rdjH7S0TA/ot5KNVcP7E6qWhOuR3CTHOBp5fRNoLoND6RAfWgJye/KzQydMtRxQsKzxd5zFQWCwZnrPBGWyd8g%3D%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS #24-1305](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=w0V5irGS29vhMTEIKOCekw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #24-746](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=nVAFkp7EG%2FRGJ11hNCcRVw%3D%3D&Title=4tYNsOAHVNMMuwyUWpFYTb6djffyyBtyvrgqLIig3hqGm70Y5fIDQK5Yvya3KmXh0TRmZnMUvj1OVZakXXixXG2p%2FN5tDtzgjK1raqf6IZzT98REck7%2BR%2Fva1Z7mqjpY&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B%2FgnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS #25-1085](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=qkmaixBCY8h766avgHE01Q%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #211204](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=YDiLotCga5wsvmsrKQe1qw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [WS #22-180](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=9bp0Q0k7GUDmJLeSlrU0xQ%3D%3D&Title=IHCqsvNz85PDkNmbCXPXavHyUqPyhNccqI0Bw6GA9IKvH7LU2g0igxfeyklXNkZtKrTUEmlqNevs3EuK%2BjacxA%3D%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=y3NfkhOYLpmaMNzLut1/wA%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [WS #25-1618](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=g6piVT9gELJkRHQVKmrfhA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #22-1329](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=Yjs6wWiE0AX9Z3DVslP8iA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [WS #24-358](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=6a0YLbpjNCTzhVlZVdwvvA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [WS #211273](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HKKcPwQfh3FTyNcrlH%2FVCw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=28iLnyTvLmy8%2FhPPi3DcdQ%3D%3D)
- [WS #22-1337](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=htMaYFJLWWLH17ioPtkHQg%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [WS Vilas Co. Sheriff](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=K1LNKkKgTwT%2FRjxiAucC7g%3D%3D&Title=BD03pCcIRk%2FQXyOztkiiJ3mToNolgyPOP0vW65myyX06nxwebEpqXQOcegMYYOZFRm%2FnfHKyoVExc7u8EMvyYwQr4qdsMwgIfgQcaqJjFmg%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J+%2FgnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q+hJtdeleDd9FfYpy9w%3D%3D)
- [WS #25-1882](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=jK5WeCcGQT5yXe769lGn8g%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [WS #24-553B](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=NClKgKZMouIIx1ghqmn2/w%3D%3D&Title=iYiN/eQ3%2BmZxO6s7zxzeLTcWFlFba7qq5ezG27oS81hDgh35E0py8ntfc4uaexODcInA0xYrrkfCSgp5VT6mbDjyxnpbx4eur1r5EhHAwck%3D&AuctionTypes=lYEVrUyUaI9qm0b3CsaHGg%3D%3D&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS #23-392](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=nn50LIaw7FjXaDhcbPfrrw%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [kewauneeco.org WS page](https://www.kewauneeco.org/government/page/wisconsin-surplus-online-auction/)
- [ocontocountywi.gov land sales](https://www.ocontocountywi.gov/417/Land-Sales---Wisconsin-Surplus-Online-Au)
- [WS #22-732B](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=tz4BTlCMTknW45Vsv//o3Q%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [govdeals.com/en/walworthcounty](https://www.govdeals.com/en/walworthcounty)
- [govdeals.com/en/racinecounty](https://www.govdeals.com/en/racinecounty)
- [govdeals.com/eauclairecounty](https://www.govdeals.com/eauclairecounty)
- [browncountywi.gov For Sale/Auction](https://www.browncountywi.gov/departments/administration/purchasing/for-saleauction/)
- [PS orgid 199473](https://m.publicsurplus.com/sms/waukeshaco,wi/list/current?orgid=199473)
- [PS orgid 17558](https://m.publicsurplus.com/sms/winnebago,wi/list/current?orgid=17558)
- [PS greencounty,wi](https://m.publicsurplus.com/sms/greencounty,wi/browse/cataucs?catid=907)
- [PS danecosw,wi](https://publicsurplus.com/sms/danecosw,wi/browse/cataucs?catid=1506)
- [treasurer.danecounty.gov](https://treasurer.danecounty.gov/taxdeedauction)
- [Proxibid event 249604](https://www.proxibid.com/Auction-Associates-Inc/Milwaukee-County-Vehicles-and-Equipment-Auction/event-catalog/249604)
- [city.milwaukee.gov/Purchasing](https://city.milwaukee.gov/Purchasing)
- [WS #23-303](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=wf2CnhUvzhwpg8TjVHq6EQ%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D)
- [janesvillewi.gov](https://www.janesvillewi.gov/departments-services/public-works/operations-division/vehicle-operations-maintenance-vom/online-auctions-for-surplus-property-other-assets)
- [WS #25-1599](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=VcManhkdCH9e2N02QYyf7w%3D%3D&Title=0z9QIjQBt/NpgD9BtYapsr9R8OpM5uoe6YLIEfs6WAOVnEJeAbwBQSbysuGcnEqYpFZjTmvWLzhYkBkJ8upY1OpfCSqf%2B5MkBWxUYzW17sg%3D&totalItems=WddRnDis30ojx01x46RicQ%3D%3D&viewtypeId=KHe6Qcx9tBs9J%2B/gnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q%2BhJtdeleDd9FfYpy9w%3D%3D)
- [WS #25-475](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=TyTopF9a1sDSfTZXKm%2BTPA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D&filter=ajBmiK%2B33KkMkTDWtuuLmg%3D%3D)
- [WS #25-1395](https://bid.wisconsinsurplus.com/Public/Auction/AuctionItems?AuctionId=FeHYcmPEmBoA%2FSgltF3iDg%3D%3D&Title=R8zSX34UPFZZe6faoUp5YGl+CWGpE3QjZvYIDbgJnc9GzYoZ92J13k78+aiDyrq4BKA2y8X5PdbN065C4hdlfoxLB1%2F7ceHaU2sQRVsE7AKXelSFMIoAsbG1c+h7LvfsYn78DK672XLKAObZ2rmK8Q%3D%3D&AuctionTypes=EZYuYbOBLD7HCiN+4vVIHEU1VP441IqXynnIdEtvD%2FvQJN6k%2FL6bh7QNvRZpihvG&totalItems=lJcZNvWR1ahMAdw4fXV00Q%3D%3D&viewtypeId=KHe6Qcx9tBs9J+%2FgnxeL3g%3D%3D&filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D&pageNumber=pf6Q+hJtdeleDd9FfYpy9w%3D%3D)
- [govdeals.com/AppletonWI](https://www.govdeals.com/AppletonWI)
- [GovDeals acct 8619](https://www.govdeals.com/content/termsandconditions/8619?companyName=Combined+Locks+Village,+WI)
- [GovDeals acct 22035](https://www.govdeals.com/content/termsandconditions/22035?companyName=Wautoma+Police+Department%2C+WI)
- [eauclairewi.gov](https://www.eauclairewi.gov/government/our-divisions/purchasing/on-line-auction)
- [PS madison,wi](https://www.publicsurplus.com/sms/madison,wi/browse/home)
- [PS orgid 1036892](https://m.publicsurplus.com/sms/list/current?orgid=1036892)
- [PS brookfield,wi](https://publicsurplus.com/sms/brookfield,wi/browse/home)
- [PS waukesha,wi](https://publicsurplus.com/sms/waukesha,wi/browse/cataucs?catid=614)
- [wausauwi.gov](https://www.wausauwi.gov/your-government/public-works/surplus-auction)
- [WS #25-1472](https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=SbU7lYbOZi3L0dGtAGuzFA%3D%3D&pageNumber=WddRnDis30ojx01x46RicQ%3D%3D&pagesize=WddRnDis30ojx01x46RicQ%3D%3D)
- [hibid.com/company/114623](https://hibid.com/company/114623/wisconsin-auction-company)
- [hibid.com/company/145740](https://hibid.com/company/145740/wilkinson-auction-and-realty-co---llc)
- [hibid.com/company/146891](https://hibid.com/company/146891/sheboygan-discount-warehouse--wi-)
- [woamadison.hibid.com](https://woamadison.hibid.com/)
- [hameleauctions.hibid.com](https://hameleauctions.hibid.com/)
- [woalacrosse.hibid.com](https://woalacrosse.hibid.com/)
- [wisauction.hibid.com](https://wisauction.hibid.com/)
- [titletownauctions.hibid.com](https://titletownauctions.hibid.com/)
- [wausauauctioneers.hibid.com](https://wausauauctioneers.hibid.com/)
- [thielandthielauctions catalog 400444](https://thielandthielauctions.hibid.com/catalog/400444)
- [bids.beloitauction.com](https://bids.beloitauction.com)
- [rrauctionsales.hibid.com](https://rrauctionsales.hibid.com/)
- [highbidauction.hibid.com](https://highbidauction.hibid.com/)
- [smithauctions.hibid.com](https://smithauctions.hibid.com/)
- [ferrisauction.hibid.com](https://ferrisauction.hibid.com/)
- [georgeauction.hibid.com](https://georgeauction.hibid.com/)
- [jonesauctionservice.hibid.com](https://jonesauctionservice.hibid.com/)
- [bidcityauctioncompany.hibid.com](https://bidcityauctioncompany.hibid.com/)
- [wagnersauctionandrealestate.hibid.com](https://wagnersauctionandrealestate.hibid.com/)
- [hibid.com/wisconsin/companysearch](https://hibid.com/wisconsin/companysearch)
- [hibid.com/wisconsin/auctions](https://hibid.com/wisconsin/auctions)
- [k-bid.com blog 215](https://www.k-bid.com/blog/215/Welcome+Aboard+Wisconsin's+Badger+Corporation+and+Equipment+Auctions)
- [tractorzoom.com](https://tractorzoom.com/auctioneer/midwest/wisconsin/k-bid-ag-iron-auctions)
- [hansenauctiongroup.com](https://www.hansenauctiongroup.com)
- [k-bid.com affiliate 175007](https://www.k-bid.com/affiliate-profile/detail/175007)
- [k-bid.com/auction/list/wisconsin](https://www.k-bid.com/auction/list/wisconsin)
- [govdeals.com/en/wisconsin](https://www.govdeals.com/en/wisconsin)
- [municibid.com R3777846](https://municibid.com/Browse/R3777846/Wisconsin)
- [allsurplus.com/wisconsin](https://www.allsurplus.com/wisconsin)
- [auctionzip.com/wi.html](https://www.auctionzip.com/wi.html)
- [estatesales.org/estate-sales/wi](https://www.estatesales.org/estate-sales/wi)
- [VendorNet: Online Auction Services contract user guide (effective 11-25-2024)](https://vendornet.wi.gov/Download.aspx?type=contract&Id=5d3ed82c-af80-ed11-8144-0050568c7f0f&filename=User+Guide+%28Effective+11-25-2024%29.docx)
- [Waukesha County surplus property page](https://www.waukeshacounty.gov/administration/purchasing/surplus-property/)
- [Milwaukee County Fleet Auction page](https://county.milwaukee.gov/EN/Department-of-Transportation/Operations/Fleet/Fleet-Auction)
- [City of Wauwatosa surplus equipment page](https://www.wauwatosa.net/government/departments/purchasing/surplus-equipment-for-sale)
- [UW-Madison SWAP for the public](https://veronaoperations.businessservices.wisc.edu/swap/public/)
- [UW-Madison News: SWAP fires up online auction site](https://news.wisc.edu/swap-fires-up-online-auction-site/)
- [Wisconsin Surplus: all auctions](https://bid.wisconsinsurplus.com/Public/Auction/All)
- [Wisconsin Surplus: company profile (WI EMS Association sponsor page)](https://www.wisconsinems.com/sponsors/wisconsin-surplus-online-auction)
- [GoToAuction: Wisconsin Surplus company 12060](https://www.gotoauction.com/companies/view/12060/Wisconsin-Surplus-Online-Auction.html)
- [HiBid Wisconsin home](https://hibid.com/wisconsin)
- [K-BID affiliate directory](https://www.k-bid.com/affiliate-directory)
- [K-BID south-Wisconsin list](https://www.k-bid.com/auction/list/south-wisconsin)
- [K-BID Hudson, WI household & estate auction 63988](https://www.k-bid.com/auction/63988)
- [K-BID River Falls, WI household & estate auction 61393](https://www.k-bid.com/auction/61393)
- [GovAuctions.app: Wisconsin GovDeals (93 active listings)](https://govauctions.app/platforms/govdeals/wisconsin)
- [GovAuctions.app: Wisconsin Public Surplus (29 active listings)](https://govauctions.app/platforms/publicsurplus/wisconsin)
- [BidProwl: Wisconsin government auctions](https://bidprowl.com/auctions/wisconsin)
- [DATCP: Surplus goods and government sales (consumer guidance)](https://datcp.wi.gov/Pages/Publications/GovernmentSalesSurplus176.aspx)
- [Winnebago County, IL surplus sales page (platform not identified)](https://wincoil.gov/departments/purchasing-department/surplus-sales)
- [Copart Milwaukee South (salvage; on hold)](https://www.copart.com/locations/milwaukee-south-wi-371)
