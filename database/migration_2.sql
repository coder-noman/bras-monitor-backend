-- ============================================================
--  MIGRATION V2 (post-merge) — new BRAS feed field set
--
--  The BRAS WebSocket feed's payload format changed (new field
--  names/order — see src/wsBrasWorker.js FIELDS). bras_device_data's
--  column set is completely different from before, so the table is
--  dropped and recreated rather than ALTERed column-by-column.
--
--  ⚠ This DROPS all previously stored raw readings in
--  bras_device_data (the old 5-BRAS-group column set is
--  incompatible with the new one). status_events,
--  system_power_events, current_component_status, and sa_list are
--  UNTOUCHED — all PDB/UPS1/UPS2 up/down history and the current
--  live status are preserved exactly as before, since those tables
--  never depended on bras_device_data's column set (they're driven
--  off row.pdb/row.ups1/row.ups2 in src/statusEngine.js, which are
--  unchanged field names in the new feed too).
--
--  Run this against your existing database, then restart
--  src/wsBrasWorker.js.
-- ============================================================

DROP TABLE IF EXISTS bras_device_data CASCADE;

CREATE TABLE bras_device_data (
    id                  BIGSERIAL,
    sa_code             VARCHAR(50)  NOT NULL,

    pdb                 NUMERIC(10,2),
    ups1                NUMERIC(10,2),
    ups2                NUMERIC(10,2),

    batt_volt_1         NUMERIC(10,2),
    batt_volt_2         NUMERIC(10,2),
    batt_curr_1         NUMERIC(10,2),
    batt_curr_2         NUMERIC(10,2),

    solar_volt          NUMERIC(10,2),
    solar_curr          NUMERIC(10,2),

    temp1               NUMERIC(10,2),
    temp2               NUMERIC(10,2),

    hum1                NUMERIC(10,2),
    hum2                NUMERIC(10,2),

    water1              NUMERIC(10,2),
    water2              NUMERIC(10,2),

    ac_curr_1           NUMERIC(10,2),
    ac_curr_2           NUMERIC(10,2),
    ac_curr_3           NUMERIC(10,2),
    ac_curr_4           NUMERIC(10,2),

    cb1                 NUMERIC(10,2),
    cb2                 NUMERIC(10,2),
    cb3                 NUMERIC(10,2),
    cb4                 NUMERIC(10,2),

    fire1               NUMERIC(10,2),
    fire2               NUMERIC(10,2),

    smoke1              NUMERIC(10,2),
    smoke2              NUMERIC(10,2),

    human_presence_1    NUMERIC(10,2),
    human_presence_2    NUMERIC(10,2),

    door_lock           NUMERIC(10,2),
    generator           NUMERIC(10,2),
    internal_batt       NUMERIC(10,2),

    psu1                NUMERIC(10,2),
    psu2                NUMERIC(10,2),

    operator            VARCHAR(50),
    signal_strength     NUMERIC(10,2),
    active              VARCHAR(50),
    server1             NUMERIC(10,2),
    server2             NUMERIC(10,2),
    data_counter        NUMERIC(10,2),

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

SELECT create_hypertable(
    'bras_device_data', 'created_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX idx_bras_device_data_sa_code
    ON bras_device_data (sa_code, created_at DESC);

-- ============================================================
--  VERIFY
-- ============================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'bras_device_data' ORDER BY ordinal_position;
-- SELECT * FROM bras_device_data ORDER BY created_at DESC LIMIT 5;
