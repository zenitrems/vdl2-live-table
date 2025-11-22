// controller.js — Diagnostic version for dumpvdl2 control
import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const router = express.Router();

// ========== CONFIG ==========
const DUMPVDL2_PATH = "/usr/local/bin/dumpvdl2";
const LOG_DIR = "/var/log/vdl2";
const LOG_FILE = path.join(LOG_DIR, "dumpvdl2.log");

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ========== STATE ==========
let proc = null;
let startTime = null;
let lastCmd = "";
let logBuffer = "";

// ========== HELPERS ==========
function appendLog(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}\n`;
  console.log(entry.trim());
  logBuffer += entry;
  fs.appendFileSync(LOG_FILE, entry);
  const lines = logBuffer.split("\n");
  if (lines.length > 5000) logBuffer = lines.slice(-5000).join("\n");
}

function safeJson(res, obj, status = 200) {
  res.status(status).json(obj);
}

// Middleware: log all requests
router.use((req, res, next) => {
  appendLog(`HTTP ${req.method} ${req.originalUrl}`);
  next();
});

// ========== ROUTES ==========

// START
router.post("/start", express.json(), (req, res) => {
  appendLog("Received /api/start request");

  if (proc) {
    appendLog("dumpvdl2 already running, PID " + proc.pid);
    return safeJson(res, { running: true, pid: proc.pid });
  }

  // Verify binary path
  if (!fs.existsSync(DUMPVDL2_PATH)) {
    appendLog("ERROR: dumpvdl2 binary not found at " + DUMPVDL2_PATH);
    return safeJson(res, { error: "Binary not found" }, 500);
  }

  const cfg = req.body || {};
  const args = [];

  const outType = cfg["output.type"] || "udp";
  const outFormat = cfg["output.format"] || "json";
  const outWhat = cfg["output.what"] || "decoded";

  if (outType === "udp") {
    const address = cfg["output.udp.address"] || "localhost";
    const port = cfg["output.udp.port"] || "5555";
    args.push("--output", `${outWhat}:${outFormat}:udp:address=${address},port=${port}`);
  } else {
    args.push("--output", `${outWhat}:${outFormat}:file:path=/tmp/dumpvdl2.jsonl,rotate=daily`);
  }

  if (cfg["source"] === "rtlsdr") {
    args.push("--rtlsdr", cfg["rtlsdr.deviceId"] || "0");
    if (cfg["rtlsdr.gain"]) args.push("--gain", cfg["rtlsdr.gain"]);
  } else if (cfg["source"] === "iq-file") {
    args.push("--iq-file", cfg["iqFile.path"] || "/tmp/test.iq");
  }

  args.push(cfg["frequencies"] || "136.975M");
  if (cfg["decodeFragments"]) args.push("--decode-fragments");
  if (cfg["utc"]) args.push("--utc");

  lastCmd = `${DUMPVDL2_PATH} ${args.join(" ")}`;
  appendLog("Attempting spawn: " + lastCmd);

  try {
    proc = spawn(DUMPVDL2_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    startTime = Date.now();

    appendLog(`Spawned dumpvdl2, PID ${proc.pid}`);

    proc.stdout.on("data", (data) => appendLog("[OUT] " + data.toString().trim()));
    proc.stderr.on("data", (data) => appendLog("[ERR] " + data.toString().trim()));
    proc.on("exit", (code, signal) => {
      appendLog(`dumpvdl2 exited (code=${code}, signal=${signal})`);
      proc = null;
    });

    return safeJson(res, { status: "starting", pid: proc.pid, command: lastCmd });
  } catch (err) {
    appendLog("SPAWN ERROR: " + err.message);
    return safeJson(res, { error: err.message }, 500);
  }
});

// STOP
router.post("/stop", (req, res) => {
  appendLog("Received /api/stop request");
  if (proc) {
    appendLog("Stopping dumpvdl2...");
    proc.kill("SIGTERM");
    proc = null;
  }
  return safeJson(res, { status: "stopped" });
});

// STATUS
router.get("/status", (req, res) => {
  safeJson(res, {
    running: !!proc,
    pid: proc?.pid || null,
    uptime: proc ? `${((Date.now() - startTime) / 1000).toFixed(0)}s` : "-",
    command: lastCmd,
  });
});

// LOGS
router.get("/logs", (req, res) => {
  res.type("text/plain").send(logBuffer || "(no logs yet)");
});

export default router;

