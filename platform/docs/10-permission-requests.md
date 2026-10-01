# Permission requests

Four operators hold most of Wisconsin's online auction inventory, and each one's terms forbid automated collection without written permission (see `08-platform-access.md` §1a and §3.1). These are drafts for the owner to send. Nothing is sent automatically.

Each ask is shaped the same way, because it is the version an operator can say yes to:

- **What we collect.** Public listing facts only: title, current price, bid count, close time, pickup city and state, and the link. No bidder data, no accounts, no bidding.
- **How we collect it.** One honest, identified crawler (`WaystockBot/0.1 (+https://waystock.org/bot)`, to become SkeuosBot once the domain exists). It obeys robots.txt and paces its requests; the hourly load is stated in each letter.
- **What they get.** Every result links to the operator's own lot page, where the bidding happens. Skeuos sends them buyers.
- **The better option.** A feed or an API key replaces the crawler entirely, and we will take either.

Fill in the bracketed fields before sending.

---

## 1. Wisconsin Surplus Online Auction

**First priority.** The owner buys at Wisconsin Surplus for a resale business, and this is the source the app is for. The owner sends this letter personally; nothing is sent from here.

**Why it is held.** The User Agreement, Legal 21: "You agree that you will not use any robot, spider, other automatic device, or manual process to monitor or copy the Site or the content contained herein without Wisconsin Surplus' prior, express written permission." So the source is held (`ingest_allowed = false`, migration 0020) and nothing of theirs is read until that permission is in hand.

**What is built and waiting** (`crawl-public`, `adapters/wisconsin-surplus.ts`):

- Two requests an hour: the Current and the Upcoming auction lists (`/Public/Auction/GetAuctions`), the same request the site's own page makes. The run also reads robots.txt first, and the hourly probe reads it once more: four requests an hour in all.
- Every auction becomes a **sale card** in search and hunts, for example "Village of French Island: 2003 Ford F450 Super Duty Diesel Reg Cab 4WD Baby Dump Truck w/ Plow · La Crosse, WI · Sale · 2 lots · closes Oct 15". The card shows the sale's name and what it holds, its pickup town, its lot count and its end time, and it links to the sale's page. Hunts match the description, so a hunt for "welder" finds the sale whose description lists welders.
- Kept: title, description, end time, item count, pickup town and the link. Not kept: street addresses, phone numbers, or anything about bidders. No photos are shown until the letter's photo question is answered yes.

**Not built yet: single items.** The item lists load only after the auction page gives the browser a session cookie (docs/08 §3.14). Reading them needs this permission plus a short build and test against the live pages. The letter asks for it as a separate item, with a hard rate cap.

### Before you send

1. Fill in the bracketed fields with the contact details you want them to have. Nothing is filled in for you.
2. If you have a Wisconsin Surplus bidder account, give your bidder name or number. It shows them you are a customer.
3. Send it through the Contact page on wisconsinsurplus.com, or call the Mount Horeb office and ask who should receive it. No address is guessed here.
4. **The crawler's information link is not ready.** Every request carries `WaystockBot/0.1 (+https://waystock.org/bot)`. waystock.org is still the older Waystock app (Vercel project `waystock`, last deployed June 2026), so that link lands on an unrelated page. The page itself is written (`web/public/bot/index.html`, served at `/bot` by the Skeuos app). Before sending, either put the Skeuos app live on waystock.org, or choose another domain and the crawler's User-Agent will be changed to match. Their IT staff may well check that link.

### The letter

**To:** Wisconsin Surplus Online Auction, Mount Horeb
**Subject:** Request for written permission to read your public auction list

Hello,

My name is [Name]. I run [a small resale business / business name] in [town], Wisconsin, and I buy at your auctions[, bidder name or number].

I am building a tool, Skeuos, that watches Wisconsin auctions for the kinds of items I buy and tells me when a sale near me lists them. Your sales are the ones I care about most. Your User Agreement (Legal 21) asks for prior, express written permission before any automated monitoring of your site, so I am asking before the tool reads anything of yours.

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

**To:** Public Surplus support (publicsurplus.com)
**Subject:** Written permission request: listing Wisconsin Public Surplus auctions with links back

Hello,

I'm building Skeuos, an auction search app for Wisconsin buyers. Many Wisconsin school districts, counties, cities and technical colleges sell through Public Surplus, and I'd like to include their current Wisconsin auctions, with your permission.

Your Buyer Agreement (§1.5(v)) asks for prior written permission before any automated monitoring, so I'm asking first.

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

I'm building Skeuos, a Wisconsin-first auction search app. HiBid carries most of Wisconsin's private auction houses: 82 open auctions and about 24,500 open lots on 30 September 2026. Your terms forbid automated collection and aggregation, so we don't crawl HiBid; today we only link to HiBid searches.

I'd like to discuss a feed:
- **Scope:** open Wisconsin lots (title, current bid, bid count, close time, auction pickup location, lot URL). A delta feed of changes would keep the load minimal.
- **In return:** every result links to the lot on HiBid or the auctioneer's HiBid site, and we can add attribution or affiliate tracking.

Is there a partner or syndication program we could join?

Thank you,
[Name], Skeuos
[Contact email / phone]
