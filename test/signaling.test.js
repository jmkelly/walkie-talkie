import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { startServer } from "../server/index.js";

function createClient(baseUrl) {
  const target = new URL(baseUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = "/ws";

  const socket = new WebSocket(target);
  const messages = [];
  const waiters = [];

  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });

  const opened = new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });

  socket.on("error", () => {});
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });

  return {
    socket,
    opened,
    closed,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    next(timeoutMs = 2000) {
      if (messages.length > 0) return Promise.resolve(messages.shift());

      return new Promise((resolve, reject) => {
        const waiter = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error("timed out waiting for a message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async expectNone(timeoutMs = 150) {
      await delay(timeoutMs);
      assert.deepEqual(messages, []);
    },
  };
}

async function setup(t) {
  const server = await startServer({ port: 0, host: "127.0.0.1", tls: null });
  const clients = [];

  t.after(async () => {
    for (const client of clients) {
      if (client.socket.readyState === WebSocket.OPEN || client.socket.readyState === WebSocket.CONNECTING) {
        client.socket.terminate();
      }
    }
    await server.close();
  });

  async function connect() {
    const client = createClient(server.url);
    clients.push(client);
    await client.opened;
    return client;
  }

  return { server, connect };
}

async function joinClient(client, room = "ABCD-EFGH") {
  client.send({ t: "join", room });
  return client.next();
}

async function pair(t, room = "ABCD-EFGH") {
  const { server, connect } = await setup(t);

  const a = await connect();
  const aJoined = await joinClient(a, room);

  const b = await connect();
  const bJoined = await joinClient(b, room);
  const bPeerJoin = await b.next();
  const aPeerJoin = await a.next();

  return { server, a, b, aJoined, bJoined, bPeerJoin, aPeerJoin };
}

async function expectFailure(client, errorCode, closeCode) {
  const error = await client.next();
  assert.equal(error.t, "error");
  assert.equal(error.code, errorCode);
  assert.equal(typeof error.message, "string");
  assert.ok(error.message.length > 0);

  const closed = await client.closed;
  assert.equal(closed.code, closeCode);
}

function get(server, path) {
  const { hostname, port } = new URL(server.url);

  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function withEnv(t, overrides) {
  const saved = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("first peer joins with peerCount 1 and gets no peer-join", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();

  const joined = await joinClient(client);

  assert.equal(joined.t, "joined");
  assert.equal(joined.room, "ABCD-EFGH");
  assert.match(joined.peerId, /^[0-9a-f]{8}$/);
  assert.equal(joined.peerCount, 1);
  await client.expectNone();
});

test("second peer receives joined then peer-join with the initiator flags", async (t) => {
  const { aJoined, bJoined, bPeerJoin, aPeerJoin } = await pair(t);

  assert.equal(bJoined.t, "joined");
  assert.equal(bJoined.room, "ABCD-EFGH");
  assert.equal(bJoined.peerCount, 2);
  assert.notEqual(bJoined.peerId, aJoined.peerId);
  assert.match(bJoined.peerId, /^[0-9a-f]{8}$/);

  assert.deepEqual(bPeerJoin, { t: "peer-join", peerId: aJoined.peerId, initiator: false });
  assert.deepEqual(aPeerJoin, { t: "peer-join", peerId: bJoined.peerId, initiator: true });
});

test("signal relays only to the other peer and is never echoed", async (t) => {
  const { a, b, aJoined } = await pair(t);
  const data = { kind: "description", sdp: "v=0\r\n", nested: { value: 1 } };

  a.send({ t: "signal", data });

  assert.deepEqual(await b.next(), { t: "signal", from: aJoined.peerId, data });
  await a.expectNone();
});

test("signal in a one peer room is dropped", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();
  await joinClient(client);

  client.send({ t: "signal", data: { kind: "candidate", candidate: "..." } });

  await client.expectNone();
});

test("chat relays only to the other peer and is never echoed", async (t) => {
  const { a, b, aJoined } = await pair(t);

  a.send({ t: "chat", text: "  Hello from A  " });

  const received = await b.next();
  assert.equal(received.t, "chat");
  assert.equal(received.from, aJoined.peerId);
  assert.equal(received.text, "Hello from A");
  assert.equal(typeof received.at, "number");
  await a.expectNone();
});

test("chat in a one peer room is dropped", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();
  await joinClient(client);

  client.send({ t: "chat", text: "Anybody there?" });

  await client.expectNone();
});

test("chat before join is a bad message and closes with 4003", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();

  client.send({ t: "chat", text: "Too early" });

  await expectFailure(client, "bad-message", 4003);
});

test("empty and non-string chat text is a bad message", async (t) => {
  const { a } = await pair(t);

  a.send({ t: "chat", text: "   " });
  await expectFailure(a, "bad-message", 4003);

  const { connect } = await setup(t);
  const other = await connect();
  await joinClient(other);
  other.send({ t: "chat", text: 42 });
  await expectFailure(other, "bad-message", 4003);
});

