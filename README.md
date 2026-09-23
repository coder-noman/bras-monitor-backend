# bras-monitor-backend — Merged Project

**Node.js + Express + TimescaleDB**

This project now combines two previously separate backends:

1. **Router / ping monitoring** (original bras-monitor-backend) — ICMP
   ping engine, ~160 routers, analytics, Excel reports, battery data.
2. **SA / BRAS power monitoring** (merged in from sa_monitor) — PDB /
   UPS1 / UPS2 power status per BRAS site, ingested over a WebSocket
   feed.

The OLD socket-related code that used to live in this project
(`src/wsBrasWorker.js` writing to `bras_power_status` /
`bras_power_events` / `bras_ups_events`, plus `src/routes/brasPower.js`)
has been **removed**. It's been **replaced** with the newer,
better-designed socket pipeline from sa_monitor:
`src/wsBrasWorker.js` (new) + `src/statusEngine.js` +
`src/routes/sa.js` + `src/routes/devices.js`.

---

## Three independent processes

| Process | Command | What it does |
|---|---|---|
| API server | `npm start` / `npm run dev` | Express REST API only — routers, analytics, battery, SA/devices. No engine, no socket. |
| Ping worker | `npm run worker` | ICMP ping engine + nightly scheduler for the ~160 routers. |
| BRAS power socket worker | `npm run socket` | Connects to the BRAS WebSocket feed, ingests PDB/UPS1/UPS2 readings. |

Restarting any one of these never interrupts the other two.

---

## Setup

### 1. Database
```bash
createdb bras_monitor
psql -U postgres -d bras_monitor -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

If this is an **existing** database that still has the old socket
tables (`bras_power_status`, `bras_power_events`, `bras_ups_events`,
`bras_power_history`, or the old 11-column `bras_device_data`), drop
them first:
```bash
psql -U postgres -d bras_monitor -f database/drop_old_bras_tables.sql
```

Then load the full schema (safe to re-run, everything is `IF NOT EXISTS`):
```bash
psql -U postgres -d bras_monitor -f database/schema.sql
```

### 2. Configure environment
Edit `.env` — see the file for `DB_*`, `PING_*`, and `BRAS_WS_URL` /
`BRAS_SA_CACHE_REFRESH_MS`.

### 3. Install & run
```bash
npm install
npm start            # API — terminal 1
npm run worker       # ping engine — terminal 2
npm run socket       # BRAS power socket — terminal 3
```

For production, run all three under PM2:
```bash
npm install -g pm2
pm2 start src/server.js     --name bras-monitor-api
pm2 start src/pingWorker.js --name bras-monitor-ping
pm2 start src/wsBrasWorker.js --name bras-monitor-socket
pm2 save
pm2 startup
```

### 4. Register your SA/BRAS sites
`src/wsBrasWorker.js` only ingests readings for `sa_code`s that
already exist in `sa_list`:
```bash
curl -X POST http://localhost:3001/api/sa -H "Content-Type: application/json" \
  -d '{"sa_code":"bras1","sa_name":"Gulshan BRAS Site"}'
```

---

## API reference
See `api.md` for the full endpoint list (router/ping/analytics/battery
endpoints, and the SA/devices power-monitoring endpoints).

## Database
See `database/schema.sql` for the full consolidated schema (all tables
from both projects) and `database/drop_old_bras_tables.sql` for the
one-time cleanup needed before applying it to a pre-merge database.

## Project structure
```
bras-monitor-backend/
├── src/
│   ├── server.js            ← Express API (routers, analytics, battery, sa, devices)
│   ├── db.js                ← shared DB connection pool
│   ├── pingEngine.js        ← router ICMP ping logic
│   ├── pingWorker.js        ← runs pingEngine.js + scheduler.js as its own process
│   ├── scheduler.js         ← nightly pre-computation
│   ├── statusEngine.js      ← PDB/UPS1/UPS2 status derivation (from sa_monitor)
│   ├── wsBrasWorker.js      ← BRAS WebSocket ingester (from sa_monitor — replaces the old one)
│   ├── utils.js
│   └── routes/
│       ├── routers.js
│       ├── analytics.js
│       ├── routerUpdate.js
│       ├── batteryInfo.js
│       ├── batteryLatestData.js
│       ├── sa.js             ← SA/BRAS site profile CRUD (from sa_monitor)
│       └── devices.js        ← SA/BRAS status & event APIs (from sa_monitor)
├── database/
│   ├── schema.sql                 ← full consolidated schema (run this)
│   └── drop_old_bras_tables.sql   ← run BEFORE schema.sql on an existing DB
├── .env
├── package.json
└── api.md
```
