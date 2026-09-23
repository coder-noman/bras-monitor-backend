-- ============================================================
--  migration_4.sql — live battery_current_capacity on sa_list
--
--  Adds a running battery-capacity value per site, maintained by
--  src/statusEngine.js on every incoming bras_device_data reading:
--    pdb = 0  (DOWN) -> battery_current_capacity -= batt_curr_1, floor 0
--    pdb > 0  (UP)   -> battery_current_capacity += batt_curr_1, cap batt_curr
--  battery_soc (%) is then battery_current_capacity / batt_curr * 100,
--  computed on read in /api/devices/live-summary — no need to store it.
-- ============================================================

ALTER TABLE sa_list
  ADD COLUMN IF NOT EXISTS battery_current_capacity NUMERIC(10,2);

-- Start every site fully charged (at its rated batt_curr) unless
-- already set.
UPDATE sa_list
SET battery_current_capacity = batt_curr
WHERE battery_current_capacity IS NULL;
