import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = join(__dirname, "..", "..", "dashboard", "index.html");

/**
 * Minimal dashboard server with WebSocket support (no external deps).
 * Uses the raw HTTP upgrade + WebSocket frame protocol.
 */
export function startDashboardServer(darwin, { port = 3777 } = {}) {
  const clients = new Set();

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      const html = readFileSync(DASHBOARD_HTML, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
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

  // Wire darwin events to WebSocket broadcasts
  darwin.on("heartbeat", () => {
    broadcast({ type: "status", data: darwin.getStatus() });
  });
  darwin.on("fetch", (data) => {
    broadcast({ type: "event", data: { type: "fetch", message: `Fetched ${data.total} assets, ingested ${data.ingested}` } });
    broadcast({ type: "genes", data: darwin.store.ranked(15) });
  });
  darwin.on("record", (data) => {
    broadcast({ type: "event", data: { type: "record", message: `Recorded: ${data.capsuleId?.slice(0, 16)}... fitness=${data.fitness?.toFixed(3) ?? '?'}` } });
    broadcast({ type: "status", data: darwin.getStatus() });
  });
  darwin.on("evolve", () => {
    broadcast({ type: "status", data: darwin.getStatus() });
    broadcast({ type: "genes", data: darwin.store.ranked(15) });
    broadcast({ type: "event", data: { type: "evolve", message: "Evolution cycle completed" } });
  });
  darwin.on("error", (e) => {
    broadcast({ type: "event", data: { type: "error", message: `${e.phase}: ${e.error}` } });
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
