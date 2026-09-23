// src/routes/sa.js — CRUD for sa_list
//
// sa_list is the master profile of each SA/BRAS site: its code (the
// WebSocket feed's prefix, e.g. "bras1"), display name, and the
// battery/UPS/solar hardware installed there. wsBrasWorker.js only
// ingests readings for sa_codes that exist here.

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

function serverError(res, err) {
  console.error('[SA]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}
function notFound(res, code) {
  return res.status(404).json({ success: false, error: `sa_code '${code}' not found` });
}

// Every editable column besides sa_code itself (sa_code is set once,
// at creation, and never changed — see PUT /:sa_code below).
const EDITABLE_FIELDS = [
  'sa_name',
  'batt_volt', 'batt_curr',
  'solar_volt', 'solar_watt',
  'ups1_capacity', 'ups1_volt',
  'ups2_capacity', 'ups2_volt',
];

// GET /api/sa/full — every sa_list site, LEFT JOINed to its router
// (matched sa_list.sa_code = routers.bts_code). Router fields are
// NULL if no router with that bts_code exists yet.
router.get('/full', async (req, res) => {
  try {
    const sql = `
      SELECT
        s.sa_code, s.sa_name,
        s.batt_volt, s.batt_curr,
        s.solar_volt, s.solar_watt,
        s.ups1_capacity, s.ups1_volt,
        s.ups2_capacity, s.ups2_volt,
        r.bts_name, r.ip_address
      FROM sa_list s
      LEFT JOIN routers r ON r.bts_code = s.sa_code
      ORDER BY s.sa_code
    `;
    const result = await query(sql);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// GET /api/sa/:sa_code/full — one site + its matched router
router.get('/:sa_code/full', async (req, res) => {
  try {
    const sql = `
      SELECT
        s.sa_code, s.sa_name,
        s.batt_volt, s.batt_curr,
        s.solar_volt, s.solar_watt,
        s.ups1_capacity, s.ups1_volt,
        s.ups2_capacity, s.ups2_volt,
        r.bts_name, r.ip_address
      FROM sa_list s
      LEFT JOIN routers r ON r.bts_code = s.sa_code
      WHERE s.sa_code = $1
    `;
    const result = await query(sql, [req.params.sa_code]);
    if (result.rowCount === 0) return notFound(res, req.params.sa_code);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// GET /api/sa — list all
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM sa_list ORDER BY sa_code');
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// GET /api/sa/:sa_code — one
router.get('/:sa_code', async (req, res) => {
  try {
    const result = await query('SELECT * FROM sa_list WHERE sa_code = $1', [req.params.sa_code]);
    if (result.rowCount === 0) return notFound(res, req.params.sa_code);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// POST /api/sa — create. Only sa_code is required; every other field
// (sa_name plus all battery/UPS/solar columns) is optional and can
// be filled in later via PATCH.
router.post('/', async (req, res) => {
  const { sa_code, ...rest } = req.body;
  if (!sa_code) {
    return res.status(400).json({ success: false, error: 'sa_code is required' });
  }

  const cols = ['sa_code'];
  const vals = [sa_code.trim()];
  for (const field of EDITABLE_FIELDS) {
    if (rest[field] !== undefined) {
      cols.push(field);
      vals.push(rest[field]);
    }
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  try {
    const sql = `
      INSERT INTO sa_list (${cols.join(',')}) VALUES (${placeholders.join(',')})
      ON CONFLICT (sa_code) DO NOTHING RETURNING *
    `;
    const result = await query(sql, vals);
    if (result.rowCount === 0) {
      return res.status(409).json({ success: false, error: `sa_code '${sa_code}' already exists` });
    }
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// PUT /api/sa/:sa_code — full replace. Every editable field must be
// supplied; anything omitted is reset to NULL. Use PATCH instead if
// you only want to touch specific fields.
router.put('/:sa_code', async (req, res) => {
  const setClauses = EDITABLE_FIELDS.map((field, i) => `${field} = $${i + 2}`);
  const vals = [req.params.sa_code, ...EDITABLE_FIELDS.map(f => (req.body[f] !== undefined ? req.body[f] : null))];

  try {
    const sql = `
      UPDATE sa_list
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE sa_code = $1
      RETURNING *
    `;
    const result = await query(sql, vals);
    if (result.rowCount === 0) return notFound(res, req.params.sa_code);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// PATCH /api/sa/:sa_code — partial update. Send only the field(s) you
// want to change, e.g. { "batt2_amp": 45.5 } or { "ups1_qty": 2 }.
// Everything else on the row is left untouched.
router.patch('/:sa_code', async (req, res) => {
  const fieldsToUpdate = EDITABLE_FIELDS.filter(f => req.body[f] !== undefined);

  if (fieldsToUpdate.length === 0) {
    return res.status(400).json({
      success: false,
      error: `No editable fields provided. Editable fields: ${EDITABLE_FIELDS.join(', ')}`,
    });
  }

  const setClauses = fieldsToUpdate.map((field, i) => `${field} = $${i + 2}`);
  const vals = [req.params.sa_code, ...fieldsToUpdate.map(f => req.body[f])];

  try {
    const sql = `
      UPDATE sa_list
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE sa_code = $1
      RETURNING *
    `;
    const result = await query(sql, vals);
    if (result.rowCount === 0) return notFound(res, req.params.sa_code);
    res.json({ success: true, updated_fields: fieldsToUpdate, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// DELETE /api/sa/:sa_code
router.delete('/:sa_code', async (req, res) => {
  try {
    const result = await query('DELETE FROM sa_list WHERE sa_code = $1 RETURNING *', [req.params.sa_code]);
    if (result.rowCount === 0) return notFound(res, req.params.sa_code);
    res.json({ success: true, message: `sa_code '${req.params.sa_code}' deleted` });
  } catch (err) { serverError(res, err); }
});

module.exports = router;