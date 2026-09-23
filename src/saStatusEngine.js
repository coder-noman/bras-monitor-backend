const { query } = require('./db');

// UPS(system) down always wins — same priority rule as before.
// system NOT tracked (systemStatus is null) -> no RCA, can't judge
// the power side.
function classify(routerStatus, systemStatus) {
  if (systemStatus === 'DOWN') return 'POWER_DOWN';
  if (systemStatus === 'UP' && routerStatus === 'Down') return 'TRANSMISSION_DOWN';
  return null; // OK
}

// Stateless by design: unlike rootCauseEngine.js, this needs no
// in-memory confirmation window and nothing is lost on a restart —
// it just reflects two already-confirmed, already-live values
// (router_status.status/down_time, and system_power_events' current
// open row) straight into one row per site. Call sync() once per
// ping cycle; safe to call as often as you like, it's idempotent.
async function syncReferenceFields() {
  const sql = `
    INSERT INTO sa_status (
      sa_code, sa_name,
      router_status, router_down_start, router_down_time,
      system_status, system_down_start, system_down_time,
      updated_at
    )
    SELECT
      s.sa_code,
      s.sa_name,
      COALESCE(rs.status, 'Unknown') AS router_status,
      CASE WHEN rs.status = 'Down' THEN NOW() - (rs.down_time * INTERVAL '1 second') ELSE NULL END AS router_down_start,
      CASE WHEN rs.status = 'Down' THEN rs.down_time ELSE 0 END AS router_down_time,
      sp.status AS system_status,
      CASE WHEN sp.status = 'DOWN' THEN sp.start_time ELSE NULL END AS system_down_start,
      CASE WHEN sp.status = 'DOWN' THEN sp.down_time ELSE 0 END AS system_down_time,
      NOW()
    FROM sa_list s
    LEFT JOIN routers r              ON r.bts_code = s.sa_code
    LEFT JOIN router_status rs       ON rs.ip_address = r.ip_address
    LEFT JOIN system_power_events sp ON sp.sa_code = s.sa_code AND sp.end_time IS NULL
    ON CONFLICT (sa_code) DO UPDATE SET
      sa_name             = EXCLUDED.sa_name,
      router_status       = EXCLUDED.router_status,
      router_down_start   = EXCLUDED.router_down_start,
      router_down_time    = EXCLUDED.router_down_time,
      system_status       = EXCLUDED.system_status,
      system_down_start   = EXCLUDED.system_down_start,
      system_down_time    = EXCLUDED.system_down_time,
      updated_at          = NOW()
  `;
  try {
    await query(sql);
  } catch (err) {
    console.error('[SA STATUS] Sync failed (run database/migration_6.sql?):', err.message);
  }
}

// Closes one open episode and logs it to sa_events as a complete,
// closed row — sa_events never holds an ongoing row.
async function closeAndLog(sa_code, status, startTime) {
  const now = new Date();
  const downTime = Math.max(0, Math.round((now.getTime() - new Date(startTime).getTime()) / 1000));
  await query(
    `INSERT INTO sa_events (sa_code, status, start_time, end_time, down_time) VALUES ($1, $2, $3, $4, $5)`,
    [sa_code, status, startTime, now, downTime]
  );
}

// Reads each site's current rca against what router_status/
// system_status now say (just refreshed by syncReferenceFields), and
// on any change: closes+logs whichever was open, then opens the new
// one — carrying its start time from the underlying reference
// (router_down_start / system_down_start) rather than "now", so a
// POWER_DOWN <-> TRANSMISSION_DOWN handoff reads as one continuous
// outage, not two separate short ones.
async function reconcileRCA() {
  let rows;
  try {
    const res = await query(`
      SELECT sa_code, router_status, router_down_start, system_status, system_down_start,
             rca, transmission_down_start, power_down_start
      FROM sa_status
    `);
    rows = res.rows;
  } catch (err) {
    console.error('[SA STATUS] Failed to load sa_status for RCA reconcile (run database/migration_7.sql?):', err.message);
    return;
  }

  for (const row of rows) {
    const candidate = classify(row.router_status, row.system_status);
    if (candidate === row.rca) continue; // no transition this cycle

    try {
      if (row.rca === 'POWER_DOWN') {
        await closeAndLog(row.sa_code, 'POWER_DOWN', row.power_down_start);
      } else if (row.rca === 'TRANSMISSION_DOWN') {
        await closeAndLog(row.sa_code, 'TRANSMISSION_DOWN', row.transmission_down_start);
      }

      const next = {
        rca: candidate,
        transmission_down_start: null, transmission_down_end: null,
        power_down_start: null, power_down_end: null,
      };
      if (candidate === 'TRANSMISSION_DOWN') {
        next.transmission_down_start = row.router_down_start; // carried, not "now"
      } else if (candidate === 'POWER_DOWN') {
        next.power_down_start = row.system_down_start; // carried, not "now"
      }

      await query(
        `UPDATE sa_status
         SET rca = $2,
             transmission_down_start = $3, transmission_down_end = $4,
             power_down_start = $5, power_down_end = $6
         WHERE sa_code = $1`,
        [row.sa_code, next.rca, next.transmission_down_start, next.transmission_down_end,
         next.power_down_start, next.power_down_end]
      );

      console.log(`[SA STATUS] ${row.sa_code} RCA ${row.rca || 'OK'} -> ${candidate || 'OK'}`);
    } catch (err) {
      console.error(`[SA STATUS] Failed RCA transition for ${row.sa_code}:`, err.message);
    }
  }
}

// One blind UPDATE, run after reconcileRCA() has settled this
// cycle's rca/transmission_down_start/power_down_start — reflects
// live elapsed seconds since whichever is currently active started.
// Same "grows every cycle" pattern as router_status.down_time.
async function updateLiveDurations() {
  try {
    await query(`
      UPDATE sa_status
      SET
        transmission_down = CASE
          WHEN rca = 'TRANSMISSION_DOWN'
          THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - transmission_down_start))::INT)
          ELSE 0
        END,
        power_down = CASE
          WHEN rca = 'POWER_DOWN'
          THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - power_down_start))::INT)
          ELSE 0
        END
    `);
  } catch (err) {
    console.error('[SA STATUS] Failed to update live durations (run database/migration_8.sql?):', err.message);
  }
}

async function sync() {
  await syncReferenceFields();
  await reconcileRCA();
  await updateLiveDurations();
}

module.exports = { sync };