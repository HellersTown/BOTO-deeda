# Market research: competitors, user pain, and what to build differently

Research date: **2026-09-27**. Prepared for Skeuos (working names before that: Skeuos, Waystock).

> **Read §0 first.** This pass could not open any web page directly, and the
> session's shared search budget ran out before the review-mining plan was
> finished. Every claim below carries a provenance label. The unfinished work is
> listed in §8, with the exact searches still to run.

---

## 0. Method, evidence labels and limits

**How the evidence was gathered**

- `WebFetch` was refused by this container's egress proxy for every domain tried:
  auctionzip.com, apps.apple.com, play.google.com, discover.proxibid.com,
  govdeals.com, reddit.com, news.ycombinator.com, web.archive.org,
  justuseapp.com and en.wikipedia.org. **No page was opened directly.**
- Everything here comes from **web-search result excerpts**: a title, a URL and
  a short extracted or summarised passage.
- The session's WebSearch budget (200 calls, shared by every agent in this
  session) ran out after this agent's ~63rd search. App-store, Reddit and
  BiggerPockets review mining was therefore **only partly done**. See §8.

**Labels**

| Label | Meaning |
|---|---|
| **[1P]** | Excerpt from the company's own site, help centre, blog or app listing. Reasonably reliable, but the page was not opened. |
| **[3P]** | Excerpt from a third party: a review aggregator, guide, forum, or a competitor's blog. Treat as directional. |
| **UNVERIFIED** | Sources conflict, the point is an inference, or it is background knowledge that could not be re-checked this session. |
| **—** | Looked for and not found in this pass. This is not evidence of absence. |

**Quotes.** Text in quotation marks is reproduced as it appeared in a search
excerpt. Pages were not opened, so re-check the wording at the source before
quoting publicly. Paraphrases are marked *(paraphrase)*.

**Counts** in §4 are the number of *distinct products* for which this pass found
evidence of a theme, not the number of individual reviews. **Scores** in §1 are
judgment, not measurement.

---

## 1. Executive summary

### Seven findings

1. **Government-only aggregation is already free, and crowded.** GovAuctions.app
   (Show HN, April 2026; Pro $7/mo) and BidProwl (Pro $9/mo or $79/yr, plus a
   REST API and an MCP server) both offer one-box government search, email
   alerts, deal scores, sold comps and AI-assisted search [1P]. A third
   "28 sites" aggregator reached Hacker News weeks later, where a commenter asked
   whether it was a "Clone of 'GovAuctions' from 3 weeks ago?" [3P].
