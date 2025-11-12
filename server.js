// server.js — UDP → SQLite enrichment → WebSocket + Events + daily rotation + unknown logging

import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import Database from "better-sqlite3";
import controllerRouter from "./controller.js";

/* =========================
   Config
   ========================= */
const UDP_PORT   = 5555;                       // UDP input (dumpvdl2)
const WS_PORT    = 8080;                       // WebSocket server
const HTTP_PORT  = 3000;                       // Express static/API
const LOG_DIR    = "/var/log/vdl2";            // Daily JSONL logs dir
const LOG_PREFIX = "received";
const KEEP_DAYS  = 7;                          // Retain daily logs
const DB_PATH    = path.join(process.cwd(), "aircraft.db"); // <- ensure correct path

// Logs for unknown ICAOs (one file per day)
const UNKNOWN_DIR = "/var/www/localhost/logs";

// Debug toggle for lookup logging
const DEBUG_LOOKUPS = true;

/* =========================
   Utilities
   ========================= */
const pad2 = (n) => n.toString().padStart(2, "0");
const dateStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const logPathFor = (dStr) => path.join(LOG_DIR, `${LOG_PREFIX}-${dStr}.jsonl`);

// Normalize ICAO to your DB style: 6 chars, lowercase, zero-padded
function normalizeHex(raw) {
  return (raw ?? "")
    .toString()
    .trim()
    .replace(/[^0-9a-fA-F]/g, "")
    .padStart(6, "0")
    .toLowerCase();
}

/* =========================
   Daily rotation for JSONL
   ========================= */
fs.mkdirSync(LOG_DIR, { recursive: true });
let currentDate = dateStamp();
let SAVE_FILE   = logPathFor(currentDate);
const LATEST_LINK = path.join(LOG_DIR, `${LOG_PREFIX}-latest.jsonl`);

function updateLatestSymlink() {
  try { try { fs.unlinkSync(LATEST_LINK); } catch(_) {}
    fs.symlinkSync(SAVE_FILE, LATEST_LINK);
  } catch(_) {}
}

function pruneOldLogs() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.startsWith(`${LOG_PREFIX}-`) || !f.endsWith(".jsonl")) continue;
      const m = f.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const t = new Date(`${m[1]}T00:00:00Z`).getTime();
      if (t < cutoff) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch (_) {}
}

function rotateIfNeeded() {
  const today = dateStamp();
  if (today !== currentDate) {
    currentDate = today;
    SAVE_FILE = logPathFor(today);
    try { fs.appendFileSync(SAVE_FILE, ""); } catch(_) {}
    updateLatestSymlink();
    pruneOldLogs();
    console.log(`🗓️  Rotated log to ${SAVE_FILE}`);
  }
}
setInterval(rotateIfNeeded, 30_000);

/* =========================
   Unknown ICAO logging
   ========================= */
fs.mkdirSync(UNKNOWN_DIR, { recursive: true });
const unknownCache = new Set(); // avoid repeated lines per runtime

function logUnknownHex(hex) {
  if (!hex) return;
  if (unknownCache.has(hex)) return;
  unknownCache.add(hex);

  const today = dateStamp();
  const p = path.join(UNKNOWN_DIR, `unknown_hex_${today}.log`);
  const line = `${new Date().toISOString()} ${hex} — not found in DB\n`;
  try { fs.appendFileSync(p, line); }
  catch (err) { console.error("❌ Failed to log unknown:", err.message); }
}

/* =========================
   SQLite setup (new schema)
   ========================= */
let db;
try {
  db = new Database(DB_PATH, { readonly: true });
  console.log(`🗃️  Opened SQLite DB: ${DB_PATH}`);
} catch (err) {
  console.error("❌ SQLite open error:", err.message);
  process.exit(1);
}

// Prepared statement — case-sensitive match (we normalize input already)
const stmtLookup = db.prepare(`
  SELECT icao, reg, icaotype, year, manufacturer, model,
         ownop, faa_pia, faa_ladd, short_type, mil
  FROM aircraft
  WHERE icao = ?
`);

/* =========================
   Express + WebSocket
   ========================= */
const app = express();
app.use(cors());
app.use(express.static(path.join(process.cwd(), "public")));
app.use("/api", controllerRouter);

const wss = new WebSocketServer({ port: WS_PORT }, () =>
  console.log(`🔌 WebSocket server: ws://localhost:${WS_PORT}`)
);
app.listen(HTTP_PORT, () =>
  console.log(`🌐 HTTP server at http://localhost:${HTTP_PORT}`)
);

