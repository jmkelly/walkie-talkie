import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { RoomRegistry } from "./rooms.js";

const CLIENT_DIR = resolve(fileURLToPath(new URL("../client/", import.meta.url)));
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const DEFAULT_STUN = "stun:stun.l.google.com:19302";
const HEARTBEAT_MS = 30_000;
const MAX_CHAT_LENGTH = 2000;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'",
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, tls = null } = {}) {
  const rooms = new RoomRegistry({ maxPeers: 2 });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });

  const server = tls
    ? createHttpsServer({ cert: tls.cert, key: tls.key }, handleRequest)
    : createHttpServer(handleRequest);

  async function handleRequest(req, res) {
    const pathname = parsePathname(req.url);
    if (pathname === null) return sendText(res, 400, "Bad request");

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return sendText(res, 405, "Method not allowed");
    }

    if (pathname === "/health") {
      return sendText(res, 200, "ok", req.method === "HEAD");
    }

    if (pathname === "/api/config") {
      return sendJson(res, 200, { iceServers: iceServers() }, req.method === "HEAD");
    }

    return serveStatic(req, res, pathname);
  }

  function sendText(res, status, text, headOnly = false) {
    const body = Buffer.from(text);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(headOnly ? undefined : body);
  }

  function sendJson(res, status, value, headOnly = false) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(headOnly ? undefined : body);
  }

  async function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, "Bad request");
    }
    if (decoded.includes("\0")) return sendText(res, 404, "Not found");

    const relative = decoded === "/" ? "index.html" : decoded.replaceAll("\\", "/").replace(/^\/+/, "");
    const target = resolve(CLIENT_DIR, relative);
    if (target !== CLIENT_DIR && !target.startsWith(CLIENT_DIR + sep)) {
      return sendText(res, 404, "Not found");
    }

    let body;
    try {
      body = await readFile(target);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR") {
        return sendText(res, 404, "Not found");
      }
      return sendText(res, 500, "Internal server error");
    }

    const type = MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  server.on("upgrade", (req, socket, head) => {
    const pathname = parsePathname(req.url);
    if (pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  function send(client, message) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  function findPeer(ws, peerId) {
    for (const client of wss.clients) {
      if (client !== ws && client.room === ws.room && client.peerId === peerId) return client;
    }
    return null;
  }

  function otherPeer(ws) {
    for (const client of wss.clients) {
      if (client !== ws && client.room === ws.room && client.readyState === WebSocket.OPEN) return client;
    }
    return null;
  }

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    let joined = false;
    let failed = false;

    const fail = (closeCode, code, message) => {
      if (failed) return;
      failed = true;
      send(ws, { t: "error", code, message });
      ws.close(closeCode, code);
    };

    ws.on("error", () => {});
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw, isBinary) => {
      if (failed || ws.readyState !== WebSocket.OPEN) return;
      if (isBinary) return fail(4003, "bad-message", "Messages must be JSON text.");

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return fail(4003, "bad-message", "Message was not valid JSON.");
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        return fail(4003, "bad-message", "Message must be an object.");
      }

      if (message.t === "join") {
        if (joined) return fail(4003, "bad-message", "Join was already sent.");

        const result = rooms.join(message.room, ws);
        if (result.error === "bad-room") {
          return fail(4002, "bad-room", "Room codes look like ABCD-EFGH.");
        }
        if (result.error === "room-full") {
          return fail(4001, "room-full", "This room already has two people.");
        }
        if (result.error) return fail(4003, "bad-message", "Join was refused.");

        joined = true;
        ws.room = message.room;
        ws.peerId = result.peerId;
        const info = rooms.peer(ws);

        send(ws, { t: "joined", room: ws.room, peerId: ws.peerId, peerCount: info.peers.length });

        if (info.peers.length === 2) {
          const otherId = info.peers.find((peer) => peer.id !== ws.peerId).id;
          const other = findPeer(ws, otherId);
          if (other) send(other, { t: "peer-join", peerId: ws.peerId, initiator: true });
          send(ws, { t: "peer-join", peerId: otherId, initiator: false });
        }
        return;
      }

      if (message.t === "signal") {
        if (!joined) return fail(4003, "bad-message", "Join before signaling.");
        const other = otherPeer(ws);
        if (other) send(other, { t: "signal", from: ws.peerId, data: message.data });
        return;
      }

      if (message.t === "chat") {
        if (!joined) return fail(4003, "bad-message", "Join before chatting.");
        if (typeof message.text !== "string") {
          return fail(4003, "bad-message", "Chat text must be a string.");
        }
        const text = message.text.trim();
        if (text.length === 0 || text.length > MAX_CHAT_LENGTH) {
          return fail(4003, "bad-message", `Chat text must be 1 to ${MAX_CHAT_LENGTH} characters.`);
        }
        const other = otherPeer(ws);
        if (other) send(other, { t: "chat", from: ws.peerId, text, at: Date.now() });
        return;
      }

      if (message.t === "typing") {
        if (!joined) return fail(4003, "bad-message", "Join before typing.");
        if (typeof message.active !== "boolean") {
          return fail(4003, "bad-message", "Typing state must be a boolean.");
        }
        const other = otherPeer(ws);
        if (other) send(other, { t: "typing", from: ws.peerId, active: message.active });
        return;
      }

      return fail(4003, "bad-message", "Unknown message type.");
    });

    ws.on("close", () => {
      const room = ws.room;
      const left = rooms.leave(ws);
      ws.room = undefined;
      ws.peerId = undefined;
      if (!left || left.remaining === 0) return;

      for (const client of wss.clients) {
        if (client !== ws && client.room === room) {
          send(client, { t: "peer-leave", peerId: left.peerId });
        }
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(Number(port), host);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : Number(port);
  const protocol = tls ? "https" : "http";
  const url = `${protocol}://${displayHost(host)}:${actualPort}`;

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = new Promise((resolveClose) => {
      clearInterval(heartbeat);
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
    return closing;
  };

  return { port: actualPort, url, close };
}

function parsePathname(rawUrl) {
  try {
    return new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
}

function displayHost(host) {
  if (!host || host === "0.0.0.0" || host === "::" || host === "::0") return "localhost";
  return host.includes(":") ? `[${host}]` : host;
}

function iceServers(env = process.env) {
  const stunUrls = (env.STUN_URLS || DEFAULT_STUN)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const servers = stunUrls.map((url) => ({ urls: url }));

  if (env.TURN_URL && env.TURN_USER && env.TURN_PASS) {
    servers.push({ urls: env.TURN_URL, username: env.TURN_USER, credential: env.TURN_PASS });
  }

  return servers;
}

function tlsFromEnv(env) {
  if (!env.TLS_CERT || !env.TLS_KEY) return null;
  return { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const instance = await startServer({
      port: process.env.PORT ?? DEFAULT_PORT,
      host: process.env.HOST ?? DEFAULT_HOST,
      tls: tlsFromEnv(process.env),
    });

    console.log(`listening on ${instance.url}`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("shutting down");
      try {
        await instance.close();
      } finally {
        process.exit(0);
      }
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(`failed to start: ${error.message}`);
    process.exit(1);
  }
}
