-- 0027: AuctionGuide reads Wisconsin's four neighbours too.
--
-- Radius search crosses state lines (docs/09 row 5: "Wisconsin + adjacent
-- states"). A hunter in La Crosse, Hudson, Superior, Marinette, Prairie du
-- Chien or Kenosha is nearer many Minnesota, Michigan, Iowa and Illinois sales
-- than most Wisconsin ones. AuctionGuide keeps one page per state, so each
-- neighbour costs one request an hour: robots.txt allows the state pages and
-- its content signals allow search use (docs/08 section 1a). At the source's
-- 10 requests a minute, five pages take about 30 s of a run.
--
-- A sale's state comes only from its own card or map point. One placed outside
-- these states is left out; one with no state is kept without a state, never
-- given the state of the page that listed it.

update sources
   set states = array['WI', 'MN', 'IL', 'IA', 'MI']
 where slug = 'auctionguide';
