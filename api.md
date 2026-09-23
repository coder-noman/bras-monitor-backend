════════════════════════════════════════════════════════════
 ROUTER / PING MONITORING  (unchanged — pingEngine + pingWorker)
════════════════════════════════════════════════════════════

Router CRUD & Status
GET    http://localhost:3001/api/routers
POST   http://localhost:3001/api/routers
GET    http://localhost:3001/api/routers/10.200.205.162
PUT    http://localhost:3001/api/routers/10.200.205.162
DELETE http://localhost:3001/api/routers/10.200.205.162
GET    http://localhost:3001/api/routers/status/up
GET    http://localhost:3001/api/routers/status/down
GET    http://localhost:3001/api/routers/10.200.205.162/history
GET    http://localhost:3001/api/routers/10.200.205.162/history?limit=500&page=2
GET    http://localhost:3001/api/routers/10.200.205.162/last-events
GET    http://localhost:3001/api/routers/10.200.205.162/last-events?limit=50&page=1

Analytics & Reporting
GET http://localhost:3001/api/analytics/all?period=1d
GET http://localhost:3001/api/analytics/all?period=7d
GET http://localhost:3001/api/analytics/all?period=30d

GET http://localhost:3001/api/analytics/summary/10.200.205.162?period=1d
GET http://localhost:3001/api/analytics/summary/10.200.205.162?period=7d
GET http://localhost:3001/api/analytics/summary/10.200.205.162?period=30d

For Excel Report
GET http://localhost:3001/api/analytics/report/excel/1d
GET http://localhost:3001/api/analytics/report/excel/7d
GET http://localhost:3001/api/analytics/report/excel/30d

Date Wise Analytics
GET http://localhost:3001/api/analytics/date/2026-06-16
GET http://localhost:3001/api/analytics/date/2026-06-16/10.200.205.2
GET http://localhost:3001/api/analytics/range/all?start=2026-06-27&end=2026-07-01
GET http://localhost:3001/api/analytics/range/10.200.205.2?start=2026-06-15&end=2026-06-16
GET http://localhost:3001/api/analytics/yesterday

Date Wise Analytics Excel report
GET http://localhost:3001/api/analytics/date/2026-06-28/excel
GET http://localhost:3001/api/analytics/date/2026-06-28/10.200.106.210/excel
GET http://localhost:3001/api/analytics/range/all/excel?start=2026-06-27&end=2026-07-01
GET http://localhost:3001/api/analytics/range/10.200.106.210/excel?start=2026-06-29&end=2026-07-01
GET http://localhost:3001/api/analytics/yesterday/excel

Month wise Analytics
GET http://localhost:3001/api/analytics/monthly/all?month=2026-06
GET http://localhost:3001/api/analytics/monthly/10.200.205.162?month=2026-06
GET http://localhost:3001/api/analytics/monthly-range/10.200.205.162?start=2026-01&end=2026-06

Router update table (external push)
GET  http://localhost:3001/api/router-update
GET  http://localhost:3001/api/router-update/10.200.205.2
POST http://localhost:3001/api/router-update   { "ip_address": "10.200.205.2", "status": 1 }

System
GET http://localhost:3001/health


════════════════════════════════════════════════════════════
 SA / BRAS POWER MONITORING  (from sa_monitor — src/wsBrasWorker.js
 + src/statusEngine.js ingest via WebSocket; run with `npm run socket`)
════════════════════════════════════════════════════════════

SA (Site Profile) CRUD
GET    http://localhost:3001/api/sa
POST   http://localhost:3001/api/sa
GET    http://localhost:3001/api/sa/bras1
PUT    http://localhost:3001/api/sa/bras1
PATCH  http://localhost:3001/api/sa/bras1
DELETE http://localhost:3001/api/sa/bras1

Devices — Site List & Current Status
GET http://localhost:3001/api/devices
GET http://localhost:3001/api/devices/bras1/current-status

Devices — Component Events (PDB / UPS1 / UPS2)
GET http://localhost:3001/api/devices/bras1/pdb-events
GET http://localhost:3001/api/devices/bras1/ups1-events
GET http://localhost:3001/api/devices/bras1/ups2-events
GET http://localhost:3001/api/devices/bras1/ups1-events?from=2026-09-01&to=2026-09-30
GET http://localhost:3001/api/devices/bras1/ups1-events?limit=50&page=1

Devices — Live Summary Dashboard
GET http://localhost:3001/api/devices/live-summary
GET http://localhost:3001/api/devices/live-summary?component=PDB
GET http://localhost:3001/api/devices/live-summary?component=UPS1
GET http://localhost:3001/api/devices/live-summary?component=UPS2

