-- ============================================================
--  MIGRATION V1 (post-merge) — remove battery_info / battery_latest_data
--
--  Removes the monthly battery-info upload feature and the
--  battery_latest_data-driven battery simulation on router_status,
--  along with their APIs (src/routes/batteryInfo.js,
--  src/routes/batteryLatestData.js — deleted from the codebase).
--
--  Run this against your existing database. Safe to run even if
--  some of these were already removed (IF EXISTS everywhere).
-- ============================================================

-- 1. Drop the two battery tables entirely
DROP TABLE IF EXISTS battery_info        CASCADE;
DROP TABLE IF EXISTS battery_latest_data CASCADE;

-- 2. Drop the battery-simulation columns from router_status
--    (these were only ever populated from battery_latest_data
--    by the ping engine's stepBattery() — now removed)
ALTER TABLE router_status
  DROP COLUMN IF EXISTS battery_current_capacity,
  DROP COLUMN IF EXISTS battery_soc,
  DROP COLUMN IF EXISTS battery_up_accum_sec,
  DROP COLUMN IF EXISTS battery_down_accum_sec,
  DROP COLUMN IF EXISTS battery_source_updated_at;

-- ============================================================
--  VERIFY
-- ============================================================
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'router_status';
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('battery_info','battery_latest_data');
--   (should return 0 rows)
