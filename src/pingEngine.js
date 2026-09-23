require('dotenv').config();
const ping = require('ping');
const { query } = require('./db');
const saStatusEngine = require('./saStatusEngine');

const PING_INTERVAL_MS     = parseInt(process.env.PING_INTERVAL_MS)     || 30000;
const BATCH_SIZE           = parseInt(process.env.PING_BATCH_SIZE)      || 40;
const COUNTDOWN_THRESHOLD  = parseInt(process.env.COUNTDOWN_THRESHOLD)  || 10;
const PING_TIMEOUT_S       = Math.floor((parseInt(process.env.PING_TIMEOUT_MS) || 3000) / 1000);

const routerState = {};

// ─── Ping a single IP with Windows ICMP (single attempt, no retry) ──────────
async function pingOne(ip) {
  try {
    const res = await ping.promise.probe(ip, {
      timeout: PING_TIMEOUT_S,
      extra: process.platform === 'win32' ? ['-n', '1'] : ['-c', '1'],
    });
    return res.alive;
  } catch {
    return false;
  }
}

// ─── Ping a batch of routers concurrently (1 attempt each) ──────────────────
async function pingBatch(routers) {
  return Promise.all(
    routers.map(async (router) => {
      const alive = await pingOne(router.ip_address);
      return { bts_name: router.bts_name, ip_address: router.ip_address, alive };
    })
  );
}

function updateState(ip, alive) {
  if (!routerState[ip]) {
    routerState[ip] = { upTime: 0, downTime: 0, status: 'Unknown', countdown: 0 };
  }
  const s = routerState[ip];
  let justConfirmed = false;

  if (alive) {
    s.countdown = 0;
    s.status    = 'Up';
    s.upTime   += 30;
    s.downTime  = 0;
  } else {
    const wasBelowThreshold = s.countdown < COUNTDOWN_THRESHOLD;
    if (s.countdown < COUNTDOWN_THRESHOLD) s.countdown += 1;

    if (s.countdown < COUNTDOWN_THRESHOLD) {
      // still in grace period — reported as Up for now
      s.status    = 'Up';
      s.upTime   += 30;
      s.downTime  = 0;
    } else {
      // confirmed down (countdown just hit, or already sitting at, threshold)
      s.status = 'Down';
      s.upTime = 0;

      if (wasBelowThreshold) {

        justConfirmed = true;
        s.downTime = COUNTDOWN_THRESHOLD * 30;
      } else {
        s.downTime += 30;
      }
    }
  }
  return { ...s, justConfirmed };
}


async function get24hSumsForAll() {
  const sql = `
    SELECT
      ip_address,
      COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up24,
      COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down24
    FROM ping_history
    WHERE checked_at >= NOW() - INTERVAL '24 hours'
    GROUP BY ip_address
  `;
  const res = await query(sql);
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.ip_address, {
      up24:   parseInt(row.up24),
      down24: parseInt(row.down24),
    });
  }
  return map;
}

async function getPreGraceSums(ip) {
  const sql = `
    SELECT up_time_last_24h, down_time_last_24h
    FROM ping_history
    WHERE ip_address = $1
    ORDER BY checked_at DESC
    OFFSET $2
    LIMIT 1
  `;
  const res = await query(sql, [ip, COUNTDOWN_THRESHOLD - 1]);
  if (res.rowCount === 0) return { up24: 0, down24: 0 }; // brand-new router, no history yet
  return {
    up24:   parseInt(res.rows[0].up_time_last_24h)   || 0,
    down24: parseInt(res.rows[0].down_time_last_24h) || 0,
  };
}

async function correctGraceWindow(ip, preGrace) {
  const graceRows = COUNTDOWN_THRESHOLD - 1;
  if (graceRows <= 0) return;

  const sql = `
    WITH grace AS (
      SELECT checked_at, ROW_NUMBER() OVER (ORDER BY checked_at DESC) AS rn
      FROM ping_history
      WHERE ip_address = $1
      ORDER BY checked_at DESC
      LIMIT $2
    )
    UPDATE ping_history p
    SET
      status              = 'Down',
      up_time             = 0,
      down_time           = (($2 + 1) - grace.rn) * 30,
      up_time_last_24h    = $3,
      down_time_last_24h  = $4 + (($2 + 1) - grace.rn) * 30
    FROM grace
    WHERE p.ip_address = $1
      AND p.checked_at = grace.checked_at
  `;
  await query(sql, [ip, graceRows, preGrace.up24, preGrace.down24]);
}

