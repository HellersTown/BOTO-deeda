-- 0011_postal_provenance.sql
--
-- Where each postal_codes row came from. Two public datasets feed the table
-- (Census ZCTA geography, public domain; GeoNames postal codes, CC BY 4.0) and
-- they disagree at the margins: GeoNames carries PO-box and single-organisation
-- ZIPs that have no Census geography. Knowing which is which lets a location
-- conflict be traced to its source instead of guessed at, and the CC BY rows are
-- what the attribution notice in the app covers.
alter table postal_codes add column if not exists source text;
comment on column postal_codes.source is
  'census_zcta_2023 | census_zcta_2023+geonames_state | geonames. GeoNames data is CC BY 4.0: attribution required in the app.';