Devices — Raw Data (date/time range, cursor-paginated)
GET http://localhost:3001/api/devices/bras1/raw?start_date=2026-09-01&end_date=2026-09-13
GET http://localhost:3001/api/devices/bras1/raw?start_date=2026-09-01&end_date=2026-09-13&start_time=09:00:00&end_time=18:00:00
GET http://localhost:3001/api/devices/bras1/raw?start_date=2026-09-01&end_date=2026-09-13&limit=500
GET http://localhost:3001/api/devices/bras1/raw?start_date=2026-09-01&end_date=2026-09-13&limit=500&after_created_at=2026-09-05T14:22:10.000Z&after_id=184223

Devices — System-wide power status (derived from UPS1/UPS2 only)
GET http://localhost:3001/api/devices/system-down
GET http://localhost:3001/api/devices/bras1/system-power-events?from=&to=&page=&limit=

sa-down 
http://localhost:3001/api/sa-status
http://localhost:3001/api/sa-status/Link3-SA00001
http://localhost:3001/api/sa-status/Link3-SA00001/events

Status values reference (PDB / UPS1 / UPS2):
UP           -> component exists, reading > 0
DOWN         -> component exists, reading = 0
NOT_PRESENT  -> component doesn't exist on this BRAS (NULL in the feed)
(No overall combined "system" status besides system-power-events, which
is UPS1/UPS2 only — PDB never factors into it.)

POST / PUT / PATCH Examples (request body)

Add a site:
POST http://localhost:3001/api/sa
Content-Type: application/json
{
  "sa_code": "bras1",
  "sa_name": "Gulshan BRAS Site",
  "battery_system": "48V VRLA",
  "batt1_volt": 12, "batt1_amp": 100, "batt1_qty": 4,
  "batt2_volt": 12, "batt2_amp": 100, "batt2_qty": 4,
  "batt3_volt": 12, "batt3_amp": 100, "batt3_qty": 4,
  "ups1_name": "APC Smart-UPS", "ups1_capacity": 3000, "ups1_qty": 1,
  "ups2_name": "APC Smart-UPS", "ups2_capacity": 3000, "ups2_qty": 1,
  "ups3_name": "APC Smart-UPS", "ups3_capacity": 3000, "ups3_qty": 1,
  "solar1_capcity": 330, "solar1_qty": 10,
  "solar2_capcity": 330, "solar2_qty": 10,
  "solar3_capcity": 330, "solar3_qty": 10
}

Update one field only (PATCH):
PATCH http://localhost:3001/api/sa/bras1
Content-Type: application/json
{ "ups2_qty": 2 }

Delete a site:
DELETE http://localhost:3001/api/sa/bras1

Response reference — GET /api/devices/:sa_code/ups1-events
{
  "success": true, "sa_code": "bras1", "component": "UPS1",
  "total": 12, "page": 1, "limit": 300, "pages": 1,
  "events": [
    { "id": 42, "sa_code": "bras1", "component": "UPS1", "status": "DOWN",
      "up_time": 0, "down_time": 720,
      "start_time": "2026-09-13T09:40:00.000Z", "end_time": null, "ongoing": true }
  ]
}
up_time / down_time are stored, live-updated values — refreshed on every
incoming reading while the event is still open. Not recalculated at query time.

Response reference — GET /api/devices/live-summary?component=PDB
{
  "success": true, "component": "PDB", "count": 160,
  "total_up": 152, "total_down": 8,
  "data": [
    { "sa_code": "bras1", "sa_name": "Gulshan BRAS Site", "status": "UP",
      "up_second": 420, "down_second": 0, "up_24h": 82340, "down_24h": 1660,
      "last_seen_at": "2026-09-13T09:58:00.000Z", "batt1": 190.5 }
  ]
}

Response reference — GET /api/devices/:sa_code/raw (cursor pagination)
{
  "success": true, "sa_code": "bras1", "count": 500, "limit": 500,
  "next_cursor": { "created_at": "2026-09-05T14:22:10.000Z", "id": 184223 },
  "data": [ "... rows in chronological order, all 83 raw columns ..." ]
}
next_cursor is null once you've reached the end of the requested range.
Pass next_cursor.created_at / next_cursor.id back as after_created_at /
after_id to get the next page. start_date and end_date are required
(YYYY-MM-DD). start_time/end_time default to 00:00:00 / 23:59:59.
limit defaults to 500, capped at 1000 per call.
