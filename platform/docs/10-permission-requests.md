# Permission requests

Most of Wisconsin's online auction inventory sits with operators whose terms forbid automated collection without written permission, or whose bot protection refuses our crawler (see `08-platform-access.md` §1a and §3.1). Sections 1 to 4 cover the four largest; sections 5 to 15 (added 2026-10-01) cover the rest that hold real Wisconsin inventory. These are drafts for the owner to send. Nothing is sent automatically.

Each ask is shaped the same way, because it is the version an operator can say yes to:

- **What we collect.** Public listing facts only: title, current price, bid count, close time, pickup city and state, and the link. No bidder data, no accounts, no bidding.
- **How we collect it.** One honest, identified crawler (`WaystockBot/0.1 (+https://waystock.org/bot)`; the page at that link says what it reads, how it behaves and how to turn it away). It obeys robots.txt and paces its requests; the hourly load is stated in each letter.
- **What they get.** Every result links to the operator's own lot page, where the bidding happens. Skeuos sends them buyers.
- **The better option.** A feed or an API key replaces the crawler entirely, and we will take either.

Fill in the bracketed fields before sending.

Where our crawler read an operator's pages before we had read its terms, the letter says what it read and when (checked against the probe log, the crawl runs and the page inspector's record on 2026-10-01). Their server logs will show it, and the request is stronger for saying so first.

---

## 1. Wisconsin Surplus Online Auction

**First priority.** The owner buys at Wisconsin Surplus for a resale business, and this is the source the app is for. The owner sends this letter personally; nothing is sent from here.

**Why it is held.** The User Agreement, Legal 21: "You agree that you will not use any robot, spider, other automatic device, or manual process to monitor or copy the Site or the content contained herein without Wisconsin Surplus' prior, express written permission." So the source is held (`ingest_allowed = false`, migration 0020), and until that permission is in hand the hourly probe reads only its robots.txt.

**What our crawler read before the hold.** Their logs will show it, so the letter says so: robots.txt on 2026-09-27, from the first egress check, whose user agent was `AuctionAggregatorBot/0.1` with the owner's contact address (egress-check v2, deployed 2026-09-29, dropped it); the home page and robots.txt hourly on 09-29 and 09-30; 17 pages through the page inspector on 09-30 (13 while the adapter was built, 4 while the terms were read); and one crawl run at 18:56 UTC that day, while the terms were being read (3 requests, 94 auctions, deleted at the owner's request on 10-01). The hold went on at 18:59 UTC; the probe read robots.txt only from 21:07 UTC.

**What is built and waiting** (`crawl-public`, `adapters/wisconsin-surplus.ts`):

- Two requests an hour: the Current and the Upcoming auction lists (`/Public/Auction/GetAuctions`), the same request the site's own page makes. The run also reads robots.txt first, and the hourly probe reads it once more: four requests an hour in all.
- Every auction becomes a **sale card** in search and hunts, for example "Village of French Island: 2003 Ford F450 Super Duty Diesel Reg Cab 4WD Baby Dump Truck w/ Plow · La Crosse, WI · Sale · 2 lots · closes Oct 15". The card shows the sale's name and what it holds, its pickup town, its lot count and its end time, and it links to the sale's page. Hunts match the description, so a hunt for "welder" finds the sale whose description lists welders.
- Kept: title, description, end time, item count, pickup town and the link. Not kept: street addresses, phone numbers, or anything about bidders. No photos are shown until the letter's photo question is answered yes.

**Not built yet: single items.** The item lists load only after the auction page gives the browser a session cookie (docs/08 §3.14). Reading them needs this permission plus a short build and test against the live pages. The letter asks for it as a separate item, with a hard rate cap.

### Before you send

1. Fill in the bracketed fields with the contact details you want them to have. Nothing is filled in for you.
2. If you have a Wisconsin Surplus bidder account, give your bidder name or number. It shows them you are a customer.
3. Send it through the Contact page on wisconsinsurplus.com, or call the Mount Horeb office and ask who should receive it. No address is guessed here.
4. **The crawler's information link is live.** Every request carries `WaystockBot/0.1 (+https://waystock.org/bot)`. Since 2026-10-01 waystock.org serves the Skeuos app, and `/bot` is the crawler's page: what it reads, how it behaves, and how to turn it away (`web/public/bot/index.html`). Their IT staff may well check that link.