2. **They are thin exactly where Skeuos plans to be thick.** GovAuctions.app's
   Wisconsin page counts **189** open lots in total: GovDeals 116, Public Surplus
   30, GSA 18, Purple Wave 11, and three other platforms [1P]. No estate-sale
   platform appears in either aggregator's source list as surfaced in this pass
   (GovAuctions' full list was not retrieved) [1P]. BidProwl pulls listings every
   12 hours [1P].
3. **Where speed decides the deal, the market prices alerts by latency, not by
   count.** Swoopa charges $47 to $352 a month, largely for speed [1P]. Flipify
   is $5 for 10-minute checks and $10 for 1-minute checks [3P]. BidProwl's free
   alerts arrive in the next morning's digest; Pro checks every 30 minutes [1P].
   Where cadence is documented, auction incumbents send daily or slower digests
   (AuctionZip overnight, BidSpotter and Invaluable daily, Bid4Assets weekly)
   [1P/3P], which is tolerable for lots that stay open for days (inference).
   Skeuos's tiers currently differ only by hunt count.
4. **Alert tools fail silently, and users notice.** Swoopa reviewers report alerts
   arriving 15+ minutes late, and coverage falling to a quarter of listings after
   the trial [3P]. A Flipify reviewer says it "missed half the items" [3P].
   SearchTempest lost its Craigslist alerts outright when Craigslist ended RSS [1P].
5. **The loudest complaints are about money and pickup, not search.** An 18%
   premium that is itself taxed (MaxSold [1P]); box charges and per-pickup fees
   (CTBids [3P]); one-chance pickup dates (MaxSold [3P]); chaotic pickups
   (AuctionNinja [3P]); condition left undisclosed (K-BID affiliates [3P]).
6. **Last-second bidding is mostly moot outside eBay.** HiBid, GovDeals, MaxSold
   and AuctionNinja all extend the close when a late bid arrives [1P/3P]. eBay's
   bid-placement Offer API is Limited Release [1P]. Reminders have to understand
   each source's close rule.
7. **Photo *valuation* is commoditised and error-prone; photo search *across live
   lots* was not found elsewhere.** EstateSaleFinder.net offers free, unlimited AI
   photo appraisals [1P]. CoinSnap users report a single 2003 quarter valued
   anywhere from $0.58 to $400 [3P]. Skeuos's image search should find lots and
   show comp bands, and should not pronounce values.

### Top 15 improvements, ranked by impact × feasibility

I = impact, F = feasibility, both 1–5. Feasibility assumes the stack described in
`README.md` and `00-architecture.md`: Postgres with pgvector and PostGIS,
pg_cron and pgmq, and a crawl budget driven by closing time.

| # | Improvement | I | F | Score | Evidence (detail in §3–§5) |
|---|---|---|---|---|---|
| 1 | **All-in price on every lot, free.** Hammer + buyer's premium + tax on the premium where it applies + card surcharge + known box, shipping or pickup fees. Sort and filter by all-in, and add a reverse calculator ("$400 all-in → bid at most $X"). | 5 | 4 | **20** | MaxSold's 18% premium is taxed on top [1P], and a reviewer calls it "extortionist" [3P]. GovDeals card payments carry a 2.5–3.5% surcharge since the August 2025 move to Flywire [3P]. Municibid's fee is tiered 9/6/4% [3P]. CTBids buyers cite a $9.32 box charge and "$15 per pickup per person" [3P]. GovAuctions.app sells a "recommended max bid … after the buyer's premium, tax, and resale fees" only in Pro [1P]. |
| 2 | **Honest hunt delivery.** A published latency target per tier, a per-hunt "last checked" heartbeat, and a public per-source health page. Charge for speed only where speed decides the outcome: eBay fixed-price, short-duration lots, newly posted estate sales. | 5 | 4 | **20** | Swoopa: 1–3 minutes promised, 15+ observed; a quarter of listings after the trial [3P]. Flipify "missed half" [3P]. SearchTempest's Craigslist alerts died with Craigslist RSS [1P]. LiveAuctioneers keeps a help article titled "Why am I not getting my Auction Alerts?" [1P]. `source_health` (`00-architecture.md` §7) already computes what users need to see. |
| 3 | **Make private-house and estate-sale depth the headline**, not "every government auction in one place". | 5 | 4 | **20** | Government search is already free at GovAuctions.app and BidProwl [1P]. Their Wisconsin inventory is 189 government lots [1P]. Neither surfaced source list includes an estate-sale platform [1P]. BidProwl refreshes listings every 12 hours [1P]. |
| 4 | **Close-rule-aware bid reminders.** Store each source's close rule. Remind at T-minus-X, re-fire when the close extends, show the minimum next bid and increment, and give a per-lot countdown on staggered sales. | 4 | 4 | **16** | Soft close: HiBid +3 minutes [1P, auctioneer FAQ on HiBid]; GovDeals extends "2-5 minutes" [3P]; MaxSold 2 minutes with lots closing 10 seconds apart [1P]; AuctionNinja has extended bidding [1P]. AuctionTime reminds by push, email and text two hours before close [1P]. BidSlammer names the minimum bid increment as the "number one" cause of misunderstood snipes [1P]. |
| 5 | **Pickup-first logistics.** Pickup window as a badge and a filter; warnings for overlapping pickups; calendar export; a route planner for an estate-sale Saturday or a run of won lots. | 4 | 4 | **16** | MaxSold: one pickup date, and if you miss it "you have lost your money" [3P]. AuctionNinja: a chaotic pickup where items could not be found [3P]. CTBids: $15 per pickup [3P]. K-BID is praised for scheduled pickups [3P]. Route optimisation is a paid feature at Yard Sale Treasure Map ($5/yr, up to 25 stops) [1P] and MapMySales ($5.99/mo) [1P]. |
| 6 | **Comps and a deal band from Skeuos's own closed lots**, shown as a 25th–75th percentile band with the number of comps and their date range, never as one number. | 4 | 4 | **16** | GovAuctions' Flip Score with a 25th/median/75th band [1P]; BidProwl's deal score against a 90-day median [1P]; Municibid's ChatGPT app returns sold comps [1P]. Free 130point and Terapeak set expectations [1P]. WorthPoint's $29.99/mo draws price complaints [3P]. |
| 7 | **Natural-language search that compiles into a visible, editable hunt.** | 4 | 4 | **16** | NL search is now table stakes: Municibid's ChatGPT app [1P], BidProwl Pro's AI-assisted search [1P], GovAuctions Pro's AI assistant [1P]. Swoopa is criticised for loose filters that alert outside the user's price or mileage [3P]. `hunts.parsed` (`00-architecture.md` §5) already supports showing the parse. |
| 8 | **Fast, state-preserving browsing.** Back returns to the same scroll position and filters; results arrive in one round trip. | 3 | 5 | **15** | GovAuctions' founder described government auction sites as "extremely tedious", with "interminable page loading times" and back buttons that return to the homepage [3P, Show HN]. |
| 9 | **Trust-safe billing.** No card for the free tier, a reminder 24 hours before any trial converts, one-tap cancel, and an annual plan. | 3 | 5 | **15** | WorthPoint: charged after cancelling, a double charge, no trial-ending reminder [3P]. CoinSnap: a 7-day trial rolls into a yearly fee without notice [3P]. Annual plans are normal: BidProwl $79/yr [1P], WorthPoint $249.99/yr [3P], Gixen $11.99/yr [1P]. |
| 10 | **Group hunts: "got one, silence the rest."** One tap mutes reminders on the other lots in the same group. | 3 | 5 | **15** | Gixen's free tier includes group bidding, where the first successful snipe cancels the others [1P]. |
| 11 | **Listing trust flags:** "condition not stated", photo count, very short description, and the house's public rating. | 4 | 3 | **12** | K-BID affiliates "are not required to say if items are new, used, or damaged" [3P]. CTBids buyers allege AI photos and a "14k gold" necklace that tested at 84% copper [3P]. MaxSold descriptions are called inaccurate [3P]. |
| 12 | **Image search that finds lots, not verdicts:** photo → matching live lots across sources → comp band, with a confidence level and no authenticity claim. | 4 | 3 | **12** | CoinSnap's values swing wildly, and it "cannot reliably detect counterfeits" [3P]. Google Lens is weak on obscure items and returns no sold prices [3P]. Free AI appraisal already exists (EstateSaleFinder.net) [1P]. |
| 13 | **Follow a seller once, everywhere:** follow an auction house or estate-sale company and receive its sales from any platform. | 3 | 4 | **12** | Favourite-company alerts at EstateSales.NET and EstateSales.org [1P]; Invaluable lets users follow sellers [1P]; LiveAuctioneers follows auctioneers [1P]. Each works only inside its own site. |
| 14 | **Eligibility pre-flight per source:** deposit, registration, payment methods and surcharges, shown before the user gets attached to a lot. | 3 | 4 | **12** | Refundable deposits on most GSA vehicles [3P]; Bid4Assets deposits (examples: $1,500 tax sale, $10,000 foreclosure) refunded minus ~$35 [3P]; GovDeals changed its new-buyer rules and payment processor in 2025 [3P]. |
| 15 | **Per-hunt channel and cadence:** push; email as digest or individual; "new" versus "updated" (price drop, relist, new photos, date change); SMS and webhook/Discord/Telegram on Dealer. | 3 | 4 | **12** | GovDeals offers Digest/Individual and New/Updated triggers [1P]; LiveAuctioneers offers email, browser and SMS [1P]; AuctionTime sends texts [1P]; power users already wire PageCrawl to Telegram, Discord and Slack [1P]. |

Just below the cut, at a score of 9: a Dealer API or MCP server with CSV export
(BidProwl already ships both an API and an MCP server [1P]); drive-time radius
instead of straight-line miles (SearchTempest and BidProwl filter by driving
distance [1P]); and aggregate demand signals in place of per-rival profiles
(GovAuctions Pro already sells a demand meter and a closing-price forecast [1P]).
The full list is in §6.

---

## 2. Competitor matrix

Legend: **✓** documented · **—** not found in this pass · **?** UNVERIFIED ·
BP = buyer's premium. App store IDs are in §3.

| Product | Type | Platforms | Coverage | Buyer price or tiers | Alerts: channel · cadence | Saved search · radius · NL · image | Bidding aids | Headline weakness found |
|---|---|---|---|---|---|---|---|---|
| HiBid | Auction platform (AuctionFlex) | iOS, Android, web | US, Canada, intl. houses; `hibid.com/wisconsin` | Free to bid; BP set per house, typically 10–18% [3P] | Push for events, watched and bid lots, outbid [3P] · — | ? · — · — · — | Absentee (proxy), live; soft close +3 min [1P] | Not mined (gap) |
| K-BID | Timed auctions via affiliates | web; app ? | "Nationwide" claim; upper-Midwest core | — | — | — | Timed | Affiliates need not disclose condition [3P] |
| Proxibid | Auction marketplace | web; app ? | — | BP set by seller [1P] | Email, user-set frequency [1P] | ✓ · — · — · — | — | Not mined (gap) |
| AuctionZip | Auctioneer directory (Invaluable-owned app) | iOS, Android, web | Auctioneer listings | Free alerts [1P] | Email · overnight run, one morning email [1P] | ✓ · ✓ ZIP + radius · — · — | Live bidding in app [1P] | Next-day latency |
| BidSpotter | Industrial, commercial | web | US and UK sites | BP as % of hammer [1P] | Email · daily; cap 30 or 50 (conflicting) [1P] | ✓ · — · — · — | — | Daily latency |
| LiveAuctioneers | Art, antiques, collectibles | iOS, Android, web | — | — | Push, email, browser, SMS; "almost up" push [1P] | ✓ follow search · — · — · — | Absentee, live | Alert-delivery help article [1P] |
| Invaluable | Fine art, antiques | iOS, web | "2,000+" houses [1P] | — | Email · daily [1P] | ✓ follow keyword, artist, seller · — · — · — | — | Daily latency |
| AuctionTime | Equipment (Sandhills) | iOS, web | North America [1P] | — | Push, email, text · 2 h before close; outbid [1P] | Watch list · — · — · — | Real-time bid; phone or email the seller [1P] | — |
| Purple Wave | No-reserve ag, construction, municipal | web | US; 761 live (530 in MO) per GovAuctions [3P] | Capped per-lot internet fee; seller fees vary [3P] | ? | ✓ saved searches (page exists) [1P] · — · — · — | Timed | Fee varies by lot [3P] |
| GovDeals / AllSurplus | Gov and commercial surplus (Liquidity Services) | web; app ? | US state and local [3P] | BP ≤12.5%, typically 7.5–12.5% [3P]; card surcharge 2.5–3.5% [3P] | Email · Digest or Individual; New or Updated [1P]; on-site notices [1P] | ✓ · — · — · — | Soft close, "2-5 minutes" [3P] | Stacked fees [3P] |
| Public Surplus | Gov surplus | web (mobile site) | State, local, schools [3P] | — | Email "alert list" [3P] | ✓ alert list · — · — · — | — | — |
| Municibid | Gov surplus | iOS, Android, web, ChatGPT app | Northeast-strong (PA 323, MA 120) [3P] | 9% to $99,999.99 · 6% to $499,999.99 · 4% above [3P] | Push: saved search, outbid, closing soon [1P] | ✓ · — · ✓ via ChatGPT app [1P] · — | Max bid, watchlist [1P] | — |
| GSA Auctions | Federal surplus | web | US federal | No BP [3P]; deposits on most vehicles [3P] | Email by bidding history (RealEstateSales.gov) [1P] | "Lacks geo-filtering and saved searches" [3P, UNVERIFIED] | Proxy/auto bid [3P] | Discovery tools [3P] |
| Bid4Assets | Tax, sheriff, US Marshals sales | web | US counties | BP ≤10% [3P]; deposits; ~$35 refund fee [3P] | Email · weekly [3P] | — | — | Deposits gate bidding |
| Treasury (CWS) | Seized real property | web | All 50 states [1P] | No BP [1P] | Email · "bi-monthly" [1P] | — | — | Slow cadence |
| Wisconsin Surplus | WI state, county, municipal | web | WI (neighbours per `01-sources.md`) | BP 0–10%, median ~7% [3P] | — | — | — | Opaque auction IDs (`01-sources.md`) |
| GovAuctions.app | Gov aggregator | web | US, later UK, CA, AU; 16–42 sources depending on page [1P] | Free; **Pro $7/mo** [1P] | Email · 3 alerts free, unlimited in Pro [1P] | ✓ · location filter · ✓ AI assistant (Pro) · — | Max bid, Flip Score band, demand meter, closing forecast (Pro) [1P] | 189 WI lots; government only |
| BidProwl | Gov plus some private aggregator | web, REST API, MCP | US, all 50 states; 26–27 sources [1P] | Free; **Pro $9/mo or $79/yr**; API free to 1,000 calls/mo [1P] | Email · free next morning, Pro every 30 min [1P] | ✓ · ✓ driving distance from ZIP · ✓ AI search (Pro) · — | Deal score vs 90-day median [1P] | 12-hour listing pulls [1P] |
| EstateSales.NET | Estate-sale listings | iOS, Android, web | — | No buyer fee found | Email and push for favourited sales and companies; "over 4.5M" emails a week [1P] | ✓ filters, favourites · ✓ · — · — | n/a | Not mined (gap) |
| EstateSales.org | Estate sales plus online auctions | iOS, Android, web | — | No buyer fee found | Push for new sales in radius; favourite companies; custom reminders [1P] | ✓ keyword · ✓ distance, map · — · — | n/a | — |
| EstateSale-Finder.com | Estate-sale listings | web | — | — | Email [3P] | — | n/a | — |
| EstateSaleFinder.net | AI estate and garage marketplace | web | ZIP or city search | Free: unlimited AI photo appraisals, 10 price checks/mo [1P] | Wishlist alerts [1P] | ✓ · ✓ · AI labels · ✓ photo appraisal | n/a | — |
| MaxSold | Online estate auctions | web; app ? | US and Canada | BP 18%, and taxable [1P] | — | — | 2-min soft close; lots 10 s apart [1P] | One pickup date; fees [3P] |
| AuctionNinja | Online estate auctions | web; app ? | — | BP set by seller; 18% most common, 10–20% [1P] | — | — | Extended bidding [1P] | Pickup chaos; slow support [3P] |
| CTBids | Franchise online estate sales | iOS, web | — | "Up to 20%" [3P] | — | — | — | Shipping and pickup fees; misrepresentation [3P] |
| MapMySales | Sale map and router | PWA | — | Free; Plus $5.99/mo [1P] | Alerts (Plus) [1P] | Match scoring [1P] | Route optimisation [1P] | Ranks itself in its own guide [1P] |
| Yard Sale Treasure Map | Garage-sale map | iOS, Android, web | Craigslist, GSALR, user submissions [1P] | Free; $5/yr upgrade [1P] | — | ✓ keyword, location | Route optimisation up to 25 stops (paid) [1P] | Depends on upstream feeds |
| GSALR | Garage-sale listings | Android, web | — | — | — | — | — | — |
| Swoopa | Marketplace alerts | iOS, Android, web | FB, Craigslist, OfferUp, Kijiji, Gumtree, Nextdoor, eBay [3P] | $47 · $144 · $352 per mo [1P] | In-app · 1–9 min by tier; top tier "instant" [1P] | ✓ keywords, price · — · AI deal evaluation (higher tiers) [3P] · — | n/a | Late or missed alerts [3P] |
| Flipify | Marketplace alerts | iOS, Android | FB, eBay, Craigslist, OfferUp, Kijiji, Vinted [1P] | $5/mo (10-min) · $10/mo (1-min) [3P] | Push [1P] | ✓ watchlists · — · AI filter · — | n/a | "missed half the items" [3P] |
| CarSnipe | FB car alerts run locally | Desktop browser | FB Marketplace | $24.99/mo [1P] | "3-minute" (page title) [1P] | — | n/a | Uses the user's own FB session |
| SearchTempest | Classifieds meta-search | web | Craigslist, FB Marketplace, eBay [1P] | Free | Craigslist alerts gone with CL RSS [1P] | — · ✓ driving distance · — · — | n/a | Upstream dependency |
| Gixen | eBay sniper | web, iOS, desktop | eBay | Free (4 wins/mo); Mirror $11.99/yr [1P] | — | — | Server snipe 3–15 s; group bidding [1P] | eBay authorisation expiry (forum) [1P] |
| AuctionSniper | eBay sniper | web, Android | eBay | 1.95%, min $0.35, max $35 [1P]; other figures differ | — | — | Server snipe | — |
| eSnipe | eBay sniper | web | eBay | 1% to $1,000, then $10 [3P] | — | — | Server snipe | — |
| Bidnapper | eBay sniper | web | eBay | $1.50/win · $4/mo · $49.99/yr [3P] | — | — | Server snipe | — |
| WorthPoint | Sold-price database | web, iOS, Android | 900M+ sold prices [3P] | $29.99/mo or $249.99/yr; higher tiers [3P] | — | — | n/a | Billing complaints [3P] |
| Terapeak | eBay research | web (Seller Hub), eBay app | eBay, up to 3 years [1P] | Free in Seller Hub [1P] | — | — | n/a | eBay only |
| 130point | Sold comps incl. hidden Best Offer prices | web, iOS, Android | eBay, Goldin, Heritage and others [1P] | Free [1P] | — | — | n/a | Card and collectible focus |
| PriceCharting | Game, card, comic prices | web, Android | — | Free; premium $4.99/mo or $39.99/yr; retailer ~$49/mo [3P, conflicting] | — | Lot value calculator [1P] | n/a | Narrow categories |
| CoinSnap | Coin ID and value | iOS | Coins | $39.99/yr after 7-day trial [3P] | — | ✓ image | n/a | Inconsistent values [3P] |
| Google Lens | Visual search | Android, iOS, web | General | Free | — | ✓ image | n/a | No sold prices; weak on obscure items [3P] |

---

## 3. Per-competitor notes

Each entry covers: what it is and who it serves · platforms · coverage · pricing ·
alerts · search · bidding · strengths · documented weaknesses · take-away for
Skeuos. "—" means not found in this pass. Full URLs are in §9.

### 3.1 Private auction platforms

#### HiBid
- **What / who:** hosted bidding for independent auction houses, on the
  AuctionFlex back end; the app developer is listed as 402 Ventures LLC. The app
  listing claims "thousands of live and online auctions" in the US, Canada and
  elsewhere [3P]. This is the highest-leverage Wisconsin source (`01-sources.md`).
- **Platforms:** iOS, Android, web [3P]. HiBid also offers auction companies their
  own branded apps [1P].
- **Coverage:** per-house tenants, with a state hub at `hibid.com/wisconsin` [1P].
- **Pricing:** free to bid. The premium is set by each house, "typically …
  10–18%, … sometimes with a few percent extra for online bidding" [3P, GhostNode].
- **Alerts:** push for upcoming events, watched and bid-on lots, and outbids [3P].
  A notification settings page exists at `hibid.com/notifications/manage` [1P].
  How saved-search alerts work: —.
- **Search:** browse and search catalogues [3P]. Radius, NL, image: —.
- **Bidding:** absentee (proxy) bids ahead of live sales, and live bidding [3P].
  Soft close: a HiBid-hosted auctioneer's FAQ says a bid "in the final minutes"
  extends the lot "for an additional 3 minutes", and this "will continue until all
  the bids have stopped" [1P]. Stagger and soft close are AuctionFlex settings [1P].
- **Strengths:** breadth of small houses; outbid push inside its own app.
- **Documented weaknesses:** not mined this pass (gap).
- **Take-away:** HiBid's own app already handles outbid and watch notifications.
  Skeuos cannot see a user's bids without logging in, so it should *hand off*
  outbid alerts ("turn on HiBid's outbid push for this lot") and own discovery,
  hunts and all-in cost.

#### K-BID
- **What / who:** online timed auctions from Maple Plain, Minnesota, run through
  affiliates. Markets itself as "Bid, Buy & Sell Nationwide" [1P].
- **Platforms:** web; app ?.
- **Coverage:** upper-Midwest core (`01-sources.md`).
- **Pricing, alerts, search, bidding:** —.
- **Ratings:** Birdeye 3.9★ from 637 reviews; Knoji 3.7/5 from 58 [3P].
- **Strengths:** reviewers value the "straightforward interface and streamlined
  payment process", and praise pickups: staff help loading, and "accommodating
  scheduled pick-up times" [3P].
- **Documented weaknesses:** "K-Bid as the host has no guidelines for third parties
  to follow when listing items, and they are not required to say if items are new,
  used, or damaged" [3P]. Affiliates "will not be forthcoming with pictures or
  descriptions" [3P]. One reviewer: "impossible to communicate with" [3P].
- **Take-away:** condition disclosure varies by affiliate, so flag "condition not
  stated". Scheduled pickup is a strength worth surfacing as a filter.

#### Proxibid
- **What / who:** a marketplace for many auction sellers [1P].
- **Platforms:** web; app ?.
- **Pricing:** the premium is "determined by the seller"; invoices itemise premium,
  taxes and shipping [1P].
- **Alerts:** Saved Search emails from proxibid@proxibid.com with the subject "New
  Items In Your Saved Search", at a chosen Email Frequency that includes Never [1P].
  Separate auction-alert management [1P].
- **Search:** saved searches managed from the dashboard [1P].
- **Bidding / weaknesses:** — / not mined (gap).
- **Take-away:** a frequency choice on each saved search is standard.

#### AuctionZip
- **What / who:** a directory of auctioneers' live and online auctions. The Android
  app ships under an Invaluable package name (`com.invaluable.auctionzip`) [1P].
- **Platforms:** iOS (id1412843982), Android, web [1P].
- **Pricing:** free alerts [1P].
- **Alerts:** email only. Searches "run overnight", and matches arrive "in a single
  email every morning" [1P]. Keyword and auctioneer alerts [1P].
- **Search:** ZIP code, radius dropdown, keywords, categories; the app adds date
  and auction house [1P].
- **Bidding:** live bidding from the app [1P].
- **Weakness:** next-morning latency, by design.
- **Take-away:** the incumbent directory's alert is a daily digest. A same-hour
  hunt is a visible upgrade for auction-house lots.

#### BidSpotter
- **What / who:** industrial and commercial auction catalogues, with US and UK sites [1P].
- **Pricing:** the premium is a percentage of hammer [1P].
- **Alerts:** email. Catalogues are searched daily; "unlimited emails" include
  images and lot details; the user picks frequency and days. One help article caps
  alerts at 30 and another at 50 (UNVERIFIED which is current) [1P].
- **Weakness:** daily latency; capped alert count.

#### LiveAuctioneers
- **What / who:** auctions of art, antiques and collectibles [1P].
- **Platforms:** iOS (id321243082), Android, web [1P].
- **Alerts:** "Follow Search" for new matches; push when saved or bid-on items are
  "almost up"; settings for "Email, Browser, and SMS" [1P].
- **Weakness signal:** a help article titled "Why am I not getting my Auction
  Alerts?" [1P]. The inference is that delivery problems recur; how often is
  UNVERIFIED. Review mining: gap.

#### Invaluable
- **What / who:** fine art and antiques. Alerts cover "Bonhams, Sotheby's and
  2,000+ other" houses [1P].
- **Platforms:** iOS, web; Android —.
- **Alerts:** "Follow this Keyword" → a daily email. Users can follow keywords,
  artists, sellers and categories [1P].
- **Take-away:** collectors expect to follow *sellers* and *artists*, not only keywords.

#### AuctionTime (Sandhills)
- **What / who:** online equipment auctions across North America; listings tie into
  TractorHouse, MachineryTrader and TruckPaper [1P].
- **Platforms:** iOS (id405124399), web [1P]; Android —.
- **Alerts:** push, email **and text** when a listing is two hours from close, and
  when the user is outbid [1P].
- **Bidding:** real-time bidding in the app; watch list; buyers can "contact
  equipment sellers directly by phone or email" [1P].
- **Also:** Sandhills sells hosted mobile apps to auctioneers [1P].
- **Take-away:** equipment buyers treat multi-channel pre-close reminders with a
  sensible default, plus one-tap seller contact, as table stakes.

#### Purple Wave
- **What / who:** no-reserve online auctions of ag and construction equipment,
  vehicles and municipal assets [3P].
- **Pricing:** a "capped internet buyer's fee (set per lot), and sellers may set
  their own fees" [3P]; forum reports of about 10% [3P].
- **Alerts:** saved searches exist at `purplewave.com/account/savedsearches` [1P];
  how they alert: —.
- **Scale:** GovAuctions.app counts 761 live Purple Wave listings nationally, 530
  of them in Missouri [3P].
- **Take-away:** store fee caps per lot, not per platform.

### 3.2 Government and surplus platforms

#### GovDeals / AllSurplus (Liquidity Services, NASDAQ: LQDT)
- **What / who:** the largest US marketplace for state and local government
  surplus [3P]. AllSurplus is the sister marketplace [3P].
- **Platforms:** web; app ?.
- **Coverage:** 116 of the 189 Wisconsin lots GovAuctions.app counts come from
  GovDeals [1P]. Another GovAuctions page shows 93 Wisconsin GovDeals listings;
  the counts move [1P].
- **Pricing:** set by each seller, "capped at 12.5% and typically lands in the
  7.5–12.5% range" [3P]. Since August 2025 payments run through Flywire, and card
  payments carry "a 2.5-3.5% bank surcharge on top of the buyer's premium" [3P].
  In mid-2025 GovDeals scrapped its old multi-level 90-day new-buyer probation [3P].
- **Alerts:** saved-search email via a checkbox, "Notify me via email when new
  results match this search"; on or off per search; format **Digest or
  Individual**; trigger on **New, Updated, or New & Updated** [1P]. On-site live
  notifications for wins, awards and payments [1P].
- **Bidding:** soft close; one guide says GovDeals extends the close "by 2-5
  minutes" when a late bid arrives [3P]. The exact window is UNVERIFIED.
- **Weaknesses:** stacked fees [3P]. A Garage Journal thread titled "GovDeals....
  Is this lot too good to be true?" shows buyers second-guessing listings (title
  only). Review mining: gap.
