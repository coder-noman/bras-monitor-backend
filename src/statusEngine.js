// src/statusEngine.js — component + system-power status derivation
//
// Reads a parsed reading's PDB / UPS1 / UPS2 values and maintains:
//   - status_events              per-component episode log:
//                                 [sa_code, component, status, up_time,
//                                  down_time, start_time, end_time]
//   - current_component_status   fast snapshot per sa_code+component
//                                 (status, live seconds, 24h totals)
//   - system_power_events        combined UPS-only episode log:
//                                 [sa_code, status, up_time, down_time,
//                                  start_time, end_time] — no separate
//                                 "current" table needed, the single
//                                 open row per sa_code IS the live
//                                 current status.
//
// up_time/down_time on BOTH event tables are updated on every incoming
// reading while the row is still open — not computed live at query
// time, but written at ingest time, so they lag real time by at most
// one reading interval.
//
// Business rules (do not change without re-reading the spec):
//   NULL  = component does not exist -> no events, status NOT_PRESENT
//   0     = component exists but DOWN
//   other = component exists and UP
//
// system_power_events derivation (PDB never factors in):
//   only UPS1 exists -> mirrors UPS1
//   only UPS2 exists -> mirrors UPS2
//   both exist        -> DOWN only once BOTH are down in the same
//                         reading (so the DOWN episode's start_time is
//                         naturally the moment the second one dropped,
//                         never the moment the first one did); UP if
//                         either is up
//   neither exists    -> not tracked, no row opens

const { query } = require('./db');

const COMPONENTS = ['PDB', 'UPS1', 'UPS2'];
const MS_24H = 24 * 60 * 60 * 1000;

// componentCache: { [sa_code]: { PDB: {status, since}, UPS1: {...}, UPS2: {...} } }
// systemPowerCache: { [sa_code]: {status, since} }  -- status: 'UP' | 'DOWN' | 'NOT_PRESENT'
const componentCache = {};
const systemPowerCache = {};

// ── Classify a raw value: null (doesn't exist) | 'UP' | 'DOWN' ──
function classify(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return value > 0 ? 'UP' : 'DOWN';
}

// ── Derive the combined UPS-only system power status ──
// Returns 'UP' | 'DOWN' | null (null = neither UPS exists, not tracked).
function computeSystemPowerStatus(ups1Status, ups2Status) {
  const existing = [ups1Status, ups2Status].filter(s => s !== null);
  if (existing.length === 0) return null;
  if (existing.length === 1) return existing[0];
  return (ups1Status === 'DOWN' && ups2Status === 'DOWN') ? 'DOWN' : 'UP';
}

function secondsSince(since, now) {
  if (!since) return 0;
  const sec = Math.round((now - new Date(since)) / 1000);
  return Number.isFinite(sec) && sec >= 0 ? sec : 0;
}

// ── Preload caches from the DB so a worker restart doesn't lose history ──
async function preloadStatusEngine() {
  for (const k of Object.keys(componentCache)) delete componentCache[k];
  for (const k of Object.keys(systemPowerCache)) delete systemPowerCache[k];

  const compRes = await query(
    'SELECT sa_code, component, status, status_since FROM current_component_status'
  );
  for (const row of compRes.rows) {
    if (!componentCache[row.sa_code]) componentCache[row.sa_code] = {};
    componentCache[row.sa_code][row.component] = { status: row.status, since: row.status_since };
  }

  const sysRes = await query(
    'SELECT sa_code, status, start_time FROM system_power_events WHERE end_time IS NULL'
  );
  for (const row of sysRes.rows) {
    systemPowerCache[row.sa_code] = { status: row.status, since: row.start_time };
  }

  console.log(
    `[STATUS ENGINE] Preloaded ${compRes.rowCount} component status row(s), ${sysRes.rowCount} open system power event(s)`
  );
}

// ── status_events: close the currently-open row for this sa_code+component ──
async function closeOpenStatusEvent(sa_code, component, now) {
  await query(
    `UPDATE status_events
     SET end_time = $3,
         up_time   = CASE WHEN status = 'UP'   THEN EXTRACT(EPOCH FROM ($3 - start_time))::INTEGER ELSE 0 END,
         down_time = CASE WHEN status = 'DOWN' THEN EXTRACT(EPOCH FROM ($3 - start_time))::INTEGER ELSE 0 END
     WHERE sa_code = $1 AND component = $2 AND end_time IS NULL`,
    [sa_code, component, now]
  );
}
async function openStatusEvent(sa_code, component, status, now) {
  await query(
    `INSERT INTO status_events (sa_code, component, status, start_time, up_time, down_time)
     VALUES ($1,$2,$3,$4,0,0)`,
    [sa_code, component, status, now]
  );
}
async function touchOpenStatusEvent(sa_code, component, status, since, now) {
  const elapsed = secondsSince(since, now);
  const up = status === 'UP' ? elapsed : 0;
  const down = status === 'DOWN' ? elapsed : 0;
  await query(
    `UPDATE status_events SET up_time = $3, down_time = $4
     WHERE sa_code = $1 AND component = $2 AND end_time IS NULL`,
    [sa_code, component, up, down]
  );
}

