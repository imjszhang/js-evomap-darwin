import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildEarningsApiPayload } from "../../src/earnings-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, "..", "..", "dashboard");
const DASHBOARD_HTML = join(DASHBOARD_DIR, "index.html");
const ASSETS_DIR = join(DASHBOARD_DIR, "assets");

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css",
  ".js": "application/javascript",
};

/** YYYY-MM-DD in local timezone (for event log filenames matching user expectations). */
function localDateYMD(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildHealthPayload(darwin, eventBuffer, upSinceIso, dataDir) {
  const now = Date.now();
  const status = darwin.getStatus();
  const hb = status.heartbeat;
  const lastHeartbeatAge = hb?.timestamp ? now - new Date(hb.timestamp).getTime() : null;

  let lastEvolveAge = null;
  for (let i = eventBuffer.length - 1; i >= 0; i--) {
    if (eventBuffer[i].type === "evolve") {
      lastEvolveAge = now - new Date(eventBuffer[i].timestamp).getTime();
      break;
    }
  }

  let lastFitnessRecordAge = null;
  try {
    const fitPath = join(dataDir, "fitness-log.jsonl");
    const fitRaw = readFileSync(fitPath, "utf-8");
    const fitLines = fitRaw.trim().split("\n").filter(Boolean);
    if (fitLines.length > 0) {
      const last = JSON.parse(fitLines[fitLines.length - 1]);
      if (last.timestamp) lastFitnessRecordAge = now - new Date(last.timestamp).getTime();
    }
  } catch {
    /* no fitness log yet */
  }

  let eventCountToday = 0;
  try {
    const logPath = join(dataDir, `darwin-events-${localDateYMD()}.jsonl`);
    const raw = readFileSync(logPath, "utf-8");
    eventCountToday = raw.trim().split("\n").filter(Boolean).length;
  } catch {
    /* no log for today */
  }

  const genePoolFill = status.geneStore
    ? status.geneStore.size / (status.geneStore.capacity || 200)
    : 0;
  const peerConnections =
    (status.subscription?.subscriptions ?? 0) +
    (status.subscription?.subscribers ?? 0) +
    (status.peerCount ?? 0);

  const TEN_MIN = 10 * 60 * 1000;
  const THIRTY_MIN = 30 * 60 * 1000;
  const EIGHT_H = 8 * 60 * 60 * 1000;
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
  const SEVEN_D = 7 * 24 * 60 * 60 * 1000;

  const checks = {
    heartbeatFresh:
      lastHeartbeatAge !== null && lastHeartbeatAge < TEN_MIN
        ? "ok"
        : lastHeartbeatAge !== null && lastHeartbeatAge < THIRTY_MIN
          ? "warn"
          : "fail",
    evolutionFresh:
      lastEvolveAge !== null && lastEvolveAge < EIGHT_H
        ? "ok"
        : lastEvolveAge !== null && lastEvolveAge < TWENTY_FOUR_H
          ? "warn"
          : "fail",
    fitnessDataFresh:
      lastFitnessRecordAge !== null && lastFitnessRecordAge < TWENTY_FOUR_H
        ? "ok"
        : lastFitnessRecordAge !== null && lastFitnessRecordAge < SEVEN_D
          ? "warn"
          : "fail",
    genePoolHealthy: genePoolFill > 0.1 ? "ok" : genePoolFill > 0.05 ? "warn" : "fail",
    peerConnected: peerConnections > 0 ? "ok" : "fail",
  };

  return {
    upSince: upSinceIso,
    heartbeatService: status.running ? "running" : "stopped",
    lastHeartbeatAge,
    lastEvolveAge,
    lastFitnessRecordAge,
    genePoolFill: Math.round(genePoolFill * 1000) / 1000,
    genePoolSize: status.geneStore?.size ?? 0,
    genePoolCapacity: status.geneStore?.capacity ?? 200,
    peerConnections,
    eventCountToday,
    checks,
  };
}

/**
 * Minimal dashboard server with WebSocket support (no external deps).
 * Uses the raw HTTP upgrade + WebSocket frame protocol.
 */
export function startDashboardServer(darwin, { port = 3777, dataDir = "./data" } = {}) {
  const clients = new Set();
  const upSinceIso = new Date().toISOString();

  const EVENT_BUFFER_MAX = 100;
  const eventBuffer = [];
  let eventIdCounter = 0;

  function pushEvent(type, message) {
    eventIdCounter++;
    eventBuffer.push({ id: eventIdCounter, type, message, timestamp: new Date().toISOString() });
    if (eventBuffer.length > EVENT_BUFFER_MAX) {
      eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_MAX);
    }
  }

  function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(DASHBOARD_HTML, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url.pathname === "/api/events") {
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      sendJson(res, 200, eventBuffer.filter((e) => e.id > since));
      return;
    }

    if (url.pathname === "/api/earnings") {
      void (async () => {
        try {
          const payload = await buildEarningsApiPayload(darwin);
          sendJson(res, 200, payload);
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
      })();
      return;
    }

    if (url.pathname === "/api/health") {
      try {
        sendJson(res, 200, buildHealthPayload(darwin, eventBuffer, upSinceIso, dataDir));
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === "/api/events-log") {
      try {
        const dateStr = url.searchParams.get("date") || localDateYMD();
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
        const typeFilter = url.searchParams.get("type") || "";
        const logPath = join(dataDir, `darwin-events-${dateStr}.jsonl`);

        let events = [];
        try {
          const raw = readFileSync(logPath, "utf-8");
          const lines = raw.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              if (!typeFilter || evt.type === typeFilter) events.push(evt);
            } catch {
              /* skip malformed lines */
            }
          }
        } catch {
          /* file missing */
        }

        const tail = events.slice(-limit);
        sendJson(res, 200, { date: dateStr, total: events.length, events: tail });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname.startsWith("/assets/")) {
      const rel = url.pathname.slice("/assets/".length).split("?")[0];
      const filePath = resolve(ASSETS_DIR, rel);
      if (!filePath.startsWith(ASSETS_DIR) || !existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      const mime = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
      const data = readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=86400",
      });
      res.end(data);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  // Minimal WebSocket handshake + framing (RFC 6455)
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }

    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-5AB5DC525B41")
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));

    // Send initial status
    send(socket, { type: "status", data: darwin.getStatus() });
    send(socket, { type: "genes", data: darwin.store.ranked(15) });
    if (darwin.peers) {
      send(socket, { type: "peers", data: darwin.peers.getPeers() });
    }
  });

  function send(socket, data) {
    const json = JSON.stringify(data);
    const buf = Buffer.from(json, "utf-8");
    const frame = encodeFrame(buf);
    try { socket.write(frame); } catch { /* dead socket */ }
  }

  function broadcast(data) {
    for (const socket of clients) send(socket, data);
  }

  function encodeFrame(payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  // Wire darwin events to WebSocket broadcasts + event buffer
  darwin.on("heartbeat", () => {
    broadcast({ type: "status", data: darwin.getStatus() });
  });
  darwin.on("fetch", (data) => {
    const msg = `Fetched ${data.total} assets, ingested ${data.ingested}`;
    pushEvent("fetch", msg);
    broadcast({ type: "event", data: { type: "fetch", message: msg } });
    broadcast({ type: "genes", data: darwin.store.ranked(15) });
  });
  darwin.on("record", (data) => {
    const msg = `Recorded: ${data.capsuleId?.slice(0, 16)}... fitness=${data.fitness?.toFixed(3) ?? '?'}`;
    pushEvent("record", msg);
    broadcast({ type: "event", data: { type: "record", message: msg } });
    broadcast({ type: "status", data: darwin.getStatus() });
  });
  darwin.on("evolve", () => {
    const status = darwin.getStatus();
    pushEvent("evolve", "Evolution cycle completed");
    broadcast({ type: "status", data: status });
    broadcast({ type: "genes", data: darwin.store.ranked(15) });
    if (darwin.peers) {
      broadcast({ type: "peers", data: darwin.peers.getPeers() });
    }
    if (status.leaderboard && status.leaderboard.length > 0) {
      broadcast({ type: "leaderboard", data: status.leaderboard });
    }
    if (status.sponsor) {
      broadcast({ type: "sponsor", data: status.sponsor });
    }
    broadcast({ type: "event", data: { type: "evolve", message: "Evolution cycle completed" } });
  });
  darwin.on("grant-consumed", (data) => {
    const msg = `Grant ${data.grantId.slice(0, 16)}... consumed ${data.amount} tokens (${data.phase})`;
    pushEvent("sponsor", msg);
    broadcast({ type: "event", data: { type: "sponsor", message: msg } });
    if (darwin.sponsor) {
      broadcast({ type: "sponsor", data: darwin.sponsor.getStats() });
    }
  });
  darwin.on("error", (e) => {
    const msg = `${e.phase}: ${e.error}`;
    pushEvent("error", msg);
    broadcast({ type: "event", data: { type: "error", message: msg } });
  });
  darwin.on("task-matched", (data) => {
    const msg = `Matched ${data.count} task(s), top: ${data.top?.task?.title || "?"} (score ${data.top?.matchScore})`;
    pushEvent("task-matched", msg);
    broadcast({ type: "event", data: { type: "task-matched", message: msg } });
    if (darwin.worker) broadcast({ type: "worker", data: darwin.worker.getStats() });
  });
  darwin.on("task-completed", (data) => {
    const msg = `Completed task "${data.title}" → asset ${data.assetId?.slice(0, 16)}...`;
    pushEvent("task-completed", msg);
    broadcast({ type: "event", data: { type: "task-completed", message: msg } });
    if (darwin.worker) {
      const stats = darwin.worker.getStats();
      broadcast({ type: "worker", data: stats });
      broadcast({ type: "tasks", data: { activeTasks: stats.activeTasks, completedHistory: stats.completedHistory } });
    }
  });
  darwin.on("task-failed", (data) => {
    const msg = `Task ${data.taskId} failed: ${data.error}`;
    pushEvent("task-failed", msg);
    broadcast({ type: "event", data: { type: "task-failed", message: msg } });
    if (darwin.worker) {
      const stats = darwin.worker.getStats();
      broadcast({ type: "worker", data: stats });
      broadcast({ type: "tasks", data: { activeTasks: stats.activeTasks, completedHistory: stats.completedHistory } });
    }
  });
  darwin.on("task-abandoned", (data) => {
    const msg = `Abandoned ${data.taskId?.slice(0, 16) || "?"} (${data.reason || "?"})`;
    pushEvent("task-abandoned", msg);
    broadcast({ type: "event", data: { type: "task-abandoned", message: msg } });
    if (darwin.worker) {
      const stats = darwin.worker.getStats();
      broadcast({ type: "worker", data: stats });
      broadcast({ type: "tasks", data: { activeTasks: stats.activeTasks, completedHistory: stats.completedHistory } });
    }
  });
  darwin.on("task-reconciled", (data) => {
    const msg = `Hub sync: ${data.taskId?.slice(0, 16) || "?"} → ${data.outcome || "?"} (${data.hubStatus || ""})`;
    pushEvent("task-reconciled", msg);
    broadcast({ type: "event", data: { type: "task-reconciled", message: msg } });
    if (darwin.worker) {
      const stats = darwin.worker.getStats();
      broadcast({ type: "worker", data: stats });
      broadcast({ type: "tasks", data: { activeTasks: stats.activeTasks, completedHistory: stats.completedHistory } });
    }
  });

  // Periodic status push
  const statusInterval = setInterval(() => {
    if (clients.size > 0) {
      broadcast({ type: "status", data: darwin.getStatus() });
    }
  }, 5000);

  server.on("close", () => clearInterval(statusInterval));

  server.listen(port, () => {
    console.log(`  Dashboard: http://localhost:${port}`);
  });

  return server;
}