- **Take-away:** copy the Digest/Individual and New/Updated controls, and model
  the card surcharge in all-in cost.

#### Public Surplus
- **What / who:** state, local and school surplus [3P].
- **Platforms:** web, with a mobile site [1P].
- **Alerts:** an "alert list" in the user profile emails matches as items appear
  [3P, county page].

#### Municibid
- **What / who:** a government surplus marketplace, strongest in the Northeast.
  GovAuctions.app counts 323 listings in Pennsylvania and 120 in Massachusetts [3P].
- **Platforms:** iOS (id6773067678), Android, web [1P], and a **ChatGPT app** [1P].
- **Pricing:** a buyer's fee tiered at 9% up to $99,999.99, 6% up to $499,999.99,
  and 4% above that [3P].
- **Alerts:** saved searches and alerts in the app; outbid and closing-soon
  notifications [1P].
- **Search:** the ChatGPT app lets users "search active Municibid auctions, review
  public listing details, compare historical sold auctions, view public agency
  summaries, and get rough market value estimates". "All bidding and transactions
  still happen on Municibid.com" [1P].
- **Bidding:** max bids, watchlists [1P].
- **Take-away:** a source has already shipped conversational search and comps on
  its own data. NL search alone will not set Skeuos apart; NL hunts that span
  sources might.

#### GSA Auctions
- **What / who:** federal personal-property surplus [1P].
- **Platforms:** web, described as refreshed and mobile-friendly [3P].
- **Pricing:** no buyer's premium; a free account; a refundable deposit before
  bidding on most vehicles [3P].
- **Alerts:** GSA "may use your registered email" for "notifications about
  auctions that match your bidding history" (RealEstateSales.gov) [1P]. GSA's
  Office of Evaluation Sciences ran a randomised trial: emails to registered users
  who had bought similar items, aimed at lots that would otherwise close with no
  bids [1P]. Results: not retrieved.
- **Search:** third-party guides say gsaauctions.gov "lacks geo-filtering and
  saved searches" [3P, UNVERIFIED].
- **Bidding:** proxy (auto) bids; a My Bids dashboard [3P].
- **Take-away:** GSA itself treats "tell past buyers of similar items" as the fix
  for no-bid lots. Hunts have seller-side value too.

#### Bid4Assets
- **What / who:** county tax and sheriff sales, and the US Marshals' online
  forfeiture auctions [1P].
- **Pricing:** a premium of up to 10% [3P]. Deposits vary by sale — examples are
  $1,500 for a tax sale and $10,000 for a mortgage foreclosure — refunded minus a
  processing fee of about $35 [3P].
- **Alerts:** weekly email alerts [3P].
- **Take-away:** deposits gate bidding. Surface them before a user commits.

#### US Treasury seized real property (CWS Asset Management & Sales)
- Operates in all 50 states. Auctions are open to the public "with no buyer's
  premiums charged", and email updates arrive "bi-monthly" [1P].

#### US Marshals Service
- Forfeited property is sold through a contractor's online auctions (a Bid4Assets
  storefront) and listed at usmarshals.gov/assets [1P].

#### Wisconsin Surplus Online Auction
- The State of Wisconsin's contracted online-auction vendor, based in Mount Horeb
  [1P]. Premium "0–10%, set per seller (median ~7%)" [3P]. GovAuctions.app names it
  as a tracked source [3P].

### 3.3 Aggregators: the direct competitors

#### GovAuctions.app (closest competitor)
- **What / who:** "a free, independent search engine for U.S. government surplus
  auctions", built and run by Ben Wallace. It is not an auction site; every result
  links out to bid [1P]. Its audiences are casual browsers and serious resellers
  [3P, HN].
- **Platforms:** web. The "GovAuctions.com – Shop Surplus" apps belong to
  GovAuctions.com, which GovAuctions.app describes as an **unrelated** private
  marketplace [1P].
- **Coverage:** the US, later the UK, Canada and Australia [3P, HN]. Its source
  counts differ by page — "16 platforms", "24 sources", "32 … sites we track", and
  "61,392 … from 42 sources" [1P] — and which is current is UNVERIFIED. Wisconsin:
  189 lots [1P].
- **Pricing:** free; **Pro $7/mo** [1P].
- **Alerts:** email; **3 alerts free**, unlimited in Pro [1P]. Latency: —.
- **Search:** filters for location, category and price; a watchlist; an AI auction
  assistant in Pro [1P].
- **Bidding aids (Pro):** a recommended max bid "after the buyer's premium, tax,
  and resale fees"; sold comps; a resale-margin estimate; a 0–100 Flip Score with
  the 25th/median/75th-percentile band; a demand meter; and an end-game forecast of
  the closing-price range and bidder count [1P]. Comps draw on 300,000+ completed
  sales [1P].
- **Strengths:** shipped fast; reached the HN front page in April 2026, and claims
  "tens of thousands" of users since [1P]; programmatic SEO pages per state and
  platform; a legitimacy page.
- **Documented weaknesses:** government only; thin in Wisconsin; its own pages
  disagree on source counts; Trustpilot 4★ from only 6 reviews [3P].
- **Take-away:** $7 is the Pro price anchor. Its Pro features (max bid, band,
  demand meter) are the bar to clear. It also shows that "rival intelligence" sells
  in *aggregate* form.

#### BidProwl
- **What / who:** one search across government and some private auction sources,
  linking out to bid [1P].
- **Platforms:** web, plus a **REST API and MCP server** with a free tier of 1,000
  calls a month [1P].
- **Coverage:** 26 sources pulled "every 12 hours" (elsewhere "27 sites") [1P]:
  federal (GSA, GSA Fleet, DLA, IRS, US Marshals, HUD, USPS); platforms (GovDeals,
  GovPlanet, PublicSurplus, Municibid, Bid4Assets, PropertyRoom, GovLiquidation);
  "aggregators" (HiBid, Proxibid, AuctionZip, Purple Wave, Ritchie Bros, JJ Kane);
  and real estate (Auction.com, HomePath, HomeSteps, Hubzu, Williams & Williams)
  [1P]. Listing counts range from 46,000 to 75,000+ depending on the page [1P].
- **Pricing:** search, email alerts and the deal score are free. **Pro is $9/mo or
  $79/yr**, adding instant alerts, live bids on closing auctions, sold comps from
  226,000+ closed auctions, and AI-assisted search [1P].
- **Alerts:** free alerts wait for the next morning's digest; Pro checks "every 30
  minutes through the auction day" [1P].
- **Search:** state and category hubs; search "within driving distance of your ZIP" [1P].
- **Bidding aids:** a 0–100 deal score comparing the current bid with the 90-day
  median sold price for similar items in the same category and state [1P].
- **Weaknesses:** listings are pulled every 12 hours, though bid updates are
  claimed every 10 minutes [1P]; no estate-sale platform in its source list [1P].
- **Take-away:** an API or MCP tier, and an annual price under $80, are already
  normal in this niche.

#### "I aggregated 28 US Government auction sites into one search" (HN, spring 2026)
- Identity UNVERIFIED. It claims 180,276 active listings normalised into Postgres
  full-text search, and about 53,000 new listings a week [3P, HN]. A commenter asked
  "Clone of 'GovAuctions' from 3 weeks ago?" [3P].
- **Take-away:** a competent clone can appear within weeks. Aggregation alone is
  not a moat.

#### GhostNode (ghostnode.co)
- Publishes auction-fee guides, such as a buyer's premium explainer that puts HiBid
  at 10–18% [1P]. What the product itself does is UNVERIFIED.

#### GovernmentAuctions.org
- A long-running state-by-state listing site with a "no fee auction search" [1P,
  URL]. Its model and current status are UNVERIFIED.

#### DIY monitors used by power users
- **PageCrawl.io:** paste a filtered results URL and it detects new lots, price
  changes and closing-soon lots, alerting via Telegram, Discord, Slack or email [1P].
- **Apify actors** exist for HiBid, BidSpotter, Bid4Assets, Municibid, PublicSurplus,
  GSA and AuctionZip. Several are exposed as MCP servers, and one sends an email
  digest of new PublicSurplus lots [1P]. Open-source MCP servers exist for GSA
  Auctions and government auctions generally (pipeworx) [1P].
- **Take-away:** power users already build their own pipelines. Webhook, Discord
  and Telegram delivery belong in Dealer.

### 3.4 Estate sales

#### EstateSales.NET
- **What / who:** the largest estate-sale listing site; a competitor's guide ranks
  it first for estate depth [1P, GarageSaleGuide].
- **Platforms:** iOS (id1018443930), Android, web [1P].
- **Alerts:** favouriting a sale brings email when it is updated or photos are
  added, plus a reminder before it starts. Smart Notifications fire when favourite
  companies post a sale; push covers date changes and newly added items [1P]. It
  claims "over 4.5M email notifications" a week [1P].
- **Search:** custom filters and favourites; users choose when, for what type of
  sale and where they are notified [1P].
- **Weaknesses:** not mined (gap).
- **Take-away:** "follow the company" and "tell me when photos are added" are core
  estate-sale behaviours.

#### EstateSales.org
- **What / who:** estate, garage and yard sales, plus online auctions [1P].
- **Platforms:** the buyer app "Estate Sale Finder" on iOS (id6657955340) and
  Android; a separate seller app; web [1P].
- **Alerts:** push for new sales within a chosen radius; alerts when favourite
  companies post; customisable reminder times for saved sales; email at a chosen
  frequency [1P].
- **Search:** keyword, interactive map, distance. Users who don't share GPS can
  enter a location manually, and the app reads location only while open [1P].
- **Take-away:** privacy-respecting location and custom reminder times are cheap wins.

#### EstateSale-Finder.com
- An estate-sale site "established in 2014" with email alerts [3P].

#### EstateSaleFinder.net (a different company)
- An AI marketplace for estate sales, garage sales and vintage shops: AI-generated
  labels and prices, wishlist alerts, **free unlimited AI photo appraisals**, and
  10 live market-price checks a month [1P].
- **Take-away:** photo appraisal is already free. Charging for it will be hard.

#### MaxSold
- **What / who:** online estate-sale auctions in the US and Canada [1P].
- **Pricing:** an **18% buyer's premium** that is itself taxable, since tax applies
  to hammer plus premium [1P]. Sellers pay 30% plus a $2,000 flat fee (Partner
  Managed) or the greater of 30% and $99 (Seller Managed) [1P].
- **Bidding:** a two-minute soft close on each lot; lots close 10 seconds apart [1P].
- **Ratings:** SmartCustomer 3.1/5 from 986 reviews [3P].
- **Strengths:** reviewers praise "the efficiency of the cataloging and website" [3P].
- **Documented weaknesses:** the premium is called "extortionist"; a single pickup
  date ("if you can't make the one & only date, you have lost your money");
  inaccurate descriptions; a $30 refund fee; rude pickup staff [3P].
- **Take-away:** the all-in calculator must tax the premium where that applies, and
  single-date pickups need a warning.

#### AuctionNinja
- **What / who:** estate sales and auctions, with pickup or shipping [3P].
- **Pricing:** each seller sets the premium. "18% is the site average and the most
  commonly charged rate", with most between 10% and 20%; AuctionNinja takes no cut
  of the premium [1P].
- **Bidding:** has an extended-bidding rule (help article) [1P]; details —.
- **Strengths:** "easy to navigate", with many auctions carrying "reasonable buyers
  premium percentages"; some pickups "quick and simple" [3P].
- **Documented weaknesses:** a pickup described as chaotic, with cars parked
  anywhere and items that could not be found; reports of weeks of unanswered calls
  and emails [3P].

#### CTBids
- **What / who:** franchise-run online estate sales [3P].
- **Platforms:** iOS (id6467594552), web; Android —.
- **Pricing:** commissions "up to 20%" [3P].
- **Ratings:** SmartCustomer 1.4/5 from 96 reviews; PissedConsumer 2.0 from 29 [3P].
- **Documented weaknesses:** shipping complaints (over $16 to ship a coin; over $60
  for a 1.7 lb pitcher; a $9.32 box charge); "$15 per pickup per person" at some
  locations; alleged AI photos, and a "14k gold" necklace that tested at 84% copper;
  "Damaged items or misrepresented items are always the buyer's fault in their
  system and there is no recourse" [3P].
- **Take-away:** shipping and pickup fees belong in all-in cost, and listings need
  trust flags.

#### MapMySales (publisher of GarageSaleGuide)
- A web app installed as a PWA, with no app store [1P]. A free tier, and **Plus at
  $5.99/mo** for full source coverage, alerts, match scoring, unlimited stops and
  route optimisation [1P]. Its own guide ranks it second, behind EstateSales.NET,
  and discloses the conflict [1P].
- **Take-away:** a PWA can ship without app review, and buyers accept route
  optimisation as a paid feature.

### 3.5 Garage and yard sales

#### Yard Sale Treasure Map
- iOS (id318649229), Android and web. Free, with a **$5 per year** upgrade: more
  location, day and keyword search; a driving mode; route optimisation for up to 25
  sales; "viewed" checkmarks; sale notes; no ads; exact locations for unlisted
  sales [1P]. Aggregates Craigslist, GSALR and user submissions, and sends routes
  to Google Maps, Waze or Apple Maps [1P].
- **Take-away:** route planning and "already viewed" markers are expected, and cheap.

#### GSALR
- Garage-sale listings with an Android app [1P]. Details: —.

### 3.6 Marketplace alert tools (Facebook Marketplace, Craigslist, OfferUp)

#### Swoopa
- **What / who:** fast alerts on private-party deals, aimed hard at car flippers [1P].
- **Platforms:** iOS (id6475300269), Android, web [1P].
- **Coverage:** Facebook Marketplace, Craigslist, OfferUp, Kijiji, Gumtree,
  Nextdoor, eBay [3P].
- **Pricing:** Go $47/mo, Turbo $144/mo, Nitro $352/mo; committed plans "save over
  40%" [1P]. A competitor lists committed prices of $28, $99 and $199 [3P]. A 7-day
  free trial [1P].
- **Alerts:** keyword slots traded against speed — for example 2 keywords at
  1-minute checks, 5 at 3 minutes, 4 at 5 minutes, 8 at 9 minutes. The top tier is
  "instant", with 18 or 22 keywords depending on the source (UNVERIFIED) [1P].
  Price-drop alerts and AI deal evaluation on higher tiers [3P].
- **Strengths:** support that answers the phone; users say alerts put them "first
  in line" [3P].
- **Documented weaknesses:** alerts promised at 1–3 minutes arriving 15+ minutes
  late; after the trial, alerts for only a quarter of listings, up to three hours
  late; loose filters; cost out of proportion to value [3P]. A competitor blames
  the delays on Facebook's anti-bot detection forcing proxy rotation [3P, biased source].
- **Take-away:** users will pay a lot for speed, and punish silent degradation hard.

