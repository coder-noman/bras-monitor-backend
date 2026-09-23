require('dotenv').config();
const WebSocket = require('ws');
const { query, testConnection } = require('./db');
const { preloadStatusEngine, processReading } = require('./statusEngine');

const WS_URL = process.env.BRAS_WS_URL || 'ws://27.147.170.162:81';
const SA_CACHE_REFRESH_MS = parseInt(process.env.BRAS_SA_CACHE_REFRESH_MS) || 60000;
const RECONNECT_DELAY_MS = 5000;

// Order MUST match the comma-separated values in the feed, exactly.
// A doubled comma in the feed (an empty value between two commas)
// parses to NULL for numeric fields below.
//
// Feed header (v2, post migration_2):
// pdb,ups1,ups2,Batt_Volt_1,Batt_Volt_2,Batt_Curr_1,Batt_Curr_2,
// Solar_Volt,Solar_Curr,Temp1,Temp2,Hum1,Hum2,water1,water2,
// AC_Curr_1,AC_Curr_2,AC_Curr_3,AC_Curr_4,cb1,cb2,cb3,cb4,
// Fire1,Fire2,Smoke1,Smoke2,Human_Presence_1,Human_Presence_2,
// Door_Lock,Generator,Internal_Batt,PSU1,PSU2,
// operator,signal_strength,Active,Server1,Server2,Data_counter
const FIELDS = [
  'pdb', 'ups1', 'ups2',
  'batt_volt_1', 'batt_volt_2',
  'batt_curr_1', 'batt_curr_2',
  'solar_volt', 'solar_curr',
  'temp1', 'temp2',
  'hum1', 'hum2',
  'water1', 'water2',
  'ac_curr_1', 'ac_curr_2', 'ac_curr_3', 'ac_curr_4',
  'cb1', 'cb2', 'cb3', 'cb4',
  'fire1', 'fire2',
  'smoke1', 'smoke2',
  'human_presence_1', 'human_presence_2',
  'door_lock',
  'generator',
  'internal_batt',
  'psu1', 'psu2',
  'operator', 'signal_strength', 'active', 'server1', 'server2', 'data_counter',
];

// Non-numeric fields are stored as raw strings. Everything else is
// parsed with parseFloat; an empty string (from a doubled comma)
// or a non-numeric token becomes NULL.
const STRING_FIELDS = new Set(['operator', 'active']);
const NUMERIC_FIELDS = new Set(FIELDS.filter(f => !STRING_FIELDS.has(f)));

// { [sa_code]: sa_name }
let knownSa = new Map();

// ── Keep the sa_list cache fresh without hitting the DB per message ──
async function refreshSaCache() {
  try {
    const res = await query('SELECT sa_code, sa_name FROM sa_list');
    knownSa = new Map(res.rows.map(r => [r.sa_code, r.sa_name]));
    console.log(`[BRAS WS] SA cache refreshed — ${knownSa.size} known sa_code(s)`);
  } catch (err) {
    console.error('[BRAS WS] Failed to refresh sa_list cache:', err.message);
  }
}

// ── Parse "bras1:220,120,220,...,gra,4.3,192.168.10.235,1,70" -> { sa_code, ...fields } ──
// A doubled comma ("120,,220") leaves an empty string in that slot,
// which becomes NULL for numeric fields — this is how a component
// that doesn't exist on a given BRAS (e.g. no UPS2) reports itself.
function parseMessage(raw) {
  const sepIdx = raw.indexOf(':');
  if (sepIdx === -1) return null;

  const sa_code = raw.slice(0, sepIdx).trim();
  const parts = raw.slice(sepIdx + 1).split(',').map(v => v.trim());

  if (parts.length !== FIELDS.length) {
    console.warn(`[BRAS WS] Malformed payload for ${sa_code}: expected ${FIELDS.length} values, got ${parts.length}`);
    return null;
  }

  const row = { sa_code };
  FIELDS.forEach((field, i) => {
    const raw_val = parts[i];
    if (NUMERIC_FIELDS.has(field)) {
      if (raw_val === '') {
        row[field] = null;
      } else {
        const n = parseFloat(raw_val);
        row[field] = Number.isNaN(n) ? null : n;
      }
    } else {
      row[field] = raw_val || null;
    }
  });
  return row;
}

// ── Insert the raw reading into bras_device_data (unchanged table) ──
async function insertDeviceData(row) {
  const cols = ['sa_code', ...FIELDS];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO bras_device_data (${cols.join(',')}) VALUES (${placeholders.join(',')})`;
  const params = cols.map(c => row[c]);
  try {
    await query(sql, params);
  } catch (err) {
    console.error(`[BRAS WS] bras_device_data insert failed for ${row.sa_code}:`, err.message);
  }
}

// ── WebSocket connection with auto-reconnect ──────────────────────────────
function connect() {
  console.log(`[BRAS WS] Connecting to ${WS_URL}...`);
  const socket = new WebSocket(WS_URL);

  socket.on('open', () => {
    console.log('[BRAS WS] Connected.');
  });

  socket.on('message', async (data) => {
    const raw = data.toString();
    console.log('[BRAS WS] RAW:', raw);

    const row = parseMessage(raw);
    if (!row) {
      console.log('[BRAS WS] Could not parse this message (wrong format) — skipped.');
      return;
    }

    if (!knownSa.has(row.sa_code)) {
      console.log(`[BRAS WS] sa_code "${row.sa_code}" NOT found in sa_list — skipped.`);
      return;
    }

    const now = new Date();
    await insertDeviceData(row);
    await processReading(row, now);
  });

  socket.on('close', () => {
    console.warn(`[BRAS WS] Connection closed. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  socket.on('error', (err) => {
    console.error('[BRAS WS] Socket error:', err.message);
    socket.close();
  });
}

// ── Graceful shutdown: close every still-open event row ──
async function closeAllOpenEvents() {
  const now = new Date();
  try {
    const r1 = await query(
      `UPDATE status_events
       SET end_time = $1,
           up_time   = CASE WHEN status = 'UP'   THEN EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER ELSE 0 END,
           down_time = CASE WHEN status = 'DOWN' THEN EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER ELSE 0 END
       WHERE end_time IS NULL`,
      [now]
    );
    const r2 = await query(
      `UPDATE system_power_events
       SET end_time = $1,
           up_time   = CASE WHEN status = 'UP'   THEN EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER ELSE 0 END,
           down_time = CASE WHEN status = 'DOWN' THEN EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER ELSE 0 END
       WHERE end_time IS NULL`,
      [now]
    );
    console.log(`[BRAS WS] Closed ${r1.rowCount} open component event(s), ${r2.rowCount} open system power event(s) on shutdown.`);
  } catch (err) {
    console.error('[BRAS WS] Failed to close open events on shutdown:', err.message);
  }
}

async function shutdown(signal) {
  console.log(`\n[BRAS WS] ${signal} received. Closing open events and shutting down gracefully...`);
  await closeAllOpenEvents();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => console.error('[BRAS WS] Uncaught:', err));
process.on('unhandledRejection', err => console.error('[BRAS WS] Unhandled rejection:', err));

async function boot() {
  console.log('═══════════════════════════════════════');
  console.log('  sa_monitor — BRAS Power WS Worker     ');
  console.log('═══════════════════════════════════════');

  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[BRAS WS] Cannot connect to database. Exiting.');
    process.exit(1);
  }

  await refreshSaCache();
  setInterval(refreshSaCache, SA_CACHE_REFRESH_MS);

  await preloadStatusEngine();

  connect();
}

boot();