function buildBatchUpsertStatus(rows) {
  const cols = [
    'bts_name', 'ip_address', 'up_time', 'down_time',
    'up_time_last_24h', 'down_time_last_24h', 'status', 'countdown',
  ];
  const valuesSql = [];
  const params = [];

  rows.forEach((row, i) => {
    const base = i * cols.length;
    const placeholders = cols.map((_, j) => `$${base + j + 1}`);
    valuesSql.push(`(${placeholders.join(',')}, NOW())`);
    cols.forEach(c => params.push(row[c]));
  });

  const sql = `
    INSERT INTO router_status (${cols.join(',')}, updated_at)
    VALUES ${valuesSql.join(',')}
    ON CONFLICT (ip_address) DO UPDATE SET
      bts_name                  = EXCLUDED.bts_name,
      up_time                   = EXCLUDED.up_time,
      down_time                 = EXCLUDED.down_time,
      up_time_last_24h          = EXCLUDED.up_time_last_24h,
      down_time_last_24h        = EXCLUDED.down_time_last_24h,
      status                    = EXCLUDED.status,
      countdown                 = EXCLUDED.countdown,
      updated_at                = NOW()
  `;
  return { sql, params };
}

// ─── Build one multi-row INSERT for ping_history ─────────────────────────────
function buildBatchInsertHistory(rows, timestamp) {
  const cols = [
    'bts_name', 'ip_address', 'up_time', 'down_time',
    'up_time_last_24h', 'down_time_last_24h', 'status', 'countdown', 'checked_at',
  ];
  const valuesSql = [];
  const params = [];

  rows.forEach((row, i) => {
    const base = i * cols.length;
    const placeholders = cols.map((_, j) => `$${base + j + 1}`);
    valuesSql.push(`(${placeholders.join(',')})`);
    cols.forEach(c => {
      params.push(c === 'checked_at' ? timestamp : row[c]);
    });
  });

  const sql = `INSERT INTO ping_history (${cols.join(',')}) VALUES ${valuesSql.join(',')}`;
  return { sql, params };
}

// ─── Load all routers from DB ────────────────────────────────────────────────
async function loadRouters() {
  const res = await query('SELECT bts_name, ip_address FROM routers ORDER BY id');
  return res.rows;
}

