-- ============================================================
--  migration_8.sql — live transmission_down / power_down duration
--
--  Two growing seconds-counters on sa_status, alongside the
--  start/end timestamps added in migration_7:
--    rca = TRANSMISSION_DOWN -> transmission_down grows, power_down = 0
--    rca = POWER_DOWN        -> power_down grows, transmission_down = 0
--    rca = NULL (OK)         -> both 0
--  Computed each cycle as NOW() - transmission_down_start /
--  NOW() - power_down_start, so they always reflect the live elapsed
--  time — same pattern as router_status.down_time growing every 30s.
-- ============================================================

ALTER TABLE sa_status
  ADD COLUMN IF NOT EXISTS transmission_down  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS power_down         INTEGER NOT NULL DEFAULT 0;
