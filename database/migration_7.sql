-- ============================================================
--  migration_7.sql — RCA tracking: sa_status columns + sa_events
--
--  Classification (immediate, no grace period):
--    system_status = DOWN                    -> POWER_DOWN        (case 2 & 3)
--    system_status = UP  + router_status=Down -> TRANSMISSION_DOWN (case 1)
--    otherwise                                -> OK (rca = NULL)
--
--  On a POWER_DOWN <-> TRANSMISSION_DOWN handoff (case 4), the new
--  episode's start time is NOT the moment of the switch — it's
--  carried from the underlying reference that's been running the
--  whole time:
--    -> TRANSMISSION_DOWN : transmission_down_start = router_down_start
--    -> POWER_DOWN         : power_down_start       = system_down_start
--  So a POWER_DOWN(case3) -> TRANSMISSION_DOWN(case1) handoff reads
--  as one continuous outage from when the router first went down,
--  even though the RCA type changed partway through.
--
--  sa_status.rca / transmission_down_*/power_down_* are the LIVE,
--  CURRENT state (only one pair populated at a time — whichever
--  matches rca; the other is NULL). The moment an episode closes
--  (recovery, or a handoff to the other type), it's written as one
--  row into sa_events and the sa_status fields for that type are
--  cleared. sa_events therefore only ever holds closed, complete
--  episodes — same shape you asked for: sa_code, status, start_time,
--  end_time, down_time. No open/ongoing rows in sa_events, ever.
--
--  Maintained by src/saStatusEngine.js (extended), called once per
--  ping cycle (every 30s) from src/pingEngine.js, right after this
--  cycle's router_status/system_status/*_down_start reference fields
--  are synced.
-- ============================================================

ALTER TABLE sa_status
  ADD COLUMN IF NOT EXISTS rca                     VARCHAR(20) CHECK (rca IN ('TRANSMISSION_DOWN', 'POWER_DOWN')),
  ADD COLUMN IF NOT EXISTS transmission_down_start  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transmission_down_end    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS power_down_start         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS power_down_end           TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sa_events (
    id          BIGSERIAL    PRIMARY KEY,
    sa_code     VARCHAR(50)  NOT NULL,
    status      VARCHAR(20)  NOT NULL CHECK (status IN ('TRANSMISSION_DOWN', 'POWER_DOWN')),
    start_time  TIMESTAMPTZ  NOT NULL,
    end_time    TIMESTAMPTZ  NOT NULL,
    down_time   INTEGER      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sa_events_lookup ON sa_events (sa_code, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_sa_status_rca    ON sa_status (rca);