#### Flipify
- iOS (id6504143452) and Android, covering Facebook Marketplace, eBay, Craigslist,
  OfferUp, Kijiji and Vinted [1P]. **Basic $5/mo with 10-minute checks, Premium
  $10/mo with 1-minute checks** [3P]. iOS rating 3.9/5 from 41 ratings [3P].
  Reviews include "Definitely worth the $20 a month" (which suggests earlier
  pricing) and "has missed half the items it was supposed to find and when it did
  find a listing, it wasn't any faster than the alert I got from Facebook
  marketplace" [3P].

#### CarSnipe
- Runs checks locally in the user's own browser session; $24.99/mo [1P]. It argues
  that cloud tools that log into Facebook on users' behalf are a security risk and a
  terms violation [1P, competitor's claim].

#### SearchTempest
- Free meta-search over Craigslist, Facebook Marketplace and eBay, by state or
  driving distance [1P]. When Craigslist discontinued RSS, SearchTempest's alert
  shortcut stopped working, and it "doesn't have direct access to Craigslist's
  data, so they can't offer their own alerts" *(paraphrase of a support answer)* [1P].
- **Take-away:** the clearest example of an upstream decision killing an
  aggregator's core feature overnight.

#### Seen, not researched
- SeeSpotBid (eBay search alerts) [1P]; JDMarket, billed as a "free Swoopa
  alternative" [1P]; Marketplace Monitor (cloud-based, per CarSnipe) [3P].

### 3.7 eBay sniping tools

#### Gixen
- Free tier: 4 winning snipes a month, placed server-side; "group bidding", where
  the first successful snipe cancels the rest [1P]. **Mirror, $11.99 a year:**
  snipes from two hosting locations, end times refreshed hourly rather than daily,
  CSV import and export, snipe offsets of 3–15 seconds, no ads [1P]. Earlier pricing
  was $6 a year recurring or $8 one-off [3P, eBay community]. iOS app
  (id6446328339) [1P]. SmartCustomer 4.0/5 from 507 reviews [3P]. Its forum has a
  thread on "ebay authorization expiration" [1P].

#### AuctionSniper
- 1.95% of the final price, with a $0.35 minimum and $35 maximum; three free snipes
  [1P]. Other sources give 1.75%, and 1.5% capped at $14.99 (UNVERIFIED which is
  current) [3P]. Android app [1P].

#### eSnipe
- 1% of the winning price up to $1,000, then a flat $10 [3P].

#### Bidnapper
- $1.50 per win prepaid, $4 a month unlimited, or $49.99 a year [3P].

#### EZsniper
- 1% per win, or $79.99 a year [1P].

#### BidSlammer
- "There are over 50 ways you can lose a snipe, and we track almost all of them"
  [1P]. The minimum bid increment is "the number one reason for a
  misunderstanding" *(paraphrase)* [1P].

#### eBay context
- eBay allows sniping, including by software [1P]. The Offer API (`placeProxyBid`)
  is Limited Release, "available only to select developers approved by business
  units" [1P]. eBay community threads ask for a soft close on eBay itself (titles only).
- **Take-away:** on eBay, a reminder with a human in the loop can't match a
  server-side sniper. Where a user wants that, point them to one — and, if Gixen's
  CSV format allows, export to it (format UNVERIFIED).

### 3.8 Price and comps tools

#### WorthPoint
- **Pricing:** Standard $29.99/mo or $249.99/yr; All Access about $46.99/mo; Pro
  $59.99/mo; Business from $36.83 per user per month, billed annually; a 7-day
  trial [3P]. Its Worthopedia holds 900M+ sold prices [3P].
- **Documented weaknesses:** charges after cancelling; hard to cancel; one user
  charged both $195 and $259.99; no "trial ending in 24 hours" reminder; the $29
  monthly fee called "an outrageous charge for a mediocre to low production app"
  *(paraphrase)* [3P].

#### Terapeak
- Free for eBay sellers in Seller Hub, and now in the eBay app too. Up to three
  years of sold data, against 90 days in ordinary sold-listing search [1P/3P].

#### 130point
- Free. Reveals the eBay "Best Offer accepted" prices that eBay hides, and covers
  Goldin, Heritage, Fanatics Collect, MySlabs, Pristine and others. Free iOS and
  Android apps [1P].

#### PriceCharting
- A free price guide for games, cards and comics. Premium is reported at $4.99/mo
  or $39.99/yr, with a retailer tier around $49/mo; another source gives a range of
  "$6 and $99 per month" (UNVERIFIED) [3P]. Offers an API, CSV export on its top
  tier, and a **lot value calculator** [1P].
- **Take-away:** a "what is this bulk lot worth" calculator maps directly onto
  estate lots.

### 3.9 Image identification

#### Google Lens
- Resellers use it at estate sales as a quick first filter [3P]. Strong on
  well-documented, mass-produced pieces such as transfer-printed pottery, pressed
  glass, Wedgwood and Royal Doulton. Weak on obscure regional pottery, rare silver
  makers and folk art. It identifies what an item looks like, but does not return
  sold-price ranges for that exact variant [3P].

#### CoinSnap
- iOS (id1634551626). A 7-day trial, then $39.99 a year [3P]. Reviewers report
  values for one 2003 quarter "anywhere from .58 cents to $400". It "cannot reliably
  detect counterfeits" and is weaker on foreign and pre-17th-century coins. The
  camera fails to focus or hangs on "Identifying", and trials convert without
  notice [3P].

#### Seen in results, not researched
- AntiqueLens, Antique Identifier, NumiSnap, CoinSpot, Coin Identifier (app
  listings only).

### 3.10 Dead or degraded aggregators

| Case | What happened | Status |
|---|---|---|
| SearchTempest's Craigslist alerts | Craigslist ended RSS; SearchTempest's alert shortcut went with it, and it cannot offer its own Craigslist alerts [1P] | Verified via support-page excerpt |
| Swoopa (degraded, not dead) | Users report alert speed and coverage dropping; a competitor blames Facebook's anti-bot measures [3P] | Reviews plus a competitor's claim |
| Bidder's Edge | An early auction aggregator sued by eBay (eBay v. Bidder's Edge, N.D. Cal., 2000), which won a preliminary injunction on a trespass-to-chattels theory; Bidder's Edge later shut down | **UNVERIFIED** — background knowledge; searches for it hit the exhausted budget |
| 3Taps / PadMapper | Re-published Craigslist listings. A 2013 ruling held that continuing after a cease-and-desist and an IP block could be access "without authorization"; both later settled | **UNVERIFIED** — background knowledge |
| GovernmentAuctions.org | An older listing-site model | Status UNVERIFIED |

These lessons match `03-legal-and-tos.md`: carrying on after a cease-and-desist is
what loses cases; server load is a real claim; and a single upstream channel (an
RSS feed, a login session) is a single point of failure.

---

## 4. User pain themes

### 4.1 Theme counts

Counted as **distinct products** with evidence in this pass. "Complaint" means
users complaining. "Structural" means the product's documented behaviour produces
the problem.

| # | Theme | Products with user complaints | Products where it is structural | Distinct products |
|---|---|---|---|---|
| 1 | Missed or late alerts | Swoopa, Flipify | AuctionZip (overnight), BidSpotter (daily), Invaluable (daily), BidProwl free (next morning), Treasury (bi-monthly), Bid4Assets (weekly), SearchTempest (Craigslist alerts gone), LiveAuctioneers (help article) | **10** |
| 2 | Buyer's premium and fee surprises | MaxSold, CTBids | GovDeals (card surcharge), Municibid (tiers), Bid4Assets (deposits, refund fee), Purple Wave (per-lot fee), HiBid (10–18% by house), AuctionNinja (10–20%) | **8** |
| 3 | Unresponsive support and refunds | K-BID, MaxSold, AuctionNinja, CTBids, WorthPoint | — | **5** |
| 4 | Pickup logistics | MaxSold, AuctionNinja, CTBids | — (K-BID is praised) | **3** |
| 5 | Inaccurate descriptions, condition, photos | K-BID, MaxSold, CTBids | — | **3** |
| 6 | Subscription price and billing traps | WorthPoint, CoinSnap, Swoopa (price vs value) | — | **3** |
| 7 | Slow sites, weak search and filters | Government auction sites as a group (GovAuctions founder; counted once), Swoopa (loose filters) | GSA Auctions (no geo-filter or saved search, 3P) | **3** |
| 8 | Close rules that defeat last-second bidding | — | HiBid, GovDeals, MaxSold, AuctionNinja | **4** |
| 9 | Upstream or anti-bot dependency | Swoopa | SearchTempest; CarSnipe (claim) | **3** |
| 10 | Valuation and identification errors | CoinSnap | Google Lens | **2** |
| 11 | Snipe failures | — | BidSlammer (50+ failure modes); Gixen (eBay authorisation expiry) | **2** |
| 12 | App crashes and bugs | CoinSnap (focus, hangs) | — | **1** — HiBid, GovDeals, LiveAuctioneers and others not mined |
| 13 | Bid lag | — | — | **0** — not researched |
| 14 | Shill bidding | — | — | **0** — not researched |
| 15 | Notification spam | — | EstateSales.NET sends "over 4.5M" emails a week (volume, not a complaint) | **0** complaints found |

Rows 12–15 are gaps in coverage, not evidence that the problems are rare (§8).

### 4.2 Evidence by theme