// ── system_power_events: same pattern, no component column ──
async function closeOpenSystemPowerEvent(sa_code, now) {
  await query(
    `UPDATE system_power_events
     SET end_time = $2,
         up_time   = CASE WHEN status = 'UP'   THEN EXTRACT(EPOCH FROM ($2 - start_time))::INTEGER ELSE 0 END,
         down_time = CASE WHEN status = 'DOWN' THEN EXTRACT(EPOCH FROM ($2 - start_time))::INTEGER ELSE 0 END
     WHERE sa_code = $1 AND end_time IS NULL`,
    [sa_code, now]
  );
}
async function openSystemPowerEvent(sa_code, status, now) {
  await query(
    `INSERT INTO system_power_events (sa_code, status, start_time, up_time, down_time)
     VALUES ($1,$2,$3,0,0)`,
    [sa_code, status, now]
  );
}
async function touchOpenSystemPowerEvent(sa_code, status, since, now) {
  const elapsed = secondsSince(since, now);
  const up = status === 'UP' ? elapsed : 0;
  const down = status === 'DOWN' ? elapsed : 0;
  await query(
    `UPDATE system_power_events SET up_time = $2, down_time = $3
     WHERE sa_code = $1 AND end_time IS NULL`,
    [sa_code, up, down]
  );
}

// ── Rolling 24h UP/DOWN totals for one sa_code+component, as of `now` ──
async function computeRolling24h(sa_code, component, now) {
  const windowStart = new Date(now.getTime() - MS_24H);

  const result = await query(
    `SELECT status, start_time, COALESCE(end_time, $3::timestamptz) AS effective_end
     FROM status_events
     WHERE sa_code = $1 AND component = $2
       AND COALESCE(end_time, $3::timestamptz) > $4::timestamptz
       AND start_time < $3::timestamptz`,
    [sa_code, component, now, windowStart]
  );

  let up24h = 0;
  let down24h = 0;
  for (const row of result.rows) {
    const overlapStart = Math.max(new Date(row.start_time).getTime(), windowStart.getTime());
    const overlapEnd = Math.min(new Date(row.effective_end).getTime(), now.getTime());
    const secs = Math.max(0, Math.round((overlapEnd - overlapStart) / 1000));
    if (row.status === 'UP') up24h += secs;
    else down24h += secs;
  }
  return { up_24h: up24h, down_24h: down24h };
}

// ── current_component_status upserts ──
async function upsertComponentStatus(sa_code, component, status, since, now, up24h, down24h) {
  const upSecond   = status === 'UP'   ? secondsSince(since, now) : 0;
  const downSecond = status === 'DOWN' ? secondsSince(since, now) : 0;

  await query(
    `INSERT INTO current_component_status
       (sa_code, component, status, status_since, last_seen_at, up_second, down_second, up_24h, down_24h)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (sa_code, component) DO UPDATE SET
       status       = EXCLUDED.status,
       status_since = EXCLUDED.status_since,
       last_seen_at = EXCLUDED.last_seen_at,
       up_second    = EXCLUDED.up_second,
       down_second  = EXCLUDED.down_second,
       up_24h       = EXCLUDED.up_24h,
       down_24h     = EXCLUDED.down_24h`,
    [sa_code, component, status, since, now, upSecond, downSecond, up24h, down24h]
  );
}

