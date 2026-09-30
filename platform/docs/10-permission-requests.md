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

**To:** the contact on wisconsinsurplus.com (Wisconsin Surplus, Mount Horeb)
**Subject:** Permission to list Wisconsin Surplus auctions in a Wisconsin auction search app

Hello,

I'm building Skeuos, a search app that helps Wisconsin buyers find public and private auctions near them. It focuses on tools, equipment, vehicles and provisions. Wisconsin Surplus is the most important source for state and municipal surplus in Wisconsin, and I'd like to include your auctions with your permission.

Your User Agreement (Legal 21) asks for written permission before any automated access, so I am asking before we list anything.

What we would show:
- Each current auction's title, selling agency, pickup city, close time and lot count, linked to its page on bid.wisconsinsurplus.com.
- Where you allow it, each lot's title, current bid and close time, linked to the lot page. Bidding stays on your site.

What it costs you: about [2–100] requests an hour from one identified crawler, `WaystockBot/0.1 (+https://waystock.org/bot)`, which obeys robots.txt. A feed or export of current auctions would replace the crawler entirely, and we'd prefer that if you have one.

Would you grant written permission, or point me to a feed? I'm glad to talk, and to stop immediately if you'd rather we didn't.

Thank you,
[Name], Skeuos
[Contact email / phone]

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
