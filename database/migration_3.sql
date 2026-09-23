-- ============================================================
--  migration_3.sql — rebuild SA_LIST (site profile table)
--
--  Run this AFTER you've already dropped the old sa_list table.
--  sa_list stays independent from `routers` (no foreign key) —
--  sa_code is just a plain unique text column here, matched up to
--  routers.bts_code / bras_device_data.sa_code by the application,
--  not enforced by the database. You can add a site here before or
--  after its router row exists.
--
--  New column set (replaces the old battery_system/batt1-3/ups1-3/
--  solar1-3 columns entirely):
--    sa_code, sa_name,
--    batt_volt, batt_curr,
--    solar_volt, solar_watt,
--    ups1_capacity, ups1_volt,
--    ups2_capacity, ups2_volt
-- ============================================================

CREATE TABLE IF NOT EXISTS sa_list (
    id              SERIAL PRIMARY KEY,
    sa_code         VARCHAR(50)   NOT NULL UNIQUE,  -- matches routers.bts_code / bras_device_data.sa_code
    sa_name         VARCHAR(100),

    batt_volt       NUMERIC(10,2),
    batt_curr       NUMERIC(10,2),

    solar_volt      NUMERIC(10,2),
    solar_watt      NUMERIC(10,2),

    ups1_capacity   NUMERIC(10,2),
    ups1_volt       NUMERIC(10,2),
    ups2_capacity   NUMERIC(10,2),
    ups2_volt       NUMERIC(10,2),

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sa_list_sa_code ON sa_list (sa_code);
