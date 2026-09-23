// src/routes/devices.js — device status & event APIs (sa_monitor)
//
// No system-level status anymore — only PDB / UPS1 / UPS2, each
// tracked independently. Reads from:
//   - current_component_status  — fast snapshot per sa_code+component
//   - status_events             — [sa_code, component, status, up_time,
//                                  down_time, start_time, end_time],
//                                  one row per continuous episode

const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { COMPONENTS } = require('../statusEngine');

function serverError(res, err) {
  console.error('[DEVICES]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}
function notFound(res, code) {
  return res.status(404).json({ success: false, error: `sa_code '${code}' not found` });
}

// Turns ?from=2026-09-01&to=2026-09-30 into a SQL clause + params,
// starting from paramIndex. Both are optional and independent.
function buildDateFilter(from, to, paramIndex) {
  const clauses = [];
  const params = [];
  let i = paramIndex;
  if (from) { clauses.push(`start_time >= $${i++}`); params.push(from); }
  if (to)   { clauses.push(`start_time <= $${i++}`); params.push(to); }
  return { clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

// Shared handler factory for the 3 fixed-component event endpoints below.
// Returns rows shaped exactly as [sa_code, status, up_time, down_time,
// start_time, end_time] (plus id/component for convenience).
function componentEventsHandler(component) {
  return async (req, res) => {
    const { sa_code } = req.params;
    const { from, to } = req.query;
    const limit  = parseInt(req.query.limit) || 300;
    const page   = parseInt(req.query.page)  || 1;
    const offset = (page - 1) * limit;

    try {
      const saCheck = await query('SELECT sa_name FROM sa_list WHERE sa_code = $1', [sa_code]);
      if (saCheck.rowCount === 0) return notFound(res, sa_code);
      const sa_name = saCheck.rows[0].sa_name;

      const params = [sa_code, component];
      let where = 'sa_code = $1 AND component = $2';
      const dateFilter = buildDateFilter(from, to, params.length + 1);
      where += dateFilter.clause;
      params.push(...dateFilter.params);

      const countRes = await query(`SELECT COUNT(*) AS total FROM status_events WHERE ${where}`, params);
      const total = parseInt(countRes.rows[0].total);

      const sql = `
        SELECT id, sa_code, component, status, up_time, down_time, start_time, end_time,
               (end_time IS NULL) AS ongoing
        FROM status_events
        WHERE ${where}
        ORDER BY start_time DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      const result = await query(sql, [...params, limit, offset]);
      const events = result.rows.map(r => ({ sa_name, ...r }));

      res.json({
        success: true, sa_code, sa_name, component,
        total, page, limit, pages: Math.ceil(total / limit),
        events,
      });
    } catch (err) { serverError(res, err); }
  };
}

// ══════════════════════════════════════════════════════════
//  GET /api/devices
//  All BRAS devices (site profile list only — no system status).
// ══════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT sa_code, sa_name FROM sa_list ORDER BY sa_code');
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/devices/:sa_code/current-status
//  PDB, UPS1, UPS2 status right now. No system status.
// ══════════════════════════════════════════════════════════
router.get('/:sa_code/current-status', async (req, res) => {
  const { sa_code } = req.params;
  try {
    const saCheck = await query('SELECT sa_name FROM sa_list WHERE sa_code = $1', [sa_code]);
    if (saCheck.rowCount === 0) return notFound(res, sa_code);

    const compRes = await query(
      `SELECT component, status, status_since, last_seen_at, up_second, down_second, up_24h, down_24h
       FROM current_component_status WHERE sa_code = $1`,
      [sa_code]
    );

    const components = {};
    for (const c of COMPONENTS) components[c] = null;
    for (const row of compRes.rows) {
      components[row.component] = {
        status: row.status,
        status_since: row.status_since,
        last_seen_at: row.last_seen_at,
        up_second: row.up_second,
        down_second: row.down_second,
        up_24h: row.up_24h,
        down_24h: row.down_24h,
      };
    }

    res.json({ success: true, sa_code, sa_name: saCheck.rows[0].sa_name, components });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/devices/:sa_code/pdb-events?from=&to=&page=&limit=
//  GET /api/devices/:sa_code/ups1-events?from=&to=&page=&limit=
//  GET /api/devices/:sa_code/ups2-events?from=&to=&page=&limit=
//  Each returns [sa_code, status, up_time, down_time, start_time, end_time]
//  for that component's UP/DOWN episode history.
// ══════════════════════════════════════════════════════════
router.get('/:sa_code/pdb-events',  componentEventsHandler('PDB'));
router.get('/:sa_code/ups1-events', componentEventsHandler('UPS1'));
router.get('/:sa_code/ups2-events', componentEventsHandler('UPS2'));

// ══════════════════════════════════════════════════════════
//  GET /api/devices/:sa_code/system-power-events?from=&to=&page=&limit=
//  Full UP + DOWN episode history for this site's combined power
//  status (derived from UPS1/UPS2 only), most recent first — every
//  transition, not just the DOWN ones. This is the "all events" log
//  scoped to one site; /system-down shows only the CURRENT status
//  across every site.
// ══════════════════════════════════════════════════════════
router.get('/:sa_code/system-power-events', async (req, res) => {
  const { sa_code } = req.params;
  const { from, to } = req.query;
  const limit  = parseInt(req.query.limit) || 300;
  const page   = parseInt(req.query.page)  || 1;
  const offset = (page - 1) * limit;

  try {
    const saCheck = await query('SELECT sa_name FROM sa_list WHERE sa_code = $1', [sa_code]);
    if (saCheck.rowCount === 0) return notFound(res, sa_code);
    const sa_name = saCheck.rows[0].sa_name;

    const params = [sa_code];
    let where = 'sa_code = $1';
    const dateFilter = buildDateFilter(from, to, params.length + 1);
    where += dateFilter.clause;
    params.push(...dateFilter.params);

    const countRes = await query(`SELECT COUNT(*) AS total FROM system_power_events WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0].total);

    const sql = `
      SELECT id, sa_code, status, up_time, down_time, start_time, end_time,
             (end_time IS NULL) AS ongoing
      FROM system_power_events
      WHERE ${where}
      ORDER BY start_time DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const result = await query(sql, [...params, limit, offset]);
    const events = result.rows.map(r => ({ sa_name, ...r }));

    res.json({
      success: true, sa_code, sa_name,
      total, page, limit, pages: Math.ceil(total / limit),
      events,
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/devices/system-down
//  "Is this site's power backed up" — derived ONLY from UPS1/UPS2.
//  Returns every site that currently has an open system_power_events
//  row (i.e. at least one UPS exists), with its live status —
//  UP or DOWN — plus up_time/down_time, updated on every reading.
//  Sites with no open event (neither UPS exists) are excluded.
//  Top-level "count"/"total_up"/"total_down" summarize the list.
// ══════════════════════════════════════════════════════════
router.get('/system-down', async (req, res) => {
  try {
    const sql = `
      SELECT s.sa_code, s.sa_name,
             sp.status, sp.up_time, sp.down_time, sp.start_time, sp.end_time
      FROM sa_list s
      JOIN system_power_events sp
        ON sp.sa_code = s.sa_code AND sp.end_time IS NULL
      ORDER BY s.sa_code
    `;
    const result = await query(sql);

    const total_up = result.rows.filter(r => r.status === 'UP').length;
    const total_down = result.rows.filter(r => r.status === 'DOWN').length;

    res.json({
      success: true,
      count: result.rowCount,
      total_up,
      total_down,
      data: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/devices/latest-data/:sa_code
//  The latest bras_device_data row for one site, trimmed to just:
//  pdb, ups1, batt_volt_1, batt_curr_1, solar_volt, solar_curr,
//  temp1, hum1, "Internal Battery" (internal_batt), PSU1 (psu1),
//  PSU2 (psu2), Operator (operator), Signal_Strength (signal_strength),
//  active, server1, server2, data_counter.
//  Also returns "charts": the last 10 readings (oldest → newest,
//  NULL coalesced to 0) for temp1 and hum1, ready to feed straight
//  into two line charts.
// ══════════════════════════════════════════════════════════
router.get('/latest-data/:sa_code', async (req, res) => {
  const { sa_code } = req.params;
  try {
    const site = await query(`SELECT sa_code FROM sa_list WHERE sa_code = $1`, [sa_code]);
    if (site.rowCount === 0) return notFound(res, sa_code);

    const result = await query(
      `SELECT * FROM bras_device_data
       WHERE sa_code = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sa_code]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: `no bras_device_data rows found for sa_code '${sa_code}'`,
      });
    }

    const row = result.rows[0];
    const trimmed = {
      pdb: row.pdb,
      ups1: row.ups1,
      batt_volt_1: row.batt_volt_1,
      batt_curr_1: row.batt_curr_1,
      solar_volt: row.solar_volt,
      solar_curr: row.solar_curr,
      temp1: row.temp1,
      hum1: row.hum1,
      'Internal Battery': row.internal_batt,
      PSU1: row.psu1,
      PSU2: row.psu2,
      Operator: row.operator,
      Signal_Strength: row.signal_strength,
      active: row.active,
      server1: row.server1,
      server2: row.server2,
      data_counter: row.data_counter,
    };

    const historyResult = await query(
      `SELECT created_at,
              COALESCE(temp1, 0) AS temp1,
              COALESCE(hum1, 0)  AS hum1
       FROM bras_device_data
       WHERE sa_code = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [sa_code]
    );
    const history = historyResult.rows.reverse(); // oldest -> newest, for left-to-right charts

    const charts = {
      temperature: {
        labels: history.map(r => r.created_at),
        temp1: history.map(r => r.temp1),
      },
      humidity: {
        labels: history.map(r => r.created_at),
        hum1: history.map(r => r.hum1),
      },
    };

    res.json({ success: true, data: trimmed, charts });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/devices/live-summary?component=PDB|UPS1|UPS2
//  Flat list for dashboards: sa_name, sa_code, status, up_second,
//  down_second, up_24h, down_24h, last_seen_at (from
//  current_component_status for the given component — defaults to
//  PDB), plus the component's own latest raw reading (pdb/ups1/ups2
//  column from the single latest bras_device_data row), plus,
//  regardless of which component was selected:
//    ups              — latest raw ups1 reading
//    load             — batt_volt_1 * batt_curr_1 when pdb = 0, else 0
//    charging_watt    — batt_volt_1 * batt_curr_1 when pdb > 0, else 0
//    battery_current_capacity — running capacity maintained by
//                        src/statusEngine.js on every reading
//    battery_soc      — battery_current_capacity / sa_list.batt_curr * 100
//    signal           — 'OK' if a reading has come in within the last
//                        5 minutes (based on last_seen_at), else 'NO_SIGNAL'
// ══════════════════════════════════════════════════════════
// Maps the whitelisted COMPONENTS values to their raw-value column
// in bras_device_data. Never build this from raw user input directly.
const COMPONENT_COLUMN = { PDB: 'pdb', UPS1: 'ups1', UPS2: 'ups2' };

router.get('/live-summary', async (req, res) => {
  const component = (req.query.component || 'PDB').toUpperCase();
  if (!COMPONENTS.includes(component)) {
    return res.status(400).json({
      success: false,
      error: `component must be one of: ${COMPONENTS.join(', ')}`,
    });
  }
  const column = COMPONENT_COLUMN[component];

  try {
    const sql = `
      SELECT
        s.sa_code,
        s.sa_name,
        ccs.status,
        COALESCE(ccs.up_second, 0)   AS up_second,
        COALESCE(ccs.down_second, 0) AS down_second,
        COALESCE(ccs.up_24h, 0)      AS up_24h,
        COALESCE(ccs.down_24h, 0)    AS down_24h,
        latest.component_value AS ${column},
        latest.ups_raw AS ups,
        CASE WHEN latest.pdb_raw = 0 THEN latest.batt_volt_1 * latest.batt_curr_1 ELSE 0 END AS load,
        CASE WHEN latest.pdb_raw > 0 THEN latest.batt_volt_1 * latest.batt_curr_1 ELSE 0 END AS charging_watt,
        s.battery_current_capacity,
        CASE WHEN s.batt_curr > 0
          THEN ROUND((s.battery_current_capacity / s.batt_curr) * 100, 2)
          ELSE NULL
        END AS battery_soc,
        CASE
          WHEN ccs.last_seen_at IS NULL THEN 'NO_SIGNAL'
          WHEN ccs.last_seen_at < NOW() - INTERVAL '5 minutes' THEN 'NO_SIGNAL'
          ELSE 'OK'
        END AS signal,
        ccs.last_seen_at
      FROM sa_list s
      LEFT JOIN current_component_status ccs
        ON ccs.sa_code = s.sa_code AND ccs.component = $1
      LEFT JOIN LATERAL (
        SELECT
          pdb AS pdb_raw,
          ups1 AS ups_raw,
          batt_volt_1,
          batt_curr_1,
          ${column} AS component_value
        FROM bras_device_data d
        WHERE d.sa_code = s.sa_code
        ORDER BY d.created_at DESC
        LIMIT 1
      ) latest ON true
      ORDER BY s.sa_code
    `;
    const result = await query(sql, [component]);
    const total_up = result.rows.filter(r => r.status === 'UP').length;
    const total_down = result.rows.filter(r => r.status === 'DOWN').length;
    const total_no_signal = result.rows.filter(r => r.signal === 'NO_SIGNAL').length;
    res.json({
      success: true,
      component,
      count: result.rowCount,
      total_up,
      total_down,
      total_no_signal,
      data: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/devices/:sa_code/raw?start_date=&end_date=&start_time=&end_time=&limit=&after_created_at=&after_id=
//  Raw bras_device_data rows for one site within a date+time range,
//  in strict chronological (created_at ASC) order. Keyset ("cursor")
//  pagination — stays fast at any depth on a table with millions of
//  rows, unlike OFFSET pagination.
// ══════════════════════════════════════════════════════════
router.get('/:sa_code/raw', async (req, res) => {
  const { sa_code } = req.params;
  const { start_date, end_date, start_time, end_time, after_created_at, after_id } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

  if (!start_date || !end_date) {
    return res.status(400).json({ success: false, error: 'start_date and end_date are required (YYYY-MM-DD)' });
  }

  const rangeStart = `${start_date} ${start_time || '00:00:00'}`;
  const rangeEnd = `${end_date} ${end_time || '23:59:59'}`;
  if (Number.isNaN(Date.parse(rangeStart)) || Number.isNaN(Date.parse(rangeEnd))) {
    return res.status(400).json({ success: false, error: 'Invalid start/end date or time' });
  }

  try {
    const saCheck = await query('SELECT 1 FROM sa_list WHERE sa_code = $1', [sa_code]);
    if (saCheck.rowCount === 0) return notFound(res, sa_code);

    const params = [sa_code, rangeStart, rangeEnd];
    let cursorClause = '';
    if (after_created_at && after_id) {
      params.push(after_created_at, after_id);
      cursorClause = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    params.push(limit);

    const sql = `
      SELECT *
      FROM bras_device_data
      WHERE sa_code = $1
        AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
        ${cursorClause}
      ORDER BY created_at ASC, id ASC
      LIMIT $${params.length}
    `;
    const result = await query(sql, params);

    const last = result.rows[result.rows.length - 1];
    const next_cursor = result.rowCount === limit && last
      ? { created_at: last.created_at, id: last.id }
      : null;

    res.json({
      success: true,
      sa_code,
      count: result.rowCount,
      limit,
      next_cursor,
      data: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

module.exports = router;