### The letter

**To:** Wisconsin Surplus Online Auction, Mount Horeb
**Subject:** Request for written permission to read your public auction list

Hello,

My name is [Name]. I run [a small resale business / business name] in [town], Wisconsin, and I buy at your auctions[, bidder name or number].

I am building a tool, Skeuos, that watches Wisconsin auctions for the kinds of items I buy and tells me when a sale near me lists them. Your sales are the ones I care about most. Your User Agreement (Legal 21) asks for prior, express written permission before any automated monitoring of your site, so I am asking for it.

I would rather you heard from me what the tool has already done, because it visited your site before we had read Legal 21. It read your robots.txt on 27 September, then checked your home page and robots.txt about once an hour on 29 and 30 September. On 30 September, while it was being built, it read your auction lists and a few auction pages, and then ran once, reading the 94 auctions listed that day. When we read Legal 21 that afternoon, we stopped it, and the next day we deleted the 94 auctions it had kept. Since 1 October it has read only your robots.txt, about once an hour.

What it would read:

1. Your public auction list, the Current and Upcoming auctions on bid.wisconsinsurplus.com: two requests an hour, one per list. From each auction it keeps the title, description, end time, item count, pickup town and link. It keeps no street addresses or phone numbers.
2. If you are willing, each open auction's item list, so the tool can match single items: never more than 30 requests in an hour, one at a time and at least 5 seconds apart.

How it behaves: it names itself in every request (`WaystockBot/0.1`), reads your robots.txt before each run and obeys it, never logs in, never bids, and collects nothing about other bidders. Every result links straight to your auction page, so all bidding stays on your site.

What I am asking for:

- Written permission for item 1, and for item 2 if you are willing. A reply to this email is enough.
- Whether the tool may show each auction's lead photo, linked to your page.
- Any limits you would like: a lower rate, certain hours, or how you would like Wisconsin Surplus credited.

If you have a feed or an export of current auctions, I would gladly use that instead, and the tool would never touch your pages. At first the tool is for my own buying. I may later open it to other Wisconsin buyers, with every result still linking to you. If you want your permission to cover only my own use, tell me and I will keep to that. If you would rather I did not do this at all, say so and that is the end of it. If you agree now and change your mind later, tell me and it stops the same day.

Thank you,
[Name]
[Business name]
[Phone] · [Email]

### When they answer

- **Yes to item 1.** One migration records who granted permission, when, and its scope, then sets `ingest_allowed = true`. Within the hour, their current and upcoming sales (about 90 to 100 at a time) appear in search and hunts as sale cards.
- **Yes to the photo.** One line in the adapter (sale rows carry no `images` today) and a redeploy.
- **Yes to item 2.** Build the item-list reader against live pages, test it, then switch it on under the 30-an-hour cap. Single lots with their own close times replace the sale cards. Hunts then match single items, and closing-soon alerts fire for each lot.
- **A feed instead.** An adapter for the feed replaces the crawler.
- **No, or limits.** Recorded in docs/08 §1a and in the source's `ingest_note`, and kept to.
- **No reply after two weeks.** Phone the Mount Horeb office. A short call usually reaches the right person faster than a second email.

---

## 2. Public Surplus

**Before you send.** The one run on 2026-09-30 kept 105 Public Surplus lots. They are hidden from search, hunts and alerts (0021) but still stored, and anyone holding the public API key could read them. Deleting them, as you did for Wisconsin Surplus, is your call; if you do, add "and deleted what it had kept" after "we stopped it".

**To:** Public Surplus support (publicsurplus.com)
**Subject:** Written permission request: listing Wisconsin Public Surplus auctions with links back

Hello,

I'm building Skeuos, an auction search app for Wisconsin buyers. Many Wisconsin school districts, counties, cities and technical colleges sell through Public Surplus, and I'd like to include their current Wisconsin auctions, with your permission.

Your Buyer Agreement (§1.5(v)) asks for prior written permission before any automated monitoring, so I'm asking for it. I should also tell you what our crawler has already done, because it visited your site before we had read §1.5(v): on 29 and 30 September it checked your home page about once an hour, and on 30 September it read about two dozen of your pages, then ran once, reading 105 Wisconsin auctions in 100 requests over about three minutes. When we read the agreement that afternoon, we stopped it, and nothing from that run appears in the app's search or alerts. Since 1 October it has read only your robots.txt, about once an hour.

