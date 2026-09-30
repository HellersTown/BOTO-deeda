# Bidding strategies

What Skeuos should tell a user about a lot: how high to go, when to bid, and
when to walk away. It also covers why each rule is there and how strong the
evidence behind it is. Section 9 is a JSON rules spec the app can evaluate for
every lot.

> **Read this first: how the evidence was gathered, and how far to trust it.**
>
> The research environment's egress policy blocked direct page fetches from
> essentially every relevant host, including:
>
> - eBay, GSA, K-BID and Purple Wave;
> - the HiBid, MaxSold and Public Surplus help sites;
> - NBER, AEA, Stanford, Wikipedia, Cornell LII and auctioneers.org;
> - the Wisconsin DOR and legislature sites, EstateSales.net and Reddit.
>
> The proxy also logged refusals for GovDeals, Public Surplus and Municibid. What was
> reachable was a web search tool that returns result links plus an extract of each
> page's content. The session's search budget ran out after that pass.
>
> The labels below tell you how much each claim can bear:
>
> | Label | Meaning |
> |---|---|
> | **[SE]** | Stated in a search-engine extract of the cited page. The page itself was **not opened**. Text in quotation marks is extract text and may contain small paraphrases. Spot-check before quoting it to users. |
> | **[SE-2nd]** | Stated in an extract of a **secondary or third-party** page, for example a guide summarising a platform's rules. Confirm against the primary source before relying on it. |
> | **UNVERIFIED** | No source this session. It comes from background knowledge, or is a common practitioner claim that could not be checked. Never show it to users as fact. |
> | **PLACEHOLDER** | A parameter value that makes the calculator runnable. **It is not a measurement.** Replace it with a calibrated value before users see it as advice. |
> | **INTERNAL** | Taken from Skeuos's own code or docs, not from outside evidence. |
> | **DESIGN** | A product choice, not a claim about the world. |
>
> **The biggest gap:** the brief asked for practitioner evidence from Reddit, reseller
> YouTube and podcasts, BiggerPockets and NAA/Auctioneer magazine. None of those
> could be read. Every practitioner rule of thumb below (the rule of thirds,
> category margins, estate-sale discount days, sign-in lists, comps tools) is marked
> UNVERIFIED. The academic and platform-rule evidence is much stronger. Section 10
> lists exactly what to verify next and where.
>
> Access date for every source: **2026-09-27**.

---

## 1. Executive summary

Skeuos cannot place bids itself: eBay's `placeProxyBid` is Limited Release, and no
other platform has a bidding API (see [`00-architecture.md` §8](00-architecture.md)).
So every strategy here takes the form *compute a number, pick a moment, alert the
user, and deep-link to the lot*. That fits how the evidence says to bid anyway: one
number, entered once, at the right time.

**The strongest findings, most useful first:**

1. **Decide the walk-away number before the auction, from what the item sells for.
   Never set it from what other people are bidding.** In eBay field data, **42%** of
   auctions for one board game ended above the fixed price for the same item shown on
   the same page, and **48%** did in a broad cross-section. A small minority of bidders
   (**17%**) was enough to cause it (Lee & Malmendier 2011) [SE]. A later comment argues
   search costs explain part of this (Schneider 2016) [SE]. Either way, a fixed-price
   cap is cheap insurance. *Confidence: high.*
2. **Match timing to the closing rule.**
   - **Hard close (eBay):** place one bid at your ceiling in the final seconds. Late
     bidding is the norm there (40–59% of eBay auctions had their last bid in the final
     5 minutes, against about 3% on Amazon's extending auctions; Roth & Ockenfels
     2002) [SE]. The measured saving is **small**: a statistically significant but small
     surplus gain in one field experiment (Ely & Hossain 2009) [SE], and 2.54% lower
     prices that were *not* significant in another (Gray & Reiley 2013) [SE].
   - **Extending close (almost everything else Skeuos indexes):** sniping is
     neutralised. The theory says its advantage is "eliminated or severely attenuated"
     (Ockenfels & Roth 2006) [SE]. Enter your full ceiling as a proxy bid **before** the
     extension window opens. Windows found: GovDeals 3 min [SE-2nd; another guide
     says 2–5], Public Surplus
     5 min [SE], Wisconsin Surplus 10 min [SE], MaxSold 2 min [SE], AuctionNinja 5 min
     [SE], K-BID 3 min [SE], HiBid 2–5 min set by each auctioneer [SE]. GSA closes only
     after a per-lot inactivity period [SE].

   *Confidence: high for the mechanics; medium for the size of any saving.*
3. **Bid once. Don't increment, and don't sit in the lead for days.** Snipers exist to
   exploit incremental bidders (Ockenfels & Roth 2006) [SE]. Bidders asked to imagine
   leading for longer bid higher (Heyman, Orhun & Ariely 2004) [SE]. Being sniped makes new
   bidders 4–18% less likely to come back (Backus et al. 2015) [SE]. Early proxy bids
   also let a shill find your number: one estimate puts 1.39% of eBay bids as seller
   shills, using a "discover-and-stop" pattern (Engelberg & Williams 2009) [SE].
   *Confidence: medium-high.*
4. **Price the whole invoice, not the hammer.** At a 10–20% premium, 5.5% tax and a 3%
   card fee, the invoice runs 20–30% above the hammer (§4 arithmetic). Government surplus adds hard
   deadlines. GSA wants payment within **2 business days** and removal within **10
   business days** of the award email [SE]. Defaulting is reported to cost the greater
   of 20% or $200 [SE-2nd]. Wisconsin Surplus charges **$10/day** storage after its
   removal deadline [SE]. *Confidence: high for the rules quoted.*
5. **Crowds are not information.** Bidders herd into lots that already have bids, even
   when those bids only reflect a low opening price, and pay more when they win them
   (Simonsohn & Ariely 2008) [SE]. Low openings raise final prices through more entry,
   sunk-cost escalation and value inference (Ku, Galinsky & Murnighan 2006) [SE].
   *Confidence: medium-high.*
6. **Look for lots with thin disclosure, but charge them a condition haircut.** On eBay
   Motors, photos and text disclosures "significantly influence" prices (Lewis 2011)
   [SE]. A CUNY thesis on eBay Motors (Nizard) reports that an additional photo raised
   prices, bidder counts and the probability of sale [SE]. Fewer photos means fewer rivals, but also more
   risk. That is exactly the logic of Skeuos's existing `compute_sleeper()`.
   *Confidence: medium.*
7. **Treat a secret reserve as a floor you probably won't like.** In a field
   experiment, secret reserves reduced the chance of sale, deterred serious bidders
   and lowered prices (Katkar & Reiley) [SE]. Don't chase a "reserve not met" lot that
   is already near your ceiling. *Confidence: medium.*
8. **Uncertain-value lots have a winner's curse.** In the classic jar experiment,
   average estimates were below the true $8.00 value, yet the average winning bid was
   $10.01 (Bazerman & Samuelson 1983) [SE-2nd]. On eBay coin auctions, bidders'
   expected profit falls 3.2% for each extra expected bidder (Bajari & Hortaçsu 2003)
   [SE]. Haircut mixed lots, untested electronics, vehicles and equipment. *Confidence:
   high that the effect exists; the size of Skeuos's haircut is a PLACEHOLDER.*

**What to ship first.** Build the calculator (§4) and rules R02, R10, R11, R12, R30,
R35 and R36 in §9. These rest on the strongest evidence and need only data Skeuos
already stores (`lots.current_bid_cents`, `bid_count`, `closes_at`,
`auctions.buyer_premium_pct`, `image_count`, `desc_richness`). Pre-fill
`watchlist.max_bid_cents` with the computed ceiling and `watchlist.remind_seconds_before`
with the rule's alert time.

**What not to ship yet.** The category defaults (§4.3) are placeholders, and so are the
practitioner heuristics marked UNVERIFIED. Do not show them as advice until they are
calibrated or sourced.

---

## 2. Strategy library

Each strategy has the same fields: **Applies to**, **Rule**, **Inputs**, **Expected
effect**, **Evidence** and **Confidence**. Rule IDs such as `R11` refer to the JSON spec
in §9.

### S1. Set the walk-away number before you look at the bidding

- **Applies to:** every format, platform and category.
- **Rule:** compute `H_max` with the §4 calculator, the most you will let the hammer
  reach. Never bid above it. Revise it only for **new information about the item**
  (condition, completeness, provenance, better comps). Never revise it because
  someone else bid. (`R02 WALK_AWAY_OVER_MAX`)
- **Inputs:** expected resale value from sold comps, buyer's premium, tax, card fee,
  pickup distance, category risk, and an optional budget.
- **Expected effect:** avoids overpaying. No claim is made that it lowers the winning
  price; it lowers the price *you* pay, sometimes to zero, by making you lose.
- **Evidence:**
  - Lee & Malmendier (2011): "42 percent of auctions exceed the simultaneous fixed
    price" for a board game, and 48% across a broad cross-section. "17 percent of
    bidders" suffice to produce it [SE].
  - Bazerman & Samuelson (1983): in common-value auctions of $8.00 jars, the average
    winning bid was $10.01, an average loss of $2.01 [SE-2nd].
  - Ku, Malhotra & Murnighan (2005): "rivalry, time pressure, presence of an audience"
    stimulate arousal and increase bidding [SE].
- **Confidence:** **high** that overbidding is common. A pre-commitment rule is the
  standard countermeasure; that framing is a DESIGN choice, not a tested intervention.

### S2. Cap every bid at the fixed-price alternative

- **Applies to:** anything that also sells at a fixed price, such as eBay Buy It Now,
  retail or dealer stock. It matters most for personal-use buyers.
- **Rule:** `all_in(H) ≤ best fixed-price alternative, all-in`. A reseller enters sold
  comps as `expected_resale_cents`. A personal-use buyer enters the cheapest
  fixed-price alternative there. (`R30 ABOVE_VALUE_ALREADY`)
- **Inputs:** `expected_resale_cents` and the cost multiplier `k` (§4).
- **Expected effect:** removes the whole class of "won it for more than the store
  price" outcomes.
- **Evidence:**
  - Lee & Malmendier (2011), as in S1 [SE]. An extract of the comment literature
    reports 73% overbidding once higher auction shipping costs are counted [SE-2nd].
  - Schneider (2016, comment): the overbidding "is not inconsistent with standard
    behavior once search costs are considered" [SE]. Even so, the cap stands; it just
    also has to count the user's search time.
- **Confidence:** **high**.

### S3. Price the whole invoice, not the hammer

- **Applies to:** every auction with a premium, tax, card fee, storage or removal cost.
- **Rule:** `k = (1 + premium%) × (1 + tax) × (1 + card fee)`. Every $100 of hammer
  costs `100 × k` on the invoice. Pickup (`T`) comes on top. (`R36 TRUE_COST`,
  `R35 PREMIUM_ASSUMED`)
- **Inputs:** `buyer_premium_pct`, platform defaults and the tax rate.
- **Expected effect:** ceilings that are real. At an 18% premium, 5.5% tax and a 3%
  card fee, `k` = 1.282, so a $100 bid is a $128 invoice. That example is our own
  arithmetic.
- **Evidence:** GovDeals premium reported as seller-set, capped at 12.5%, typically
  7.5–12.5%, with a 2.5–3.5% card surcharge [SE-2nd]. Wisconsin Surplus adds a tiered
  "Auction Buyer's Fee" determined by "the actual amount of the final accepted high
  bid" [SE]. GSA reportedly charges no buyer's premium [SE-2nd], and "The U.S. Federal
  Government will not charge sales tax", although "your state may charge sales taxes
  for items that have to be registered, such as vehicles" [SE].
- **Confidence:** **high** for the arithmetic. Default rates are medium or UNVERIFIED
  per platform (§5).

### S4. Hard close: one bid, at your ceiling, in the last seconds

- **Applies to:** eBay, and any lot whose published extension window is 0.
- **Rule:** don't bid while watching. Alert at T−120 s. Place **one** bid equal to
  `H_max` with about 10 s left by hand; a sniping service can go later.
  (`R10 HARD_CLOSE_SINGLE_LATE_BID`)
- **Inputs:** `closes_at`, `soft_close_window_minutes = 0` or `platform = ebay`, and
  `H_max`.
- **Expected effect:** a small saving on average, and no bidding war. It also denies
  incremental bidders and shills the chance to react.
- **Evidence:**
  - Roth & Ockenfels (2002): "40 percent of eBay-Computers auctions and 59 percent of
    eBay-Antiques auctions have last bids in the last 5 minutes, as compared to about 3
    percent of both Amazon-Computers and Amazon-Antiques auctions". Amazon's auctions
    "continue if necessary past the scheduled end time until ten minutes have passed
    without a bid". "More experience causes bidders to bid later on eBay, but earlier on
    Amazon" [SE].
  - Ariely, Ockenfels & Roth (2005, lab): "the difference in auction ending rules is
    sufficient by itself to produce the differences in late bidding" [SE].
  - Ockenfels & Roth (2006): "Sniping in fixed-deadline auctions also arises … as a
    best reply to incremental bidding" [SE].
  - Ely & Hossain (2009), DVD field experiment: sniping gave a "statistically
    significant increase in average surplus, however, this improvement was small".
    Snipes were placed "within the last 5 seconds" via a sniping service [SE]. The size
    is reported as about 18 cents, or 1.36% of induced value [SE-2nd].
  - Gray & Reiley (2013), 70 matched pairs: "2.54% lower prices for the sniped auction,
    but did not find this benefit to be statistically significant" [SE].
  - Roth & Ockenfels also note that "very late bids have a positive probability of not
    being successfully submitted" [SE]. That is why the manual target is 10 s rather
    than 1 s (a DESIGN choice).
- **Confidence:** **medium**. The direction is consistent across studies; the dollar
  benefit is small and sometimes not significant.

### S5. Extending close: enter your ceiling as a proxy before the window opens

- **Applies to:** GovDeals, Public Surplus, Municibid, Wisconsin Surplus, HiBid timed,
  K-BID, Proxibid timed, MaxSold, AuctionNinja and GSA (inactivity close).
- **Rule:** let `W` be the extension window. Enter `H_max` once as a max or proxy bid
  at least `W + 1` minutes before the scheduled close, with an alert at T−(W+5) min.
  If you are already inside the window, enter the ceiling once and do not raise it. If
  `W` is unknown, assume 10 minutes. (`R11 PROXY_BEFORE_WINDOW`,
  `R12 IN_EXTENSION_WINDOW`, `R13 EXTENSION_RULE_UNKNOWN`)
- **Inputs:** `soft_close_window_minutes` (or the platform default), `closes_at` and
  `H_max`.
- **Expected effect:** you participate at your full value without triggering or
  prolonging a bidding war. Sniping on these platforms only restarts the clock.
- **Evidence:**
  - Ockenfels & Roth (2006): "the strategic advantages of sniping are eliminated or
    severely attenuated in auctions that apply the automatic extension rule" [SE].
  - Overstock vs eBay: on soft-close Overstock, "sniping happens predominantly in a
    short window of time before the triggering period". In other words, experienced
    bidders bid just before the window, which is this rule [SE].
  - Platform rules, quoted in §5. For example, Public Surplus: "If a bid that changes
    the maximum offer amount, including a proxy bid, is placed during the final five
    (5) minutes … its end time will automatically extend for 5 additional minutes"
    [SE].
- **Confidence:** **high**.

### S6. Bid once; never increment

- **Applies to:** all online formats.
- **Rule:** at most one bid per lot, at `H_max`. A second bid is allowed only after
  new information about the item. Skeuos should never show "+1 increment" as a
  suggested action.
- **Expected effect:** you stop being the target that sniping strategies are built to
  beat, and your valuation doesn't drift upward with competition.
- **Evidence:**
  - Ockenfels & Roth (2006): "one substantial cause of late bidding is as a strategic
    response to incremental bidding" [SE].
  - Backus, Blake, Masterov & Tadelis (2015): new bidders who get sniped are "between
    4 and 18 percent less likely to return to the platform" [SE]. The paper's premise
    is that snipers catch incremental bidders "at a price below their reserve, with no
    time to respond". The regret is real, and it lands on the incremental bidder.
  - Heyman, Orhun & Ariely (2004): the "opponent effect" and "quasi-endowment" raise
    bids during an auction [SE].
- **Confidence:** **medium-high**.

### S7. Don't sit in the lead for days

- **Applies to:** multi-day timed auctions.
- **Rule:** watch, but don't bid until the final hours. On extending closes, bid just
  before the window (S5); on hard closes, in the final seconds (S4).
- **Expected effect:** less self-inflicted escalation, and less herd attraction to the
  lot.
- **Evidence:** "Subjects told to imagine they were in the lead for longer periods of
  time submitted higher bids" (Heyman, Orhun & Ariely 2004) [SE]. Bidders herd into
  lots with more existing bids (Simonsohn & Ariely 2008) [SE], so an early bid of
  yours recruits competition.
- **Confidence:** **medium**. The quasi-endowment evidence is experimental, and part
  of it used hypothetical bids.

### S8. Fade the herd: a high bid count is not a quality signal

- **Applies to:** all online auctions.
- **Rule:** when `bid_count ≥` the category's herd threshold (a PLACEHOLDER), warn and
  suggest quieter comparable lots. (`R32 HERD_WARNING`)
- **Expected effect:** shifts the user toward lots where they face fewer rivals.
- **Evidence:** Simonsohn & Ariely (2008): "Bidders herd into auctions with more
  existing bids, even if these are a signal of no-longer-available lower starting
  prices rather than of higher quality". "Bidders bidding a given dollar amount are less
  likely to win low starting price auctions, and pay more for them when they do win".
  "Experienced bidders are less likely to bid on low starting price auctions" [SE].
- **Confidence:** **medium-high** for the effect. The threshold is a PLACEHOLDER;
  calibrate it per category from the `bid_events` distribution.

### S9. Anchor on comps, never on the opening price

- **Applies to:** no-reserve lots and low openings ($1 starts, "no reserve" farm and
  estate auctions).
- **Rule:** ignore the opening price and the current bid when forming value. A low
  start predicts a *higher* finish, not a bargain.
- **Evidence:** Ku, Galinsky & Murnighan (2006): "lower starting prices result in
  higher final prices". The paper names three routes. Low starts "reduce barriers to
  entry, which increase traffic". They "entice bidders to invest time and energy
  (creating sunk costs) and, consequently, escalate their commitments". And the
  resulting "traffic … can lead bidders to infer value in the item" [SE].