// ─── Main ping cycle ─────────────────────────────────────────────────────────
async function runPingCycle() {
  const cycleStart = Date.now();
  let routers;

  try {
    routers = await loadRouters();
  } catch (err) {
    console.error('[PING ENGINE] Failed to load routers:', err.message);
    return;
  }

  if (routers.length === 0) {
    console.log('[PING ENGINE] No routers found in DB. Waiting...');
    return;
  }

  const cycleTimestamp = new Date();
  console.log(`\n[PING ENGINE] ── Cycle start | ${routers.length} routers | ${cycleTimestamp.toISOString()}`);

  // ── Ping all routers in batches of BATCH_SIZE ──
  const allResults = [];
  for (let i = 0; i < routers.length; i += BATCH_SIZE) {
    const batch = routers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(routers.length / BATCH_SIZE);
    console.log(`[PING ENGINE] Batch ${batchNum}/${totalBatches} | ${batch.length} routers`);
    const results = await pingBatch(batch);
    allResults.push(...results);
  }

  let sums;
  try {
    sums = await get24hSumsForAll();
  } catch (err) {
    console.error('[PING ENGINE] Failed to get 24h sums:', err.message);
    sums = new Map();
  }


  const updated = allResults.map(r => {
    const state = updateState(r.ip_address, r.alive);
    return { ...r, state };
  });
  const justConfirmedIps = updated.filter(u => u.state.justConfirmed).map(u => u.ip_address);

  const preGraceMap = new Map();
  for (const ip of justConfirmedIps) {
    try {
      preGraceMap.set(ip, await getPreGraceSums(ip));
    } catch (err) {
      console.error(`[PING ENGINE] Failed to get pre-grace sums for ${ip}:`, err.message);
      preGraceMap.set(ip, { up24: 0, down24: 0 });
    }
  }

  // ── Build final row objects for this cycle's batch insert ──
  const rows = updated.map(r => {
    const state = r.state;
    let up24h, down24h;

    if (state.justConfirmed) {
      const base = preGraceMap.get(r.ip_address) || { up24: 0, down24: 0 };
      up24h   = base.up24;                              // no Up growth during a down streak
      down24h = base.down24 + COUNTDOWN_THRESHOLD * 30;  // whole confirmed window counted
    } else {
      const sum = sums.get(r.ip_address) || { up24: 0, down24: 0 };
      up24h   = sum.up24   + (state.status === 'Up'   ? 30 : 0);
      down24h = sum.down24 + (state.status === 'Down' ? 30 : 0);
    }

    const symbol = r.alive ? '✔' : '✘';
    const tag = state.justConfirmed ? ' [CONFIRMED DOWN — correcting grace window]' : '';
    console.log(`[PING] ${symbol} ${r.bts_name} (${r.ip_address}) | status=${state.status} | up=${state.upTime}s | down=${state.downTime}s | countdown=${state.countdown}${tag}`);

    return {
      bts_name:           r.bts_name,
      ip_address:         r.ip_address,
      up_time:            state.upTime,
      down_time:          state.downTime,
      up_time_last_24h:   up24h,
      down_time_last_24h: down24h,
      status:             state.status,
      countdown:          state.countdown,
    };
  });

  // ── ONE batch write to router_status ──
  try {
    const { sql, params } = buildBatchUpsertStatus(rows);
    await query(sql, params);
  } catch (err) {
    console.error('════════════════════════════════════════════════════════');
    console.error('[PING ENGINE] router_status batch upsert FAILED:', err.message);
    console.error('[PING ENGINE] This means up_time/down_time/status');
    console.error('[PING ENGINE] were NOT written this cycle for ANY router.');
    console.error('[PING ENGINE] If the error mentions a missing column, run');
    console.error('[PING ENGINE] the latest database/migration_v*.sql files.');
    console.error('════════════════════════════════════════════════════════');
  }

  for (const ip of justConfirmedIps) {
    try {
      const preGrace = preGraceMap.get(ip) || { up24: 0, down24: 0 };
      await correctGraceWindow(ip, preGrace);
      console.log(`[PING ENGINE] Corrected grace window for ${ip} — rows 1-${COUNTDOWN_THRESHOLD - 1} flipped Up→Down`);
    } catch (err) {
      console.error(`[PING ENGINE] Failed to correct grace window for ${ip}:`, err.message);
    }
  }

  // ── ONE batch write to ping_history (this cycle's row for every router) ──
  try {
    const { sql, params } = buildBatchInsertHistory(rows, cycleTimestamp);
    await query(sql, params);
  } catch (err) {
    console.error('[PING ENGINE] Batch insert (ping_history) failed:', err.message);
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  const extraWrites = justConfirmedIps.length;
  console.log(`[PING ENGINE] ── Cycle done in ${elapsed}s (2 DB writes${extraWrites ? ` + ${extraWrites} correction write(s)` : ''})\n`);

  // ── Sync sa_status (fixed snapshot: router down + UPS system down
  //    per site) using this cycle's fresh router_status ──
  await saStatusEngine.sync();
}

// ─── Start the engine ────────────────────────────────────────────────────────
async function start() {
  console.log('[PING ENGINE] Starting...');
  console.log(`  Interval           : ${PING_INTERVAL_MS / 1000}s`);
  console.log(`  Batch size         : ${BATCH_SIZE} routers`);
  console.log(`  Countdown threshold: ${COUNTDOWN_THRESHOLD} cycles (= ${(COUNTDOWN_THRESHOLD * PING_INTERVAL_MS) / 1000}s to confirm Down)`);
  console.log(`  Ping timeout       : ${PING_TIMEOUT_S}s per ping`);
  console.log(`  Retroactive correction: ON — grace window rows get corrected Up→Down when confirmed`);

  await runPingCycle();

  setInterval(async () => {
    try {
      await runPingCycle();
    } catch (err) {
      console.error('[PING ENGINE] Cycle error:', err.message);
    }
  }, PING_INTERVAL_MS);
}

module.exports = { start };

if (require.main === module) {
  const { testConnection } = require('./db');
  testConnection().then(ok => {
    if (!ok) process.exit(1);
    start();
  });
}