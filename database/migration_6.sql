-- ============================================================
--  migration_6.sql — sa_status (fixed live snapshot, like router_status)
--
--  One row per sa_code (= bts_code — same site identifier, just
--  matched across the router side and the BRAS side). Mirrors two
--  already-confirmed, already-live values — no new grace period or
--  in-memory state needed, just a straight reflection:
--
--   router_status / router_down_start / router_down_time
--     <- router_status.status / down_time, for the router whose
--        bts_code = sa_list.sa_code. down_time already grows live
--        every 30s ping cycle; down_start is derived as
--        NOW() - down_time (recomputed every cycle, so it stays
--        exact since down_time itself grows in lockstep with real
--        time).
--
--   system_status / system_down_start / system_down_time
--     <- system_power_events' current open row (end_time IS NULL)
--        for that sa_code: UPS1+UPS2 combined ("if only one UPS
--        exists, mirrors that one" — already system_power_events'
--        own existing derivation, unchanged here). start_time and
--        down_time are copied straight from that row, since
--        statusEngine.js already keeps them live-updated.
--
--  Maintained by src/saStatusEngine.js, called once per ping cycle
--  (every 30s) from src/pingEngine.js — one UPSERT, no per-site
--  loop, no confirmation delay (both source values are already
--  confirmed/live by the time this reads them).
-- ============================================================

CREATE TABLE IF NOT EXISTS sa_status (
    sa_code             VARCHAR(50)  PRIMARY KEY,
    sa_name             VARCHAR(100),

    router_status       VARCHAR(10)  NOT NULL DEFAULT 'Unknown',  -- 'Up' / 'Down' / 'Unknown' (no matching router yet)
    router_down_start   TIMESTAMPTZ,                              -- NULL when not Down
    router_down_time    INTEGER      NOT NULL DEFAULT 0,          -- seconds, mirrors router_status.down_time

    system_status       VARCHAR(10),                              -- 'UP' / 'DOWN' / NULL (UPS not tracked for this site)
    system_down_start   TIMESTAMPTZ,                              -- NULL when not DOWN
    system_down_time    INTEGER      NOT NULL DEFAULT 0,          -- seconds, mirrors system_power_events.down_time

    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sa_status_router_status ON sa_status (router_status);
CREATE INDEX IF NOT EXISTS idx_sa_status_system_status ON sa_status (system_status);
