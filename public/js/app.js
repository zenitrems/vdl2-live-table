// app.js — Live VDL2 feed table with enrichment (new schema) + auto-reconnect + packet rate + clickable ICAOs
// Partial-safe version: re-queries DOM per render/bind so dynamic pages work

// =============================
// Global State
// =============================
let tableData = [];
let ws;
let reconnectDelay = 1000;
let reconnectTimer;

let packetCount = 0;
let packetsThisSecond = 0;
let lastPacketTime = Date.now();
let packetRate = 0;

let showOnlyMil = false; // filter flag

// Small helpers (partial-safe)
const $ = (sel) => document.querySelector(sel);
const byId = (id) => document.getElementById(id);

// =============================
// MIL filter toggle — fully partial-safe
// =============================
function bindMilToggle() {
  const btn = byId("toggleUnkBtn"); // this is the existing button id in your partial
  if (!btn) return; // partial not loaded yet

  if (btn.dataset.bound === "true") return; // prevent re-binding on nav changes
  btn.dataset.bound = "true";

  // initial label
  btn.textContent = showOnlyMil ? "Show all" : "Show only military";

  btn.addEventListener("click", () => {
    showOnlyMil = !showOnlyMil;
    btn.textContent = showOnlyMil ? "Show all" : "Show only military";
    btn.classList.toggle("active", showOnlyMil);
    renderTable();
  });

  console.log("✅ MIL toggle bound");
}

// Try after DOM ready
document.addEventListener("DOMContentLoaded", bindMilToggle);

// Try after each dynamic partial load (your nav should dispatch this)
window.addEventListener("navPageLoaded", bindMilToggle);

// As a last resort, watch for the button to appear dynamically
const milObserver = new MutationObserver(() => bindMilToggle());
milObserver.observe(document.documentElement, { childList: true, subtree: true });

// =============================
// Handle incoming UDP packets
// =============================
function handlePacket(event) {
  try {
    const data = JSON.parse(event.data);
    const vdl2 = data?.vdl2 || {};
    const acars = vdl2?.avlc?.acars || {};
    const text = acars?.msg_text || "";
    const db = data?.db || {};

    // --- Extract core fields ---
    const icao = vdl2?.avlc?.src?.addr?.toUpperCase?.() || "";
    const timestampSec = vdl2?.t?.sec ?? null;
    const timestamp = timestampSec
      ? new Date(timestampSec * 1000)
          .toISOString()
          .replace("T", " ")
          .replace("Z", " UTC")
      : data?.timestamp_iso?.replace("T", " ").replace("Z", " UTC") || "";

    const reg = db.reg || "";
    const icaotype = db.icaotype || "";
    const flight = acars?.flight || "";
    const ownop = db.ownop || "";
    const faa_pia = db.faa_pia ? "✅" : "";
    const faa_ladd = db.faa_ladd ? "✅" : "";
    const mil = db.mil ? "🪖" : ""; // you currently store the string in the row

    // --- Assemble row in the new order (with TXT) ---
    const row = { icao, timestamp, reg, icaotype, flight, ownop, txt: text, faa_pia, faa_ladd, mil };
    tableData.unshift(row);
    if (tableData.length > 500) tableData.pop();

    renderTable();

    // --- Packet rate tracking ---
    const now = Date.now();
    packetsThisSecond++;
    packetCount++;
    if (now - lastPacketTime >= 1000) {
      packetRate = packetsThisSecond / ((now - lastPacketTime) / 1000);
      packetsThisSecond = 0;
      lastPacketTime = now;

      const rateEl = byId("packetRate");
      if (rateEl) rateEl.textContent = `Packets/sec: ${packetRate.toFixed(1)}`;
    }
  } catch (err) {
    console.error("Parse error:", err);
  }
}

// =============================
// WebSocket Connection + Auto-Reconnect
// =============================
function connectWS() {
  ws = new WebSocket("ws://localhost:8080");

  ws.onopen = () => {
    console.log("🟢 WebSocket connected");
    const statusEl = byId("status");
    if (statusEl) statusEl.textContent = "🟢 Connected";
    reconnectDelay = 1000;
  };

  ws.onmessage = handlePacket;

  ws.onerror = (err) => {
    console.error("⚠️ WebSocket error:", err);
    ws.close();
  };

  ws.onclose = () => {
    console.log(`🔴 WebSocket closed, retrying in ${reconnectDelay}ms`);
    const statusEl = byId("status");
    if (statusEl) statusEl.textContent = `🔴 Reconnecting in ${reconnectDelay / 1000}s…`;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

connectWS();

// =============================
// Table Rendering (partial-safe)
// =============================
function renderTable() {
  const tbody = $("#dataTable tbody");          // re-query (partial-safe)
  const searchInput = byId("searchInput");      // re-query (partial-safe)
  if (!tbody) return;

  tbody.innerHTML = "";

  // Filter: show only MIL if toggled (your row.mil is "🪖" or "")
  const filtered = showOnlyMil
    ? tableData.filter((r) => !!r.mil)  // truthy string means MIL
    : tableData;

  // Search
  const query = (searchInput?.value || "").toLowerCase();
  const searched = query
    ? filtered.filter((r) =>
        Object.values(r).some((v) =>
          (v ?? "").toString().toLowerCase().includes(query)
        )
      )
    : filtered;

  // Sort newest first by timestamp string (already ISO-like)
  searched.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  // Build rows
  for (const row of searched) {
    const tr = document.createElement("tr");
    if (row.mil) tr.classList.add("highlight");

    // Cells in order: ICAO (clickable), Timestamp, Reg, ICAO Type, Flight, Ownop, Text
    // ICAO clickable link to ADSB Exchange
    const icaoCell = document.createElement("td");
    if (row.icao) {
      const link = document.createElement("a");
      link.href = `https://globe.adsbexchange.com/?icao=${row.icao}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = row.icao;
      link.classList.add("icaoLink");
      icaoCell.appendChild(link);
    }
    tr.appendChild(icaoCell);

    const values = [
      row.timestamp,
      row.reg,
      row.icaotype,
      row.flight,
      row.ownop,
      row.txt
    ];
    for (const val of values) {
      const td = document.createElement("td");
      td.textContent = val ?? "";
      tr.appendChild(td);
    }

    // Flag cells (PIA, LADD, MIL) as glowing dots via CSS classes
    const piaCell = document.createElement("td");
    if (row.faa_pia) piaCell.classList.add("flag-pia");

    const laddCell = document.createElement("td");
    if (row.faa_ladd) laddCell.classList.add("flag-ladd");

    const milCell = document.createElement("td");
    if (row.mil) milCell.classList.add("flag-mil");

    tr.appendChild(piaCell);
    tr.appendChild(laddCell);
    tr.appendChild(milCell);

    tbody.appendChild(tr);
  }
}

// =============================
// Search handler (partial-safe)
// =============================
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "searchInput") {
    renderTable();
  }
});