// ── Update one component (PDB/UPS1/UPS2) for one reading ──
async function updateComponentStatus(sa_code, component, newStatus, now) {
  if (!componentCache[sa_code]) componentCache[sa_code] = {};
  const prev = componentCache[sa_code][component];

  if (newStatus === null) {
    if (prev && prev.status !== 'NOT_PRESENT') {
      await closeOpenStatusEvent(sa_code, component, now);
    }
    const since = prev && prev.status === 'NOT_PRESENT' ? prev.since : now;
    componentCache[sa_code][component] = { status: 'NOT_PRESENT', since };
    await upsertComponentStatus(sa_code, component, 'NOT_PRESENT', since, now, 0, 0);
    return componentCache[sa_code][component];
  }

  let since;
  if (!prev || prev.status !== newStatus) {
    if (prev && prev.status !== 'NOT_PRESENT') {
      await closeOpenStatusEvent(sa_code, component, now);
    }
    await openStatusEvent(sa_code, component, newStatus, now);
    since = now;
    componentCache[sa_code][component] = { status: newStatus, since };
  } else {
    since = prev.since;
  }

  await touchOpenStatusEvent(sa_code, component, newStatus, since, now);

  const { up_24h, down_24h } = await computeRolling24h(sa_code, component, now);
  await upsertComponentStatus(sa_code, component, newStatus, since, now, up_24h, down_24h);
  return componentCache[sa_code][component];
}

// ── Update the combined system-power status for one reading ──
async function updateSystemPowerStatus(sa_code, newStatus, now) {
  const prev = systemPowerCache[sa_code];

  if (newStatus === null) {
    // Neither UPS exists — nothing to track. If it previously had an
    // open event (UPS(s) just removed), close it out.
    if (prev) {
      await closeOpenSystemPowerEvent(sa_code, now);
      delete systemPowerCache[sa_code];
    }
    return null;
  }

  let since;
  if (!prev || prev.status !== newStatus) {
    if (prev) await closeOpenSystemPowerEvent(sa_code, now);
    await openSystemPowerEvent(sa_code, newStatus, now);
    since = now;
    systemPowerCache[sa_code] = { status: newStatus, since };
  } else {
    since = prev.since;
  }

  await touchOpenSystemPowerEvent(sa_code, newStatus, since, now);
  return systemPowerCache[sa_code];
}

// ── sa_list.battery_current_capacity: running capacity, updated on
// every reading. pdb=0 (DOWN) drains it by batt_curr_1, floored at 0.
// pdb>0 (UP) recharges it by batt_curr_1, capped at the site's rated
// batt_curr. pdb NULL (component doesn't exist) leaves it unchanged.
// Single atomic UPDATE — no read-then-write race. ──
async function updateBatteryCapacity(sa_code, pdb, battCurr1) {
  const drain = pdb === 0;
  const charge = pdb !== null && pdb !== undefined && !Number.isNaN(pdb) && pdb > 0;
  if (!drain && !charge) return; // pdb NULL — leave capacity untouched

  await query(
    `UPDATE sa_list
     SET battery_current_capacity = CASE
       WHEN $2 THEN GREATEST(0, COALESCE(battery_current_capacity, batt_curr) - COALESCE($4, 0))
       WHEN $3 THEN LEAST(batt_curr, COALESCE(battery_current_capacity, batt_curr) + COALESCE($4, 0))
       ELSE battery_current_capacity
     END
     WHERE sa_code = $1`,
    [sa_code, drain, charge, battCurr1]
  );
}

// ── Entry point: call this once per parsed reading, after it's inserted into bras_device_data ──
// row must have .sa_code, .pdb, .ups1, .ups2 (nulls allowed on the last three).
async function processReading(row, now) {
  const { sa_code } = row;

  const pdbStatus  = classify(row.pdb);
  const ups1Status = classify(row.ups1);
  const ups2Status = classify(row.ups2);

  try {
    await updateComponentStatus(sa_code, 'PDB',  pdbStatus,  now);
    await updateComponentStatus(sa_code, 'UPS1', ups1Status, now);
    await updateComponentStatus(sa_code, 'UPS2', ups2Status, now);

    const systemPowerStatus = computeSystemPowerStatus(ups1Status, ups2Status);
    await updateSystemPowerStatus(sa_code, systemPowerStatus, now);

    await updateBatteryCapacity(sa_code, row.pdb, row.batt_curr_1);

    console.log(
      `[STATUS ENGINE] ${sa_code} | PDB=${pdbStatus ?? 'N/A'} UPS1=${ups1Status ?? 'N/A'} UPS2=${ups2Status ?? 'N/A'} | SYSTEM_POWER=${systemPowerStatus ?? 'N/A'}`
    );
  } catch (err) {
    console.error(`[STATUS ENGINE] Failed processing ${sa_code} (run database/schema.sql / migration_1.sql / migration_2.sql / migration_4.sql?):`, err.message);
  }
}

module.exports = {
  COMPONENTS,
  classify,
  computeSystemPowerStatus,
  preloadStatusEngine,
  processReading,
};