What we would show:
- For each current Wisconsin auction: title, agency, pickup city, current price, bid count and close time.
- Each result links to the auction on publicsurplus.com, where all bidding happens.

What it costs you: about 100 page requests an hour for Wisconsin's roughly 100 live auctions, from one identified crawler (`WaystockBot/0.1 (+https://waystock.org/bot)`), paced at one request every 2 seconds, obeying robots.txt. An RSS feed, export or API key for Wisconsin listings would remove the crawler altogether.

May we have written permission, or access to a feed?

Thank you,
[Name], Skeuos
[Contact email / phone]

---

## 3. Municibid

**To:** Municibid (info.municibid.com contact)
**Subject:** Written agreement for read-only listing access (Wisconsin)

Hello,

Your Terms of Use (§c) allow automated access only under a separate written agreement, and I'd like to ask for one. I'm building Skeuos, an auction search app for Wisconsin buyers. Today Wisconsin has no live Municibid listings, but 16 Wisconsin agencies sell through you.

What we would use:
- Read-only listing facts: title, agency, city and state, current bid, bid count and close time.
- Each result links to the listing on municibid.com.

What it costs you: one state-page request an hour, plus one request per live Wisconsin listing. Your public MCP connector would also work well for this, if a written agreement can cover it.

Thank you,
[Name], Skeuos
[Contact email / phone]

---

## 4. HiBid / Auction Flex

**To:** HiBid business development (hibid.com), cc Auction Flex
**Subject:** Partnership request: Wisconsin listings feed for an auction search app

Hello,

I'm building Skeuos, a Wisconsin-first auction search app. HiBid carries most of Wisconsin's private auction houses: 82 open auctions and about 24,500 open lots on 30 September 2026. Your terms forbid automated collection and aggregation, so since reading them we don't crawl HiBid; today we only link to HiBid searches. Before we had read them, our crawler read your robots.txt on 27 September, checked your home page about once an hour on 29 and 30 September and, on the 30th, read your public Wisconsin pages and lot data while we built the app (about 30 requests), which is where the figures above come from. Since 1 October it has read only your robots.txt.

I'd like to discuss a feed:
- **Scope:** open Wisconsin lots (title, current bid, bid count, close time, auction pickup location, lot URL). A delta feed of changes would keep the load minimal.
- **In return:** every result links to the lot on HiBid or the auctioneer's HiBid site, and we can add attribution or affiliate tracking.

Is there a partner or syndication program we could join?

Thank you,
[Name], Skeuos
[Contact email / phone]

---

## 5. GovDeals and AllSurplus (Liquidity Services)

**Why:** GovDeals holds the State of Wisconsin's online auction contract. The DOA Surplus Property Program says so, and DNR sells there as `widnr`. Counties, cities and schools sell there too. An aggregator snapshot showed 93 active Wisconsin listings, and 116 of 189 open Wisconsin government lots (`07-wisconsin-sources.md` §3). **Why a letter:** Akamai answers our crawler, and any non-browser client, with "Access Denied" (HTTP 403) on both the site and its JSON API (`08` §1). A block is an answer, so we never work around it.

**To:** Liquidity Services, business development (GovDeals and AllSurplus)
**Subject:** Feed or partner access for Wisconsin GovDeals listings in a Wisconsin auction search app

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that finds public and private auctions near a buyer and links each result to the auction's own page. Wisconsin's state agencies, counties, cities and schools sell on GovDeals, so a Wisconsin auction search without GovDeals is missing its largest government seller.

Your site refuses automated clients, and we respect that. We don't work around it, so I am asking for a sanctioned route instead:

- A feed or API access for open Wisconsin listings, with each lot's title, current bid, bid count, close time, pickup city and state, and its GovDeals URL. A daily file plus hourly changes would be ample.
- Or, if you prefer, written permission for our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) to read your Wisconsin listings, at no more than 60 requests an hour.

Every result would link to the lot on GovDeals or AllSurplus, where all bidding happens. If there is a partner or affiliate program, I would gladly join it.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 6. K-BID

**Why:** K-BID carries northwest Wisconsin and St. Croix valley inventory (household, estate, equipment) and Twin Cities border sales (`07` §3, rank 5). **Why a letter:** its robots.txt and home page answer HTTP 403 to our crawler (`08` §1a). So far we have no terms to read and no way in.

