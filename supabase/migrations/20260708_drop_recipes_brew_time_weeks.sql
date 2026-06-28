-- brew_time_weeks was superseded by the granular days_brewhouse + days_fermenter + days_brite
-- breakdown. All 22 recipes had NULL values; the UI never populated it.
alter table public.recipes drop column if exists brew_time_weeks;