- **Confidence:** **medium-high**. The paper uses six studies, lab and field.

### S10. Hunt thin disclosure, with a condition haircut

- **Applies to:** every platform, and especially general-merchandise, estate and
  municipal lots.
- **Rule:** flag lots with fewer than 12 words or fewer than 3 photos that have 0–1
  bids. Ask the user to identify the item from the photos. The ceiling already
  carries the category's uncertainty and repair haircut. With 0 photos on a
  high-value category, the advice is "inspect or skip". (`R34 SLEEPER_CANDIDATE`,
  `R33 INSPECT_OR_SKIP`, `R45 CLOSING_QUIET`; thresholds INTERNAL, from
  `compute_sleeper()`)
- **Expected effect:** fewer rivals and lower prices where the seller under-described
  the lot. There is also more lemon risk, which the haircut prices in.
- **Evidence:**
  - Lewis (2011), eBay Motors: "online disclosures are important price determinants,
    and … disclosure costs impact both the level of disclosure and prices". Disclosure
    defines "a precise contract … to deliver the car shown — which helps protect the
    buyer from adverse selection" [SE].
  - A CUNY thesis on eBay Motors (Nizard) reports that "an additional photo will
    increase all three of the outcome variables (bid prices, number of bidders, and
    probability of trade) and more so for non-dealers than for dealers" [SE]. The
    extract describes the data as 80,000 completed used-car auctions, March–October
    2006. It is ambiguous whether that describes the thesis's data or Lewis's; check.
  - A blog summary puts it at about $80 per extra photo on eBay Motors [SE-2nd].
- **Confidence:** **medium** for the demand effect. The size of the discount available
  to a buyer is **not measured** here.

### S11. Hunt misspelled and miscategorised lots

- **Applies to:** eBay and any keyword-searched platform. Skeuos's image search
  (00-architecture §6) is the systematic version of this.
- **Rule:** run typo variants and category-agnostic image matches for every standing
  hunt. Treat a hit like S10: few rivals, so identify it carefully.
- **Evidence:** a 2004 *New York Times* piece, "In Online Auctions, Misspelling in Ads
  Often Spells Cash", with the example of "chandaleer earrings" [SE]. Several
  typo-search tools exist for eBay (TypoHound, Typable, GoofBid, AuctionSpeller,
  NoBids), which shows the practice is widespread [SE]. **No peer-reviewed estimate of
  the discount was found.** A "12–37% median price reduction" figure appears on an
  unsourced commercial blog. It is **UNVERIFIED; do not use it.**
- **Confidence:** **low-medium**.

### S12. Shade uncertain-value lots for the winner's curse

- **Applies to:** mixed and box lots, "untested" electronics, vehicles, equipment,
  jewelry and aircraft. These are lots where every bidder is guessing the same unknown
  value.
- **Rule:** the ceiling deducts `uncertainty_haircut_rate × R` (a PLACEHOLDER per
  category). The more competitors a lot has, the more the winner is likely to be the
  one who overestimated, so don't bid past the haircut. (`R44 WINNERS_CURSE_GUARD`)
- **Evidence:**
  - Bazerman & Samuelson (1983): average estimate $5.13 against a true value of $8.00,
    yet an average winning bid of $10.01; winners lost money in more than half of the
    auctions [SE-2nd].
  - Bajari & Hortaçsu (2003), eBay coin auctions: "a bidder's expected profits fall by
    3.2 percent when the expected number of bidders increases by one". Bidders need
    "$3.20 of expected profit to enter" [SE].
- **Confidence:** **high** that the effect exists; **low** for any specific haircut
  size.

### S13. Treat a secret reserve as a floor you probably won't like

- **Applies to:** reserve auctions, where the `reserve_flag` is `reserve_not_met`.
- **Rule:** if the reserve is not met and the current bid is already ≥ 90% of your
  ceiling (the 90% is a PLACEHOLDER), stop. Watch for a relist. (`R03
  RESERVE_NOT_MET_STOP`)
- **Evidence:**
  - Katkar & Reiley (50 matched pairs of Pokémon cards): secret reserves reduce "the
    probability of the auction resulting in a sale, deterring serious bidders from
    entering the auction, and lowering the expected transaction price" [SE].
  - Contrast: Bajari & Hortaçsu find "items with higher book value tend to be sold
    using a secret reserve price with a low minimum bid" [SE]. A search extract also
    says secret reserves raised prices relative to open reserves in their data
    [SE-2nd]. Our inference: sellers of valuable items use secret reserves, so a secret
    reserve is itself a hint the seller values the item highly.
- **Confidence:** **medium**.

### S14. Keep your ceiling hidden from shills

- **Applies to:** proxy-bidding platforms, where a proxy bid entered early can be
  probed.
- **Rule:** enter the ceiling late (S4/S5). If the price climbs in minimum increments
  **only while you are the high bidder**, and the other bidder stops just short, treat
  it as a possible shill. Do not raise.
- **Evidence:** Engelberg & Williams (2009) estimate "1.39% of all bids in eBay
  auctions are placed by sellers (or accomplices)". They use a "Discover-and-Stop"
  strategy in which a shill "can push the price of an item up to the highest bidder's
  bid without becoming the high bidder" [SE].
- **Confidence:** **medium**. Detecting it per lot needs bidder-level history in
  `bid_events`, which is outside the §9 input set, so it stays a prose rule for now.

### S15. Expect higher prices where the clock extends

- **Applies to:** every extending-close platform.
- **Rule:** plan for less discount. Use extending-close lots for items you need, and
  hunt bargains where attention is thin (S10, S11) or rules are unusual (S18).
  (`R37 EXTENDING_CLOSE_PRICES_HIGHER`)
- **Evidence:**
  - Glover & Raviv (2012), Yahoo!: soft close "increases the selling price by an
    amount between $25 and $44 (or 13–20 percent) over the hard-close format" [SE].
  - Houser & Wooders (14 pairs of $50 gift certificates): "revenues are higher under
    the soft-close ending rule" [SE].
  - The Overstock study "confirms the positive revenue effect for soft-close auctions
    over hard-close ones" [SE].
- **Confidence:** **medium**. It is consistent across three studies, but the samples
  are small or narrow.

### S16. End time, day of week and duration: weak signals

- **Applies to:** choosing which lots to watch, not how much to bid.
- **Rule:** prefer lots that close in crowded windows, where many similar lots close
  at once, and short-duration listings. Do not use day-of-week rules.
- **Evidence:**
  - Simonsohn (2010): "(i) a disproportionate share of auctions end during peak bidding
    hours, (ii) such hours exhibit lower selling rates and prices" [SE]. That is
    seller-side evidence from eBay; the transfer to HiBid catalogs is UNVERIFIED.
  - Lucking-Reiley et al. (2007), eBay one-cent coins: 7-day auctions averaged 24% and
    10-day auctions 42% higher prices than shorter ones [SE].
  - Day-of-week effects are inconsistent. Weekend revenue was 7% higher but "not
    significantly different from zero at the 5% level" in one eBay coin study
    [SE-2nd]. German eBay wine sold about 9% higher on Fridays than Sundays in another
    [SE-2nd; source not pinned down].
- **Confidence:** **low-medium**. There is deliberately no JSON rule for this.

### S17. Price the pickup before the bid

- **Applies to:** pickup-only lots: all government surplus and most HiBid, K-BID and
  estate lots.
- **Rule:** `T = 2 × miles × cost per mile + time cost` is deducted from the ceiling.
  Warn when `T > 25%` of resale (a PLACEHOLDER). Before bidding, check the removal
  deadline and whether the site loads for you. (`R31 PICKUP_EATS_MARGIN`, `R38`,
  `R39`, `R40`)
- **Expected effect:** kills small far-away lots. At the default settings, a $200 tool
  lot 40 miles away has a ceiling of $0; the test case is in §9.3.
- **Evidence:** GSA says property must be "removed within 10 business days from the
  time and date of the award e-mail" [SE]. "GSA Auctions® does not ship merchandise"
  [SE]. Storage fees apply after the allowance [SE]. Wisconsin Surplus: "A $10 Per Day
  Storage Fee Applies on all items remaining after the posted removal deadline" [SE].
- **Confidence:** **high** for the rules; the per-mile cost is UNVERIFIED (§4.3).

### S18. Government-surplus specifics that change the play

- **Applies to:** GSA, GovDeals, Public Surplus, Municibid and Wisconsin Surplus.
- **Rules:**
  1. **GSA inactivity close.** Most lots close only after an inactivity period, found
     on the "Bidding Details" tab. In GSA's example, with a 2:00 pm close and a
     10-minute period, a bid at 1:55 pm moves the close to 2:05 pm [SE]. On GSA's real
     estate site, "Modifying your Proxy bid during the inactivity period will also
     reset the time of the auction" [SE]. Don't fiddle with your own bid late.
  2. **GSA increments shrink on stale lots.** If a lot goes a set period (for example
     2 days) without bids, "the system will automatically lower the minimum amount
     required for the next bid", down to a "reduction limit" [SE]. On a quiet lot,
     don't pay a full increment early.
  3. **Pay and remove on time.** GSA: payment in 2 business days, removal in 10
     business days [SE]. Accepted payment is credit card, debit card or wire.
     Credit cards go up to "$24,999.99 per card, per day". Debit cards must carry a
     card-network logo, and ones with dollar limits or a PIN are refused [SE].
     Default is reported to cost the greater of 20% or $200 [SE-2nd]; a contract
     appeals decision upheld 20% [SE].
  4. **Vehicles.** The SF-97 "is evidence of title only and is to be used by the
     purchaser to obtain a proper state motor vehicle registration" [SE].
- **Confidence:** **high** for GSA rules (primary extracts); **medium** for the
  GovDeals items, which come from third parties.

### S19. Allocate a budget across many lots

- **Applies to:** users bidding on several lots in one night or one catalog.
- **Rule (DESIGN):**
  - **Exposure** = Σ over lots where the user's bid is live of `H_max,i × k_i + T_i`.
    Keep exposure ≤ budget unless the user explicitly accepts the risk of winning
    everything.
  - To bid on more lots than the budget covers, use **expected spend** =
    Σ `p_win,i × E[price_i | win]`, where `p_win` comes from Skeuos's own history of
    outcomes against ceilings (`watchlist.outcome`, `lots.sold_price_cents`).
  - Share one trip: pickup cost `T` is per **site**, so lots at the same site should
    split it (the §9 spec, which is per-lot, charges it to each lot).
- **Evidence:** Ely & Hossain's results are explained by "a model of multiple
  concurrent auctions, in which opponents are naive or incremental bidders" [SE].
  Concurrent lots are substitutes, which is why a disciplined bidder can lose many and
  still fill a budget. No field evidence on portfolio rules was found (UNVERIFIED).
- **Confidence:** **low-medium**. It is sound arithmetic, but the win probabilities
  need calibration.

### S20. Format-specific plays (details in §6)

- **Live webcast:** leave an absentee (max) bid at `H_max` instead of bidding live.
  The competitive-arousal evidence (S1) is strongest for live rooms: rivalry, an
  audience and time pressure. (`R14`) *Confidence: medium.*
- **Sealed bid:** you pay what you bid. Submit `H_max`, since the margin is already
  inside it; don't add to it. (`R15`) *Confidence: medium.*
- **Estate tag sale:**
  - Buy scarce under-ceiling items early on day 1.
  - Wait for a last-day discount on bulky, common items.
  - Discount schedules and sign-in practices are UNVERIFIED. (`R16`–`R18`)

  *Confidence: low.*

### S21. Practitioner rules of thumb (all UNVERIFIED in this pass)

These are widely repeated in reseller communities. None could be sourced this
session. Skeuos may show them only as labelled cross-checks, never as the ceiling.

| Heuristic | Form | How Skeuos uses it |
|---|---|---|
| Rule of thirds | Pay ≈ ⅓ of resale; ⅓ covers costs; ⅓ is profit | Display `thirds_rule_cents` next to `H_max`. It roughly equals the §4 formula when fees + costs + risk ≈ ⅓ of resale. |
| "Buy at a percentage of sold comps" | Pay a fixed percentage of the median sold price | Not used. The §4 formula makes the same thing explicit per category. |
| Sold, not asking | Comps must be completed **sold** prices, same condition, recent | Built into the `expected_resale_cents` definition. |
| Non-round max bids | Enter $101.37 rather than $100 to win ties against round-number bidders | Not used. UNVERIFIED, and the effect on outcomes is unmeasured. |
| Estate sale "day 2 = 25% off, day 3 = 50% off" | Common schedule | The example in the brief. The spec uses a 50% PLACEHOLDER for "final day" and tells the user to check the company's schedule. |

---

## 3. What "evidence" means for each strategy

| Strategy | Best evidence | Type | Confidence |
|---|---|---|---|
| S1 walk-away number | Lee & Malmendier 2011; Bazerman & Samuelson 1983 | Field data + lab | High |
| S2 fixed-price cap | Lee & Malmendier 2011 (Schneider 2016 caveat) | Field data | High |
| S3 whole-invoice pricing | Platform terms (GSA, Wisconsin Surplus; GovDeals via third parties) | Primary/secondary | High (arithmetic) |
| S4 hard-close late bid | Roth & Ockenfels 2002; Ely & Hossain 2009; Gray & Reiley 2013 | Field data + field experiments | Medium |
| S5 proxy before window | Ockenfels & Roth 2006; Overstock 2019; platform rules | Theory + field data + primary | High |
| S6 bid once | Ockenfels & Roth 2006; Backus et al. 2015; Heyman et al. 2004 | Theory + field + lab | Medium-high |
| S7 don't lead early | Heyman et al. 2004; Simonsohn & Ariely 2008 | Lab + field | Medium |
| S8 fade the herd | Simonsohn & Ariely 2008 | Field | Medium-high |
| S9 ignore the opening price | Ku, Galinsky & Murnighan 2006 | Lab + field | Medium-high |
| S10 thin disclosure | Lewis 2011; Nizard | Field | Medium |
| S11 typos | NYT 2004; existence of typo tools | Journalism | Low-medium |
| S12 winner's curse | Bazerman & Samuelson 1983; Bajari & Hortaçsu 2003 | Lab + structural | High (existence) |
| S13 secret reserves | Katkar & Reiley; Bajari & Hortaçsu 2003 | Field experiment + structural | Medium |
| S14 shills | Engelberg & Williams 2009 | Field | Medium |
| S15 extending close ⇒ higher prices | Glover & Raviv 2012; Houser & Wooders; Overstock 2019 | Field | Medium |
| S16 timing/duration | Simonsohn 2010; Lucking-Reiley et al. 2007 | Field | Low-medium |
| S17 pickup economics | GSA terms; Wisconsin Surplus terms | Primary | High |
| S18 government specifics | GSA FAQ/terms; CBCA decision | Primary | High |
| S19 portfolio | Ely & Hossain 2009 (concurrent-auction model) | Theory | Low-medium |
| S20 formats | Ku et al. 2005 (live); theory | Lab/field | Low–medium |
| S21 practitioner heuristics | none this session | — | UNVERIFIED |

---

## 4. Max-bid calculator

### 4.1 Formula

```
Inputs per lot:   R  expected resale (median of recent SOLD comps, same condition)   [user]
                  B  user's max budget, invoice total                                 [user, optional]
                  bp buyer's premium %            (lot terms → platform default → 20% PLACEHOLDER)
                  t  sales/use tax rate           (0.055 UNVERIFIED; 0 for exempt resale inventory)
                  c  card surcharge rate          (platform default → 3% PLACEHOLDER)
                  d  one-way pickup miles         (null ⇒ ships; inbound shipping not modelled)

Per category:     f   selling fee rate            (marketplace + payment fees on resale)
                  s   outbound shipping you absorb, cents
                  u   uncertainty haircut rate    (winner's-curse / lemon reserve)
                  r   repair & cleaning reserve rate
                  m   target margin rate
                  Pmin minimum profit per lot, cents

Constants:        cpm cost per mile (70¢ UNVERIFIED), τ time cost per pickup trip ($25 PLACEHOLDER)

Derived:
  k  = (1 + bp/100) × (1 + t) × (1 + c)          invoice dollars per hammer dollar
  T  = 2 × d × cpm + τ                            pickup cost (0 if d is null)
  N  = R × (1 − f) − s                            net proceeds when you resell
  P  = max(m × R, Pmin)                           profit you require
  X  = (u + r) × R                                risk + repair reserve

  H_resale = max(0, floor_to_dollar( (N − P − T − X) / k ))
  H_budget = floor_to_dollar( B / k )                              (if B given)
  H_max    = min(H_resale, H_budget)   — whichever exist

Checks:
  all_in(H)      = H × k + T                      what the lot really costs you
  walk away when   next_min_bid > H_max           (R02)
  warn when        all_in(current) ≥ R            (R30: already at/above value)
  cross-check      thirds = R / 3                 (practitioner rule of thirds, UNVERIFIED, display only)
```

Every term is computed in `derived` in §9. `floor_to_dollar` rounds down to whole
dollars, so users never see a ceiling in cents.

### 4.2 Worked example

These use the §4.3 placeholder defaults and come from the synthetic test lots in §9.3.

| | eBay tool lot | HiBid tool lot, 40 mi away | Wisconsin Surplus coin lot, $200 budget |
|---|---|---|---|
| R (sold comps) | $300 | $200 | $300 |
| f, s | 14%, $0 | 14%, $0 | 5%, $0 |
| N = R(1−f) − s | $258 | $172 | $285 |
| P = max(mR, Pmin) | max($90, $25) = $90 | max($60, $25) = $60 | max($30, $10) = $30 |
| X = (u+r)R | 15% → $45 | 15% → $30 | 5% → $15 |
| T | $0 (ships) | 2×40×$0.70 + $25 = $81 | 2×30×$0.70 + $25 = $67 |
| k | 1 × 1.055 × 1 = 1.055 | 1.18 × 1.055 × 1.03 = 1.282 | 1.10 × 1.055 × 1.03 = 1.195 |
| H_resale | ($258−90−0−45)/1.055 = **$116** | ($172−60−81−30)/1.282 → **$0** | ($285−30−67−15)/1.195 = **$144** |
| H_budget | — | — | $200/1.195 = $167 |
| **H_max** | **$116** | **$0: skip** (`R01`) | **$144** (resale binds) |
| Rule-of-thirds cross-check | $100 | $66 | $100 |