/* =========================
   Events aggregation
   ========================= */
let totalPackets = 0;
const uniqueHex = new Set();
const uniqueFlights = new Set();
const topOwners = new Map();
const topModels = new Map();
let timeline = [];

function incMap(map, key) { map.set(key, (map.get(key) || 0) + 1); }

function updateStats(pkt) {
  totalPackets++;
  const hex = pkt.vdl2?.avlc?.src?.addr ? normalizeHex(pkt.vdl2.avlc.src.addr) : "";
  const flight = pkt.vdl2?.avlc?.acars?.flight || "";
  const owner = pkt.db?.ownop || "Unknown";
  const model = pkt.db?.icaotype || "Unknown";

  if (hex) uniqueHex.add(hex);
  if (flight) uniqueFlights.add(flight);

  incMap(topOwners, owner);
  incMap(topModels, model);

  const key = new Date().toISOString().slice(0, 16); // per-minute bucket
  let bucket = timeline.length && timeline[timeline.length - 1].time === key
    ? timeline[timeline.length - 1]
    : null;
  if (!bucket) {
    bucket = { time: key, count: 0 };
    timeline.push(bucket);
    if (timeline.length > 1440) timeline.shift(); // last 24h
  }
  bucket.count++;
}

const eventsRouter = express.Router();
eventsRouter.get("/summary", (req, res) => {
  const topO = [...topOwners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([owner, count]) => ({ owner, count }));
  const topM = [...topModels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([model, count]) => ({ model, count }));

  res.json({
    totalPackets,
    uniqueAircraft: uniqueHex.size,
    uniqueFlights: uniqueFlights.size,
    topOwners: topO,
    topModels: topM,
  });
});
eventsRouter.get("/timeline", (req, res) => {
  res.json(timeline.slice(-120)); // last 2 hours
});
app.use("/api/events", eventsRouter);

/* =========================
   UDP → Enrich → Log → WS
   ========================= */
const udp = dgram.createSocket("udp4");
udp.bind(UDP_PORT, () => console.log(`🛰️  UDP listener on ${UDP_PORT}`));

// Log one lookup line per ICAO per runtime (to avoid spam)
const lookupSeen = new Set();

udp.on("message", (msg) => {
  rotateIfNeeded();

  const text = msg.toString().trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error("Invalid JSON:", err.message);
    return;
  }

  const vdl2 = parsed?.vdl2 || {};
  const rawHex = vdl2?.avlc?.src?.addr ?? "";
  const hex = normalizeHex(rawHex);

  let enriched = {};
  if (hex) {
    try {
      const row = stmtLookup.get(hex);
      if (row) {
        enriched = {
          reg:         row.reg || "",
          icaotype:    row.icaotype || "",
          year:        row.year || "",
          manufacturer:row.manufacturer || "",
          model:       row.model || "",
          ownop:       row.ownop || "",
          short_type:  row.short_type || "",
          mil:        !!row.mil,
          faa_pia:    !!row.faa_pia,
          faa_ladd:   !!row.faa_ladd,
        };
        if (DEBUG_LOOKUPS && !lookupSeen.has(hex)) {
          lookupSeen.add(hex);
          console.log(`✅ DB match for ${hex} → reg:${enriched.reg} type:${enriched.icaotype} owner:${enriched.ownop}`);
        }
      } else {
        if (DEBUG_LOOKUPS && !lookupSeen.has(hex)) {
          lookupSeen.add(hex);
          console.log(`❔ No DB match for ${hex}`);
        }
        logUnknownHex(hex);
      }
    } catch (err) {
      console.error("DB lookup error for", hex, "→", err.message);
    }
  } else {
    if (DEBUG_LOOKUPS) console.log("ℹ️ Packet without src.addr — skipping DB lookup");
  }

  const outObj = {
    ...parsed,
    db: enriched,
    timestamp_iso: vdl2?.t?.sec
      ? new Date(vdl2.t.sec * 1000).toISOString()
      : new Date().toISOString(),
  };

  // Append to daily JSONL
  try {
    fs.appendFileSync(SAVE_FILE, JSON.stringify(outObj) + "\n");
  } catch (err) {
    console.error("❌ Failed writing daily log:", err.message);
  }

  // Update in-memory stats
  updateStats(outObj);

  // Broadcast to WebSocket clients
  const payload = JSON.stringify(outObj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
});
