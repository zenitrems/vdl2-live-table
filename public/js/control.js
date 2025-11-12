// control.js — Front-end controller for dumpvdl2 management
// Works with controller.js router mounted at /api

const API_BASE = "/api";

const statusText = document.getElementById("statusText");
const pidEl = document.getElementById("pid");
const uptimeEl = document.getElementById("uptime");
const cmdEl = document.getElementById("cmd");
const logView = document.getElementById("logView");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const saveBtn = document.getElementById("saveBtn");

// ================================
// Helper functions
// ================================
async function apiRequest(endpoint, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    alert("API error: " + err.message);
    console.error("API request failed:", err);
    throw err;
  }
}

async function refreshStatus() {
  try {
    const data = await apiRequest("/status");
    statusText.textContent = data.running ? "🟢 Running" : "🔴 Stopped";
    pidEl.textContent = data.pid || "-";
    uptimeEl.textContent = data.uptime || "-";
    cmdEl.textContent = data.command || "";
  } catch (err) {
    console.error("Failed to get status:", err);
  }
}

async function refreshLogs() {
  try {
    const res = await fetch(`${API_BASE}/logs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    logView.textContent = text || "(no logs yet)";
    logView.scrollTop = logView.scrollHeight;
  } catch (err) {
    console.error("Failed to fetch logs:", err);
  }
}

// ================================
// Form serialization
// ================================
function formToObject(form) {
  const obj = {};
  const formData = new FormData(form);
  for (const [key, val] of formData.entries()) {
    if (obj[key] !== undefined) {
      // handle multi-values
      if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
      obj[key].push(val);
    } else {
      obj[key] = val;
    }
  }

  // checkboxes must be handled manually
  form.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    obj[cb.name] = cb.checked;
  });

  return obj;
}

// ================================
// Button actions
// ================================
startBtn.addEventListener("click", async () => {
  const form = document.getElementById("configForm");
  const body = formToObject(form);
  console.log("Sending start with config:", body);
  try {
    const res = await apiRequest("/start", "POST", body);
    console.log("Start response:", res);
    await refreshStatus();
    await refreshLogs();
  } catch (err) {
    console.error("Start failed:", err);
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await apiRequest("/stop", "POST");
    await refreshStatus();
    await refreshLogs();
  } catch (err) {
    console.error("Stop failed:", err);
  }
});

saveBtn.addEventListener("click", async () => {
  const form = document.getElementById("configForm");
  const body = formToObject(form);
  localStorage.setItem("dumpvdl2Settings", JSON.stringify(body));
  alert("Settings saved locally.");
});

// ================================
// Persist settings
// ================================
window.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("dumpvdl2Settings");
  if (saved) {
    try {
      const cfg = JSON.parse(saved);
      for (const [k, v] of Object.entries(cfg)) {
        const el = document.querySelector(`[name="${k}"]`);
        if (!el) continue;
        if (el.type === "checkbox") el.checked = v;
        else el.value = v;
      }
    } catch (err) {
      console.warn("Failed to restore settings:", err);
    }
  }

  // show/hide parameter blocks
  const outputTypeSel = document.getElementById("outputType");
  const udpParams = document.getElementById("udpParams");
  const fileParams = document.getElementById("fileParams");
  const updateOutputParams = () => {
    if (outputTypeSel.value === "udp") {
      udpParams.style.display = "block";
      fileParams.style.display = "none";
    } else {
      udpParams.style.display = "none";
      fileParams.style.display = "block";
    }
  };
  outputTypeSel.addEventListener("change", updateOutputParams);
  updateOutputParams();

  refreshStatus();
  refreshLogs();
  setInterval(refreshStatus, 5000);
  setInterval(refreshLogs, 8000);
});