The middle column is the most useful lesson in this document for a Wisconsin user.
**Once pickup is priced honestly, small lots far away are worth nothing.** Combine
several lots at one site into one trip, or skip.

### 4.3 Default values

**Platform defaults.** These are used only when the lot's own terms were not
captured. The lot's terms always win.

| Platform | Premium default | Card fee default | Extension window default | Status / source |
|---|---|---|---|---|
| eBay | 0% | 0% | 0 (hard close) | Hard close [SE] Roth & Ockenfels; premium and fee UNVERIFIED |
| GSA Auctions | 0% | 0% | per-lot inactivity period (FAQ example: 10 min) | Premium [SE-2nd] BidProwl; inactivity [SE] GSA FAQ; card fee UNVERIFIED |
| GovDeals | 12.5% (reported cap) | 3% (midpoint of 2.5–3.5%) | 3 min | All [SE-2nd] third-party guides. Another guide cited in `05-market-research.md` says "2–5 minutes". The primary rule was not captured. |
| Public Surplus | unknown → 20% PLACEHOLDER | unknown → 3% PLACEHOLDER | 5 min | Window [SE] Public Surplus glossary |
| Municibid | unknown (a tiered 9/6/4% fee is reported) | unknown | unknown (soft close reported) | [SE-2nd]; fee tiers from `05-market-research.md` [3P there] |
| Wisconsin Surplus | tiered by bid size; % not captured ("0–10%, median ~7%" reported) | unknown | 10 min | [SE] terms page; range from `05-market-research.md` [3P there] |
| HiBid (timed) | per auctioneer ("typically 10–18%" reported) | per auctioneer | per auctioneer (2, 3, "3–5" observed) | [SE] HiBid lot pages, W. Nutting PDF; premium range from `05-market-research.md` [3P there] |
| K-BID | unknown | unknown | 3 min (one sale's own FAQ lot) | [SE] |
| Proxibid (timed) | unknown | unknown | seller-set | [SE] Proxibid support |
| MaxSold | **18%** (taxed along with the hammer) | unknown | 2 min | Window [SE] MaxSold help; premium from `05-market-research.md` [1P there] |
| AuctionNinja | **18%** (site average; most 10–20%; seller-set) | unknown | 5 min | Window [SE] AuctionNinja help; premium from `05-market-research.md` [1P there] |
| BidSpotter, Purple Wave, AuctionZip-listed houses | unknown | unknown | unknown | UNVERIFIED |
| EstateSales.net tag sales | 0% | unknown | n/a (fixed price) | UNVERIFIED |

**Constants.**

| Constant | Default | Status |
|---|---|---|
| Sales/use tax `t` | 5.5% | **UNVERIFIED.** It assumes the common Wisconsin combination of 5% state + 0.5% county. Milwaukee County and City rates differ. Resort-area taxes exist in some municipalities. Whether a buyer's premium is taxable in Wisconsin was **not** verified. A reseller buying inventory with a valid exemption certificate sets `t = 0`. GSA charges no sales tax but "your state may charge sales taxes for items that have to be registered, such as vehicles" [SE]. Wisconsin use tax on untaxed purchases is UNVERIFIED. |
| Cost per mile `cpm` | 70¢ | **UNVERIFIED.** The IRS 2025 business standard mileage rate, from memory; update it yearly. |
| Pickup time cost `τ` | $25 | **PLACEHOLDER** (one hour at $25). The user sets it. |
| Unknown premium | 20% | **PLACEHOLDER.** Deliberately conservative. |
| Unknown card fee | 3% | **PLACEHOLDER.** The GovDeals range of 2.5–3.5% [SE-2nd] informed it. |

**Category defaults. EVERY VALUE IN THIS TABLE IS A PLACEHOLDER.** No selling-fee
schedule, margin survey or repair-cost data could be sourced this session. The values
are chosen to be conservative so the calculator runs. Replace them before users see
them as advice, as follows:

- Take `f` from the current eBay or marketplace fee schedule per category.
- Take `m` and `Pmin` from the user's own settings.
- Take `u` and `r` from Skeuos outcomes: realised resale versus `expected_resale_cents`.

| Category | f | s | r | u | m | Pmin | Herd threshold (bids) |
|---|---|---|---|---|---|---|---|
| tools | 14% | $0 | 5% | 10% | 30% | $25 | 15 |
| electronics | 14% | $0 | 10% | 20% | 30% | $25 | 15 |
| vehicles | 0% (private sale) | $0 | 10% | 15% | 20% | $500 | 20 |
| farm_equipment | 10% | $0 | 10% | 15% | 20% | $500 | 20 |
| construction_equipment | 10% | $0 | 10% | 15% | 20% | $500 | 20 |
| furniture | 0% (local sale) | $0 | 10% | 10% | 40% | $50 | 10 |
| coins_bullion | 5% (dealer spread) | $0 | 0% | 5% | 10% | $10 | 20 |
| jewelry | 14% | $0 | 5% | 25% | 30% | $50 | 15 |
| collectibles | 14% | $0 | 0% | 15% | 30% | $20 | 15 |
| household_general | 14% | $0 | 5% | 15% | 40% | $15 | 10 |
| aircraft | 10% | $0 | 20% | 30% | 25% | $5,000 | 10 |
| other | 14% | $0 | 5% | 15% | 30% | $20 | 15 |

`s = $0` assumes the buyer pays shipping on resale. Set it if the user offers free
shipping.

### 4.4 Comps: where `R` comes from

- **Rule:** `R` is the **median of recent completed-and-sold prices for the same item in
  the same condition**. Asking prices and "similar" items don't count. Use at least
  several comps, and exclude parts-only sales unless the lot is parts-only.
- **Why sold, not asking:** Lee & Malmendier's comparison is against the fixed price
  actually available. Using asking prices would inflate `R` and cause exactly the
  overbidding S1 guards against.
- **Tools** (all UNVERIFIED this session):
  - eBay's sold-listings filter.
  - Terapeak (eBay's research tool).
  - 130point, reportedly showing eBay sales including accepted Best Offers.
  - WorthPoint (a paid price archive).
  - For coins and bullion: metal content × spot as a floor.
  - For vehicles and equipment: auction results of comparable units.
- **Product note:** Skeuos's own closed-lot history (`lots.sold_price_cents`) can
  become a comps source for categories eBay covers poorly, such as farm equipment and
  municipal surplus.

### 4.5 When to walk away

| Condition | Code | Why |
|---|---|---|
| The next bid exceeds `H_max` | `WALK_AWAY_OVER_MAX` | S1 |
| The ceiling is $0 at any price | `WALK_AWAY_UNECONOMIC` | S3, S17 |
| Reserve not met and the bid is ≥ 90% of the ceiling | `RESERVE_NOT_MET_STOP` | S13 |
| All-in at the current bid is ≥ value | `ABOVE_VALUE_ALREADY` | S2 |
| Pickup is more than 25% of value | `PICKUP_EATS_MARGIN` | S17 |
| No photos on a high-risk category | `INSPECT_OR_SKIP` | S10 |
| You have already raised your max once, with no new information | (prose rule) | S6 |
| You can't meet the payment or removal deadline | (prose rule) | S18 |

---

## 5. Platform mechanics reference

### 5.1 Closing rules

| Platform | Rule | Quote | Status |
|---|---|---|---|
| **eBay** | Hard close (fixed end time) | Roth & Ockenfels contrast eBay's fixed end with Amazon's rule, where auctions "continue … until ten minutes have passed without a bid" | [SE] |
| **GSA Auctions** | Inactivity close | "An inactivity period is a period of time (in minutes) that must go by without any bidding activity before an auction can close. Most auctions are assigned an inactivity period (located under the "Bidding Details" tab on the item description page)." | [SE] |
| **GSA real estate** | Same idea, can run long | "If the inactivity period is NA, then the auction will close at the specified auction close date and time." "This can go on for hours, even days." "Modifying your Proxy bid during the inactivity period will also reset the time of the auction." | [SE] |
| **GovDeals** | Soft close; 3 minutes per one guide, "2–5 minutes" per another | "If a bid is placed during the final three minutes of a GovDeals auction, the auction's current end time will automatically extend for an additional three minutes" | [SE-2nd]; the conflicting "2–5 minutes" is reported in `05-market-research.md` [3P] |
| **Public Surplus** | 5-minute auto-extend | "If a bid that changes the maximum offer amount, including a proxy bid, is placed during the final five (5) minutes of a Public Surplus auction, its end time will automatically extend for 5 additional minutes. This will continue until no bids are placed within the last five minutes of the auction." | [SE] |
| **Municibid** | Soft close; window not captured | A guide lists "GovDeals, PublicSurplus, and Municibid" among sites that extend 2–5 minutes | [SE-2nd] |
| **Wisconsin Surplus** | 10-minute AutoExtend | "All Wisconsin Surplus auctions use the AutoExtend feature, where there must be a minimum of 10 minutes for a bidder to react to a bid. If there is a bid placed in the final 10 minutes for an item, the ending time for that item is automatically extended" | [SE] |
| **HiBid** | Staggered close + soft close, set per auctioneer | "if an item receives a bid within two minutes of its close, that item will have two additional minutes added to its 'Close Time'" (one house). Another says "(Normally 3-5 minutes)". Another lot page states "3 minutes". | [SE] |
| **K-BID** | 3-minute soft close (seen in one sale) + staggered | "Whenever a bid takes place on an item in the last 3 minutes before that item is set to close, that clock is reset to 3 minutes." The same sale was "closing at a rate of 5 lots per minute". | [SE] |
| **Proxibid (timed)** | Extended bidding, seller-set | "Most Timed auctions will have a period during which bidding is extended." A buyer on a tractor forum: "Some are a one extend all extend … so if it's set to close at 6pm it could be several hours before it actually ends." | [SE] |
| **MaxSold** | 2-minute soft close | "MaxSold has a two-minute soft close feature on each lot". "The lot will not close until bidding is static for two minutes." | [SE] |
| **AuctionNinja** | 5-minute extension | "automatically extend the closing time of a lot whenever a bid is placed within the last five minutes of its scheduled closing" | [SE] |
| **BidSpotter, Purple Wave** | Not captured | — | UNVERIFIED |
| **EstateSales.net** | Tag sale: fixed price, first come | [`01-sources.md` Tier 5](01-sources.md) | INTERNAL |

### 5.2 Bid increments and proxy bidding

- **eBay automatic bidding:** "enter the maximum amount you'd like to pay … eBay will
  bid in increments on your behalf to keep you in the lead but only up to your limit."
  "Occasionally you'll see bids increase by less. This means that someone else placed
  a bid slightly higher than your automatic bid amount." [SE]
- **eBay increments** [SE-2nd]. The table was assembled in a search summary of eBay
  help and community pages and a LiveAbout explainer; check it against eBay's help
  page. The spec uses it as the default ladder for platforms whose increments weren't
  captured.

  | Current price | Increment |
  |---|---|
  | $0.01–$0.99 | $0.05 |
  | $1.00–$4.99 | $0.25 |
  | $5.00–$24.99 | $0.50 |
  | $25.00–$99.99 | $1.00 |
  | $100.00–$249.99 | $2.50 |
  | $250.00–$499.99 | $5.00 |
  | $500.00–$999.99 | $10.00 |
  | $1,000.00–$2,499.99 | $25.00 |
  | $2,500.00–$4,999.99 | $50.00 |
  | $5,000.00 and up | $100.00 |

- **GSA proxy:** "A Proxy bid is an amount higher than the minimum bid … the system will
  incrementally bid on the bidders behalf up (if/when there's competition) to the
  maximum amount entered." You can raise or lower your max while winning, but "You
  cannot decrease your bid below the minimum bid price." Increments shrink after a
  period of inactivity, down to a "reduction limit". [SE]
- **Tie-breaks** (earliest bid wins at equal maxima) are commonly stated for eBay.
  UNVERIFIED this session.

### 5.3 Buyer's premium, card surcharges and tax

- **Premium norms, captured in this pass:**
  - GSA: none [SE-2nd].
  - GovDeals: seller-set, capped at 12.5%, typically 7.5–12.5% [SE-2nd].
  - Wisconsin Surplus: tiered by bid size [SE].
- **Premium norms, from the sibling market-research pass** (`05-market-research.md`,
  under its labels):
  - MaxSold: 18%, and "tax applies to hammer plus premium" [1P].
  - AuctionNinja: "18% is the site average", with most sellers at 10–20% [1P].
  - HiBid houses: "typically … 10–18%", sometimes a few percent more for online bidding
    [3P].
  - Municibid: tiered 9/6/4% [3P].
  - Wisconsin Surplus: "0–10%, set per seller (median ~7%)" [3P].
- **Everything else is UNVERIFIED.** HiBid, K-BID and Proxibid premiums are set by
  each auction house, so Skeuos must read `auctions.buyer_premium_pct` per sale. The
  schema already has the column.
- **Tax on the premium.** The §4 cost multiplier applies tax to hammer + premium. That
  matches MaxSold's stated practice; for other sellers it is conservative.
- **Card surcharges.**
  - GovDeals: 2.5–3.5% [SE-2nd]; invoices of $5,000 or more reportedly must be wired
    [SE-2nd].
  - GSA: cards accepted up to $24,999.99 per card per day; no surcharge found [SE].
  - Wisconsin Surplus accepts cash, bank-guaranteed checks, money orders, wire, ACH,
    Mastercard, Visa, Discover and PayPal [SE]; any surcharge was not captured.
- **Wisconsin sales tax on auction purchases: UNVERIFIED.** Background knowledge, not
  checked:
  - The state rate is 5%, and most counties add 0.5%.
  - Vehicles are taxed when titled.
  - Resellers can buy inventory exempt with a Wisconsin exemption certificate, and
    farm machinery has its own exemption.
  - The Wisconsin DOR's sales-tax publications are the place to confirm all of this,
    and in particular whether a buyer's premium is taxable.
- **Third-party guides contradict the primary source.** BidProwl says "GSA Auctions
  does not accept credit cards" and "15 days means 15 days" [SE-2nd]. GSA's own FAQ
  says cards are accepted up to $24,999.99 per card per day, and its terms say 10
  business days [SE]. Treat third-party fee summaries as leads, not facts.

### 5.4 Reserve and absolute auctions

- **Definitions: UNVERIFIED.** Background knowledge, not checked this session:
  - Under UCC § 2-328, adopted in Wisconsin as Wis. Stat. § 402.328, an auction is
    "with reserve" unless it is expressly announced "without reserve".
  - With reserve, the auctioneer may withdraw a lot until the sale is announced
    complete.
  - Without reserve, a lot cannot be withdrawn once bids are called unless no bid
    arrives within a reasonable time.
  - Seller bidding without notice gives the buyer remedies.

  Confirm against the statute text before showing any of this to users.
- **What the research says:** see S13. Secret reserves deter entry and lower prices
  (Katkar & Reiley) [SE]. Sellers of higher-book-value coins favour secret reserves
  with low openings (Bajari & Hortaçsu) [SE].
- **Absolute (no-reserve) auctions:** the price is set purely by competition, and low
  openings escalate (S9). Purple Wave is recorded in Skeuos's seed as "No-reserve
  absolute auctions, ag and construction equipment" (INTERNAL).

### 5.5 Absentee, max and sealed bids

- **Live webcasts** (Proxibid, HiBid, BidSpotter, AuctionZip-listed houses): leave an
  absentee or max bid rather than bidding live (S20). Whether each platform executes
  absentee bids competitively, that is only as high as needed, was **not verified**.
  Read the house's terms.
- **Sealed bids** (GSA sealed sales, some agency sales): mechanics, deposits and
  tie-breaks were **not researched** (UNVERIFIED). The strategy logic (S20, R15) doesn't
  depend on them: submit at most `H_max`.

### 5.6 Estate sales

- **Day-by-day discounting** (for example 25% off on day 2 and 50% off on day 3) and
  **early sign-in lists**: **UNVERIFIED this session.** Both are widely described
  practices, but schedules vary by company and nothing could be checked.
  - The spec models only a single "final day" discount (a 50% PLACEHOLDER).
  - It always tells the user to confirm the company's schedule.
  - A future version should ingest the schedule from each listing's text.
- **Online estate auctions** (MaxSold, AuctionNinja) are ordinary soft-close auctions
  (2- and 5-minute windows [SE]). Treat them under S5. The MaxSold help centre has a
  page on scheduling a pickup time from the invoice [SE, title only], so pickup is a
  fixed appointment.

### 5.7 Removal deadlines and hidden costs

| Item | Rule | Status |
|---|---|---|
| GSA payment | Within 2 business days of the award email | [SE] |
| GSA removal | Within 10 business days of the award email; "GSA Auctions® does not ship merchandise"; storage fees after the allowance | [SE] |
| GSA default | Liquidated damages reported as the greater of 20% or $200; 20% upheld on appeal | [SE-2nd] / [SE] |
| GSA aircraft | "All aircraft disassembly, scrap, removal planning, and transportation costs/arrangements will be the sole responsibility of the purchaser. The Government (FAA) will not provide any ground support equipment for the removal." Listings state aircraft are "NOT in a FAA flyable condition" and "airworthiness documentation will NOT be provided". An End Use Certificate is required. | [SE] |
| Wisconsin Surplus storage | $10 per day after the posted removal deadline | [SE] |
| GovDeals, Public Surplus, Municibid | Set by the selling agency, per lot | UNVERIFIED specifics |
| **Aircraft removal fee amounts** | The brief mentions removal fees GSA discloses on aircraft. The extracts found state that removal is the buyer's cost but **no dollar figure** was captured | UNVERIFIED |

---

## 6. Per-format playbooks

Each playbook ends with the alert Skeuos should arm (`watchlist.remind_seconds_before`)
and the rule codes that fire.

### 6.1 Hard-close online (eBay)

1. **Value it.** Enter sold comps, and let the calculator produce `H_max` (§4).
2. **Look for a fixed-price alternative.** If a Buy It Now or retail copy costs less
   all-in than your ceiling, buy that instead (S2).
3. **Watch; don't bid.** Early bids help incremental rivals and shills, and inflate
   your own valuation (S6, S7, S14).
4. **Alert at T−120 s** and deep-link to the lot.
5. **Place one bid of `H_max` with about 10 s left** by hand (S4). Don't go later by
   hand: late bids can fail to register [SE].
6. **If you lose, you lost to someone who valued it more.** Don't chase the next
   identical listing above your ceiling.
7. **Expected result:** small average savings and no bidding wars (S4 evidence).

- Alert: `120` s.
- Fires: `R10`, `R36`, and `R30`/`R02` when applicable.

### 6.2 Soft-close online

Covers HiBid timed, K-BID, GovDeals, Public Surplus, Municibid, Wisconsin Surplus,
MaxSold, AuctionNinja and Proxibid timed.

1. **Find the window `W`** in the auction terms (§5.1). If it isn't stated, assume 10
   minutes.
2. **Value it** (§4). The premium varies by house on HiBid, K-BID and Proxibid, so read
   it.
3. **Before `T − W`, enter `H_max` once as your max bid.** Then stop.
4. **Staggered closes:** each lot closes at its own time (HiBid, K-BID [SE]).
   "One extend all extend" group rules can keep a sale running for hours [SE], so plan
   your evening around the lots you care about, not the published end time.
5. **Inside the window:** don't raise because the clock is running (S6). Time pressure
   is one of the documented arousal triggers [SE].
6. **Expect less discount than eBay** (S15).

- Alert: `(W + 5) × 60` s.
- Fires: `R11` or `R12`, `R13` if `W` is unknown, and `R37`.

### 6.3 Live webcast

Covers Proxibid, HiBid webcasts, BidSpotter and houses found via AuctionZip.

1. **Read the terms.** Premium, whether online bidders pay a different premium than
   the floor (UNVERIFIED as a norm), payment and pickup.
2. **Leave an absentee or max bid at `H_max`** before the sale.
3. **If bidding live:** write the ceiling down before the lot opens. Webcast lag and
   the auctioneer's pace are exactly the "time pressure" and "rivalry" conditions (Ku,
   Malhotra & Murnighan 2005) [SE].
4. **Don't bid on "fair warning"** above your number.

- Alert: `3600` s before the sale.
- Fires: `R14`.

### 6.4 Sealed bid

1. **You pay what you bid**, and you get no information from rivals.
2. **Submit at most `H_max`.** Your margin, risk reserve and pickup are already inside
   it (§4).
3. **On uncertain-value lots, stay at or below the haircut ceiling** (S12). Winner's
   curse effects are largest when you can't see anyone else's estimate.
4. **Deposits, bid bonds, tie rules and opening procedure:** read the invitation.
   These were not researched here (UNVERIFIED).

- Alert: `86400` s before the deadline.
- Fires: `R15`.

### 6.5 Estate tag sale (EstateSales.net)

Everything below except the structural fact of fixed prices, first come first served,
is **UNVERIFIED practitioner practice**. Do not present it as fact until it is sourced.

1. **Preview the listing photos** and set a ceiling for each item you want.
2. **Scarce items priced under your ceiling:** go early on day 1. Some companies use
   sign-in lists or numbers before opening.
3. **Bulky or common items over your ceiling:** come back on the last day if the
   company discounts. Many post a schedule such as a percentage off on later days, and
   some take written offers.
4. **Bring transport and helpers.** Pickup is usually expected quickly.

- Fires: `R16`, `R17` or `R18`.

### 6.6 Government surplus

Covers GSA, GovDeals, Public Surplus, Municibid and Wisconsin Surplus.

1. **Identify the mechanism.** GSA uses an inactivity close; GovDeals, Public Surplus
   and Wisconsin Surplus use 3-, 5- and 10-minute soft closes (§5.1). GovDeals' window
   comes only from third parties. Then apply S5.
2. **Plan removal before you bid.** GSA gives 10 business days and does not ship.
   Wisconsin Surplus charges $10 a day after its deadline. The selling agency sets the
   terms elsewhere (§5.7).
3. **Plan payment.** GSA requires payment in 2 business days, with cards up to
   $24,999.99 per card per day, or a wire (§5.3).
4. **Vehicles:** the SF-97 is evidence of title for state registration, and the state
   may tax the vehicle when you register it [SE]. A refundable deposit is reportedly
   required before bidding on most GSA vehicles (`05-market-research.md` [3P]).
5. **Aircraft and heavy items:** price disassembly and transport before bidding [SE].
6. **Stale GSA lots:** increments shrink after inactivity [SE]. On a quiet lot you can
   wait.
7. **Default is expensive:** reported as the greater of 20% or $200 at GSA [SE-2nd].

- Fires: `R38`, `R39`, `R40`, `R41`, `R43` and the S5 rules.

---

## 7. Category heuristics

The **Evidence** lines are sourced. The **Practice** lines are UNVERIFIED rules of
thumb from background knowledge; verify them before shipping.

**Tools**
- Evidence: Skeuos's `compute_sleeper()` treats a thin description ("Box of misc
  tools") as the strongest sleeper signal (INTERNAL). S10 supports thin listings in
  general.
- Practice (UNVERIFIED):
  - Brand-name cordless tools resell on battery platform.
  - Kits beat bare tools.
  - Test at preview.
  - Weight drives resale shipping cost.

**Electronics**
- Evidence: high value uncertainty, so apply the winner's-curse haircut (S12).
- Practice (UNVERIFIED):
  - Price "untested" as broken.
  - Institutional laptops and phones may carry activation or BIOS locks, or have their
    drives removed.
  - Missing chargers cut resale.

**Vehicles**
- Evidence:
  - Disclosure drives price on eBay Motors (Lewis 2011; Nizard) [SE], so a vehicle
    with few photos is either a bargain or a lemon. Inspect.
  - SF-97 for federal vehicles [SE].
  - State tax at registration [SE].
  - GSA's card limit is $24,999.99 per card per day [SE].
- Practice (UNVERIFIED):
  - Ask for maintenance records.
  - Idle hours matter on ex-police units.
  - Title processing can take weeks.

**Farm and construction equipment**
- Evidence:
  - Proxibid group extensions can run a sale for hours [SE].
  - No-reserve equipment sales (INTERNAL seed note on Purple Wave) invite escalation
    (S9).
  - Large pickups make S17 decisive.
- Practice (UNVERIFIED):
  - Verify the hours meter.
  - Check for hydraulic leaks and undercarriage wear.
  - Price trucking by the loaded mile.
  - Off-season buying.

**Furniture**
- Evidence: pickup economics (S17) dominate. The §4.2 example shows how quickly `T`
  erases the value of a small lot.
- Practice (UNVERIFIED):
  - Solid wood and known makers over laminate.
  - Plan the local resale channel before bidding.

**Coins and bullion**
- Evidence:
  - eBay coin auctions show winner's-curse shading (Bajari & Hortaçsu) [SE].
  - Longer auctions fetch more, and negative seller feedback costs more than positive
    feedback earns (Lucking-Reiley et al.) [SE].
  - Skeuos's thesis: the opportunity is in general estate and municipal auctions,
    where "lot of assorted coins" hides varieties (INTERNAL, `01-sources.md` Tier 7).
- Practice (UNVERIFIED):
  - Melt value (metal content × spot) is the floor for bullion and common silver.
  - Raw "key date" coins carry counterfeit risk.
  - Dealers buy below spot.

**Jewelry**
- Evidence: high value uncertainty (S12). The largest placeholder haircut (25%) is
  deliberate.
- Practice (UNVERIFIED):
  - Scrap value from karat and weight is the floor.
  - Costume pieces are common in estate lots.
  - Stones rarely resell at retail value.

**Collectibles**
- Evidence: the secret-reserve experiment used Pokémon cards (Katkar & Reiley) [SE].
  The overbidding study used a board game (Lee & Malmendier) [SE]. Both apply directly.
- Practice (UNVERIFIED):
  - Condition and grading dominate value.
  - Use sold comps only.

**Aircraft**
- Evidence: GSA listings put disassembly, removal and transport on the buyer, with no
  airworthiness documents and an End Use Certificate [SE].
- Practice: none. Treat as specialist-only.

---

## 8. Red flags and psychological traps

### 8.1 Red flags

| Red flag | What it looks like | Why it matters | App behaviour | Evidence | Confidence |
|---|---|---|---|---|---|
| Shill probing | Another bidder raises in minimum steps only while you lead, and stops just below you | "Discover-and-Stop" shilling pushes the price "up to the highest bidder's bid" | Prose warning; needs `bid_events` for automation | Engelberg & Williams [SE] | Medium |
| Secret reserve near your ceiling | "Reserve not met" with the price already at 90%+ of your max | The reserve is probably above your value | `R03` | Katkar & Reiley [SE] | Medium |
| Seller bidding / withdrawal games | Price jumps with no new bidders; lots withdrawn after bidding starts | Legal limits exist (UCC § 2-328) | Prose only | UNVERIFIED | Low |
| No photos on a high-value lot | 0 images; vehicles, electronics, jewelry, coins, equipment | Sellers who can show quality usually do | `R33` | Lewis; Nizard [SE] | Medium |
| Premium not shown | No premium in the captured terms | Changes your ceiling directly | `R35` (assumes 20%) | GovDeals, Wisconsin Surplus terms [SE/SE-2nd] | High |
| Card surcharge / wire requirement | 2.5–3.5% card fee; wire for invoices of $5,000 or more (GovDeals) | Adds to `k`; wires take time | Constants | [SE-2nd] | Medium |
| Removal window you can't meet | 10 business days (GSA); storage after deadline | Storage fees, default penalties | `R38`, `R39`, `R40` | GSA, Wisconsin Surplus [SE] | High |
| Default penalty | Liquidated damages | The greater of 20% or $200 at GSA | `R38` | [SE-2nd]; CBCA [SE] | Medium |
| Vehicle paperwork | SF-97 only (federal); unclear paperwork elsewhere | You need it to register | `R41`, `R42` | GSA SF-97 page [SE] | High / low |
| Aircraft removal costs | Disassembly and transport are the buyer's | Can exceed the hammer | `R43` | GSA listings [SE] | High |
| Extension cascades | "One extend all extend" catalogs | The close can move by hours | Prose (§6.2) | Forum [SE] | Medium |
| Third-party fee summaries | Guides that disagree with platform pages | GSA cards and removal days were wrong in one guide | Always cite the primary source | BidProwl vs GSA FAQ [SE] | High |
| Suspicious "discount" statistics | Precise numbers from unsourced blogs (for example "12–37%" for typo listings) | Unfalsifiable | Never display | [SE-2nd] | — |

### 8.2 Psychological traps

| Trap | Mechanism | Countermeasure in Skeuos | Evidence |
|---|---|---|---|
| Auction fever / competitive arousal | Rivalry, time pressure and an audience raise bids | Pre-computed ceiling; absentee bids; one bid (S1, S6, R14) | Ku, Malhotra & Murnighan 2005 [SE] |
| Quasi-endowment | Leading for longer makes you value it more | Don't bid early (S7) | Heyman, Orhun & Ariely 2004 [SE] |
| Opponent effect | Competing against others raises valuations; "quasi-endowment and opponent effects may result in over-bidding" | Show the ceiling, not the rival's moves, near the close | Heyman, Orhun & Ariely 2004 [SE] |
| Escalation from low openings | Sunk time plus traffic signals value | Anchor on comps (S9) | Ku, Galinsky & Murnighan 2006 [SE] |
| Herding | More bids feel like a better item | `R32` warning (S8) | Simonsohn & Ariely 2008 [SE] |
| Bidder's curse | Paying above the fixed price next to the auction | Fixed-price cap (S2, R30) | Lee & Malmendier 2011 [SE] |
| Winner's curse | Winning means you were the most optimistic | Uncertainty haircut (S12, R44) | Bazerman & Samuelson 1983 [SE-2nd]; Bajari & Hortaçsu 2003 [SE] |
| Regret from being sniped | Sniped incremental bidders quit | Frame "lost at my ceiling" as a success, and log it | Backus et al. 2015 [SE] |

---

## 9. Machine-readable rules spec

### 9.1 How to evaluate it

- **Format.** One JSON object. Expressions are [JSONLogic](https://jsonlogic.com) with
  five custom operations:
  - `floor`
  - `minutes_until`
  - `platform_attr`
  - `category_attr`
  - `increment_ladder`

  Their exact semantics are in `expression_language.custom_ops`. json-logic-js
  supports custom operations via `add_operation`.
- **Inputs.** Only the fields in `inputs`:
  - Lot fields: current bid cents, bid count, closes at, soft-close window minutes,
    platform, buyer premium %, reserve flag, pickup distance miles, image count,
    description word count and category.
  - Optional user fields: expected resale value and max budget.

  The evaluator also supplies `now`; without it `closes_at` can't become time
  remaining.
- **Order of evaluation.**
  1. Compute `derived` top to bottom. Each entry may reference inputs, `constants.*` and
     earlier derived values.
  2. Evaluate every rule's `when`.
  3. Sort the fired rules by `priority`.
  4. `primary` is the first fired rule whose kind is `action`.
  5. Render `text` with the template syntax in `output_contract`, and return
     `numbers` as a name → value object.
- **Null safety.** json-logic-js does not reject `null`. Depending on the operator it
  quietly becomes 0 or NaN, which is our reading of the library, not a documented
  guarantee. Every expression is guarded, and the harness in §9.3 fails on any
  unguarded null.
- **Schema mapping.**

  | Spec field | Skeuos column |
  |---|---|
  | `current_bid_cents` | `lots.current_bid_cents` |
  | `bid_count` | `lots.bid_count` |
  | `closes_at` | `lots.closes_at` |
  | `buyer_premium_pct` | `auctions.buyer_premium_pct` |
  | `image_count` | `lots.image_count` |
  | `description_word_count` | `lots.desc_richness` |
  | `platform` | `sources.platform`, plus `:webcast`, `:sealed` or `:tag` when the format differs from the platform default |
  | `reserve_flag` | from `lots.reserve_met`, plus the auction's reserve / no-reserve terms |
  | `max_hammer_cents` | pre-fills `watchlist.max_bid_cents` |
  | `alert_seconds_before` | pre-fills `watchlist.remind_seconds_before` |

- **Statuses travel with values.** `constants_meta`, `categories_meta` and each
  platform's `_meta` say whether a value is sourced, UNVERIFIED or a PLACEHOLDER.
  Surface that in the UI: a PLACEHOLDER-driven ceiling should say so.

### 9.2 The spec

```json
{
  "spec": "skeuos.bidding-rules",
  "version": "1.0.0",
  "as_of": "2026-09-27",
  "status_legend": {
    "SE": "Stated in a search-engine extract of the cited page; the page itself could not be fetched from the research environment.",
    "SE-2nd": "Stated in a search-engine extract of a secondary or third-party page; confirm against the primary source.",
    "INTERNAL": "Aligned with Skeuos's own compute_sleeper() thresholds (migration 0006); not an external finding.",
    "DESIGN": "A product design choice, not a claim about the world.",
    "PLACEHOLDER": "Not a measured value. Must be replaced by a sourced or calibrated value before it is shown to users as advice.",
    "UNVERIFIED": "Not confirmed by any source in this research pass."
  },
  "expression_language": {
    "name": "JSONLogic subset (https://jsonlogic.com)",
    "standard_ops": ["var", "if", "==", "!=", "<", "<=", ">", ">=", "and", "or", "!", "in", "+", "-", "*", "/", "min", "max"],
    "notes": [
      "'-' is binary, as in json-logic-js. '+' and '*' are variadic.",
      "Never pass null into min/max or arithmetic: every expression below guards with != null first, because json-logic-js coerces null to 0 in comparisons and NaN in arithmetic.",
      "'if' takes [cond1, value1, cond2, value2, ..., else].",
      "Data object seen by 'var': the lot inputs, every derived value computed so far, and 'constants' (so {\"var\": \"constants.sales_tax_rate\"} works)."
    ],
    "custom_ops": {
      "floor": "[x] -> Math.floor(x); null if x is null.",
      "minutes_until": "[iso_timestamp] -> (timestamp - context.now) in minutes, as a float. Negative once closed. null if the timestamp is null.",
      "platform_attr": "[attr] -> platforms[platform][attr]; if the full platform key is absent, platforms[base][attr] where base is the text before ':'; if that is absent too, platforms['other'][attr].",
      "category_attr": "[attr] -> categories[category][attr], falling back to categories['other'][attr].",
      "increment_ladder": "[amount_cents, ladder_name] -> the increment of the highest rung whose from_cents <= amount_cents in increment_ladders[ladder_name]."
    }
  },
  "inputs": {
    "current_bid_cents": {
      "type": "integer",
      "required": true,
      "doc": "Current high bid. For a fixed-price tag sale, the tag price. For a lot with no bids, the opening/minimum bid."
    },
    "bid_count": {"type": "integer", "required": true},
    "closes_at": {"type": "string", "format": "date-time", "required": true, "doc": "Scheduled close (tag sales: the end of the sale)."},
    "soft_close_window_minutes": {
      "type": ["integer", "null"],
      "required": false,
      "doc": "Extension window as published for this auction. 0 = hard close. null = not captured; the platform default applies."
    },
    "platform": {
      "type": "string",
      "required": true,
      "doc": "sources.platform value, optionally suffixed with a format: '<platform>[:timed|webcast|sealed|tag]'. Keys are listed under 'platforms'."
    },
    "buyer_premium_pct": {"type": ["number", "null"], "required": false, "doc": "Percent, e.g. 15 for 15%. null = not captured."},
    "reserve_flag": {"type": "string", "enum": ["absolute", "reserve_met", "reserve_not_met", "unknown"], "required": true},
    "pickup_distance_miles": {"type": ["number", "null"], "required": false, "doc": "One-way road miles from the user to the pickup site. null = ships or unknown."},
    "image_count": {"type": "integer", "required": true},
    "description_word_count": {"type": "integer", "required": true, "doc": "Word count of title + description, the same quantity as lots.desc_richness."},
    "category": {"type": "string", "required": true, "doc": "Keys are listed under 'categories'."},
    "expected_resale_cents": {
      "type": ["integer", "null"],
      "required": false,
      "user_input": true,
      "doc": "Median of recent SOLD comps in the same condition (a personal-use buyer enters the best fixed-price alternative instead)."
    },
    "user_max_budget_cents": {
      "type": ["integer", "null"],
      "required": false,
      "user_input": true,
      "doc": "The most the user will pay the auction for this lot, invoice total (hammer + premium + tax + card fee)."
    }
  },
  "context": {
    "now": "Evaluation timestamp supplied by the evaluator. It is the only value not taken from the lot or the user, and is needed to turn closes_at into time remaining."
  },
  "constants": {
    "sales_tax_rate": 0.055,
    "bp_unknown_assumed_pct": 20,
    "card_fee_unknown_assumed_rate": 0.03,
    "mileage_cost_cents_per_mile": 70,
    "pickup_time_cost_cents": 2500,
    "transport_share_warn": 0.25,
    "reserve_stop_ratio": 0.9,
    "thin_listing_max_words": 12,
    "full_confidence_min_photos": 3,
    "quiet_max_bids": 1,
    "closing_quiet_minutes": 720,
    "hard_close_alert_seconds": 120,
    "manual_snipe_seconds": 10,
    "soft_close_alert_buffer_minutes": 5,
    "unknown_window_assumed_minutes": 10,
    "live_absentee_alert_seconds": 3600,
    "sealed_alert_seconds": 86400,
    "tag_final_day_discount_rate": 0.5,
    "winners_curse_note_min_haircut": 0.15
  },
  "constants_meta": {
    "sales_tax_rate": {
      "status": "UNVERIFIED",
      "note": "Wisconsin 5% state + 0.5% county, the common combination. Milwaukee County and City rates differ; premier-resort-area taxes exist; whether the buyer's premium is taxable was not verified. A reseller with a valid exemption certificate sets this to 0 for resale inventory."
    },
    "bp_unknown_assumed_pct": {
      "status": "PLACEHOLDER",
      "note": "Deliberately conservative assumption used only when the premium was not captured. The lot's own terms always win."
    },
    "card_fee_unknown_assumed_rate": {"status": "PLACEHOLDER", "note": "Assumes card payment. A third-party guide reports GovDeals card surcharges of 2.5-3.5% (SE-2nd)."},
    "mileage_cost_cents_per_mile": {
      "status": "UNVERIFIED",
      "note": "IRS 2025 business standard mileage rate (70 cents/mile), from memory; replace with the current year's rate or the user's own cost."
    },
    "pickup_time_cost_cents": {"status": "PLACEHOLDER", "note": "One hour at $25/hour for the pickup trip. User-editable."},
    "transport_share_warn": {"status": "PLACEHOLDER"},
    "reserve_stop_ratio": {"status": "PLACEHOLDER"},
    "thin_listing_max_words": {"status": "INTERNAL", "note": "compute_sleeper(): fewer than 12 words = thin_description."},
    "full_confidence_min_photos": {"status": "INTERNAL", "note": "compute_sleeper(): 3+ photos = full confidence."},
    "quiet_max_bids": {"status": "INTERNAL", "note": "compute_sleeper(): 0-1 bids = low_competition."},
    "closing_quiet_minutes": {"status": "INTERNAL", "note": "compute_sleeper(): closes within 12 hours and still quiet."},
    "hard_close_alert_seconds": {"status": "DESIGN", "note": "Maps to watchlist.remind_seconds_before."},
    "manual_snipe_seconds": {
      "status": "DESIGN",
      "note": "Ely & Hossain placed snipes in the last 5 seconds with a sniping service (SE-2nd); Roth & Ockenfels note very late bids may fail to go through, so a human doing it by hand needs margin."
    },
    "soft_close_alert_buffer_minutes": {"status": "DESIGN"},
    "unknown_window_assumed_minutes": {
      "status": "DESIGN",
      "note": "The longest window observed in this research (Wisconsin Surplus, 10 minutes), so 'bid before the window' is safe for any shorter one."
    },
    "live_absentee_alert_seconds": {"status": "DESIGN"},
    "sealed_alert_seconds": {"status": "DESIGN"},
    "tag_final_day_discount_rate": {
      "status": "PLACEHOLDER",
      "note": "Estate-sale discount schedules vary by company; 50% off on the last day is the example in the product brief and is NOT verified."
    },
    "winners_curse_note_min_haircut": {"status": "DESIGN"}
  },
  "increment_ladders": {
    "ebay_us": {
      "status": "SE-2nd",
      "source": "ebay_automatic_bidding (table assembled in a search summary of eBay help/community pages and a LiveAbout explainer; verify against eBay help)",
      "note": "Used as a proxy ladder for platforms whose increments were not verified. Auctioneers and GSA set their own increments; the lot page wins.",
      "rungs": [
        {"from_cents": 0, "increment_cents": 5},
        {"from_cents": 100, "increment_cents": 25},
        {"from_cents": 500, "increment_cents": 50},
        {"from_cents": 2500, "increment_cents": 100},
        {"from_cents": 10000, "increment_cents": 250},
        {"from_cents": 25000, "increment_cents": 500},
        {"from_cents": 50000, "increment_cents": 1000},
        {"from_cents": 100000, "increment_cents": 2500},
        {"from_cents": 250000, "increment_cents": 5000},
        {"from_cents": 500000, "increment_cents": 10000}
      ]
    }
  },
  "platforms": {
    "ebay": {
      "base": "ebay",
      "close_type": "hard",
      "soft_close_default_minutes": 0,
      "bp_default_pct": 0,
      "card_fee_default_rate": 0,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE roth_ockenfels_2002 (fixed end time)", "bp_default_pct": "UNVERIFIED (no buyer's premium on eBay auctions; not re-checked)", "card_fee_default_rate": "UNVERIFIED"}
    },
    "gsa": {
      "base": "gsa",
      "close_type": "inactivity",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": 0,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE gsa_faq: closes after a per-lot inactivity period (FAQ example uses 10 minutes); the period is on the 'Bidding Details' tab", "bp_default_pct": "SE-2nd gsa_thirdparty (BidProwl: no buyer's premium)", "card_fee_default_rate": "UNVERIFIED (cards accepted up to $24,999.99 per card per day, SE gsa_faq; no surcharge found)", "deposit": "05-market-research.md reports a refundable deposit before bidding on most vehicles [3P there]"}
    },
    "gsa:sealed": {
      "base": "gsa",
      "close_type": "sealed",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": 0,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED (sealed-bid mechanics not researched in this pass)", "bp_default_pct": "SE-2nd gsa_thirdparty"}
    },
    "govdeals": {
      "base": "govdeals",
      "close_type": "soft",
      "soft_close_default_minutes": 3,
      "bp_default_pct": 12.5,
      "card_fee_default_rate": 0.03,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE-2nd govdeals_thirdparty says 3 minutes; another guide cited in 05-market-research.md says '2-5 minutes' [3P]. Primary rule not captured", "bp_default_pct": "SE-2nd govdeals_thirdparty (reported cap 12.5%, typical 7.5-12.5%, set by seller)", "card_fee_default_rate": "SE-2nd govdeals_thirdparty (2.5-3.5% card surcharge; midpoint used)"}
    },
    "public-surplus": {
      "base": "public-surplus",
      "close_type": "soft",
      "soft_close_default_minutes": 5,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE public_surplus_extensions", "bp_default_pct": "UNVERIFIED (set per selling agency)"}
    },
    "public-surplus:sealed": {
      "base": "public-surplus",
      "close_type": "sealed",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED"}
    },
    "municibid": {
      "base": "municibid",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE-2nd (third-party guide lists Municibid among soft-close sites; window UNVERIFIED)", "bp_default_pct": "05-market-research.md reports a tiered 9/6/4% fee [3P there]; tiers depend on amount, so left null"}
    },
    "wisconsin-surplus": {
      "base": "wisconsin-surplus",
      "close_type": "soft",
      "soft_close_default_minutes": 10,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE wisconsin_surplus_terms (AutoExtend, 10 minutes)", "bp_default_pct": "SE wisconsin_surplus_terms: tiered buyer's fee by bid size; 05-market-research.md reports '0-10%, set per seller (median ~7%)' [3P there]; left null until the tiers are captured"}
    },
    "hibid": {
      "base": "hibid",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE hibid_softclose_examples: set per auctioneer; 2, 3 and 'normally 3-5' minutes observed", "bp_default_pct": "Per auctioneer. 05-market-research.md reports 'typically 10-18%', sometimes a few percent more for online bidding [3P there]; left null so the conservative assumption applies until captured"}
    },
    "hibid:webcast": {
      "base": "hibid",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "k-bid": {
      "base": "k-bid",
      "close_type": "soft",
      "soft_close_default_minutes": 3,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE kbid_softclose (one K-BID auction's own FAQ lot; may vary by seller)"}
    },
    "proxibid": {
      "base": "proxibid",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE proxibid_timed ('Most Timed auctions will have a period during which bidding is extended'); window set per seller; group ('one extend all extend') extensions reported by buyers (SE yesterdays_tractors_forum)"}
    },
    "proxibid:webcast": {
      "base": "proxibid",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "bidspotter": {
      "base": "bidspotter",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED"}
    },
    "bidspotter:webcast": {
      "base": "bidspotter",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "purple-wave": {
      "base": "purple-wave",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED (extension rule and buyer's premium not captured in this pass)"}
    },
    "auctionzip": {
      "base": "auctionzip",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "AuctionZip is a directory; the listed house's own software decides the format"}
    },
    "auctionzip:webcast": {
      "base": "auctionzip",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "maxsold": {
      "base": "maxsold",
      "close_type": "soft",
      "soft_close_default_minutes": 2,
      "bp_default_pct": 18,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE maxsold_softclose", "bp_default_pct": "INTERNAL cross-reference: 05-market-research.md reports an 18% premium that is itself taxed [1P there]"}
    },
    "auctionninja": {
      "base": "auctionninja",
      "close_type": "soft",
      "soft_close_default_minutes": 5,
      "bp_default_pct": 18,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE auctionninja_extended", "bp_default_pct": "INTERNAL cross-reference: 05-market-research.md reports '18% is the site average', most sellers 10-20%, seller-set [1P there]"}
    },
    "estatesales-net": {
      "base": "estatesales-net",
      "close_type": "fixed",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "Tag sale: fixed prices, first come first served (01-sources.md, Tier 5)", "bp_default_pct": "UNVERIFIED (tag sales normally carry no premium; card fees vary by company)"}
    },
    "other": {
      "base": "other",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:hard": {
      "base": "other",
      "close_type": "hard",
      "soft_close_default_minutes": 0,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:timed": {
      "base": "other",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:webcast": {
      "base": "other",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:sealed": {
      "base": "other",
      "close_type": "sealed",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:tag": {
      "base": "other",
      "close_type": "fixed",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    }
  },
  "categories": {
    "tools": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.1, "target_margin_rate": 0.3, "min_profit_cents": 2500, "herd_bid_count": 15, "high_value_risk": false},
    "electronics": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.2, "target_margin_rate": 0.3, "min_profit_cents": 2500, "herd_bid_count": 15, "high_value_risk": true},
    "vehicles": {"sell_fee_rate": 0.0, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.2, "min_profit_cents": 50000, "herd_bid_count": 20, "high_value_risk": true},
    "farm_equipment": {"sell_fee_rate": 0.1, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.2, "min_profit_cents": 50000, "herd_bid_count": 20, "high_value_risk": true},
    "construction_equipment": {"sell_fee_rate": 0.1, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.2, "min_profit_cents": 50000, "herd_bid_count": 20, "high_value_risk": true},
    "furniture": {"sell_fee_rate": 0.0, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.1, "target_margin_rate": 0.4, "min_profit_cents": 5000, "herd_bid_count": 10, "high_value_risk": false},
    "coins_bullion": {"sell_fee_rate": 0.05, "outbound_ship_cents": 0, "repair_reserve_rate": 0.0, "uncertainty_haircut_rate": 0.05, "target_margin_rate": 0.1, "min_profit_cents": 1000, "herd_bid_count": 20, "high_value_risk": true},
    "jewelry": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.25, "target_margin_rate": 0.3, "min_profit_cents": 5000, "herd_bid_count": 15, "high_value_risk": true},
    "collectibles": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.0, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.3, "min_profit_cents": 2000, "herd_bid_count": 15, "high_value_risk": false},
    "household_general": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.4, "min_profit_cents": 1500, "herd_bid_count": 10, "high_value_risk": false},
    "aircraft": {"sell_fee_rate": 0.1, "outbound_ship_cents": 0, "repair_reserve_rate": 0.2, "uncertainty_haircut_rate": 0.3, "target_margin_rate": 0.25, "min_profit_cents": 500000, "herd_bid_count": 10, "high_value_risk": true},
    "other": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.3, "min_profit_cents": 2000, "herd_bid_count": 15, "high_value_risk": false}
  },
  "categories_meta": {
    "status": "PLACEHOLDER",
    "note": "EVERY VALUE IN THIS TABLE IS A PLACEHOLDER. None was measured or sourced in this research pass. Replace with values calibrated from Skeuos's own outcomes (watchlist.outcome, lots.sold_price_cents) and a sourced selling-fee schedule before showing them as advice."
  },
  "derived": [
    {"name": "close_type", "expr": {"platform_attr": ["close_type"]}},
    {"name": "platform_base", "expr": {"platform_attr": ["base"]}},
    {
      "name": "window_min",
      "expr": {"if": [{"!=": [{"var": "soft_close_window_minutes"}, null]}, {"var": "soft_close_window_minutes"}, {"platform_attr": ["soft_close_default_minutes"]}]},
      "doc": "The lot's own extension window, else the platform default, else null."
    },
    {
      "name": "is_hard_close",
      "expr": {"or": [{"==": [{"var": "close_type"}, "hard"]}, {"and": [{"in": [{"var": "close_type"}, ["soft", "inactivity", "unknown"]]}, {"!=": [{"var": "window_min"}, null]}, {"==": [{"var": "window_min"}, 0]}]}]}
    },
    {
      "name": "effective_close_type",
      "expr": {"if": [{"in": [{"var": "close_type"}, ["live", "sealed", "fixed"]]}, {"var": "close_type"}, {"var": "is_hard_close"}, "hard", {"in": [{"var": "close_type"}, ["soft", "inactivity"]]}, {"var": "close_type"}, {"and": [{"!=": [{"var": "window_min"}, null]}, {">": [{"var": "window_min"}, 0]}]}, "soft", "unknown"]},
      "doc": "hard | soft | inactivity | live | sealed | fixed | unknown. A lot that publishes a window > 0 is treated as extending even if the platform default is unknown."
    },
    {"name": "is_extending_close", "expr": {"in": [{"var": "effective_close_type"}, ["soft", "inactivity"]]}},
    {"name": "bp_assumed", "expr": {"==": [{"var": "buyer_premium_pct"}, null]}},
    {
      "name": "bp_pct",
      "expr": {"if": [{"!=": [{"var": "buyer_premium_pct"}, null]}, {"var": "buyer_premium_pct"}, {"!=": [{"platform_attr": ["bp_default_pct"]}, null]}, {"platform_attr": ["bp_default_pct"]}, {"var": "constants.bp_unknown_assumed_pct"}]}
    },
    {
      "name": "bp_source",
      "expr": {"if": [{"!=": [{"var": "buyer_premium_pct"}, null]}, "the lot's terms", {"!=": [{"platform_attr": ["bp_default_pct"]}, null]}, "platform default", "conservative assumption"]}
    },
    {
      "name": "card_fee_rate",
      "expr": {"if": [{"!=": [{"platform_attr": ["card_fee_default_rate"]}, null]}, {"platform_attr": ["card_fee_default_rate"]}, {"var": "constants.card_fee_unknown_assumed_rate"}]}
    },
    {"name": "tax_rate", "expr": {"var": "constants.sales_tax_rate"}},
    {
      "name": "cost_multiplier",
      "expr": {"*": [{"+": [1, {"/": [{"var": "bp_pct"}, 100]}]}, {"+": [1, {"var": "tax_rate"}]}, {"+": [1, {"var": "card_fee_rate"}]}]},
      "doc": "k: what one dollar of hammer price costs on the invoice."
    },
    {"name": "transport_known", "expr": {"!=": [{"var": "pickup_distance_miles"}, null]}},
    {
      "name": "transport_cents",
      "expr": {"if": [{"var": "transport_known"}, {"+": [{"*": [{"var": "pickup_distance_miles"}, 2, {"var": "constants.mileage_cost_cents_per_mile"}]}, {"var": "constants.pickup_time_cost_cents"}]}, 0]},
      "doc": "Round trip at the mileage rate plus the time cost. 0 when the lot ships or distance is unknown (inbound shipping is then NOT modelled)."
    },
    {"name": "has_value", "expr": {"and": [{"!=": [{"var": "expected_resale_cents"}, null]}, {">": [{"var": "expected_resale_cents"}, 0]}]}},
    {"name": "has_budget", "expr": {"and": [{"!=": [{"var": "user_max_budget_cents"}, null]}, {">": [{"var": "user_max_budget_cents"}, 0]}]}},
    {"name": "sell_fee_rate", "expr": {"category_attr": ["sell_fee_rate"]}},
    {"name": "outbound_ship_cents", "expr": {"category_attr": ["outbound_ship_cents"]}},
    {"name": "uncertainty_haircut_rate", "expr": {"category_attr": ["uncertainty_haircut_rate"]}},
    {"name": "repair_reserve_rate", "expr": {"category_attr": ["repair_reserve_rate"]}},
    {"name": "target_margin_rate", "expr": {"category_attr": ["target_margin_rate"]}},
    {"name": "min_profit_cents", "expr": {"category_attr": ["min_profit_cents"]}},
    {
      "name": "net_proceeds_cents",
      "expr": {"if": [{"var": "has_value"}, {"-": [{"*": [{"var": "expected_resale_cents"}, {"-": [1, {"var": "sell_fee_rate"}]}]}, {"var": "outbound_ship_cents"}]}, null]}
    },
    {
      "name": "profit_target_cents",
      "expr": {"if": [{"var": "has_value"}, {"max": [{"*": [{"var": "expected_resale_cents"}, {"var": "target_margin_rate"}]}, {"var": "min_profit_cents"}]}, null]}
    },
    {
      "name": "risk_reserve_cents",
      "expr": {"if": [{"var": "has_value"}, {"*": [{"var": "expected_resale_cents"}, {"+": [{"var": "uncertainty_haircut_rate"}, {"var": "repair_reserve_rate"}]}]}, null]}
    },
    {
      "name": "max_hammer_resale_cents",
      "expr": {"if": [{"var": "has_value"}, {"max": [0, {"*": [100, {"floor": [{"/": [{"/": [{"-": [{"var": "net_proceeds_cents"}, {"+": [{"var": "profit_target_cents"}, {"var": "transport_cents"}, {"var": "risk_reserve_cents"}]}]}, {"var": "cost_multiplier"}]}, 100]}]}]}]}, null]},
      "doc": "H_resale = floor_to_dollar( (N - P - T - risk) / k ), never below 0."
    },
    {
      "name": "max_hammer_budget_cents",
      "expr": {"if": [{"var": "has_budget"}, {"*": [100, {"floor": [{"/": [{"/": [{"var": "user_max_budget_cents"}, {"var": "cost_multiplier"}]}, 100]}]}]}, null]}
    },
    {
      "name": "max_hammer_cents",
      "expr": {"if": [{"and": [{"var": "has_value"}, {"var": "has_budget"}]}, {"min": [{"var": "max_hammer_resale_cents"}, {"var": "max_hammer_budget_cents"}]}, {"var": "has_value"}, {"var": "max_hammer_resale_cents"}, {"var": "has_budget"}, {"var": "max_hammer_budget_cents"}, null]}
    },
    {
      "name": "binding_cap",
      "expr": {"if": [{"and": [{"var": "has_value"}, {"var": "has_budget"}]}, {"if": [{"<=": [{"var": "max_hammer_budget_cents"}, {"var": "max_hammer_resale_cents"}]}, "budget", "resale value"]}, {"var": "has_value"}, "resale value", {"var": "has_budget"}, "budget", "none"]}
    },
    {"name": "increment_cents", "expr": {"increment_ladder": [{"var": "current_bid_cents"}, {"platform_attr": ["increment_ladder"]}]}},
    {
      "name": "next_min_bid_cents",
      "expr": {"if": [{"or": [{"==": [{"var": "bid_count"}, 0]}, {"==": [{"var": "effective_close_type"}, "fixed"]}]}, {"var": "current_bid_cents"}, {"+": [{"var": "current_bid_cents"}, {"var": "increment_cents"}]}]},
      "doc": "With no bids the opening bid is the minimum; otherwise current + one increment (proxy ladder)."
    },
    {"name": "minutes_to_close", "expr": {"minutes_until": [{"var": "closes_at"}]}},
    {"name": "is_open", "expr": {">": [{"var": "minutes_to_close"}, 0]}},
    {
      "name": "all_in_at_current_cents",
      "expr": {"+": [{"*": [{"var": "current_bid_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}]}
    },
    {"name": "all_in_at_next_cents", "expr": {"+": [{"*": [{"var": "next_min_bid_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}]}},
    {
      "name": "all_in_at_max_cents",
      "expr": {"if": [{"!=": [{"var": "max_hammer_cents"}, null]}, {"+": [{"*": [{"var": "max_hammer_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}]}, null]}
    },
    {
      "name": "headroom_cents",
      "expr": {"if": [{"!=": [{"var": "max_hammer_cents"}, null]}, {"-": [{"var": "max_hammer_cents"}, {"var": "next_min_bid_cents"}]}, null]}
    },
    {
      "name": "current_to_max_ratio",
      "expr": {"if": [{"and": [{"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}]}, {"/": [{"var": "current_bid_cents"}, {"var": "max_hammer_cents"}]}, null]}
    },
    {
      "name": "profit_at_next_cents",
      "expr": {"if": [{"var": "has_value"}, {"-": [{"var": "net_proceeds_cents"}, {"+": [{"*": [{"var": "next_min_bid_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}, {"var": "risk_reserve_cents"}]}]}, null]}
    },
    {
      "name": "thirds_rule_cents",
      "expr": {"if": [{"var": "has_value"}, {"floor": [{"/": [{"var": "expected_resale_cents"}, 3]}]}, null]},
      "doc": "Practitioner 'rule of thirds' cross-check (UNVERIFIED heuristic). Display only; never used as the ceiling."
    },
    {"name": "transport_share", "expr": {"if": [{"var": "has_value"}, {"/": [{"var": "transport_cents"}, {"var": "expected_resale_cents"}]}, null]}},
    {"name": "cost_per_100_cents", "expr": {"floor": [{"*": [10000, {"var": "cost_multiplier"}]}]}},
    {"name": "is_thin_listing", "expr": {"<": [{"var": "description_word_count"}, {"var": "constants.thin_listing_max_words"}]}},
    {"name": "is_few_photos", "expr": {"<": [{"var": "image_count"}, {"var": "constants.full_confidence_min_photos"}]}},
    {"name": "is_quiet", "expr": {"<=": [{"var": "bid_count"}, {"var": "constants.quiet_max_bids"}]}},
    {"name": "herd_bid_count", "expr": {"category_attr": ["herd_bid_count"]}},
    {"name": "is_crowded", "expr": {">=": [{"var": "bid_count"}, {"var": "herd_bid_count"}]}},
    {"name": "high_value_risk", "expr": {"category_attr": ["high_value_risk"]}},
    {
      "name": "effective_window_min",
      "expr": {"if": [{"!=": [{"var": "window_min"}, null]}, {"var": "window_min"}, {"var": "constants.unknown_window_assumed_minutes"}]}
    },
    {"name": "proxy_deadline_minutes_before_close", "expr": {"+": [{"var": "effective_window_min"}, 1]}},
    {
      "name": "alert_seconds_before",
      "expr": {"if": [{"var": "is_hard_close"}, {"var": "constants.hard_close_alert_seconds"}, {"var": "is_extending_close"}, {"*": [{"+": [{"var": "effective_window_min"}, {"var": "constants.soft_close_alert_buffer_minutes"}]}, 60]}, {"==": [{"var": "effective_close_type"}, "live"]}, {"var": "constants.live_absentee_alert_seconds"}, {"==": [{"var": "effective_close_type"}, "sealed"]}, {"var": "constants.sealed_alert_seconds"}, null]},
      "doc": "Suggested value for watchlist.remind_seconds_before."
    },
    {
      "name": "tag_price_final_day_cents",
      "expr": {"floor": [{"*": [{"var": "current_bid_cents"}, {"-": [1, {"var": "constants.tag_final_day_discount_rate"}]}]}]}
    }
  ],
  "rules": [
    {
      "id": "R00",
      "code": "LOT_CLOSED",
      "kind": "action",
      "priority": 1,
      "confidence": "high",
      "evidence": [],
      "when": {"!": [{"var": "is_open"}]},
      "text": "This lot has closed. Record the result (won, lost, price) so Skeuos can calibrate your ceilings.",
      "numbers": ["current_bid_cents", "bid_count", "max_hammer_cents"]
    },
    {
      "id": "R01",
      "code": "WALK_AWAY_UNECONOMIC",
      "kind": "action",
      "priority": 5,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "bazerman_samuelson_1983"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"var": "has_value"}, {"==": [{"var": "max_hammer_resale_cents"}, 0]}]}]},
      "text": "Skip this lot. Even at a $0 hammer it does not clear your margin: expected resale {expected_resale_cents|usd}, net after selling costs {net_proceeds_cents|usd}, minus required profit {profit_target_cents|usd}, pickup {transport_cents|usd} and risk reserve {risk_reserve_cents|usd}.",
      "numbers": ["expected_resale_cents", "net_proceeds_cents", "profit_target_cents", "transport_cents", "risk_reserve_cents"]
    },
    {
      "id": "R02",
      "code": "WALK_AWAY_OVER_MAX",
      "kind": "action",
      "priority": 10,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "bazerman_samuelson_1983", "ku_malhotra_murnighan_2005"],
      "when": {"and": [{"var": "is_open"}, {"!=": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {">": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Walk away. The next bid would be {next_min_bid_cents|usd}; your ceiling is {max_hammer_cents|usd} (set by your {binding_cap}). At the next bid you would pay about {all_in_at_next_cents|usd} all-in. Do not raise a ceiling because other people are bidding; raise it only for new information about the item.",
      "numbers": ["next_min_bid_cents", "max_hammer_cents", "binding_cap", "all_in_at_next_cents", "cost_multiplier"]
    },
    {
      "id": "R03",
      "code": "RESERVE_NOT_MET_STOP",
      "kind": "action",
      "priority": 15,
      "confidence": "medium",
      "evidence": ["katkar_reiley_2006", "bajari_hortacsu_2003"],
      "when": {"and": [{"var": "is_open"}, {"!=": [{"var": "effective_close_type"}, "fixed"]}, {"==": [{"var": "reserve_flag"}, "reserve_not_met"]}, {"!=": [{"var": "current_to_max_ratio"}, null]}, {">=": [{"var": "current_to_max_ratio"}, {"var": "constants.reserve_stop_ratio"}]}]},
      "text": "Reserve not met, and bidding is already at {current_to_max_ratio|pct} of your ceiling ({max_hammer_cents|usd}). The hidden reserve is probably above what this lot is worth to you. Do not chase it; watch for a relist.",
      "numbers": ["current_bid_cents", "max_hammer_cents", "current_to_max_ratio"]
    },
    {
      "id": "R10",
      "code": "HARD_CLOSE_SINGLE_LATE_BID",
      "kind": "action",
      "priority": 30,
      "confidence": "medium",
      "evidence": ["roth_ockenfels_2002", "ockenfels_roth_2006", "ely_hossain_2009", "gray_reiley_2013", "engelberg_williams_2009", "heyman_orhun_ariely_2004"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_hard_close"}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Hard close: the clock will not extend. Don't bid yet. Skeuos will alert you {alert_seconds_before} seconds before the end; then place ONE bid of {max_hammer_cents|usd} with about {constants.manual_snipe_seconds} seconds left. Bidding early mainly helps incremental bidders and shill bidders find your number.",
      "numbers": ["max_hammer_cents", "minutes_to_close", "alert_seconds_before", "headroom_cents", "all_in_at_max_cents"]
    },
    {
      "id": "R11",
      "code": "PROXY_BEFORE_WINDOW",
      "kind": "action",
      "priority": 31,
      "confidence": "high",
      "evidence": ["ockenfels_roth_2006", "ariely_ockenfels_roth_2005", "overstock_softclose_2019", "public_surplus_extensions", "wisconsin_surplus_terms", "gsa_faq"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}, {">": [{"var": "minutes_to_close"}, {"var": "effective_window_min"}]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Extending close: a bid in the last {effective_window_min} minutes pushes the close back, so a last-second bid gains nothing. Enter your full ceiling of {max_hammer_cents|usd} as a max (proxy) bid once, at least {proxy_deadline_minutes_before_close} minutes before the scheduled close, then leave it alone.",
      "numbers": ["max_hammer_cents", "window_min", "effective_window_min", "minutes_to_close", "proxy_deadline_minutes_before_close", "alert_seconds_before"]
    },
    {
      "id": "R12",
      "code": "IN_EXTENSION_WINDOW",
      "kind": "action",
      "priority": 32,
      "confidence": "high",
      "evidence": ["ockenfels_roth_2006", "ku_malhotra_murnighan_2005", "heyman_orhun_ariely_2004"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}, {"<=": [{"var": "minutes_to_close"}, {"var": "effective_window_min"}]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "You are inside the {effective_window_min}-minute extension window, so any bid restarts the clock. If your ceiling is not already in, enter {max_hammer_cents|usd} once. Do not raise it just because the clock is running; time pressure and rivalry are the conditions under which bidders overpay.",
      "numbers": ["max_hammer_cents", "window_min", "effective_window_min", "minutes_to_close", "headroom_cents"]
    },
    {
      "id": "R13",
      "code": "EXTENSION_RULE_UNKNOWN",
      "kind": "warning",
      "priority": 33,
      "confidence": "medium",
      "evidence": ["hibid_softclose_examples", "proxibid_timed"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}, {"==": [{"var": "window_min"}, null]}]},
      "text": "This lot extends on late bids, but its extension window was not captured. Read the auction terms. Until then Skeuos assumes up to {constants.unknown_window_assumed_minutes} minutes.",
      "numbers": ["effective_window_min", "minutes_to_close"]
    },
    {
      "id": "R14",
      "code": "WEBCAST_ABSENTEE_BID",
      "kind": "action",
      "priority": 34,
      "confidence": "medium",
      "evidence": ["ku_malhotra_murnighan_2005", "heyman_orhun_ariely_2004"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "live"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Live webcast: leave an absentee (max) bid of {max_hammer_cents|usd} before the sale instead of bidding live. If you do bid live, write the ceiling down before the lot opens; rivalry, an audience and a fast clock are the conditions under which bidders overbid.",
      "numbers": ["max_hammer_cents", "minutes_to_close", "alert_seconds_before"]
    },
    {
      "id": "R15",
      "code": "SEALED_BID_AT_CEILING",
      "kind": "action",
      "priority": 35,
      "confidence": "medium",
      "evidence": ["bazerman_samuelson_1983", "bajari_hortacsu_2003"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "sealed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}]},
      "text": "Sealed bid: you pay what you bid. Submit {max_hammer_cents|usd} or less; your margin and risk reserve are already inside that number, and anything above it hands them to the seller.",
      "numbers": ["max_hammer_cents", "all_in_at_max_cents", "risk_reserve_cents"]
    },
    {
      "id": "R16",
      "code": "TAG_BUY_EARLY",
      "kind": "action",
      "priority": 36,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {"<=": [{"var": "current_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "The tag price {current_bid_cents|usd} is already under your ceiling {max_hammer_cents|usd}. Go on the first day, early; waiting for a discount risks losing it to another buyer.",
      "numbers": ["current_bid_cents", "max_hammer_cents", "all_in_at_current_cents"]
    },
    {
      "id": "R17",
      "code": "TAG_WAIT_FOR_DISCOUNT",
      "kind": "action",
      "priority": 37,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "current_bid_cents"}, {"var": "max_hammer_cents"}]}, {"<=": [{"var": "tag_price_final_day_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Over your ceiling at full tag ({current_bid_cents|usd}). If this company discounts on its last day (check its schedule; the discount assumed here is not verified), the price would be about {tag_price_final_day_cents|usd}, under your ceiling of {max_hammer_cents|usd}. Go on the last day, or leave an offer if the company takes them.",
      "numbers": ["current_bid_cents", "tag_price_final_day_cents", "max_hammer_cents"]
    },
    {
      "id": "R18",
      "code": "TAG_PASS",
      "kind": "action",
      "priority": 38,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "tag_price_final_day_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Pass. Even at a last-day discount (about {tag_price_final_day_cents|usd}) this is above your ceiling of {max_hammer_cents|usd}.",
      "numbers": ["current_bid_cents", "tag_price_final_day_cents", "max_hammer_cents"]
    },
    {
      "id": "R19",
      "code": "BID_UP_TO_MAX",
      "kind": "action",
      "priority": 39,
      "confidence": "medium",
      "evidence": ["lee_malmendier_2011", "ockenfels_roth_2006"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "unknown"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Closing rule not captured for this platform. Enter one max bid of {max_hammer_cents|usd} about {proxy_deadline_minutes_before_close} minutes before the close; that works whether or not the lot extends.",
      "numbers": ["max_hammer_cents", "headroom_cents", "minutes_to_close"]
    },
    {
      "id": "R20",
      "code": "NEED_VALUE",
      "kind": "action",
      "priority": 80,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"!": [{"var": "has_value"}]}, {"!": [{"var": "has_budget"}]}]}]},
      "text": "No ceiling yet. Add the median of recent SOLD prices (not asking prices) for this item in this condition, or the most you will pay, and Skeuos will compute a walk-away number. Every $100 bid here costs about {cost_per_100_cents|usd} before pickup.",
      "numbers": ["cost_per_100_cents", "bp_pct", "tax_rate", "card_fee_rate"]
    },
    {
      "id": "R21",
      "code": "BUDGET_ONLY_CEILING",
      "kind": "warning",
      "priority": 81,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "bazerman_samuelson_1983"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"!": [{"var": "has_value"}]}, {"var": "has_budget"}]}]},
      "text": "Your ceiling ({max_hammer_cents|usd} hammer, {user_max_budget_cents|usd} invoice) comes only from your budget. It does not check whether the lot is worth that. Add a sold-comps value.",
      "numbers": ["max_hammer_cents", "user_max_budget_cents"]
    },
    {
      "id": "R30",
      "code": "ABOVE_VALUE_ALREADY",
      "kind": "warning",
      "priority": 50,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "schneider_2016"],
      "when": {"and": [{"var": "is_open"}, {"var": "has_value"}, {">=": [{"var": "all_in_at_current_cents"}, {"var": "expected_resale_cents"}]}]},
      "text": "At the current bid you would already pay {all_in_at_current_cents|usd} all-in, at or above the {expected_resale_cents|usd} value you entered. In eBay field data a large share of auctions finish above the same item's fixed price on the same page. Check Buy It Now or retail before going further.",
      "numbers": ["all_in_at_current_cents", "expected_resale_cents"]
    },
    {
      "id": "R31",
      "code": "PICKUP_EATS_MARGIN",
      "kind": "warning",
      "priority": 51,
      "confidence": "medium",
      "evidence": ["gsa_terms", "wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"var": "has_value"}, {"var": "transport_known"}, {">": [{"var": "transport_share"}, {"var": "constants.transport_share_warn"}]}]}]},
      "text": "The pickup trip ({pickup_distance_miles} miles each way, about {transport_cents|usd}) is {transport_share|pct} of the expected resale value. It is already deducted from your ceiling; combine it with other lots at the same site or skip.",
      "numbers": ["pickup_distance_miles", "transport_cents", "transport_share"]
    },
    {
      "id": "R32",
      "code": "HERD_WARNING",
      "kind": "warning",
      "priority": 52,
      "confidence": "medium",
      "evidence": ["simonsohn_ariely_2008", "ku_galinsky_murnighan_2006"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_crowded"}]},
      "text": "Crowded lot ({bid_count} bids). Bidders herd into lots that already have bids even when the bids only reflect a low opening price, and pay more when they win them. The bid count is not evidence of quality; look for a quieter comparable lot.",
      "numbers": ["bid_count", "herd_bid_count"]
    },
    {
      "id": "R33",
      "code": "INSPECT_OR_SKIP",
      "kind": "warning",
      "priority": 53,
      "confidence": "medium",
      "evidence": ["lewis_2011", "nizard_thesis"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"==": [{"var": "image_count"}, 0]}, {"var": "high_value_risk"}]}]},
      "text": "No photos on a high-risk category. Sellers who can show quality usually do; inspect at preview or skip.",
      "numbers": ["image_count", "description_word_count"]
    },
    {
      "id": "R34",
      "code": "SLEEPER_CANDIDATE",
      "kind": "info",
      "priority": 54,
      "confidence": "medium",
      "evidence": ["lewis_2011", "nizard_thesis", "nyt_misspelling_2004", "sleeper_internal"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_quiet"}, {">=": [{"var": "image_count"}, 1]}, {"or": [{"var": "is_thin_listing"}, {"var": "is_few_photos"}]}]},
      "text": "Possible sleeper: a thin listing ({description_word_count} words, {image_count} photo(s)) with {bid_count} bid(s). Fewer photos and less text are associated with fewer bidders and lower prices, which is the opportunity, and with more condition risk, which your {uncertainty_haircut_rate|pct} risk haircut covers. Identify it from the photos before bidding.",
      "numbers": ["description_word_count", "image_count", "bid_count", "uncertainty_haircut_rate"]
    },
    {
      "id": "R35",
      "code": "PREMIUM_ASSUMED",
      "kind": "warning",
      "priority": 55,
      "confidence": "high",
      "evidence": ["govdeals_thirdparty", "wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {"var": "bp_assumed"}]},
      "text": "Buyer's premium was not captured for this lot; using {bp_pct}% ({bp_source}). Check the auction terms, because the premium moves your ceiling directly.",
      "numbers": ["bp_pct", "bp_source"]
    },
    {
      "id": "R36",
      "code": "TRUE_COST",
      "kind": "info",
      "priority": 56,
      "confidence": "high",
      "evidence": ["govdeals_thirdparty", "wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {">": [{"var": "cost_multiplier"}, 0]}]},
      "text": "Every $100 of hammer price costs about {cost_per_100_cents|usd} on the invoice ({bp_pct}% premium, {tax_rate|pct} tax, {card_fee_rate|pct} card fee), before pickup.",
      "numbers": ["cost_multiplier", "cost_per_100_cents", "bp_pct", "tax_rate", "card_fee_rate"]
    },
    {
      "id": "R37",
      "code": "EXTENDING_CLOSE_PRICES_HIGHER",
      "kind": "info",
      "priority": 57,
      "confidence": "medium",
      "evidence": ["glover_raviv_2012", "houser_wooders_2005", "overstock_softclose_2019"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}]},
      "text": "Auctions that extend on late bids have finished higher than fixed-end auctions in the published comparisons, so expect less discount here and don't count on a last-second steal.",
      "numbers": ["window_min"]
    },
    {
      "id": "R38",
      "code": "GSA_INACTIVITY_AND_REMOVAL",
      "kind": "info",
      "priority": 58,
      "confidence": "high",
      "evidence": ["gsa_faq", "gsa_terms", "gsa_realestate_faq", "cbca_2007", "gsa_thirdparty"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "platform_base"}, "gsa"]}]},
      "text": "GSA: most lots close only after an inactivity period with no bids (see 'Bidding Details'), so a late bid just restarts it; GSA's real-estate FAQ adds that changing your own proxy bid restarts it too. If you win, pay within 2 business days and remove within 10 business days of the award email. Missing either can cost liquidated damages (reported as the greater of 20% or $200). GSA does not ship.",
      "numbers": ["window_min"]
    },
    {
      "id": "R39",
      "code": "WISCONSIN_SURPLUS_TERMS",
      "kind": "info",
      "priority": 59,
      "confidence": "high",
      "evidence": ["wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "platform_base"}, "wisconsin-surplus"]}]},
      "text": "Wisconsin Surplus: bids in the last 10 minutes extend the item by 10 minutes; a tiered buyer's fee is added; items left past the posted removal deadline cost $10 per day in storage.",
      "numbers": ["window_min", "bp_pct"]
    },
    {
      "id": "R40",
      "code": "GOV_REMOVAL_CHECK",
      "kind": "info",
      "priority": 60,
      "confidence": "medium",
      "evidence": ["public_surplus_extensions", "govdeals_thirdparty"],
      "when": {"and": [{"var": "is_open"}, {"in": [{"var": "platform_base"}, ["govdeals", "public-surplus", "municibid"]]}]},
      "text": "Government surplus: the selling agency sets payment and removal deadlines and whether it loads for you. Read them before bidding and plan the pickup (truck, trailer, helpers) first.",
      "numbers": ["pickup_distance_miles", "transport_cents"]
    },
    {
      "id": "R41",
      "code": "SF97_TITLE_CHECK",
      "kind": "warning",
      "priority": 61,
      "confidence": "high",
      "evidence": ["gsa_sf97", "gsa_faq"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"==": [{"var": "category"}, "vehicles"]}, {"==": [{"var": "platform_base"}, "gsa"]}]}]},
      "text": "Federal vehicle: the SF-97 is evidence of title only; you use it to title and register the vehicle with the state. GSA itself charges no sales tax, but the state may tax registered items such as vehicles; that tax is inside your {tax_rate|pct} assumption.",
      "numbers": ["tax_rate"]
    },
    {
      "id": "R42",
      "code": "VEHICLE_PAPERWORK_CHECK",
      "kind": "warning",
      "priority": 62,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"and": [{"==": [{"var": "category"}, "vehicles"]}, {"!=": [{"var": "platform_base"}, "gsa"]}]}]},
      "text": "Before bidding on a vehicle, confirm in the terms what paperwork you receive (title, bill of sale, or neither) and when. Not verified per platform.",
      "numbers": []
    },
    {
      "id": "R43",
      "code": "AIRCRAFT_REMOVAL_COSTS",
      "kind": "warning",
      "priority": 63,
      "confidence": "high",
      "evidence": ["gsa_aircraft_listing"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "category"}, "aircraft"]}]},
      "text": "Aircraft: disassembly, removal planning and transport are the buyer's cost and arrangement, and the government provides no ground support equipment. Listings may state the aircraft is not in FAA-flyable condition and comes without airworthiness documents. Price the removal before bidding.",
      "numbers": ["max_hammer_cents"]
    },
    {
      "id": "R44",
      "code": "WINNERS_CURSE_GUARD",
      "kind": "info",
      "priority": 64,
      "confidence": "high",
      "evidence": ["bazerman_samuelson_1983", "bajari_hortacsu_2003"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"var": "has_value"}, {">=": [{"var": "uncertainty_haircut_rate"}, {"var": "constants.winners_curse_note_min_haircut"}]}]}]},
      "text": "This category's value is uncertain, so the winner is usually whoever overestimated it most. Your ceiling already deducts a {uncertainty_haircut_rate|pct} uncertainty haircut; don't bid past it.",
      "numbers": ["uncertainty_haircut_rate", "risk_reserve_cents"]
    },
    {
      "id": "R45",
      "code": "CLOSING_QUIET",
      "kind": "info",
      "priority": 65,
      "confidence": "medium",
      "evidence": ["sleeper_internal", "simonsohn_ariely_2008"],
      "when": {"and": [{"var": "is_open"}, {"<=": [{"var": "minutes_to_close"}, {"var": "constants.closing_quiet_minutes"}]}, {"var": "is_quiet"}]},
      "text": "Closes in {minutes_to_close|min} with {bid_count} bid(s): the crowd has not found it yet.",
      "numbers": ["minutes_to_close", "bid_count"]
    }
  ],
  "output_contract": {
    "per_lot": {
      "primary": "The fired rule of kind 'action' with the lowest priority number, or null.",
      "actions": "All fired rules of kind 'action', ascending priority.",
      "warnings": "All fired rules of kind 'warning', ascending priority.",
      "info": "All fired rules of kind 'info', ascending priority.",
      "each_item": {
        "code": "string",
        "rule_id": "string",
        "text": "rendered template",
        "numbers": "object: name -> value for every name listed in the rule's 'numbers'",
        "confidence": "high|medium|low",
        "evidence": "array of evidence_index ids"
      },
      "derived": "Every derived value, for display and debugging."
    },
    "template_syntax": "{name} inserts a value; {name|usd} renders integer cents as $1,234.56; {name|pct} renders a fraction as a percent (0.123 -> 12.3%); {name|min} renders minutes as whole minutes. Dotted names read constants. null renders as 'n/a'."
  },
  "evidence_index": {
    "roth_ockenfels_2002": "https://www.aeaweb.org/articles?id=10.1257%2F00028280260344632",
    "ariely_ockenfels_roth_2005": "https://ideas.repec.org/p/ces/ceswps/_987.html",
    "ockenfels_roth_2006": "https://www.sciencedirect.com/science/article/pii/S089982560500059X",
    "ely_hossain_2009": "https://www.aeaweb.org/articles?id=10.1257/mic.1.2.68",
    "gray_reiley_2013": "http://www.davidreiley.com/papers/BenefitsToSniping.pdf",
    "backus_et_al_2015": "https://www.nber.org/papers/w20942",
    "overstock_softclose_2019": "https://link.springer.com/article/10.1007/s11002-019-09487-7",
    "houser_wooders_2005": "https://ideas.repec.org/h/spr/sprchp/978-0-387-24243-9_6.html",
    "glover_raviv_2012": "https://www.sciencedirect.com/science/article/abs/pii/S0167268111002319",
    "lee_malmendier_2011": "https://www.aeaweb.org/articles?id=10.1257%2Faer.101.2.749",
    "schneider_2016": "https://www.aeaweb.org/articles?id=10.1257/aer.20120767",
    "bazerman_samuelson_1983": "https://www.cs.princeton.edu/courses/archive/spr09/cos444/papers/BazermanSamuelson83.pdf",
    "bajari_hortacsu_2003": "https://ideas.repec.org/a/rje/randje/v34y2003i2p329-55.html",
    "ku_malhotra_murnighan_2005": "https://econpapers.repec.org/RePEc:eee:jobhdp:v:96:y:2005:i:2:p:89-103",
    "heyman_orhun_ariely_2004": "https://www.sciencedirect.com/science/article/abs/pii/S1094996804701152",
    "ku_galinsky_murnighan_2006": "https://pubmed.ncbi.nlm.nih.gov/16784346/",
    "simonsohn_ariely_2008": "https://pubsonline.informs.org/doi/10.1287/mnsc.1080.0881",
    "simonsohn_2010": "https://pubsonline.informs.org/doi/abs/10.1287/mnsc.1100.1180",
    "lucking_reiley_2007": "https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1467-6451.2007.00309.x",
    "lewis_2011": "https://www.aeaweb.org/articles?id=10.1257%2Faer.101.4.1535",
    "nizard_thesis": "https://academicworks.cuny.edu/hc_sas_etds/1177/",
    "nyt_misspelling_2004": "https://www.math.utoronto.ca/mpugh/Teaching/Sci199_03/EBay_misspellings.htm",
    "katkar_reiley_2006": "https://www.nber.org/papers/w8183",
    "engelberg_williams_2009": "https://www.sciencedirect.com/science/article/abs/pii/S0167268109001504",
    "ebay_automatic_bidding": "https://www.ebay.com/help/buying/bidding/automatic-bidding?id=4014",
    "gsa_faq": "https://gsaauctions.gov/auctions/auction-faq",
    "gsa_terms": "https://gsaauctions.gov/auctions/terms-conditions",
    "gsa_realestate_faq": "https://realestatesales.gov/html/static/faq.htm",
    "gsa_thirdparty": "https://bidprowl.com/guides/gsa-auctions-faq",
    "cbca_2007": "https://www.cbca.gov/files/decisions/2007/PARKER_03-07-2007_426__GHULAM_H_SYED_508.pdf",
    "gsa_aircraft_listing": "https://www.gsaauctions.gov/auctions/preview/297688",
    "gsa_sf97": "https://www.gsa.gov/reference/forms/the-united-states-government-certificate-to-obtain-title-to-a-vehicle",
    "govdeals_thirdparty": "https://govauctions.app/guides/govdeals-faq",
    "public_surplus_extensions": "https://m.publicsurplus.com/sms/help/public/gloss_extension.html",
    "hibid_softclose_examples": "https://www.wnutting.com/HiBid%20-%20How%20HiBid%20Closing%20Works.pdf",
    "kbid_softclose": "https://www.k-bid.com/auction/29680/item/375-INFO?offset=243",
    "wisconsin_surplus_terms": "https://wisconsinsurplus.com/terms-2/",
    "maxsold_softclose": "https://support.maxsold.com/hc/en-us/articles/203144064-What-does-soft-close-mean",
    "auctionninja_extended": "https://support.auctionninja.com/knowledge/what-is-extended-bidding",
    "proxibid_timed": "https://support.proxibid.com/hc/en-gb/articles/360012856098-Timed-Auctions",
    "yesterdays_tractors_forum": "https://forums.yesterdaystractors.com/threads/proxibid-tips-please.1519535/",
    "sleeper_internal": "platform/supabase/migrations/0006_ranking_and_sleeper_fixes.sql",
    "internal_market_research": "platform/docs/05-market-research.md"
  }
}
```

### 9.3 Test results

The spec above was run through a strict reference evaluator (Python). The evaluator
raises on any null reaching arithmetic or an ordering comparison. It was run against
13 synthetic lots at `now = 2026-09-27T18:00Z`. All evaluated without error:

| Test lot | Primary recommendation | Ceiling |
|---|---|---|
| eBay tool lot, $300 comps, closes in 2 days | `HARD_CLOSE_SINGLE_LATE_BID` | $116 |
| HiBid tool lot, $200 comps, 40 mi, 18% premium | `WALK_AWAY_UNECONOMIC` | $0 |
| GovDeals vehicle, $9,000 comps, bid $4,500, reserve not met | `WALK_AWAY_OVER_MAX` (+ `RESERVE_NOT_MET_STOP`) | $3,959 |
| GSA aircraft, budget $50,000 only, window not captured | `PROXY_BEFORE_WINDOW` (+ `EXTENSION_RULE_UNKNOWN`, `AIRCRAFT_REMOVAL_COSTS`, `BUDGET_ONLY_CEILING`) | $47,393 |
| EstateSales.net tag $150, $250 comps furniture | `TAG_PASS` | $56 |
| Proxibid webcast, $20,000 comps farm equipment | `WEBCAST_ABSENTEE_BID` | $7,403 |
| Public Surplus sealed, $4,000 comps construction equipment | `SEALED_BID_AT_CEILING` | $1,601 |
| MaxSold collectible, no value, no budget | `NEED_VALUE` | — |
| Wisconsin Surplus coin lot, 6 words, 1 photo, 0 bids | `PROXY_BEFORE_WINDOW` (+ `SLEEPER_CANDIDATE`, `CLOSING_QUIET`) | $144 |
| GSA vehicle inside a 10-min inactivity window, over ceiling | `WALK_AWAY_OVER_MAX` (+ `SF97_TITLE_CHECK`) | $7,215 |
| Purple Wave (close rule not captured) | `BID_UP_TO_MAX` | $3,960 |
| K-BID lot already closed | `LOT_CLOSED` | — |
| AuctionNinja furniture 80 mi away | `WALK_AWAY_UNECONOMIC` (+ `PICKUP_EATS_MARGIN`) | $0 |

Several ceilings are low: $7,403 against $20,000 of comps, $1,601 against $4,000. The
cause is the placeholder margins, haircuts and fees stacking up, which is a reason to
calibrate them rather than to trust them. The logic is sound; the parameters are not
yet.

---

## 10. Research gaps and verification queue

These could not be verified this session. They are listed in the order they would
change the product.

1. **Practitioner evidence**, the owner's explicit ask:
   - r/Flipping, r/Auctions, r/estatesales, r/coins, r/Pawn and r/smallbusiness
     threads on max-bid rules, margins by category, estate-sale timing and government
     surplus.
   - Reseller YouTube and podcast show notes.
   - BiggerPockets threads on government and estate auctions.
   - NAA's "What Is A Soft Close Or Dynamic Ending Of An Online Auction?"
     (auctioneers.org).
   - *Auctioneer* magazine.

   Reddit could not be fetched at all, and the search budget ran out before any
   practitioner searches were run.
2. **Buyer's premium and card-fee norms** from primary pages:
   - [GovDeals FAQ](https://www.govdeals.com/faq) and [how to bid](https://blog.govdeals.com/how-to-bid).
   - [HiBid terminology](https://help.hibid.com/en/articles/11533716-auction-terminology).
   - [Proxibid timed auctions](https://support.proxibid.com/hc/en-gb/articles/360012856098-Timed-Auctions).
   - [AuctionNinja FAQs](https://www.auctionninja.com/blog/auctionninja-faqs).
   - MaxSold terms.
   - Purple Wave, BidSpotter and Municibid help pages.
   - The Wisconsin Surplus fee tiers.
3. **Wisconsin sales and use tax** on auction purchases: premium taxability, the
   exemption certificate, vehicles, farm equipment, and GSA purchases (use tax).
   Source: the Wisconsin DOR.
4. **Estate-sale discount schedules and sign-in customs.** Sample Wisconsin listings on
   EstateSales.net and EstateSales.org, and extract the stated schedules.
5. **Sealed-bid and absentee-bid mechanics** per platform: GSA sealed, Public Surplus,
   Proxibid, HiBid webcast.
6. **Primary text for the reported numbers:**
   - Ely & Hossain: the 18-cent / 1.36% figure.
   - Bazerman & Samuelson: the jar figures.
   - GSA liquidated damages: 20% or $200.
   - GovDeals: 3-minute window.
7. **Typo listings:** look for a peer-reviewed estimate. None was found.
8. **Calibration data** (Skeuos's own, once live):
   - Realised resale against `expected_resale_cents` sets `u` and `r`.
   - The `bid_count` distribution per category sets the herd threshold.
   - Win rates against ceilings set `p_win` for S19.

To unblock items 1–6, change the cloud environment's network access to allow the
hosts named above, or raise the session's web-search limit
(`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`), and re-run this research.

---

## 11. Sources

All accessed **2026-09-27**. **[SE]** means the claim came from a search-engine extract
of that URL; the page itself was not opened. **[SE-2nd]** means a third-party or
secondary page. **[listed]** means the URL appeared in results but no content from it
is relied on.

**Academic: late bidding, closing rules and proxy bidding**

1. Roth, A. & Ockenfels, A. (2002). Last-Minute Bidding and the Rules for Ending Second-Price Auctions: Evidence from eBay and Amazon Auctions on the Internet. *AER* 92(4):1093–1103. https://www.aeaweb.org/articles?id=10.1257%2F00028280260344632 [SE]; PDF https://web.stanford.edu/~alroth/papers/eBay.veryshortaer.pdf [listed]; NBER w7729 https://www.nber.org/papers/w7729 [listed]; https://www.nber.org/system/files/working_papers/w7729/w7729.pdf [listed]; https://www.jstor.org/stable/3083298 [listed]; https://econpapers.repec.org/RePEc:aea:aecrev:v:92:y:2002:i:4:p:1093-1103 [listed]; https://web.stanford.edu/class/cs206/roth-ockenfels.pdf [listed]; https://www.cs.princeton.edu/courses/archive/spr08/cos444/papers/roth_ockenfels02.pdf [listed]; https://www.hbs.edu/faculty/Pages/item.aspx?num=11038 [listed]; https://stanford.edu/~alroth/papers/eBay.ai.pdf [listed]
2. Ariely, D., Ockenfels, A. & Roth, A. (2005). An Experimental Analysis of Ending Rules in Internet Auctions. *RAND J. Econ.* 36(4):890–907. https://ideas.repec.org/p/ces/ceswps/_987.html [SE]; https://www.econstor.eu/bitstream/10419/76421/1/cesifo_wp987.pdf [listed]; https://web.stanford.edu/~alroth/papers/eBay.experiment.pdf [listed]; https://doi.org/10.2139/ssrn.429963 [listed]; https://www.hbs.edu/faculty/Pages/item.aspx?num=17879 [listed]
3. Ockenfels, A. & Roth, A. (2006). Late and multiple bidding in second price Internet auctions. *Games Econ. Behav.* 55(2):297–320. https://www.sciencedirect.com/science/article/pii/S089982560500059X [SE]; https://econpapers.repec.org/article/eeegamebe/v_3a55_3ay_3a2006_3ai_3a2_3ap_3a297-320.htm [SE]; https://cramton.umd.edu/market-design-papers/ockenfels-roth-late-bidding.pdf [listed]; https://web.stanford.edu/~alroth/papers/equilibrium.geb.pdf [listed]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=432900 [listed]; https://kylewoodward.com/blog-data/pdfs/references/ockenfels+roth-games-and-economic-behavior-2006A.pdf [listed]
4. Ely, J. & Hossain, T. (2009). Sniping and Squatting in Auction Markets. *AEJ: Micro* 1(2):68–94. https://www.aeaweb.org/articles?id=10.1257/mic.1.2.68 [SE]; https://faculty.wcas.northwestern.edu/jel292/sniping_v21.pdf [listed]; https://www-2.rotman.utoronto.ca/tanjim.hossain/sniping.pdf [listed]; https://ideas.repec.org/a/aea/aejmic/v1y2009i2p68-94.html [listed]; https://www.semanticscholar.org/paper/Sniping-and-Squatting-in-Auction-Markets-Ely-Hossain/c014d7092e6a80d031ed153d38c237520d899c2a [listed]
5. Gray, S. & Reiley, D. (2013; WP 2004). Measuring the Benefits to Sniping on eBay: Evidence from a Field Experiment. *J. Econ. & Mgmt.* 9(2):137–152. http://www.davidreiley.com/papers/BenefitsToSniping.pdf [SE]; https://oz.stern.nyu.edu/seminar/reiley2.pdf [listed]; http://www.davidreiley.com/papers/Sniping.pdf [listed]
6. Backus, M., Blake, T., Masterov, D. & Tadelis, S. (2015). Is Sniping A Problem For Online Auction Markets? WWW '15 / NBER w20942. https://www.nber.org/papers/w20942 [SE]; https://faculty.haas.berkeley.edu/stadelis/sniping_published_version.pdf [listed]; https://dl.acm.org/doi/abs/10.1145/2736277.2741690 [listed]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2562232 [listed]
7. Sniping in soft-close online auctions: empirical evidence from Overstock (2019). *Marketing Letters* 30(2). https://link.springer.com/article/10.1007/s11002-019-09487-7 [SE]; https://ideas.repec.org/a/kap/mktlet/v30y2019i2d10.1007_s11002-019-09487-7.html [listed]; https://www.researchgate.net/publication/332402193_Sniping_in_soft-close_online_auctions_empirical_evidence_from_overstock [listed]
8. Houser, D. & Wooders, J. (2005). Hard and Soft Closes: A Field Experiment on Auction Closing Rules. https://ideas.repec.org/h/spr/sprchp/978-0-387-24243-9_6.html [SE]; https://www.johnwooders.com/papers/Yahoo061404.pdf [listed]; https://mason.gmu.edu/~dhouser/hard.pdf [listed]
9. Glover, B. & Raviv, Y. (2012). Revenue non-equivalence between auctions with soft and hard closing mechanisms: New evidence from Yahoo! *JEBO* 81(1):129–136. https://www.sciencedirect.com/science/article/abs/pii/S0167268111002319 [SE]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=990166 [listed]; https://ideas.repec.org/a/eee/jeborg/v81y2012i1p129-136.html [listed]
10. Engelberg, J. & Williams, J. (2009). eBay's proxy bidding: A license to shill. *JEBO* 72(1):509–526. https://www.sciencedirect.com/science/article/abs/pii/S0167268109001504 [SE]; https://ideas.repec.org/a/eee/jeborg/v72y2009i1p509-526.html [listed]

**Academic: overbidding, winner's curse and psychology**

11. Lee, Y. H. & Malmendier, U. (2011). The Bidder's Curse. *AER* 101(2):749–87. https://www.aeaweb.org/articles?id=10.1257%2Faer.101.2.749 [SE]; https://www.nber.org/papers/w13699 [listed]; https://eml.berkeley.edu/~ulrike/Papers/bidderscurse19.pdf [listed]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1080202 [listed]
12. Schneider, H. (2016). The Bidder's Curse: Comment. *AER*. https://www.aeaweb.org/articles?id=10.1257/aer.20120767 [SE]; Reply: https://www.aeaweb.org/articles?id=10.1257/aer.20151372 [listed]
13. Bazerman, M. & Samuelson, W. (1983). I Won the Auction But Don't Want the Prize. *J. Conflict Resolution* 27(4):618–634. https://www.cs.princeton.edu/courses/archive/spr09/cos444/papers/BazermanSamuelson83.pdf [listed]; summary https://www.futilitycloset.com/2015/02/28/the-winners-curse/ [SE-2nd]
14. Thaler, R. (1988). Anomalies: The Winner's Curse. *JEP* 2(1). https://pubs.aeaweb.org/doi/pdf/10.1257/jep.2.1.191 [listed]
15. Kagel, J. Common Value Auctions and the Winner's Curse (survey). https://www.asc.ohio-state.edu/kagel.4/CVsurvey.short.PDF [listed]
16. Bajari, P. & Hortaçsu, A. (2003). The Winner's Curse, Reserve Prices, and Endogenous Entry: Empirical Insights from eBay Auctions. *RAND J. Econ.* 34(2):329–55. https://ideas.repec.org/a/rje/randje/v34y2003i2p329-55.html [SE]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=406693 [SE]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=224950 [listed]; https://patbajari.ai/wp-content/uploads/2023/11/the-winners-curse-reserve-prices-and-endogenous-entry.pdf [listed]
17. Ku, G., Malhotra, D. & Murnighan, J. K. (2005). Towards a competitive arousal model of decision-making: A study of auction fever in live and Internet auctions. *OBHDP* 96(2):89–103. https://econpapers.repec.org/RePEc:eee:jobhdp:v:96:y:2005:i:2:p:89-103 [SE]; https://www.hbs.edu/faculty/Pages/item.aspx?num=15069 [SE]; https://www.semanticscholar.org/paper/Towards-a-competitive-arousal-model-of-A-study-of-Ku-Malhotra/585b8ab705373ad696f35b9f648f9e6bc4e70237 [listed]
18. Heyman, J., Orhun, Y. & Ariely, D. (2004). Auction fever: The effect of opponents and quasi-endowment on product valuations. *J. Interactive Marketing* 18(4):7–21. https://www.sciencedirect.com/science/article/abs/pii/S1094996804701152 [SE]; https://people.duke.edu/~dandan/webfiles/PapersPI/Auction%20Fever.pdf [listed]; https://scholars.duke.edu/display/pub963532 [listed]
19. Ku, G., Galinsky, A. & Murnighan, J. K. (2006). Starting low but ending high: A reversal of the anchoring effect in auctions. *JPSP*. https://pubmed.ncbi.nlm.nih.gov/16784346/ [SE]; https://www.kellogg.northwestern.edu/faculty/research/detail/2006/starting-low-but-ending-high-a-reversal-of-the/?p=1 [listed]
20. Simonsohn, U. & Ariely, D. (2008). When Rational Sellers Face Nonrational Buyers: Evidence from Herding on eBay. *Management Science*. https://pubsonline.informs.org/doi/10.1287/mnsc.1080.0881 [SE]; https://urisohn.com/sohn_files/papers/herding_published.pdf [listed]; https://repository.upenn.edu/marketing_papers/302/ [listed]
21. Simonsohn, U. (2010). eBay's Crowded Evenings: Competition Neglect in Market Entry Decisions. *Management Science* 56(7):1060–1073. https://pubsonline.informs.org/doi/abs/10.1287/mnsc.1100.1180 [SE]; https://repository.upenn.edu/marketing_papers/311/ [listed]; https://ideas.repec.org/a/inm/ormnsc/v56y2010i7p1060-1073.html [listed]
22. Lucking-Reiley, D., Bryan, D., Prasad, N. & Reeves, D. (2007). Pennies from eBay: The Determinants of Price in Online Auctions. *J. Industrial Economics* 55:223–233. https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1467-6451.2007.00309.x [SE]; http://www.davidreiley.com/papers/PenniesFromEBay.pdf [listed]; https://kylewoodward.com/blog-data/pdfs/references/lucking-reiley+bryan+prasad+reeves-the-journal-of-industrial-economics-2007A.pdf [SE-2nd, day-of-week extract]
23. Day-of-week / ending-time studies surfaced together in one search, used only for the weak S16 claims: https://www.researchgate.net/publication/221407540_An_Examination_of_Auction_Price_Determinants_on_eBay [SE-2nd]; https://ideas.repec.org/p/ags/aaea04/20407.html [SE-2nd]; https://scholarship.claremont.edu/cgi/viewcontent.cgi?article=2248&context=cmc_theses [listed]; https://www.essex.ac.uk/-/media/documents/departments/economics/halton-eesj-s18.pdf?la=en [listed]

**Academic: disclosure, reserves and typos**

24. Lewis, G. (2011). Asymmetric Information, Adverse Selection and Online Disclosure: The Case of eBay Motors. *AER* 101(4):1535–46. https://www.aeaweb.org/articles?id=10.1257%2Faer.101.4.1535 [SE]; https://scholar.harvard.edu/lewis/publications/asymmetric-information-adverse-selection-and-online-disclosure-case-ebay-motors [SE]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1358341 [listed]
25. Nizard, I. Adverse Selection in Online Auctions: A Study of eBay Motors (CUNY thesis). https://academicworks.cuny.edu/hc_sas_etds/1177/ [SE]; https://academicworks.cuny.edu/cgi/viewcontent.cgi?article=2279&context=hc_sas_etds [listed]
26. Managerial Econ blog, "Advice for selling on eBay Motors: use lots of photos". https://managerialecon.blogspot.com/2013/11/repost-advice-for-selling-on-ebay.html?m=0 [SE-2nd]
27. Katkar, R. & Reiley, D. Public Versus Secret Reserve Prices in eBay Auctions: Results from a Pokémon Field Experiment. https://www.nber.org/papers/w8183 [SE]; https://ideas.repec.org/a/bpj/bejeap/vadvances.6y2007i2n7.html [listed]; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=264437 [listed]
28. Schemo, D. J. (2004). In Online Auctions, Misspelling in Ads Often Spells Cash. *New York Times* (mirror). https://www.math.utoronto.ca/mpugh/Teaching/Sci199_03/EBay_misspellings.htm [SE]
29. Typo-search tools, cited as evidence the practice exists: https://typohound.com/ [SE]; https://www.typable.com/ [listed]; http://www.goofbid.com/ebay_misspellings_search.html [listed]; http://www.auctionspeller.com/ [listed]; https://nobids.net/misspelled-items/ [listed]
30. Unsourced "12–37%" typo-discount claim, **not used**: https://lifetips.alibaba.com/tech-efficiency/eaby-finds-misspelled-items-on-ebay-for-cheaper-prices [SE-2nd]

**Platforms: eBay**

31. eBay Help, Automatic bidding. https://www.ebay.com/help/buying/bidding/automatic-bidding?id=4014 [SE]
32. Bid increments table as returned by search: https://www.liveabout.com/how-do-ebay-bid-increments-work-1140154 [SE-2nd]; https://community.ebay.com/t5/Ask-a-Mentor/bid-Increments-Table/td-p/33037599 [listed]

**Platforms: federal (GSA)**

33. GSA Auctions FAQs. https://gsaauctions.gov/auctions/auction-faq [SE]
34. GSA Auctions Terms and Conditions. https://gsaauctions.gov/auctions/terms-conditions [SE]; https://gsaauctions.gov/html/static/terms.htm [listed]
35. GSA Auctions User Guide / bid tutorial. https://gsaauctions.gov/auctions/auction-user-guide [SE]; https://gsaauctions.gov/html/tutorials/bid_information.html [SE]
36. GSA Auctions Payment Options. https://gsaauctions.gov/auctions/payment-options [listed]
37. GSA real estate auctions FAQ (inactivity-period wording). https://realestatesales.gov/html/static/faq.htm [SE]
38. GSA aircraft listings: https://www.gsaauctions.gov/auctions/preview/297688 [SE]; https://www.gsaauctions.gov/auctions/preview/347839?target=fleet [SE]; https://ppms.gov/auctions/preview/346563?target=fleet [SE]; https://ppms.gov/auctions/preview/313053 [listed]
39. GSA, SF-97 Certificate to Obtain Title to a Vehicle. https://www.gsa.gov/reference/forms/the-united-states-government-certificate-to-obtain-title-to-a-vehicle [SE]; GovPlanet explainer https://www.govplanet.com/form-sf97-for-government-surplus [SE-2nd]
40. Civilian Board of Contract Appeals, CBCA 426 (2007), 20% liquidated damages. https://www.cbca.gov/files/decisions/2007/PARKER_03-07-2007_426__GHULAM_H_SYED_508.pdf [SE]; GSBCA decision https://www.gsbca.gsa.gov/appeals/y1655331.pdf [SE]

**Platforms: state and local government**

41. GovDeals (third-party summaries): https://govauctions.app/guides/govdeals-faq [SE-2nd]; https://bidprowl.com/guides/govdeals-faq [SE-2nd]; https://bidprowl.com/guides/how-government-auctions-work [SE-2nd]; https://bstalker.com/guides/government-surplus-auctions [SE-2nd]; https://govauctions.app/guides/best-government-auction-sites [listed]. GovDeals primary pages, not readable here: https://www.govdeals.com/faq [listed]; https://blog.govdeals.com/how-to-bid [listed]
42. BidProwl GSA FAQ (the source contradicting GSA's own pages). https://bidprowl.com/guides/gsa-auctions-faq [SE-2nd]; https://govauctions.app/guides/gsa-auctions-faq [listed]
43. Public Surplus, Extensions glossary. https://m.publicsurplus.com/sms/help/public/gloss_extension.html [SE]; https://govauctions.app/guides/public-surplus-faq [SE-2nd]
44. Wisconsin Surplus Online Auction terms. https://wisconsinsurplus.com/terms-2/ [SE]; https://www.wisconsinsurplus.com/terms.html [SE]; https://bid.wisconsinsurplus.com/Public/Account/TermsAndCondition [listed]

**Platforms: private auction houses and estate**

45. HiBid soft close examples: https://www.wnutting.com/HiBid%20-%20How%20HiBid%20Closing%20Works.pdf [SE]; https://hibid.com/en/lot/186775874/this-is-a-soft-close-timed-auction [SE]; https://hibid.com/lot/213628892/whats-a-soft-closing-time---soft-close-definition [SE]; https://benladage.hibid.com/content/how-to-bid-online [SE]; https://help.hibid.com/en/articles/11533716-auction-terminology [listed]
46. K-BID auction FAQ lot on soft close: https://www.k-bid.com/auction/29680/item/375-INFO?offset=243 [SE]; https://www.k-bid.com/auction/11832 [listed]
47. Proxibid: https://support.proxibid.com/hc/en-gb/articles/360012856098-Timed-Auctions [SE]; https://support.proxibid.com/hc/en-gb/articles/8818403561233-Bidding-on-Proxibid [listed]; https://www.proxibid.com/asp/AnnouncementsGeneral.asp?anncid=95 [listed]; dealer blog https://www.mideastequip.com/feeds/blog/how-bid-proxibid [SE-2nd]
48. Yesterday's Tractors forum, "Proxibid tips please" (buyer practitioner report). https://forums.yesterdaystractors.com/threads/proxibid-tips-please.1519535/ [SE]
49. MaxSold Help: What does 'soft close' mean? https://support.maxsold.com/hc/en-us/articles/203144064-What-does-soft-close-mean [SE]; pickup scheduling https://support.maxsold.com/hc/en-us/articles/360056789113-Scheduling-your-specific-pickup-time-from-your-invoice [listed]; terms https://maxsold.com/terms-and-conditions [listed]
50. AuctionNinja Help: What is extended bidding? https://support.auctionninja.com/knowledge/what-is-extended-bidding [SE]; https://www.auctionninja.com/blog/everything-you-need-to-know-about-bid-increments-and-max-bids [listed]; https://www.auctionninja.com/blog/auctionninja-faqs [listed]
51. National Auction Association, What Is A Soft Close Or Dynamic Ending Of An Online Auction? https://www.auctioneers.org/auctionswork/what-is-a-soft-close-or-dynamic-ending-of-an-online-auction [listed]
52. AuctionMethod, When to Use Soft Close Groups. https://www.auctionmethod.com/blog/when-to-use-soft-close-groups-in-your-online-auction [listed]

**Internal (Skeuos repository)**

53. `platform/docs/00-architecture.md` §8–9: bidding API limits, rival intelligence.
54. `platform/docs/01-sources.md`: tiers, the coin thesis, estate sales as fixed-price events.
55. `platform/supabase/migrations/0002_core_schema.sql`: `lots`, `auctions.buyer_premium_pct`, `watchlist.max_bid_cents`, `watchlist.remind_seconds_before`.
56. `platform/supabase/migrations/0006_ranking_and_sleeper_fixes.sql`: `compute_sleeper()` thresholds reused by R34/R45.
57. `platform/supabase/seed/sources.sql`: `sources.platform` identifiers; Purple Wave "No-reserve absolute auctions" note.
58. `platform/docs/05-market-research.md` (sibling research pass, same date): used only for the cross-referenced premium norms (MaxSold, AuctionNinja, HiBid, Municibid, Wisconsin Surplus), the conflicting GovDeals window and the GSA vehicle deposit, each under that document's own labels.