**To:** K-BID Online Auctions (contact page on k-bid.com)
**Subject:** Permission or a feed for listing Wisconsin K-BID auctions, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that shows buyers the auctions near them and links each one to its own page. Several K-BID affiliates sell in northwest Wisconsin, and I would like to include their auctions with your permission.

Our crawler (`WaystockBot/0.1`, described at waystock.org/bot) is refused by your site with HTTP 403. I take that as a no, so I am asking directly:

- May we read your public Wisconsin auction listings? We would make about 20 requests an hour, one at a time and several seconds apart, and obey robots.txt.
- Or is there an affiliate feed or export we could use instead? We would prefer that.

Each result would show the auction's title, close time and pickup town, and link to it on k-bid.com, where all bidding happens.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 7. UW-Madison SWAP (Surplus With A Purpose)

**Why:** UW-Madison's surplus program runs its own auction site, `swapauction.wisc.edu`, with 25 or more new listings each weekday: computers, furniture, lab and shop equipment, vehicles. **Why a letter:** its server resets every connection from our crawler's cloud host (Supabase, on AWS), so the probe has never read even its robots.txt (`08` §1a, 2026-10-01). We do not route around network blocks. A public university program may well publish a feed if asked.

**To:** UW-Madison SWAP (contact on swap.wisc.edu)
**Subject:** Is there a feed of current SWAP auction listings?

Hello,

I run [business name], a resale business in [town], Wisconsin, and I buy at SWAP. I am building Skeuos, an app that finds public auctions near a buyer and links each result to the auction's own page.

I'd like SWAP's auctions to appear there. Your auction site refuses connections from the cloud servers our app runs on, so I am asking rather than trying another way:

- Do you publish a feed of current listings (RSS, CSV, an export, or an email list)? With a feed, the app would never need to visit the site.
- If not, would you allow our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) to read the current listings about once an hour?

Each result would show the item's title, current bid, close time and Verona pickup, and link to its page on swapauction.wisc.edu, where all bidding happens.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 8. Proxibid (ATG)

**Why:** Milwaukee County's live fleet auctions are catalogued on Proxibid through Auction Associates Inc., and equipment-heavy Wisconsin houses list there (`07` §3, rank 6). **Why a letter:** Proxibid is behind Cloudflare, and plain clients get 403. Its user agreements are PDFs. The same company's BidSpotter terms forbid "any data mining, robots or similar data gathering or extraction methods" (`08` §1a). It is held (0028).

**To:** Auction Technology Group, partnerships (Proxibid)
**Subject:** Partner access to Wisconsin Proxibid catalogues for an auction search app

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that finds auctions near a buyer and links each result to the auction's own page. Wisconsin government fleets and equipment auctioneers sell through Proxibid.

Your terms don't allow automated collection, so I am asking whether there is a sanctioned route: a partner or affiliate feed of open Wisconsin catalogues (lot title, current bid, close time, pickup city and state, lot URL). Every result would link to the lot on Proxibid, where all bidding happens.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 9. Purple Wave

**Why:** no-reserve agricultural, construction and government equipment auctions, including 11 of 189 open Wisconsin government lots in an aggregator snapshot (`07` §3, rank 7). **Why a letter:** its Terms of Website Use (2025-05-15) forbid using "any robot, spider or other automatic device, process or means to access the Website for any purpose, including monitoring or copying any of the material". It is held (0022).

**To:** Purple Wave (contact page on purplewave.com)
**Subject:** Permission or syndication for listing Purple Wave's Wisconsin items, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that finds auctions near a buyer and links each result to the item's own page. Your Wisconsin items, equipment and government fleet especially, are exactly what my customers look for.

Your Terms of Website Use forbid automated access, so I am asking before the app reads any of your listings. So far our crawler has read your home page (about once an hour on 29 and 30 September), your sitemaps and the terms themselves, and since 1 October only your robots.txt. It has never read a listing. What I am asking:

- Is there a syndication feed or API for open items by state? We would much prefer that.
- If not, may we have written permission for our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) to read open Wisconsin items? It would make at most 30 requests an hour, obey robots.txt, and never touch results or bid pages.

Each result would show the item's title, current bid, close time and location, and link to it on purplewave.com, where all bidding happens.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 10. EstateSales.NET

