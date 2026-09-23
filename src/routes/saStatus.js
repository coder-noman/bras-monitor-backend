const express = require('express');
const router = express.Router();
const { query } = require('../db');

function serverError(res, err) {
  console.error('[SA STATUS API]', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
}

// ══════════════════════════════════════════════════════════
//  GET /api/sa-status
//  Only currently-down sites — router_status = 'Down' OR
//  system_status = 'DOWN'. Fixed live snapshot, one row per site
//  (like router_status) — router_status/router_down_start/
//  router_down_time mirrors that site's router; system_status/
//  system_down_start/system_down_time mirrors UPS1+UPS2 combined.
//  Maintained by src/saStatusEngine.js on the ping engine's 30s cycle.
// ══════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM sa_status
       WHERE router_status = 'Down' OR system_status = 'DOWN'
       ORDER BY sa_code`
    );
    const router_down   = result.rows.filter(r => r.router_status === 'Down').length;
    const system_down   = result.rows.filter(r => r.system_status === 'DOWN').length;
    res.json({
      success: true,
      count: result.rowCount,
      router_down,
      system_down,
      data: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

// GET /api/sa-status/:sa_code
router.get('/:sa_code', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM sa_status WHERE sa_code = $1`, [req.params.sa_code]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: `No sa_status row for sa_code '${req.params.sa_code}' yet` });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/sa-status/:sa_code/events?from=&to=&page=&limit=
//  Closed RCA episode history — TRANSMISSION_DOWN / POWER_DOWN,
//  most recent first. Only complete (closed) episodes, same shape
//  as your other event endpoints. Maintained by
//  src/saStatusEngine.js's reconcileRCA(), on the ping engine's 30s
//  cycle.
// ══════════════════════════════════════════════════════════
router.get('/:sa_code/events', async (req, res) => {
  const { sa_code } = req.params;
  const { from, to } = req.query;
  const limit  = parseInt(req.query.limit) || 300;
  const page   = parseInt(req.query.page)  || 1;
  const offset = (page - 1) * limit;

  try {
    const params = [sa_code];
    let where = 'sa_code = $1';
    if (from) { params.push(from); where += ` AND start_time >= $${params.length}`; }
    if (to)   { params.push(to);   where += ` AND start_time <= $${params.length}`; }

    const countRes = await query(`SELECT COUNT(*) AS total FROM sa_events WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0].total);

    const sql = `
      SELECT id, sa_code, status, start_time, end_time, down_time
      FROM sa_events
      WHERE ${where}
      ORDER BY start_time DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const result = await query(sql, [...params, limit, offset]);

    res.json({
      success: true, sa_code,
      total, page, limit, pages: Math.ceil(total / limit),
      events: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

module.exports = router;