test("chat text over the limit is a bad message", async (t) => {
  const { a } = await pair(t);

  a.send({ t: "chat", text: "x".repeat(2001) });

  await expectFailure(a, "bad-message", 4003);
});

test("signal before join is a bad message and closes with 4003", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();

  client.send({ t: "signal", data: { kind: "description" } });

  await expectFailure(client, "bad-message", 4003);
});

test("invalid JSON is a bad message and closes with 4003", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();

  client.socket.send("{not json");

  await expectFailure(client, "bad-message", 4003);
});

test("an unknown message type is a bad message and closes with 4003", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();

  client.send({ t: "wat" });

  await expectFailure(client, "bad-message", 4003);
});

test("a second join is a bad message and closes with 4003", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();
  await joinClient(client);

  client.send({ t: "join", room: "ABCD-EFGH" });

  await expectFailure(client, "bad-message", 4003);
});

test("a third peer gets room-full and close code 4001", async (t) => {
  const { server, a, b, aJoined, bJoined } = await pair(t);
  const third = createClient(server.url);
  await third.opened;
  t.after(() => third.socket.terminate());

  third.send({ t: "join", room: "ABCD-EFGH" });
  await expectFailure(third, "room-full", 4001);

  a.send({ t: "signal", data: { kind: "description" } });
  assert.deepEqual(await b.next(), {
    t: "signal",
    from: aJoined.peerId,
    data: { kind: "description" },
  });
  assert.equal(bJoined.peerCount, 2);
});

test("a bad room id gets bad-room and close code 4002", async (t) => {
  const { connect } = await setup(t);
  const client = await connect();

  client.send({ t: "join", room: "abcd-efgh" });

  await expectFailure(client, "bad-room", 4002);
});

test("the remaining peer gets peer-leave and the room is empty afterwards", async (t) => {
  const { server, a, b, bJoined } = await pair(t);

  b.socket.close();
  assert.deepEqual(await a.next(), { t: "peer-leave", peerId: bJoined.peerId });
  await b.closed;

  a.socket.close();
  await a.closed;
  await delay(50);

  const rejoined = createClient(server.url);
  await rejoined.opened;
  t.after(() => rejoined.socket.terminate());
  const joined = await joinClient(rejoined);

  assert.equal(joined.t, "joined");
  assert.equal(joined.peerCount, 1);
});

test("static requests cannot escape the client directory", async (t) => {
  const { server } = await setup(t);
  const paths = [
    "/%2e%2e%2fserver%2findex.js",
    "/..%2fserver%2findex.js",
    "/%2e%2e%2f%2e%2e%2fpackage.json",
    "/..%2F..%2Fetc%2Fpasswd",
  ];

  for (const path of paths) {
    const response = await get(server, path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.body, /startServer|walkie-talkie|root:/, path);
  }

  const missing = await get(server, "/definitely-not-here.js");
  assert.equal(missing.status, 404);
});

test("health returns ok with the security headers", async (t) => {
  const { server } = await setup(t);

  const response = await get(server, "/health");

  assert.equal(response.status, 200);
  assert.equal(response.body, "ok");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.match(response.headers["content-security-policy"], /connect-src 'self' ws: wss:/);
});

test("config defaults to the public STUN server", async (t) => {
  withEnv(t, {
    STUN_URLS: undefined,
    TURN_URL: undefined,
    TURN_USER: undefined,
    TURN_PASS: undefined,
  });
  const { server } = await setup(t);

  const response = await get(server, "/api/config");

  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
});

test("config reads STUN_URLS and appends TURN credentials when all are set", async (t) => {
  withEnv(t, {
    STUN_URLS: "stun:stun.example.com:3478, stun:backup.example.com:3478",
    TURN_URL: "turn:turn.example.com:3478",
    TURN_USER: "user",
    TURN_PASS: "secret",
  });
  const { server } = await setup(t);

  const response = await get(server, "/api/config");

  assert.deepEqual(JSON.parse(response.body), {
    iceServers: [
      { urls: "stun:stun.example.com:3478" },
      { urls: "stun:backup.example.com:3478" },
      { urls: "turn:turn.example.com:3478", username: "user", credential: "secret" },
    ],
  });
});

test("upgrades on paths other than /ws are refused", async (t) => {
  const { server } = await setup(t);
  const target = new URL(server.url);
  target.protocol = "ws:";
  target.pathname = "/nope";

  const socket = new WebSocket(target);
  const result = await new Promise((resolve) => {
    socket.once("open", () => resolve({ open: true }));
    socket.once("error", (error) => resolve({ error }));
  });

  assert.equal(result.open, undefined);
  socket.terminate();
});
