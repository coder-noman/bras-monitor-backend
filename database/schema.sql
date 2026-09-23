-- ============================================================
--  bras-monitor-backend — FULL CONSOLIDATED SCHEMA
--
--  This replaces schema.sql + migration_v2..v11 as separate steps.
--  It is the single source of truth for a FRESH database.
--
--  If you are upgrading an EXISTING database that already has the
--  old socket-based BRAS power tables (bras_power_status,
--  bras_power_events, bras_ups_events, bras_power_history, and the
--  OLD bts_code-keyed bras_device_data), run
--  database/drop_old_bras_tables.sql FIRST, then run this file.
--  Every CREATE below is IF NOT EXISTS, so this file is also safe
--  to re-run on a database that's already up to date.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ════════════════════════════════════════════════════════════
--  PART 1 — ROUTER / PING MONITORING (unchanged, ping engine)
-- ════════════════════════════════════════════════════════════

-- 1. ROUTERS — master list
CREATE TABLE IF NOT EXISTS routers (
    id         SERIAL PRIMARY KEY,
    bts_name   VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45)  NOT NULL UNIQUE,
    bts_code   VARCHAR(50),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_routers_bts_code
    ON routers (bts_code) WHERE bts_code IS NOT NULL;

-- 2. ROUTER_STATUS — live / current state (one row per router)
CREATE TABLE IF NOT EXISTS router_status (
    ip_address                 VARCHAR(45)  PRIMARY KEY,
    bts_name                   VARCHAR(100) NOT NULL,
    up_time                    INTEGER      NOT NULL DEFAULT 0,   -- seconds
    down_time                  INTEGER      NOT NULL DEFAULT 0,   -- seconds
    up_time_last_24h           INTEGER      NOT NULL DEFAULT 0,   -- seconds
    down_time_last_24h         INTEGER      NOT NULL DEFAULT 0,   -- seconds
    status                     VARCHAR(10)  NOT NULL DEFAULT 'Unknown',
    countdown                  SMALLINT     NOT NULL DEFAULT 0,
    updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 3. PING_HISTORY — TimescaleDB hypertable (every 30s record)
CREATE TABLE IF NOT EXISTS ping_history (
    id                 BIGSERIAL,
    bts_name           VARCHAR(100) NOT NULL,
    ip_address         VARCHAR(45)  NOT NULL,
    up_time            INTEGER      NOT NULL DEFAULT 0,
    down_time          INTEGER      NOT NULL DEFAULT 0,
    up_time_last_24h   INTEGER      NOT NULL DEFAULT 0,
    down_time_last_24h INTEGER      NOT NULL DEFAULT 0,
    status             VARCHAR(10)  NOT NULL,
    countdown          SMALLINT     NOT NULL DEFAULT 0,
    checked_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

SELECT create_hypertable(
    'ping_history', 'checked_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_ping_history_ip
    ON ping_history (ip_address, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ping_history_status
    ON ping_history (status, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_router_status_status
    ON router_status (status);

-- 4. DAILY_SUMMARY — pre-computed per-router per-date totals
CREATE TABLE IF NOT EXISTS daily_summary (
    summary_date   DATE        NOT NULL,
    bts_name       TEXT        NOT NULL,
    ip_address     TEXT        NOT NULL,
    up_seconds     INTEGER     NOT NULL DEFAULT 0,
    down_seconds   INTEGER     NOT NULL DEFAULT 0,
    down_incidents INTEGER     NOT NULL DEFAULT 0,
    uptime_pct     NUMERIC(5,2),
    downtime_pct   NUMERIC(5,2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (summary_date, ip_address)
);
CREATE INDEX IF NOT EXISTS idx_daily_summary_ip
    ON daily_summary (ip_address, summary_date DESC);

-- 5. DAILY_EVENTS — pre-computed Up/Down cycle transitions per date
CREATE TABLE IF NOT EXISTS daily_events (
    id                  BIGSERIAL    PRIMARY KEY,
    event_date          DATE         NOT NULL,
    bts_name            TEXT         NOT NULL,
    ip_address          TEXT         NOT NULL,
    up_time             INTEGER      NOT NULL DEFAULT 0,
    down_time           INTEGER      NOT NULL DEFAULT 0,
    up_time_last_24h    INTEGER      NOT NULL DEFAULT 0,
    down_time_last_24h  INTEGER      NOT NULL DEFAULT 0,
    status              TEXT         NOT NULL,
    countdown           SMALLINT     NOT NULL DEFAULT 0,
    started_at          TIMESTAMPTZ  NOT NULL,
    ended_at            TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_events_date_ip
    ON daily_events (event_date, ip_address);
CREATE INDEX IF NOT EXISTS idx_daily_events_ip
    ON daily_events (ip_address, event_date DESC);

-- 6. ROUTER_UPDATE — fixed table, external push status per router
CREATE TABLE IF NOT EXISTS router_update (
    ip_address  TEXT        PRIMARY KEY
                             REFERENCES routers(ip_address)
                             ON DELETE CASCADE
                             ON UPDATE CASCADE,
    status      SMALLINT    NOT NULL DEFAULT 0 CHECK (status IN (0, 1)),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO router_update (ip_address, status, updated_at)
SELECT ip_address, 0, NOW() FROM routers
ON CONFLICT (ip_address) DO NOTHING;

CREATE OR REPLACE FUNCTION fn_router_update_auto_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO router_update (ip_address, status, updated_at)
  VALUES (NEW.ip_address, 0, NOW())
  ON CONFLICT (ip_address) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_router_update_auto_insert ON routers;
CREATE TRIGGER trg_router_update_auto_insert
AFTER INSERT ON routers
FOR EACH ROW
EXECUTE FUNCTION fn_router_update_auto_insert();

-- ════════════════════════════════════════════════════════════
--  PART 2 — SA / BRAS POWER MONITORING (from sa_monitor, via
--  src/wsBrasWorker.js + src/statusEngine.js — WebSocket ingest)
-- ════════════════════════════════════════════════════════════

-- 9. SA_LIST — master list of SA/BRAS sites tracked by the socket feed
CREATE TABLE IF NOT EXISTS sa_list (
    id                SERIAL PRIMARY KEY,
    sa_code           VARCHAR(50)   NOT NULL UNIQUE,  -- e.g. 'bras1' — matches the WebSocket feed's prefix
    sa_name           VARCHAR(100),

    battery_system    VARCHAR(100),

    batt1_volt        NUMERIC(10,2),
    batt1_amp         NUMERIC(10,2),
    batt1_qty         INTEGER,
    batt2_volt        NUMERIC(10,2),
    batt2_amp         NUMERIC(10,2),
    batt2_qty         INTEGER,
    batt3_volt        NUMERIC(10,2),
    batt3_amp         NUMERIC(10,2),
    batt3_qty         INTEGER,

    ups1_name         VARCHAR(100),
    ups1_capacity     NUMERIC(10,2),
    ups1_qty          INTEGER,
    ups2_name         VARCHAR(100),
    ups2_capacity     NUMERIC(10,2),
    ups2_qty          INTEGER,
    ups3_name         VARCHAR(100),
    ups3_capacity     NUMERIC(10,2),
    ups3_qty          INTEGER,

    solar1_capcity    NUMERIC(10,2),
    solar1_qty        INTEGER,
    solar2_capcity    NUMERIC(10,2),
    solar2_qty        INTEGER,
    solar3_capcity    NUMERIC(10,2),
    solar3_qty        INTEGER,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 10. BRAS_DEVICE_DATA — raw reading log, forever-growing hypertable.
-- Column set matches the BRAS WebSocket feed's payload exactly, in
-- order (v2 field set, post migration_2). A doubled comma in the
-- feed (empty value) lands as NULL here.
CREATE TABLE IF NOT EXISTS bras_device_data (
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

CREATE INDEX IF NOT EXISTS idx_bras_device_data_sa_code
    ON bras_device_data (sa_code, created_at DESC);

-- 11. STATUS_EVENTS — per-component (PDB/UPS1/UPS2) episode log
CREATE TABLE IF NOT EXISTS status_events (
    id                BIGSERIAL PRIMARY KEY,
    sa_code           VARCHAR(50)  NOT NULL,
    component         VARCHAR(10)  NOT NULL CHECK (component IN ('PDB','UPS1','UPS2')),
    status            VARCHAR(10)  NOT NULL CHECK (status IN ('UP','DOWN')),
    start_time        TIMESTAMPTZ  NOT NULL,
    end_time          TIMESTAMPTZ,             -- NULL = still ongoing
    up_time           INTEGER      NOT NULL DEFAULT 0,
    down_time         INTEGER      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_status_events_lookup
    ON status_events (sa_code, component, start_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_status_events_open
    ON status_events (sa_code, component) WHERE end_time IS NULL;

-- 12. SYSTEM_POWER_EVENTS — combined UPS1/UPS2-only "power backed up" log
CREATE TABLE IF NOT EXISTS system_power_events (
    id          BIGSERIAL PRIMARY KEY,
    sa_code     VARCHAR(50)  NOT NULL,
    status      VARCHAR(10)  NOT NULL CHECK (status IN ('UP','DOWN')),
    start_time  TIMESTAMPTZ  NOT NULL,
    end_time    TIMESTAMPTZ,
    up_time     INTEGER      NOT NULL DEFAULT 0,
    down_time   INTEGER      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_system_power_events_lookup
    ON system_power_events (sa_code, start_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_power_events_open
    ON system_power_events (sa_code) WHERE end_time IS NULL;

-- 13. CURRENT_COMPONENT_STATUS — fast per sa_code+component dashboard snapshot
CREATE TABLE IF NOT EXISTS current_component_status (
    sa_code           VARCHAR(50)  NOT NULL,
    component         VARCHAR(10)  NOT NULL CHECK (component IN ('PDB','UPS1','UPS2')),
    status            VARCHAR(15)  NOT NULL CHECK (status IN ('UP','DOWN','NOT_PRESENT')),
    status_since      TIMESTAMPTZ  NOT NULL,
    last_seen_at      TIMESTAMPTZ  NOT NULL,
    up_second         INTEGER      NOT NULL DEFAULT 0,
    down_second       INTEGER      NOT NULL DEFAULT 0,
    up_24h            INTEGER      NOT NULL DEFAULT 0,
    down_24h          INTEGER      NOT NULL DEFAULT 0,
    PRIMARY KEY (sa_code, component)
);

-- ============================================================
--  USEFUL QUERIES FOR MONITORING / TESTING
-- ============================================================

-- Live overview: how many up vs down right now (routers)
-- SELECT status, COUNT(*) FROM router_status GROUP BY status;

-- Top 10 routers with most downtime today
-- SELECT bts_name, ip_address, down_time_last_24h FROM router_status
-- ORDER BY down_time_last_24h DESC LIMIT 10;

-- Uptime % per router in last 24h
-- SELECT bts_name, ip_address, ROUND(up_time_last_24h::numeric / 86400 * 100, 2) AS uptime_pct
-- FROM router_status ORDER BY uptime_pct ASC;

-- Routers currently down with how long they've been down
-- SELECT bts_name, ip_address, down_time, updated_at FROM router_status
-- WHERE status = 'Down' ORDER BY down_time DESC;

-- All SA/BRAS sites and their live PDB/UPS1/UPS2 status
-- SELECT * FROM current_component_status ORDER BY sa_code, component;

-- Sites currently with power fully down (UPS1 & UPS2 both down, or the only one present down)
-- SELECT s.sa_code, s.sa_name, sp.status, sp.down_time, sp.start_time
-- FROM sa_list s JOIN system_power_events sp
--   ON sp.sa_code = s.sa_code AND sp.end_time IS NULL
-- WHERE sp.status = 'DOWN';

-- PDB/UPS1/UPS2 event history for one site
-- SELECT * FROM status_events WHERE sa_code = 'bras1' AND component = 'UPS1'
-- ORDER BY start_time DESC LIMIT 50;

-- Total raw readings stored for one site
-- SELECT COUNT(*) FROM bras_device_data WHERE sa_code = 'bras1';