**Why:** the category leader for estate sales. Its Wisconsin directory is the largest estate-sale gap in the app (`07` §3: "EstateSales.net will probably jump to rank 3 or 4"). **Why a letter:** its terms (§16.6) bar harvesting without written permission. It is held (0028). EstateSales.org is not asked: its terms (§4.1) set liquidated damages for scraping and offer an authorized API only, so that route is theirs to offer.

**To:** EstateSales.NET (partner or contact page)
**Subject:** Written permission request: Wisconsin estate sales in an auction search app, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that shows buyers the estate sales and auctions near them, with every result linking to the sale's own page.

Your terms (§16.6) require written permission before any harvesting, so I am asking first:

- May we list Wisconsin sales from EstateSales.NET: each sale's title, dates, city and a link to its page on your site? We would never copy photos or descriptions beyond a short excerpt.
- Our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) would read your Wisconsin listing pages a few times a day and obey robots.txt. A feed would be better still, if you offer one.

Every result would send the buyer to your sale page.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 11. CTBids (Caring Transitions)

**Why:** CTBids carries online estate auctions from Caring Transitions franchises, seven of them with Wisconsin location pages: Appleton, Eau Claire, Green Bay, Madison, Milwaukee, Sheboygan and Waukesha (its sitemap, 2026-10-01). Estate sales are the largest gap in the app. **Why a letter:** robots.txt allows every agent, but the terms are a PDF ("CTBIDS Terms & Conditions, Website User Agreement", 1.25.24), which our tools do not read. The part quoted in search results bars obtaining "any materials or information through any means not intentionally made available or provided for through the website". The source is held as a precaution (0033), as Proxibid was.

**To:** Caring Transitions, CTBids team (or a Wisconsin franchise owner, who can forward it)
**Subject:** Listing Wisconsin CTBids estate auctions in an auction search app, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that shows buyers the estate sales and auctions near them. Every result links to the sale's own page. Caring Transitions' Wisconsin franchises run some of the best estate auctions in the state, and I would like them to appear in it.

Your website terms are a PDF that our software does not read, so rather than guess, I am asking:

- May the app list your open Wisconsin auctions: each sale's title, dates, town and a link to it on ctbids.com? Bidding would stay entirely on CTBids.
- Our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) would read those listings about once an hour, one request at a time, and obey robots.txt. If you offer a feed or partner access, we would use that instead.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 12. Aucteeno and the Global Auction Guide sites (Farm Auction Guide, AuctionGuy)

**Why:** one syndication network carries a large Wisconsin calendar:
- Farm Auction Guide: "125 Upcoming Auctions in Wisconsin".
- AuctionGuy: "Wisconsin 129 auctions".
- Global Auction Guide.

Read through our crawler on 2026-10-01, AuctionGuy's sale pages link the same sale on globalauctionguide.com, load their photos from aucteeno.com, and tag the bid link `utm_source=aucteeno&utm_medium=syndication`. Farm Auction Guide's footer reads "Part of the Global Auction Guide Media Group". So one owner can say yes for all of them.

**Why a letter:** the terms forbid reproduction without written permission. Global Auction Guide's terms (farmauctionguide.com/disclaimer) say: "no portion of the information on this Web site may be reproduced in any form or by any means without the prior written permission from globalauctionguide.com". Copies are allowed "solely for personal, informational, non-commercial purposes". AuctionGuy publishes no terms of its own and is held with the network (0037). AuctionGuide (auctionguide.com) is a different company ("© Auction Guide 1997–2026") and is not part of this ask.

**To:** Aucteeno / Global Auction Guide Media Group (contact page on globalauctionguide.com or farmauctionguide.com/contact-us/)
**Subject:** Syndication request: Wisconsin auction listings in an auction search app, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that shows buyers the auctions near them. Every result links to the sale's own page.

Your sites carry the most complete calendar of Wisconsin farm, equipment and estate auctions I have found, and your terms ask for written permission before any reproduction, so I am asking first:

- Do you offer a syndication feed to partners? Your links are already tagged for syndication (utm_medium=syndication). A Wisconsin feed of upcoming sales would be ideal: title, auctioneer, dates, town and the link.
- If not, may our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) read your Wisconsin listing page about once an hour? It obeys robots.txt and makes one request at a time. The app would show each sale's title, dates, town and auctioneer, and link to the sale. Photos and descriptions would not be copied.