**1 · Missed or late alerts**
- Flipify reviewer: "has missed half the items it was supposed to find and when it
  did find a listing, it wasn't any faster than the alert I got from Facebook
  marketplace." —
  [App Store reviews](https://apps.apple.com/us/app/flipify-marketplace-alerts/id6504143452?see-all=reviews&platform=iphone)
- Swoopa reviewers *(paraphrase)*: alerts promised at 1–3 minutes "take upwards of
  15 minutes"; after paying, notifications for "only a quarter of marketplace
  listings", taking "up to three hours". —
  [App Store reviews](https://apps.apple.com/us/app/swoopa/id6475300269?see-all=reviews&platform=iphone),
  [JustUseApp](https://justuseapp.com/en/app/6475300269/swoopa/reviews)
- SearchTempest *(paraphrase)*: with Craigslist RSS gone, "there's nothing for
  SearchTempest to link to", and it cannot offer its own Craigslist alerts. —
  [SearchTempest support](https://searchtempest.zendesk.com/hc/en-us/community/posts/7036274145171-What-happened-to-the-Alert-Feature-via-RSS)
- LiveAuctioneers help article: "Why am I not getting my Auction Alerts?" —
  [help centre](https://help.liveauctioneers.com/article/666-why-am-i-not-getting-my-auction-alerts)
- Latency by design: AuctionZip searches "run overnight"
  ([help](https://www.auctionzip.com/helpCenter/az-email-alerts.html)); BidSpotter
  searches daily ([alerts](https://www.bidspotter.com/en-us/auction-alerts));
  Invaluable emails daily
  ([alerts](https://www.invaluable.com/invaluable/overviewAuctionAlert.cfm));
  BidProwl free alerts "wait for the next morning's digest"
  ([pricing](https://bidprowl.com/is-bidprowl-legit)); Treasury updates are
  "bi-monthly"
  ([CWS FAQ](https://cwsmarketing.com/faqs/faqs-us-treasury-department-seized-real-property-auctions/)).

**2 · Buyer's premium and fee surprises**
- MaxSold *(paraphrase)*: a reviewer calls the 18% premium plus sales tax
  "extortionist"; another cites a $48.60 premium on a $270 purchase. MaxSold
  confirms the premium is taxable. —
  [Trustpilot](https://www.trustpilot.com/review/maxsold.com?page=2),
  [SmartCustomer](https://www.smartcustomer.com/reviews/maxsold.com),
  [MaxSold help](https://support.maxsold.com/hc/en-us/articles/203144004-What-does-buyer-s-premium-mean)
- CTBids *(paraphrase)*: over $16 to ship a coin; over $60 for a 1.7 lb pitcher;
  $48 of shipping that included a $9.32 box charge; "$15 per pickup per person" at
  some locations. —
  [SmartCustomer](https://www.smartcustomer.com/reviews/ctbids.com),
  [PissedConsumer](https://ctbids.pissedconsumer.com/review.html)
- GovDeals [3P guide]: card payments add "a 2.5-3.5% bank surcharge on top of the
  buyer's premium". — [GovAuctions guide](https://govauctions.app/guides/govdeals-faq)
- Bid4Assets [3P]: deposits before bidding, refunded minus about $35. —
  [Clever review](https://listwithclever.com/bid4assets-reviews/)

**3 · Unresponsive support and refunds**
- K-BID: "impossible to communicate with". —
  [BBB](https://www.bbb.org/us/mn/maple-plain/profile/online-auctions/k-bid-online-inc-0704-96008521/customer-reviews),
  [Knoji](https://kbidonline.knoji.com/)
- AuctionNinja *(paraphrase)*: "weeks of unanswered calls and emails". —
  [Trustpilot](https://www.trustpilot.com/review/auctionninja.com),
  [TechRaisal](https://www.techraisal.com/software/auctionninja/)
- MaxSold *(paraphrase)*: a seller refused a refund unless MaxSold charged a $30
  refund fee. — [SmartCustomer](https://www.smartcustomer.com/reviews/maxsold.com)
- CTBids: "Damaged items or misrepresented items are always the buyer's fault in
  their system and there is no recourse." —
  [ComplaintsBoard](https://www.complaintsboard.com/ct-bids-b144471),
  [SmartCustomer](https://www.smartcustomer.com/reviews/ctbids.com)
- WorthPoint *(paraphrase)*: one user charged both a discounted $195 and the
  standard $259.99. —
  [BBB](https://www.bbb.org/us/ga/atlanta/profile/antique-dealers/worthpoint-corporation-0443-27259399/complaints),
  [PissedConsumer](https://worthpoint.pissedconsumer.com/review.html)

**4 · Pickup logistics**
- MaxSold: "the seller is not obligated to offer a second pickup date so if you
  can't make the one & only date, you have lost your money." —
  [Trustpilot](https://www.trustpilot.com/review/maxsold.com?page=2),
  [ComplaintsBoard](https://www.complaintsboard.com/maxsold-b124671)
- AuctionNinja *(paraphrase)*: the pickup was chaotic, with "no direction";
  customers parked wherever they could, and items couldn't be located. Another
  reviewer found it "quick and simple with lots of staff". —
  [Trustpilot](https://www.trustpilot.com/review/auctionninja.com)
- CTBids: "$15 per pickup per person". —
  [SmartCustomer](https://www.smartcustomer.com/reviews/ctbids.com)
- K-BID (positive): staff help with loading, and scheduled pickup times are
  accommodated. — [Birdeye](https://birdeye.com/k-bid-online-auctions-150169529936335)

**5 · Inaccurate descriptions, condition, photos**
- K-BID: "K-Bid as the host has no guidelines for third parties to follow when
  listing items, and they are not required to say if items are new, used, or
  damaged." — [BBB](https://www.bbb.org/us/mn/maple-plain/profile/online-auctions/k-bid-online-inc-0704-96008521/customer-reviews),
  [no1reviews](https://online-auction-sites-usa.no1reviews.com/user-reviews/k-bid.html)
- CTBids *(paraphrase)*: "misrepresentation and AI photos"; a necklace "advertised
  as 14k gold weighing 1 oz" tested at 84% copper. —
  [PissedConsumer](https://ctbids.pissedconsumer.com/review.html),
  [App Store reviews](https://apps.apple.com/us/app/ctbids/id6467594552?see-all=reviews&platform=iphone)
- MaxSold *(paraphrase)*: items "misrepresented, broken, or missing parts". —
  [BBB](https://www.bbb.org/ca/on/kitchener/profile/estate-sales/maxsold-estate-sales-0117-70874/complaints)

**6 · Subscription price and billing traps**
- WorthPoint *(paraphrase)*: charged after cancelling; "next to impossible to
  cancel"; no "trial ending in 24 hours" reminder. —
  [App Store reviews](https://apps.apple.com/us/app/worthpoint/id1472512649?see-all=reviews&platform=iphone),
  [Trustpilot](https://www.trustpilot.com/review/www.worthpoint.com?page=4),
  [Underpriced AI](https://underpricedai.com/blog/worthpoint-review)
- CoinSnap *(paraphrase)*: a 7-day trial rolls into a yearly fee; charged after
  cancelling; no notice before the trial ended. —
  [App Store reviews](https://apps.apple.com/us/app/coinsnap-coin-identifier/id1634551626?see-all=reviews&platform=iphone),
  [LodPost](https://lodpost.com/coin-snap-21611)
- Swoopa *(paraphrase)*: many users find the cost "disproportionate to the value
  offered". — [JustUseApp](https://justuseapp.com/en/app/6475300269/swoopa/reviews)

**7 · Slow sites, weak search and filters**
- GovAuctions' founder, on Show HN: browsing government auctions was "extremely
  tedious", with "interminable page loading times" and a back button that goes all
  the way to the homepage. — [HN](https://news.ycombinator.com/item?id=47662945)
- Third-party guide: gsaauctions.gov "lacks geo-filtering and saved searches"
  (UNVERIFIED). — [BidProwl GSA FAQ](https://bidprowl.com/guides/gsa-auctions-faq),
  [GovAuctions GSA FAQ](https://govauctions.app/guides/gsa-auctions-faq)
- Swoopa *(paraphrase)*: alerts "for listings outside the price or mileage set". —
  [App Store reviews](https://apps.apple.com/us/app/swoopa/id6475300269?see-all=reviews&platform=iphone)

**8 · Close rules**
- HiBid auctioneer FAQ: a bid in the final minutes extends the lot "for an
  additional 3 minutes", continuing "until all the bids have stopped". —
  [Affordable Creations on HiBid](https://affordablecreationsto.hibid.com/content/faqs-testimonials)
- GovDeals [3P]: extends the close "by 2-5 minutes" when a late bid arrives. —
  [BidProwl guide](https://bidprowl.com/guides/how-government-auctions-work)
- MaxSold: a two-minute soft close, with lots staggered 10 seconds apart. —
  [MaxSold help](https://support.maxsold.com/hc/en-us/articles/203144064-What-does-soft-close-mean)
- AuctionNinja: extended-bidding rule. —
  [help](https://support.auctionninja.com/knowledge/what-is-extended-bidding)

**9 · Upstream dependency** — SearchTempest and Swoopa, above; and CarSnipe's
claim that cloud tools which log into Facebook violate its terms —
[CarSnipe](https://carsnipe.com/blog/best-facebook-marketplace-monitoring-tools-compared).

**10 · Valuation errors**
- CoinSnap: "price on coins are anywhere from .58 cents to $400 dollars in a 2003
  quarter". — surfaced from one of
  [App Store reviews](https://apps.apple.com/us/app/coinsnap-coin-identifier/id1634551626?see-all=reviews&platform=iphone),
  [JustUseApp](https://justuseapp.com/en/app/1634551626/coinsnap-value-guide/reviews)
  (exact page UNVERIFIED)
- Google Lens guides *(paraphrase)*: it can tell you what an item looks like, but
  not what that exact variant sells for. —
  [Antique Identifier](https://www.antiqueidentifier.org/google-lens-for-antiques-does-it-work/),
  [Finest Flips](https://finestflips.com/blog/google-lens-for-reselling.html)

**11 · Snipe failures**
- BidSlammer: "There are over 50 ways you can lose a snipe, and we track almost all
  of them." — [BidSlammer FAQ](https://bidslammer.com/faq/)
- Gixen forum thread "ebay authorization expiration ??" —
  [Gixen forum](https://www.gixen.com/forum/viewtopic.php?t=9200)

### 4.3 Public ratings snapshot

| Product | Rating | Where |
|---|---|---|
| K-BID | 3.9★, 637 reviews | Birdeye |
| K-BID | 3.7/5, 58 reviews | Knoji |
| MaxSold | 3.1/5, 986 reviews | SmartCustomer |
| CTBids | 1.4/5, 96 reviews | SmartCustomer |
| CTBids | 2.0, 29 reviews | PissedConsumer |
| Gixen | 4.0/5, 507 reviews | SmartCustomer |
| Flipify | 3.9/5, 41 ratings | iOS App Store (via excerpt) |
| Swoopa | 3.9 | grand-screen.com |
| GovAuctions.app | 4★, 6 reviews | Trustpilot |

All [3P]. The averages were not independently checked.

---

## 5. Pricing benchmarks

These are list prices only. **No data was found on conversion rates, paying-user
counts or revenue for any competitor**, so what people *actually* pay beyond list
price is UNVERIFIED.

### 5.1 Alerts and deal-finding

| Product | Free tier | Paid | What the money buys |
|---|---|---|---|
| GovAuctions.app | Search; 3 email alerts | Pro **$7/mo** | Unlimited alerts, max bid, comps, Flip Score band, demand meter, AI assistant [1P] |
| BidProwl | Search, next-morning email alerts, deal score | Pro **$9/mo or $79/yr**; API free up to 1,000 calls/mo | 30-minute alerts, live closing bids, comps, AI search [1P] |
| MapMySales | Yes | Plus **$5.99/mo** | Full sources, alerts, match scoring, route optimisation [1P] |
| Yard Sale Treasure Map | Yes | **$5/yr** | More search, driving mode, 25-stop routes, no ads [1P] |
| Flipify | Trial | **$5/mo** (10-min) · **$10/mo** (1-min) [3P] | Speed |
| CarSnipe | — | **$24.99/mo** [1P] | Speed, local-session model |
| Swoopa | 7-day trial | **$47 / $144 / $352 per mo**; committed ~$28 / $99 / $199 [1P/3P] | Speed × keyword slots, more marketplaces |
| AuctionZip, BidSpotter, Invaluable, Proxibid, GovDeals, EstateSales.NET/.org | Alerts free | — | Platforms subsidise alerts because they drive bids |

### 5.2 Sniping (eBay)

| Product | Price |
|---|---|
| Gixen | Free (4 wins/mo); Mirror $11.99/yr [1P] (earlier $6/yr [3P]) |
| AuctionSniper | 1.95% of price, $0.35 minimum, $35 maximum [1P]; other figures of 1.75% and 1.5% (UNVERIFIED) |
| eSnipe | 1% up to $1,000, then $10 [3P] |
| Bidnapper | $1.50/win · $4/mo · $49.99/yr [3P] |
| EZsniper | 1% per win, or $79.99/yr [1P] |

Snipers can charge per win because they place the bid and see the result.
Skeuos only deep-links, cannot observe wins, and so cannot use this model.

### 5.3 Comps and valuation

| Product | Price |
|---|---|
| Terapeak | Free (eBay Seller Hub) [1P] |
| 130point | Free [1P] |
| PriceCharting | Free; premium $4.99/mo or $39.99/yr; retailer ~$49/mo (UNVERIFIED; sources conflict) [3P] |
| WorthPoint | $29.99/mo or $249.99/yr; tiers at ~$46.99 and $59.99; business $36.83/user/mo [3P] |
| CoinSnap | $39.99/yr after a 7-day trial [3P] |
| EstateSaleFinder.net | Free unlimited AI photo appraisals; 10 free price checks/mo [1P] |
| Municibid ChatGPT app | Free (comps and rough values from Municibid data) [1P] |

### 5.4 Buyer's premiums (inputs for the all-in calculator)

Always store the premium **per lot**, from that lot's terms. These are typical
ranges only.

| Source | Premium | Label |
|---|---|---|
| GSA Auctions | None | [3P] |
| Treasury real property (CWS) | None | [1P] |
| eBay | None (sellers pay fees) | [3P] |
| Wisconsin Surplus | 0–10%, median ~7% | [3P] |
| GovDeals / AllSurplus | ≤12.5%, typically 7.5–12.5%; card surcharge 2.5–3.5% | [3P] |
| GovPlanet | 10–15% | [3P] |
| Municibid | 9% to $99,999.99 · 6% to $499,999.99 · 4% above | [3P] |
| Bid4Assets | ≤10%, plus deposits | [3P] |
| HiBid | Typically 10–18%, set by each house | [3P] |
| AuctionNinja | 10–20%; 18% most common | [1P] |
| MaxSold | 18%, and taxable | [1P] |
| CTBids | Up to 20% | [3P] |
| Purple Wave | Capped per-lot internet fee | [3P] |

### 5.5 What this means for Free / Pro $12 / Dealer $49

- **Free (3 hunts)** matches GovAuctions.app's 3 free alerts. BidProwl's free tier
  also includes search, alerts and a deal score. Keep the all-in calculator and a
  basic comps band free; both competitors give away comparable basics.
- **Pro at $12/mo** is 33% above BidProwl ($9) and 71% above GovAuctions.app ($7),
  and far below Swoopa ($47) and WorthPoint ($29.99). It holds only if Pro visibly
  includes what the $7–$9 products lack: estate-sale and private-house coverage,
  faster hunts, pickup planning, and close-rule-aware reminders. If it can't, lead
  with an annual price; BidProwl sets the reference at $79 a year.
- **Dealer at $49/mo** sits beside Swoopa Go ($47), PriceCharting's retailer tier
  (~$49) and WorthPoint Pro ($59.99). Flippers at that price pay for **speed,
  volume and data out**. Dealer should carry the fastest delivery target; SMS,
  webhook, Discord and Telegram delivery; API or MCP access (BidProwl gives 1,000
  calls a month free); and CSV export.
- **Tier on speed and channels, not only hunt count.** Every speed-sensitive
  competitor does. None of the auction incumbents charges for alerts at all.

---

## 6. Full improvement list

Every improvement found, grouped. **Evidence** points to §3–§5. **F** is
feasibility on a 1–5 scale. IDs are for reference only.

### 6.1 Search

| ID | Improvement | Evidence | F |
|---|---|---|---|
| S1 | NL query compiles into a hunt the user sees and edits (terms, exclusions, price, radius) before saving | Municibid ChatGPT app; BidProwl AI search; GovAuctions AI assistant; Swoopa loose-filter complaints | 4 |
| S2 | Drive-time (isochrone) radius, not only straight-line miles; keep the nearby OR in-state OR ships union and label why each lot matched | SearchTempest and BidProwl filter by driving distance; GSA lacks geo-filtering (3P). No competitor offering the union was found (absence UNVERIFIED) | 3 |
| S3 | Sort and filter by **all-in** price, maximum premium %, "no deposit", "pickup Saturday", "ships" | Premium and fee spread in §5.4; pickup complaints | 4 |
| S4 | Cross-source de-duplication, with one canonical lot page | GovAuctions markets de-duplicated results; SearchTempest added duplicate detection; one house can list on its own site, HiBid and AuctionZip | 4 |
| S5 | Follow a house, agency or estate company across every platform | EstateSales.NET and .org favourite companies; Invaluable sellers; LiveAuctioneers auctioneers — each single-site | 4 |
| S6 | Starter hunts from state and category hubs ("WI police vehicles", "mid-century furniture near Appleton") | BidProwl and GovAuctions state and category hubs; GovAuctions' busiest WI pickup cities | 5 |
| S7 | Typo and synonym expansion, plus learned negative terms, aimed at weak catalogue text | K-BID affiliates' thin descriptions; CTBids and MaxSold misdescriptions; `00-architecture.md` §5 | 4 |
| S8 | "Buyers of X also hunt Y" suggestions from past wins | GSA emails by bidding history; the GSA OES trial targeting past buyers of similar items | 3 |
| S9 | Value estimate for mixed bulk lots (games, cards, coins) | PriceCharting's lot value calculator | 2 |

### 6.2 Alerts (hunts)

| ID | Improvement | Evidence | F |
|---|---|---|---|
| A1 | Publish a delivery target per tier and measure it. Charge for speed only where speed decides (eBay fixed-price, short lots, newly posted estate sales) | Swoopa and Flipify price by speed; incumbents use daily digests for multi-day lots | 4 |
| A2 | Per-hunt heartbeat ("checked 1,240 new lots in the last hour, 0 matches") and a public per-source health page | Swoopa's silent degradation; SearchTempest; `source_health` already exists | 4 |
| A3 | Channels per hunt: push; email as digest or individual; SMS (Dealer); webhook, Discord or Telegram (Dealer) | GovDeals, LiveAuctioneers, AuctionTime, PageCrawl | 4 |
| A4 | Alert on **updates**, not only new lots: price drop, relist, date change, photos added, pickup window posted | GovDeals New/Updated; EstateSales.NET photo and date alerts; Swoopa price-drop alerts | 4 |
| A5 | Configurable pre-close reminders (default 2 hours and 15 minutes) | AuctionTime 2 hours; LiveAuctioneers "almost up"; Municibid closing soon; EstateSales.org custom reminder times | 5 |
| A6 | Quiet hours and daily caps per hunt | Proxibid frequency; BidSpotter chosen days. No spam complaints found, so this is design hygiene | 5 |
| A7 | Outbid hand-off: a link that turns on the source's own outbid push | HiBid, AuctionTime and Municibid alert outbids in-app; Skeuos can't see bids without logging in | 5 |
| A8 | Group hunts: "got one, silence the rest" | Gixen group bidding | 5 |
| A9 | Explain cadence at sign-up, so free users know theirs is a digest | BidProwl states free alerts "wait for the next morning's digest" | 5 |
| A10 | Photo-reference hunts: alert when something *looks like* this appears | Not found at any competitor in this pass (absence UNVERIFIED); `00-architecture.md` §6 | 3 |

### 6.3 Bidding

| ID | Improvement | Evidence | F |
|---|---|---|---|
| B1 | Store each source's close rule; reminders re-fire when a close extends; show per-lot close times on staggered sales | HiBid, GovDeals, MaxSold and AuctionNinja extend closes; MaxSold's 10-second stagger | 4 |
| B2 | Put the minimum next bid and the increment table in the reminder | BidSlammer: increments are the top cause of misunderstood snipes | 3 |
| B3 | Strategy text by close type: hard close (eBay) vs soft close ("set your true maximum; a last-second bid only extends the clock") | Soft-close evidence; eBay allows sniping | 5 |
| B4 | Recommended max bid from comps, all-in cost and the user's target margin | GovAuctions Pro "recommended max bid" | 4 |
| B5 | Rival intelligence as **aggregate demand** first (active bidders, closing-price forecast); per-alias profiles later, and only where aliases are verified to be public | GovAuctions Pro demand meter and end-game forecast; which platforms show bidder aliases is UNVERIFIED | 3 |
| B6 | Re-weight rival metrics for soft close: `median_snipe_seconds` means little when late bids extend the clock; chase ratio and bidder count matter more | Soft-close evidence vs `00-architecture.md` §9 | 4 |
| B7 | eBay: "send to your sniper" (e.g. Gixen CSV import) instead of competing on snipe timing | Gixen Mirror CSV import [1P], format UNVERIFIED; Offer API is Limited Release | 3 |
| B8 | Per-lot pre-bid checklist: registered? deposit posted? payment method and surcharge? | GSA deposits; Bid4Assets deposits; GovDeals' Flywire move | 4 |

### 6.4 Trust and data quality

| ID | Improvement | Evidence | F |
|---|---|---|---|
| T1 | Flags for "condition not stated", photo count, and very short descriptions | K-BID affiliates; MaxSold; CTBids | 4 |
| T2 | A house reputation panel linking public ratings (BBB, Trustpilot, SmartCustomer) | §4.3 ranges from 1.4/5 to 4.0/5 | 3 |
| T3 | Show values as a band with the number of comps and their date range; no single "worth" figure; no authenticity or grade claims | CoinSnap; Google Lens | 4 |
| T4 | Live, timestamped coverage counts per source, never a static marketing number | GovAuctions (16/24/32/42 sources) and BidProwl (26/27 sources; 46k–75k listings) contradict themselves across pages | 5 |
| T5 | A "how we make money; we never take bids or payments" legitimacy page | GovAuctions and BidProwl both publish "Is it legit?" pages; GovAuctions says there are "no bid packs, credits, or 'pay to access' schemes" | 5 |
| T6 | User reports on bad listings ("not as described", "AI photo") feeding the house panel | CTBids AI-photo allegations; feasibility of automated AI-image detection UNVERIFIED | 3 |
| T7 | Scam-safety notes on Facebook Marketplace and Craigslist deep links | ProPublica investigation of Marketplace scams (title seen only) | 5 |

### 6.5 Cost transparency

| ID | Improvement | Evidence | F |
|---|---|---|---|
| C1 | All-in on every card: premium, tax on the premium where it applies, card surcharge, and known box, shipping and pickup fees | MaxSold, GovDeals, CTBids | 4 |
| C2 | Reverse calculator: all-in budget → maximum bid | GovAuctions paywalls a version of this | 5 |
| C3 | Tiered and capped premium logic | Municibid tiers; Purple Wave caps (§5.4) | 4 |
| C4 | Disclose deposits and refund fees | Bid4Assets | 4 |
| C5 | "Pickup only" vs "ships" badge, with a shipping-cost warning when the house ships | CTBids shipping complaints | 4 |
| C6 | Keep C1 and C2 free | Trust; competitors charge for similar tools | 5 |

### 6.6 Pickup and logistics

| ID | Improvement | Evidence | F |
|---|---|---|---|
| P1 | Pickup windows as first-class data: badge, filter, and a warning on single-date pickups | MaxSold's one-date pickup | 3 (needs per-source extraction) |
| P2 | Overlap and distance warnings across watched or won lots | Pickup complaints | 4 |
| P3 | Calendar export (ICS) for close times and pickups | Not seen in any product reviewed | 5 |
| P4 | Route planner for estate-sale Saturdays and multi-lot pickups, handing off to Google Maps, Waze or Apple Maps | Yard Sale Treasure Map (25 stops, $5/yr); MapMySales ($5.99/mo) | 3 |
| P5 | Pickup-fee flags | CTBids, $15 per pickup | 4 |
| P6 | Where the pickups are this week ("Appleton: 23 lots") | GovAuctions' busiest WI pickup cities | 5 |
| P7 | One-tap seller contact, where published | AuctionTime | 4 |

### 6.7 Mobile UX

| ID | Improvement | Evidence | F |
|---|---|---|---|
| M1 | Instant back navigation to the same scroll position and filters; fast first results | The HN complaint about government sites | 5 |
| M2 | Ship the web app as an installable PWA first; go native later | MapMySales runs as a PWA | 4 |
| M3 | Driving mode and route hand-off | Yard Sale Treasure Map | 3 |
| M4 | Manual ZIP entry; location read only while the app is open | EstateSales.org | 5 |
| M5 | "Viewed" marks and private notes on lots | Yard Sale Treasure Map | 5 |
| M6 | Camera search with a timeout and a text fallback | CoinSnap hangs on "Identifying" | 4 |
| M7 | Deep links that open the source's app when it is installed | Which sources support app links is UNVERIFIED | 3 |

### 6.8 Onboarding

| ID | Improvement | Evidence | F |
|---|---|---|---|
| O1 | First hunt from a template in under a minute | S6 hubs | 5 |
| O2 | Per-source "how to bid here" cards: registration, deposits, payment, premium, close rule | GovDeals' 2025 changes; GSA deposits; Bid4Assets | 4 |
| O3 | No card for Free; a reminder 24 hours before a trial converts; one-tap cancel | WorthPoint, CoinSnap | 5 |
| O4 | State the tier's alert cadence during setup | A9 | 5 |
| O5 | Link the legitimacy page from onboarding | T5 | 5 |

### 6.9 Monetisation

| ID | Improvement | Evidence | F |
|---|---|---|---|
| $1 | Differentiate tiers on speed and channels, not only hunt count | Swoopa, Flipify, BidProwl | 5 |
| $2 | Offer annual plans; consider an annual Pro price that competes with BidProwl's $79/yr | BidProwl, WorthPoint, Gixen and PriceCharting all sell annual plans | 5 |
| $3 | Justify Pro at $12 against $7–$9 competitors with estate and private coverage, pickup planning and close-aware reminders — or lower it | §5.5 | 5 |
| $4 | Dealer: API and MCP server, CSV export, webhooks | BidProwl API and MCP; PriceCharting and Gixen CSV | 3 |
| $5 | Distribution through AI assistants (a ChatGPT app or public MCP server) as an acquisition channel | Municibid ChatGPT app; BidProwl MCP | 3 |
| $6 | Later B2B: anonymised demand insights for Wisconsin houses and agencies ("37 hunters want skid steers within 60 miles"), guarding neutrality | The GSA OES no-bid problem; Sandhills sells apps to auctioneers; EstateSales.NET and LiveAuctioneers sell advertising | 2 |
| $7 | Programmatic SEO pages per WI county, city and source, with live counts | GovAuctions' and BidProwl's state and platform pages are their acquisition engine | 4 |
| $8 | Don't copy sniper per-win pricing, because Skeuos cannot observe wins | §5.2 | — |

---

## 7. Risks

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | **Terms-of-service and legal exposure** | See `03-legal-and-tos.md` (hiQ, Van Buren, Ryanair). CarSnipe asserts that cloud tools logging into Facebook for users violate Facebook's terms [competitor's claim] | Keep Facebook Marketplace and Craigslist deep-link only; never log in to crawl; comply with a cease-and-desist immediately |
| R2 | **An upstream change kills a feature overnight** | SearchTempest lost Craigslist alerts when RSS ended [1P] | Prefer official APIs and public pages to single fragile channels; show per-source health; never market a feature that depends on one upstream you don't control |
| R3 | **Anti-bot degradation looks like a broken product** | Swoopa's late and missing alerts, blamed by a competitor on Facebook's anti-bot measures [3P] | Polite crawling (`schedule.ts`); a visible heartbeat; publish only delivery targets you can meet |
| R4 | **Sources build their own AI and aggregation** | Municibid's ChatGPT app [1P]; Liquidity Services runs both GovDeals and AllSurplus; Sandhills sells hosted apps to auctioneers [1P] | Win on cross-source coverage and Wisconsin depth, which no single source can offer |
| R5 | **Commoditised scraping; clones within weeks** | Apify actors and MCP servers for HiBid, BidSpotter, Bid4Assets, Municibid, PublicSurplus and GSA [1P]; "Clone of 'GovAuctions' from 3 weeks ago?" [3P] | The moat is hunt quality, all-in cost, pickup logistics, estate coverage and closed-lot history |
| R6 | **Direct competitors already shipped the core** | GovAuctions.app Pro $7; BidProwl Pro $9 with API and MCP [1P] | Don't lead with government-only (§1, #3) |
| R7 | **Valuation liability** | CoinSnap's inconsistent values and no counterfeit detection [3P] | Bands with counts and dates; an explicit "not an appraisal"; no authenticity claims |
| R8 | **Billing reputation** | WorthPoint and CoinSnap complaints [3P] | O3; follow app-store auto-renew rules; take counsel on state auto-renewal law (specifics UNVERIFIED) |
| R9 | **Brand collision** | GovAuctions.app vs the unrelated GovAuctions.com [1P] | Check for similarly named auction marketplaces before launch (see `02-naming.md`) |
| R10 | **Privacy of rival profiling** | `00-architecture.md` §9 plans per-alias profiles; which platforms expose aliases is UNVERIFIED; GovAuctions sells aggregate demand instead [1P] | Ship aggregate signals first (B5), and keep the "never resolve an alias to a person" rule |
| R11 | **Marketing numbers that drift** | GovAuctions and BidProwl contradict their own source and listing counts [1P] | T4: live, timestamped counts only |
| R12 | **Precedent from dead aggregators** | Bidder's Edge and 3Taps (UNVERIFIED, background knowledge): continuing after objections; server load | Rate limits, robots checks, and immediate compliance on objection, as `03-legal-and-tos.md` already sets out |

### Implications for the existing design docs (not edited here)

- `00-architecture.md` §6 calls image search "the feature nobody else has". Narrow
  that: photo *appraisal* is common and free (EstateSaleFinder.net, Google Lens).
  Photo search *over live lots across sources* was not found in this pass (absence
  UNVERIFIED).
- `00-architecture.md` §8 lists "sub-minute alerts" as a paid feature. For
  multi-day auctions, incumbents' users accept daily digests; sub-minute delivery
  matters mainly for eBay fixed-price items and newly posted estate sales. Price
  speed where it changes outcomes, and publish what you can deliver.
- `00-architecture.md` §9's `median_snipe_seconds` loses meaning on soft-close
  sources (HiBid, GovDeals, MaxSold, AuctionNinja). Tag the metric by close type.
- `00-architecture.md` §4 says "every competitor" ANDs location filters. This pass
  neither confirmed nor contradicted that: SearchTempest and BidProwl offer
  driving-distance modes, and no union of nearby, in-state and ships was found.

---

## 8. Gaps and next research pass

Not done, because the shared search budget ran out and page fetching was blocked.
Each item is a concrete task for the next pass.

1. **App Store and Google Play 1–3★ reviews** for HiBid, GovDeals, LiveAuctioneers,
   EstateSales.NET, K-BID, Proxibid, AuctionZip, MaxSold, AuctionNinja and the
   sniping apps. Only Swoopa, Flipify, CoinSnap, CTBids and WorthPoint have any
   review evidence here.
2. **Reddit:** r/Flipping, r/Auctions, r/estatesales, r/Frugal, and whether
   r/govdeals exists. Nothing was collected.
3. **BiggerPockets** threads on Bid4Assets, tax sales and government auctions.
   Nothing was collected.
4. **Themes with zero evidence:** bid lag, shill bidding, notification spam, and
   crashes in the auction apps.
5. **HiBid's saved-search capability**, and whether its alerts are push, email or
   both; whether HiBid and GovDeals currently ship native apps.
6. **Which platforms publicly show bidder aliases and bid histories.** This gates
   B5 and `00-architecture.md` §9.
7. **The GSA OES trial results:** did the alert emails reduce no-bid lots?
8. **Dead aggregators:** verify eBay v. Bidder's Edge and Craigslist v.
   3Taps/PadMapper, and look for other shut-down auction aggregators and their causes.
9. **Current prices where sources conflict:** AuctionSniper's percentage, Swoopa's
   keyword counts, PriceCharting's tiers, WorthPoint's tiers, BidSpotter's alert cap.
10. **Wisconsin inventory per source** (HiBid WI, K-BID WI, Wisconsin Surplus,
    EstateSales.NET WI), to put a real number on Skeuos's coverage edge.

---

## 9. Sources

Every URL below was **accessed 2026-09-27** as a web-search result excerpt. None
could be opened directly (§0).

### Direct aggregators and DIY monitors
- [GovAuctions.app — home](https://govauctions.app/) — accessed 2026-09-27
- [GovAuctions.app — About / is it legit](https://govauctions.app/about) — accessed 2026-09-27
- [GovAuctions.app — Is GovAuctions legit (2026)](https://govauctions.app/is-govauctions-legit) — accessed 2026-09-27
- [GovAuctions.app — Subscribe to Pro](https://govauctions.app/subscribe) — accessed 2026-09-27
- [GovAuctions.app — Sites we track](https://govauctions.app/sources) — accessed 2026-09-27
- [GovAuctions.app — Platform comparisons](https://govauctions.app/compare) — accessed 2026-09-27
- [GovAuctions.app — Wisconsin](https://govauctions.app/auctions/wisconsin) — accessed 2026-09-27
- [GovAuctions.app — Wisconsin real estate](https://govauctions.app/auctions/real-estate/wisconsin) — accessed 2026-09-27
- [GovAuctions.app — Wisconsin GovDeals](https://govauctions.app/platforms/govdeals/wisconsin) — accessed 2026-09-27
- [GovAuctions.app — Wisconsin Public Surplus](https://govauctions.app/platforms/publicsurplus/wisconsin) — accessed 2026-09-27
- [GovAuctions.app — Purple Wave](https://govauctions.app/platforms/purple-wave) — accessed 2026-09-27
- [GovAuctions.app — Missouri Purple Wave](https://govauctions.app/platforms/purple-wave/missouri) — accessed 2026-09-27
- [GovAuctions.app — Municibid](https://govauctions.app/platforms/municibid) — accessed 2026-09-27
- [GovAuctions.app — Pennsylvania Municibid](https://govauctions.app/platforms/municibid/pennsylvania) — accessed 2026-09-27
- [GovAuctions.app — Massachusetts Municibid](https://govauctions.app/platforms/municibid/massachusetts) — accessed 2026-09-27
- [GovAuctions.app — GovDeals FAQ](https://govauctions.app/guides/govdeals-faq) — accessed 2026-09-27
- [GovAuctions.app — GSA Auctions FAQ](https://govauctions.app/guides/gsa-auctions-faq) — accessed 2026-09-27
- [GovAuctions.app — Best government auction sites, ranked by fees](https://govauctions.app/guides/best-government-auction-sites) — accessed 2026-09-27
- [GovAuctions.app — GSA vs GovDeals vs Public Surplus](https://govauctions.app/guides/gsa-auctions-vs-govdeals-vs-public-surplus) — accessed 2026-09-27
- [GovAuctions.app — Complete guide to government surplus auctions](https://govauctions.app/guides/complete-guide-government-surplus-auctions) — accessed 2026-09-27
- [GovAuctions.app — How to flip government surplus](https://govauctions.app/guides/how-to-flip-government-surplus) — accessed 2026-09-27
- [GovAuctions.app — GovDeals alternatives](https://govauctions.app/guides/govdeals-alternatives) — accessed 2026-09-27
- [GovAuctions.app — Seized property auctions](https://govauctions.app/auctions/seized-property) — accessed 2026-09-27
- [GovAuctions.app — GSA vehicle auctions](https://govauctions.app/auctions/gsa-vehicle-auctions) — accessed 2026-09-27
- [Trustpilot — govauctions.app](https://ca.trustpilot.com/review/govauctions.app) — accessed 2026-09-27
- [Trustpilot — govauctions.com (unrelated)](https://www.trustpilot.com/review/govauctions.com) — accessed 2026-09-27
- [App Store — GovAuctions.com Shop Surplus](https://apps.apple.com/us/app/govauctions-com-shop-surplus/id6752552771) — accessed 2026-09-27
- [Google Play — GovAuctions.com Shop Surplus](https://play.google.com/store/apps/details?id=com.govauctions&hl=en_US) — accessed 2026-09-27
- [HN — Show HN: GovAuctions](https://news.ycombinator.com/item?id=47662945) — accessed 2026-09-27
- [HN — GovAuctions now in US, UK, CA, AU](https://news.ycombinator.com/item?id=48747650) — accessed 2026-09-27
- [HN — comment on GovAuctions tagline](https://news.ycombinator.com/item?id=48821663) — accessed 2026-09-27
- [HN — I aggregated 28 US Government auction sites](https://news.ycombinator.com/item?id=47961378) — accessed 2026-09-27
- [HN — "US government auctions are scattered across at least 28 platforms"](https://news.ycombinator.com/item?id=47961379) — accessed 2026-09-27
- [HN — "Clone of 'GovAuctions' from 3 weeks ago?"](https://news.ycombinator.com/item?id=47961747) — accessed 2026-09-27
- [BidProwl — home](https://bidprowl.com/) — accessed 2026-09-27
- [BidProwl — About](https://bidprowl.com/about) — accessed 2026-09-27
- [BidProwl — Is BidProwl legit (pricing)](https://bidprowl.com/is-bidprowl-legit) — accessed 2026-09-27
- [BidProwl — Sources we track](https://bidprowl.com/sources) — accessed 2026-09-27
- [BidProwl — Research and market data](https://bidprowl.com/research) — accessed 2026-09-27
- [BidProwl — Tools](https://bidprowl.com/tools) — accessed 2026-09-27
- [BidProwl — Auctions](https://bidprowl.com/auctions) — accessed 2026-09-27
- [BidProwl — Connecticut](https://bidprowl.com/auctions/connecticut) — accessed 2026-09-27
- [BidProwl — Heavy equipment auctions](https://bidprowl.com/heavy-equipment-auctions) — accessed 2026-09-27
- [BidProwl — Equipment auctions near me](https://bidprowl.com/equipment-auctions-near-me) — accessed 2026-09-27
- [BidProwl — Police auctions](https://bidprowl.com/police-auctions) — accessed 2026-09-27
- [BidProwl — GovDeals FAQ](https://bidprowl.com/guides/govdeals-faq) — accessed 2026-09-27
- [BidProwl — GSA Auctions FAQ](https://bidprowl.com/guides/gsa-auctions-faq) — accessed 2026-09-27
- [BidProwl — How government auctions work](https://bidprowl.com/guides/how-government-auctions-work) — accessed 2026-09-27
- [BidProwl — Best government auction sites](https://bidprowl.com/guides/best-government-auction-sites) — accessed 2026-09-27
- [Devtalk — BidProwl](https://forum.devtalk.com/t/bidprowl-government-surplus-auctions-in-one-place/243452) — accessed 2026-09-27
- [GhostNode — Buyer's premium explained](https://ghostnode.co/guides/buyers-premium-explained) — accessed 2026-09-27
- [GovernmentAuctions.org — Wisconsin](https://www.governmentauctions.org/aNoFeeAuctionSearch.asp?sState=WI) — accessed 2026-09-27
- [PageCrawl — government auction monitoring (blog)](https://pagecrawl.io/blog/government-auction-govdeals-monitoring) — accessed 2026-09-27
- [PageCrawl — government auction lot alerts (tool)](https://pagecrawl.io/tools/government-auction-govdeals-monitoring.html) — accessed 2026-09-27
- [Apify — PublicSurplus email digest](https://apify.com/scrapersdelight/publicsurplus-scraper/examples/email-digest-new-publicsurplus-auctions) — accessed 2026-09-27
- [Apify — HiBid scraper MCP (solidcode)](https://apify.com/solidcode/hibid-scraper/api/mcp) — accessed 2026-09-27
- [Apify — HiBid scraper MCP (scrapersdelight)](https://apify.com/scrapersdelight/hibid-scraper/api/mcp) — accessed 2026-09-27
- [Apify — HiBid actor MCP (zcamper)](https://apify.com/zcamper/hibidactor/api/mcp) — accessed 2026-09-27
- [Apify — BidSpotter scraper MCP](https://apify.com/getdataforme/bidspotter-auctions-scraper/api/mcp) — accessed 2026-09-27
- [Apify — Bid4Assets scraper MCP](https://apify.com/crawlerbros/bid4assets-scraper/api/mcp) — accessed 2026-09-27
- [Apify — Municibid scraper MCP](https://apify.com/crawlerbros/municibid-scraper/api/mcp) — accessed 2026-09-27
- [Apify — PublicSurplus scraper MCP](https://apify.com/parseforge/publicsurplus-scraper/api/mcp) — accessed 2026-09-27
- [Apify — GSA Auctions scraper](https://apify.com/scrapersdelight/gsa-auctions-scraper) — accessed 2026-09-27
- [Apify — GovDeals & surplus scraper (SurplusLead AI) MCP](https://apify.com/automation_studio/govdeals-surplus-auction-scraper/api/mcp) — accessed 2026-09-27
- [Apify — Government surplus auction scraper MCP](https://apify.com/moving_beacon-owner1/government-surplus-auction-scraper/api/mcp) — accessed 2026-09-27
- [Apify — AuctionZip scraper](https://apify.com/lulzasaur/auctionzip-scraper) — accessed 2026-09-27
- [Apify — AuctionZip scraper API](https://apify.com/scrapersdelight/auctionzip-scraper/api) — accessed 2026-09-27
- [Apify — Facebook Marketplace scraper](https://apify.com/k1ra/facebook-marketplace-scraper) — accessed 2026-09-27
- [GitHub — pipeworx-io/mcp-gsa-auctions](https://github.com/pipeworx-io/mcp-gsa-auctions) — accessed 2026-09-27
- [GitHub — pipeworx-io/mcp-gov-auctions](https://github.com/pipeworx-io/mcp-gov-auctions) — accessed 2026-09-27

### Private auction platforms
- [HiBid — Manage notifications](https://hibid.com/notifications/manage) — accessed 2026-09-27
- [HiBid app listing (appstor.io)](https://hibid.appstor.io/) — accessed 2026-09-27
- [HiBid mobile apps for your auction company](https://manateegalleries.auctionflex.com/hibid_mobile_apps.htm) — accessed 2026-09-27
- [HiBid Wisconsin](https://hibid.com/wisconsin) — accessed 2026-09-27
- [HiBid auctioneer FAQ (Affordable Creations) — soft close](https://affordablecreationsto.hibid.com/content/faqs-testimonials) — accessed 2026-09-27
- [HiBid — soft close definition](https://hibid.com/lot/213628892/whats-a-soft-closing-time---soft-close-definition) — accessed 2026-09-27
- [AuctionFlex — Stagger & soft close](https://help-auctionflex.azurewebsites.net/auction-flex-360-help/stagger-soft-close/) — accessed 2026-09-27
- [K-BID — home](https://www.k-bid.com/) — accessed 2026-09-27
- [Birdeye — K-BID reviews](https://birdeye.com/k-bid-online-auctions-150169529936335) — accessed 2026-09-27
- [Knoji — K-BID reviews](https://kbidonline.knoji.com/) — accessed 2026-09-27
- [BBB — K-Bid customer reviews](https://www.bbb.org/us/mn/maple-plain/profile/online-auctions/k-bid-online-inc-0704-96008521/customer-reviews) — accessed 2026-09-27
- [no1reviews — K-Bid user reviews](https://online-auction-sites-usa.no1reviews.com/user-reviews/k-bid.html) — accessed 2026-09-27
- [Proxibid — Using saved search](https://discover.proxibid.com/using-proxibids-saved-search-functionality) — accessed 2026-09-27
- [Proxibid — Saved search](https://discover.proxibid.com/proxibid-saved-search/) — accessed 2026-09-27
- [Proxibid — Managing auction alerts](https://support.proxibid.com/hc/en-gb/articles/10289006911249-Managing-Auction-Alerts) — accessed 2026-09-27
- [Proxibid — Bidding & buying](https://discover.proxibid.com/bidding-buying) — accessed 2026-09-27
- [AuctionZip — Emails and alerts help](https://www.auctionzip.com/helpCenter/az-email-alerts.html) — accessed 2026-09-27
- [AuctionZip — Free keyword & auctioneer alerts](https://www.auctionzip.com/alertsLanding.html) — accessed 2026-09-27
- [AuctionZip — Search help](https://www.auctionzip.com/helpCenter/az-search.html) — accessed 2026-09-27
- [App Store — AuctionZip](https://apps.apple.com/us/app/auctionzip/id1412843982) — accessed 2026-09-27
- [Google Play — AuctionZip](https://play.google.com/store/apps/details?id=com.invaluable.auctionzip&hl=en_US) — accessed 2026-09-27
- [BidSpotter — Auction alerts](https://www.bidspotter.com/en-us/auction-alerts) — accessed 2026-09-27
- [BidSpotter — What are auction alerts?](https://support.bidspotter.com/hc/en-gb/articles/360006642054-What-are-Auction-Alerts) — accessed 2026-09-27
- [BidSpotter — How do I change my auction alerts?](https://support.bidspotter.com/hc/en-gb/articles/360000780273-How-do-I-change-my-Auction-Alerts) — accessed 2026-09-27
- [BidSpotter — FAQs](https://www.bidspotter.com/en-us/about-us/faqs) — accessed 2026-09-27
- [App Store — LiveAuctioneers](https://apps.apple.com/us/app/liveauctioneers-bid-collect/id321243082) — accessed 2026-09-27
- [Google Play — LiveAuctioneers](https://play.google.com/store/apps/details?id=com.liveauctioneers.and&hl=en_US) — accessed 2026-09-27
- [LiveAuctioneers — Why am I not getting my auction alerts?](https://help.liveauctioneers.com/article/666-why-am-i-not-getting-my-auction-alerts) — accessed 2026-09-27
- [Invaluable — Auction alerts overview](https://www.invaluable.com/invaluable/overviewAuctionAlert.cfm) — accessed 2026-09-27
- [Invaluable — Emails and alerts FAQ](https://www.invaluable.com/inv/help/faq/emails-alerts/) — accessed 2026-09-27
- [Invaluable — Mobile](https://www.invaluable.com/mobile/) — accessed 2026-09-27
- [App Store — Invaluable](https://apps.apple.com/rs/app/invaluable/id944415329) — accessed 2026-09-27
- [AuctionTime — Use the app for real-time bidding](https://www.auctiontime.com/blog/how-to-and-tips/2018/08/use-the-auctiontime-app-for-real-time-bidding-and-more) — accessed 2026-09-27
- [App Store — AuctionTime](https://apps.apple.com/us/app/auctiontime-online-auctions/id405124399) — accessed 2026-09-27
- [AuctionTime — Hosted mobile apps (2026)](https://www.auctiontime.com/blog/how-to-and-tips/2026/01/hosted-mobile-apps-put-inventory-customers-pockets) — accessed 2026-09-27
- [Purple Wave — Saved searches](https://www.purplewave.com/account/savedsearches) — accessed 2026-09-27
- [Reference.com — Purple Wave overview](https://www.reference.com/science-technology/purple-wave-auction-platform-overview-buyer-evaluation) — accessed 2026-09-27
- [Heavy Equipment Forums — Purple Wave auctions?](https://www.heavyequipmentforums.com/threads/purple-wave-auctions.15741/) — accessed 2026-09-27

### Government and surplus
- [GovDeals blog — Saved search](https://blog.govdeals.com/saved-search) — accessed 2026-09-27
- [GovDeals blog — Real-time notification alerts](https://blog.govdeals.com/onsite-alerts-and-notifications) — accessed 2026-09-27
- [GovDeals blog — Welcome to the new GovDeals](https://blog.govdeals.com/new-govdeals) — accessed 2026-09-27
- [UW Surplus — Timed auctions](https://facilities.uw.edu/uw-surplus/timed-auctions) — accessed 2026-09-27
- [Garage Journal — GovDeals: is this lot too good to be true?](https://www.garagejournal.com/forum/threads/govdeals-is-this-lot-too-good-to-be-true.517939/) — accessed 2026-09-27
- [Public Surplus — home](https://www.publicsurplus.com/sms/browse/home?tm=m) — accessed 2026-09-27
- [Loudoun County — Online surplus auction](https://www.loudoun.gov/693/Online-Surplus-Auction) — accessed 2026-09-27
- [Municibid — Mobile app](https://info.municibid.com/municibid-mobile-app) — accessed 2026-09-27
- [Municibid — ChatGPT app](https://info.municibid.com/municibid-chatgpt-app) — accessed 2026-09-27
- [Municibid blog — The Municibid app is here](https://municibid.com/blog/the-municibid-app-is-here-plus-a-rare-micro-van-and-picnic-highlights) — accessed 2026-09-27
- [App Store — Municibid](https://apps.apple.com/us/app/municibid/id6773067678) — accessed 2026-09-27
- [Google Play — Municibid](https://play.google.com/store/apps/details?id=com.municibid.mobile) — accessed 2026-09-27
- [GSA Auctions — home](https://www.gsaauctions.gov/) — accessed 2026-09-27
- [GSA Auctions — User guide](https://gsaauctions.gov/auctions/auction-user-guide) — accessed 2026-09-27
- [RealEstateSales.gov — Buyers](https://www.realestatesales.gov/buyers/) — accessed 2026-09-27
- [GSA OES — Matching surplus property with interested buyers](https://oes.gsa.gov/projects/gsa-auctions/) — accessed 2026-09-27
- [Bid4Assets — Buyer guide](https://www.bid4assets.com/pages/public/content/help/buyerguide) — accessed 2026-09-27
- [Bid4Assets — Tax sale buyer FAQs](https://www.bid4assets.com/pages/public/content/help/tax-sale-buyer-faqs) — accessed 2026-09-27
- [Bid4Assets — US Marshals storefront](https://www.bid4assets.com/storefront/usms) — accessed 2026-09-27
- [Clever — Bid4Assets reviews](https://listwithclever.com/bid4assets-reviews/) — accessed 2026-09-27
- [Treasury — Seized real property auctions, about](https://www.treasury.gov/auctions/treasury/rp/about.shtml) — accessed 2026-09-27
- [CWS — Treasury seized real property FAQs](https://cwsmarketing.com/faqs/faqs-us-treasury-department-seized-real-property-auctions/) — accessed 2026-09-27
- [US Marshals — Asset forfeiture](https://www.usmarshals.gov/what-we-do/asset-forfeiture) — accessed 2026-09-27
- [USAGov — Government auctions](https://www.usa.gov/auctions-and-sales) — accessed 2026-09-27
- [Wisconsin Surplus Online Auction](https://wisconsinsurplus.com/) — accessed 2026-09-27
- [Wisconsin Surplus — bidding site](https://bid.wisconsinsurplus.com/Public) — accessed 2026-09-27
- [Wisconsin DATCP — Surplus goods and government sales](https://datcp.wi.gov/Pages/Publications/GovernmentSalesSurplus176.aspx) — accessed 2026-09-27

### Estate, garage and yard sales
- [EstateSales.NET — Push notifications for favorites](https://www.estatesales.net/grow/marketing/push-notifications) — accessed 2026-09-27
- [EstateSales.NET — Email notifications about upcoming sales](https://estatesales.zendesk.com/hc/en-gb/articles/26947578346001-How-to-Receive-Email-Notifications-About-Upcoming-Sales) — accessed 2026-09-27
- [EstateSales.NET — Can I favorite or follow sales?](https://estatesales.zendesk.com/hc/en-gb/articles/30301241384081-Can-I-Favorite-or-Follow-Sales) — accessed 2026-09-27
- [EstateSales.NET — Advertise your sale](https://www.estatesales.net/advertise) — accessed 2026-09-27
- [App Store — EstateSales.NET](https://apps.apple.com/us/app/estate-sales-estatesales-net/id1018443930) — accessed 2026-09-27
- [Google Play — EstateSales.NET](https://play.google.com/store/apps/details?id=net.estatesales.estatesales&hl=en_US) — accessed 2026-09-27
- [JustUseApp — EstateSales.NET reviews](https://justuseapp.com/en/app/1018443930/estate-sales-estatesales-net/reviews) — accessed 2026-09-27
- [EstateSales.org](https://estatesales.org/) — accessed 2026-09-27
- [App Store — Estate Sale Finder (EstateSales.org)](https://apps.apple.com/us/app/estate-sale-finder/id6657955340) — accessed 2026-09-27
- [Google Play — Estate Sale Finder (EstateSales.org)](https://play.google.com/store/apps/details?id=org.estatesales.esbuyerapp&hl=en_US) — accessed 2026-09-27
- [EstateSale-Finder.com — map](https://estatesale-finder.com/all_sales_map.php) — accessed 2026-09-27
- [EstateSaleFinder.net — Estate sales near me](https://estatesalefinder.net/estate-sales-near-me) — accessed 2026-09-27
- [GarageSaleGuide — Best estate sale apps 2026](https://garagesaleguide.com/best-estate-sale-apps/) — accessed 2026-09-27
- [ThriftFlipping — Best garage sale apps 2026](https://www.thriftflipping.com/blog/article-124-best-garage-sale-apps-2026.html) — accessed 2026-09-27
- [Underpriced AI — Best apps for estate sale sourcing](https://underpricedai.com/blog/best-apps-for-estate-sale-sourcing) — accessed 2026-09-27
- [MaxSold — What does buyer's premium mean?](https://support.maxsold.com/hc/en-us/articles/203144004-What-does-buyer-s-premium-mean) — accessed 2026-09-27
- [MaxSold — Is there a fee to use MaxSold?](https://support.maxsold.com/hc/en-us/articles/203144484-Is-there-a-fee-to-use-Maxsold) — accessed 2026-09-27
- [MaxSold — What does soft close mean?](https://support.maxsold.com/hc/en-us/articles/203144064-What-does-soft-close-mean) — accessed 2026-09-27
- [Trustpilot — MaxSold](https://www.trustpilot.com/review/maxsold.com?page=2) — accessed 2026-09-27
- [BBB — MaxSold complaints](https://www.bbb.org/ca/on/kitchener/profile/estate-sales/maxsold-estate-sales-0117-70874/complaints) — accessed 2026-09-27
- [SmartCustomer — MaxSold](https://www.smartcustomer.com/reviews/maxsold.com) — accessed 2026-09-27
- [ComplaintsBoard — MaxSold](https://www.complaintsboard.com/maxsold-b124671) — accessed 2026-09-27
- [AuctionNinja — What is the buyer's premium?](https://support.auctionninja.com/knowledge/what-is-the-buyers-premium) — accessed 2026-09-27
- [AuctionNinja — What is extended bidding?](https://support.auctionninja.com/knowledge/what-is-extended-bidding) — accessed 2026-09-27
- [Trustpilot — AuctionNinja](https://www.trustpilot.com/review/auctionninja.com) — accessed 2026-09-27
- [TechRaisal — AuctionNinja reviews](https://www.techraisal.com/software/auctionninja/) — accessed 2026-09-27
- [App Store — CTBids reviews](https://apps.apple.com/us/app/ctbids/id6467594552?see-all=reviews&platform=iphone) — accessed 2026-09-27
- [Trustpilot — CTBids](https://www.trustpilot.com/review/ctbids.com) — accessed 2026-09-27
- [PissedConsumer — CTBids](https://ctbids.pissedconsumer.com/review.html) — accessed 2026-09-27
- [SmartCustomer — CTBids](https://www.smartcustomer.com/reviews/ctbids.com) — accessed 2026-09-27
- [ComplaintsBoard — CT Bids](https://www.complaintsboard.com/ct-bids-b144471) — accessed 2026-09-27
- [Yard Sale Treasure Map — home](https://yardsaletreasuremap.com/) — accessed 2026-09-27
- [Yard Sale Treasure Map — About](https://yardsaletreasuremap.com/blogit/?page_id=2) — accessed 2026-09-27
- [App Store — Yard Sale Treasure Map](https://apps.apple.com/us/app/yard-sale-treasure-map/id318649229) — accessed 2026-09-27
- [Google Play — Yard Sale Treasure Map](https://play.google.com/store/apps/details?id=com.webmap&hl=en_US) — accessed 2026-09-27
- [Google Play — Garage Sale Map (GSALR)](https://play.google.com/store/apps/details?id=com.treasurelistings.gsalr&hl=en_US) — accessed 2026-09-27

### Marketplace alert tools
- [Swoopa — home](https://getswoopa.com/) — accessed 2026-09-27
- [Swoopa — Subscription options](https://getswoopa.com/subscription-options/) — accessed 2026-09-27
- [App Store — Swoopa reviews](https://apps.apple.com/us/app/swoopa/id6475300269?see-all=reviews&platform=iphone) — accessed 2026-09-27
- [JustUseApp — Swoopa reviews](https://justuseapp.com/en/app/6475300269/swoopa/reviews) — accessed 2026-09-27
- [grand-screen — Swoopa](https://grand-screen.com/apps/swoopa/) — accessed 2026-09-27
- [CarSnipe — Swoopa pricing](https://carsnipe.com/blog/swoopa-pricing) — accessed 2026-09-27
- [CarSnipe — Monitoring tools compared: account risk](https://carsnipe.com/blog/best-facebook-marketplace-monitoring-tools-compared) — accessed 2026-09-27
- [CarSnipe — Best FB Marketplace monitoring tools: 3-min alerts](https://carsnipe.com/blog/facebook-marketplace-monitoring-tools) — accessed 2026-09-27
- [JDMarket — Free Swoopa alternative](https://jdmarket.cc/swoopa-free-alternative/) — accessed 2026-09-27
- [Flipify — home](https://www.flipifyapp.com/) — accessed 2026-09-27
- [App Store — Flipify reviews](https://apps.apple.com/us/app/flipify-marketplace-alerts/id6504143452?see-all=reviews&platform=iphone) — accessed 2026-09-27
- [AppBrain — Flipify (Android)](https://www.appbrain.com/app/flipify-marketplace-alerts/com.samsalfi.flipify) — accessed 2026-09-27
- [SearchTempest — home](https://www.searchtempest.com/) — accessed 2026-09-27
- [SearchTempest — What happened to the alert feature via RSS?](https://searchtempest.zendesk.com/hc/en-us/community/posts/7036274145171-What-happened-to-the-Alert-Feature-via-RSS) — accessed 2026-09-27
- [Garage Journal — Meta-search tool for Craigslist?](https://www.garagejournal.com/forum/threads/anyone-have-a-meta-search-tool-for-craigslist.308244/) — accessed 2026-09-27
- [SeeSpotBid — eBay search alerts](https://seespotbid.app/) — accessed 2026-09-27
- [ProPublica — Facebook Marketplace scams](https://www.propublica.org/article/facebook-grew-marketplace-to-1-billion-users-now-scammers-are-using-it-to-target-people-around-the-world) — accessed 2026-09-27

### eBay sniping
- [Gixen — home](https://www.gixen.com/main/index.php) — accessed 2026-09-27
- [Gixen — Free vs Mirror comparison](https://www.gixen.com/compare.php) — accessed 2026-09-27
- [Gixen — FAQ](https://www.gixen.com/main/faq.php) — accessed 2026-09-27
- [eBay AU community — Sniping with Gixen: some changes are coming](https://community.ebay.com.au/t5/Buying/Sniping-with-Gixen-some-changes-are-coming/td-p/2260331) — accessed 2026-09-27
- [Gixen forum — eBay authorization expiration](https://www.gixen.com/forum/viewtopic.php?t=9200) — accessed 2026-09-27
- [Trustpilot — Gixen](https://www.trustpilot.com/review/gixen.com) — accessed 2026-09-27
- [SmartCustomer — Gixen](https://www.smartcustomer.com/reviews/gixen.com) — accessed 2026-09-27
- [App Store — Gixen](https://apps.apple.com/au/app/gixen-ebay-auction-sniper/id6446328339) — accessed 2026-09-27
- [AuctionSniper — Pricing](https://auctionsniper.com/help/auction-sniper-pricing/) — accessed 2026-09-27
- [Google Play — Auction Sniper](https://play.google.com/store/apps/details?id=com.auctiva.auctionsniper&hl=en_US) — accessed 2026-09-27
- [eSnipe — home](https://www.esnipe.com/) — accessed 2026-09-27
- [MyWifeQuitHerJob — Best eBay sniping tools](https://mywifequitherjob.com/ebay-sniping-tools/) — accessed 2026-09-27
- [Bidnapper — Prices](https://www.bidnapper.com/prices.php3/1000) — accessed 2026-09-27
- [EZsniper — Prices](https://www.ezsniper.com/prices.php3) — accessed 2026-09-27
- [BidSlammer — FAQ](https://bidslammer.com/faq/) — accessed 2026-09-27
- [BidSlammer — 20 ways you can miss an eBay snipe](https://bidslammer.com/blog/6/) — accessed 2026-09-27
- [BidSlammer — 50 ways you can miss a snipe](https://bidslammer.com/help/status-messages/BidSlammer-50-Ways-You-Can-Miss-a-Snipe/) — accessed 2026-09-27
- [eBay Developers — Offer API overview](https://developer.ebay.com/api-docs/buy/offer/overview.html) — accessed 2026-09-27
- [eBay Help — Bid sniping](https://www.ebay.com/help/buying/bidding/bid-sniping?id=4224) — accessed 2026-09-27
- [eBay Community — "Sniping needs to stop and I have a solution"](https://community.ebay.com/t5/Buying/Sniping-needs-to-stop-and-I-have-a-solution/m-p/32407543) — accessed 2026-09-27
- [eBay Community — "Extend the auction by three minutes…"](https://community.ebay.com/t5/Selling/Extend-the-auction-by-three-minutes-when-a-bid-is-placed-with-in/m-p/29419771/highlight/true) — accessed 2026-09-27
- [National Auction Association — What is a soft close?](https://www.auctioneers.org/auctionswork/what-is-a-soft-close-or-dynamic-ending-of-an-online-auction) — accessed 2026-09-27

### Comps and valuation
- [Underpriced AI — WorthPoint review](https://underpricedai.com/blog/worthpoint-review) — accessed 2026-09-27
- [Britannic Auctions — Is WorthPoint worth it?](https://www.britannicauctions.com/blog/research-prices/) — accessed 2026-09-27
- [WorthPoint — Worthopedia](https://www.worthpoint.com/worthopedia) — accessed 2026-09-27
- [App Store — WorthPoint reviews](https://apps.apple.com/us/app/worthpoint/id1472512649?see-all=reviews&platform=iphone) — accessed 2026-09-27
- [BBB — WorthPoint complaints](https://www.bbb.org/us/ga/atlanta/profile/antique-dealers/worthpoint-corporation-0443-27259399/complaints) — accessed 2026-09-27
- [Trustpilot — WorthPoint](https://www.trustpilot.com/review/www.worthpoint.com?page=4) — accessed 2026-09-27
- [PissedConsumer — WorthPoint](https://worthpoint.pissedconsumer.com/review.html) — accessed 2026-09-27
- [eBay — Terapeak free to Seller Hub sellers](https://export.ebay.com/en/resources/important-updates/ebay-news-archive/terapeak) — accessed 2026-09-27
- [eBay Inc. — Terapeak Research 2.0](https://innovation.ebayinc.com/stories/new-improved-terapeak-research-2-0-in-ebay-seller-hub/) — accessed 2026-09-27
- [130point — About](https://130point.com/about) — accessed 2026-09-27
- [Ball Card Genius — See eBay Best Offer prices](https://ballcardgenius.com/blog/how-to-see-what-ebay-items-sold-for-at-best-offer/) — accessed 2026-09-27
- [PriceCharting — Premium](https://www.pricecharting.com/pricecharting-pro) — accessed 2026-09-27
- [PriceCharting blog — Premium features for retailers](https://blog.pricecharting.com/2021/10/pricecharting-has-premium-features-for.html) — accessed 2026-09-27
- [PriceCharting — Lot value calculator](https://www.pricecharting.com/lot-value-calculator) — accessed 2026-09-27
- [PriceCharting — API documentation](https://www.pricecharting.com/api-documentation) — accessed 2026-09-27

### Image identification
- [ANA Reading Room — CoinSnap pros and cons](https://readingroom.money.org/mind-the-app-coinsnaps-pros-cons/) — accessed 2026-09-27
- [App Store — CoinSnap reviews](https://apps.apple.com/us/app/coinsnap-coin-identifier/id1634551626?see-all=reviews&platform=iphone) — accessed 2026-09-27
- [JustUseApp — CoinSnap reviews](https://justuseapp.com/en/app/1634551626/coinsnap-value-guide/reviews) — accessed 2026-09-27
- [LodPost — CoinSnap auto-charges and misidentifications](https://lodpost.com/coin-snap-21611) — accessed 2026-09-27
- [Coin-Identifier — CoinSnap limitations](https://coin-identifier.com/blog/collector-apps-and-tools/coinsnap-may-let-you-down-heres-a-smarter-way-to-scan-your-coins) — accessed 2026-09-27
- [Antique Identifier — Google Lens for antiques](https://www.antiqueidentifier.org/google-lens-for-antiques-does-it-work/) — accessed 2026-09-27
- [Finest Flips — Google Lens for reselling](https://finestflips.com/blog/google-lens-for-reselling.html) — accessed 2026-09-27
- [Underpriced AI — Best antique identifier apps](https://underpricedai.com/blog/best-antique-identifier-apps) — accessed 2026-09-27
- [Google Play — AntiqueLens](https://play.google.com/store/apps/details?id=com.antiquelens.identifier&hl=en_US) — accessed 2026-09-27
- [App Store — NumiSnap](https://apps.apple.com/us/app/numisnap-coin-value-id/id6526486598?uo=4) — accessed 2026-09-27