Every result would send the buyer to the sale, with whatever tracking parameters you ask for.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 13. Farmers Hot Line (Catalyst Communications Network)

**Why:** a farm auction calendar by state, with Wisconsin houses such as Dairyland of Elroy, Wilkinson of Muscoda, Northern Auction of River Falls, and B and M. Its auction list loads by script, so a feed is the practical route in any case.

**Why a letter:** the terms (farmershotline.com/terms-use, read 2026-10-01) say no material on the site "may be copied, distributed, republished, reproduced, downloaded, displayed or transmitted in any form for commercial use without prior written permission of Catalyst Communications Network". Only "personal, non-commercial use" is permitted. The source is held (0037).

**To:** Catalyst Communications Network, Farmers Hot Line (info@farmershotline.com, 1-800-247-2000)
**Subject:** Permission request: Wisconsin auction listings in an auction search app, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that shows buyers the auctions near them. Every result links to the sale's own page.

Farmers Hot Line lists Wisconsin farm and equipment auctions I would like buyers to find. Your terms require written permission for any commercial use, so I am asking:

- May the app list your Wisconsin auctions: each sale's title, auctioneer, date, town and a link to its page on farmershotline.com?
- Is there a feed or export for partners? We would use it instead of reading the site. If not, our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) would read the Wisconsin list about once an hour and obey robots.txt.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 14. BigIron Auctions

**Why:** weekly unreserved online auctions of farm, construction and transport equipment, with Wisconsin pages ("Equipment for sale in Wisconsin", "Northern Wisconsin farm equipment"). This is the equipment market a resale buyer watches, and it does not run on HiBid.

**Why a letter:** robots.txt allows the sale pages, with a 5-second Crawl-delay. But the Terms of Use (bigiron.com/TermsOfUse, read 2026-10-01) bar "any robot, spider, or other automatic device, process, or means to access the Services for any purpose, including monitoring or copying any of the material", and limit use to "personal, non-commercial use only". Held (0040).

**To:** BigIron Auctions (contact page on bigiron.com)
**Subject:** Permission request: Wisconsin equipment listings in an auction search app, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that shows buyers the auctions near them. Every result links to the item's own page, where the bidding happens.

BigIron's Wisconsin equipment is exactly what my buyers look for. Your Terms of Use rule out automated access without permission, so I am asking before the app reads any of your listings. So far our crawler has read only your robots.txt and your terms pages. What I am asking:

- May the app list your Wisconsin items: title, current bid, close time, town and a link to the item on bigiron.com? Photos and descriptions would stay on your site.
- Do you offer a feed or partner API? We would use it instead of reading pages. If not, our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) would read your Wisconsin sale pages a few times an hour at most, honour your 5-second Crawl-delay and obey robots.txt.

Every result would send the buyer to BigIron to bid.

Thank you,
[Name], [Business name]
[Phone] · [Email]

---

## 15. Steffes Group

**Why:** Steffes Group runs timed online equipment auctions across the upper Midwest. Among them are "Wisconsin Area Equipment Auctions", multi-location sales with items at Wisconsin sites.

**Why a letter:** robots.txt allows the auction pages (only `/api/` and account paths are disallowed). But the terms (steffesgroup.com/legal/terms, RESTRICTIONS (c), read 2026-10-01) bar using "any robot, spider, scraper, data mining tool, data gathering or extraction tool, or any other automated means, to access, collect, copy or record the Services". Held (0040).

**To:** Steffes Group, Inc. (Contact Us on steffesgroup.com)
**Subject:** Permission request: Wisconsin auction listings in an auction search app, with links back

Hello,

I run [business name], a resale business in [town], Wisconsin, and I am building Skeuos, an app that shows buyers the auctions near them, with every result linking to the lot's own page.

Your Wisconsin area equipment auctions belong in it. Your terms restrict automated access, so I am asking before the app reads any of your listings. So far our crawler has read only your robots.txt, your home page and your terms. What I am asking:

- May the app list your Wisconsin lots: title, current bid, close time, location and a link to the lot on steffesgroup.com? Bidding stays entirely with you.
- Is there a feed or partner access we could use? If not, our identified crawler (`WaystockBot/0.1`, described at waystock.org/bot) would read your Wisconsin auction pages about once an hour, one request at a time, and obey robots.txt, including your `/api/` rule.

Thank you,
[Name], [Business name]
[Phone] · [Email]
