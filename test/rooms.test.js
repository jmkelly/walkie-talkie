import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomRegistry } from "../server/rooms.js";

function socket() {
  return {};
}

test("join returns an 8 character lowercase hex peer id", () => {
  const rooms = new RoomRegistry({ maxPeers: 2 });
  const result = rooms.join("ABCD-EFGH", socket());

  assert.deepEqual(Object.keys(result), ["peerId"]);
  assert.match(result.peerId, /^[0-9a-f]{8}$/);
});

test("a third peer is rejected with room-full and does not enter the room", () => {
  const rooms = new RoomRegistry({ maxPeers: 2 });
  const firstSocket = socket();
  const first = rooms.join("ABCD-EFGH", firstSocket);
  const second = rooms.join("ABCD-EFGH", socket());
  const third = socket();

  assert.deepEqual(rooms.join("ABCD-EFGH", third), { error: "room-full" });
  assert.equal(rooms.peer(third), null);
  assert.deepEqual(rooms.peer(firstSocket).peers, [{ id: first.peerId }, { id: second.peerId }]);
});

test("invalid room ids are rejected with bad-room", () => {
  const rooms = new RoomRegistry({ maxPeers: 2 });
  const invalid = [
    "",
    "abcd-efgh",
    "ABC-EFGH",
    "ABCDEFGH",
    "ABCD-EFG0",
    "ABCD-EFG1",
    "ABCD-EFGH ",
    "ABCD-EFGHI",
    "1234-5678",
    42,
    null,
    undefined,
  ];

  for (const room of invalid) {
    assert.deepEqual(rooms.join(room, socket()), { error: "bad-room" }, `rejected ${String(room)}`);
  }
});

test("leave reports the room, peer id, and remaining count", () => {
  const rooms = new RoomRegistry({ maxPeers: 2 });
  const a = socket();
  const b = socket();
  const aJoin = rooms.join("ABCD-EFGH", a);
  const bJoin = rooms.join("ABCD-EFGH", b);

  assert.deepEqual(rooms.leave(a), { room: "ABCD-EFGH", peerId: aJoin.peerId, remaining: 1 });
  assert.deepEqual(rooms.peer(b), {
    room: "ABCD-EFGH",
    peerId: bJoin.peerId,
    peers: [{ id: bJoin.peerId }],
  });
  assert.equal(rooms.leave(a), null);
  assert.deepEqual(rooms.leave(b), { room: "ABCD-EFGH", peerId: bJoin.peerId, remaining: 0 });
  assert.equal(rooms.peer(b), null);
});

test("room state disappears when the last peer leaves", () => {
  const rooms = new RoomRegistry({ maxPeers: 2 });
  const a = socket();
  const b = socket();
  rooms.join("ABCD-EFGH", a);
  rooms.join("ABCD-EFGH", b);
  rooms.leave(a);
  rooms.leave(b);

  const c = socket();
  const joined = rooms.join("ABCD-EFGH", c);

  assert.equal(joined.error, undefined);
  assert.deepEqual(rooms.peer(c), {
    room: "ABCD-EFGH",
    peerId: joined.peerId,
    peers: [{ id: joined.peerId }],
  });
});

test("peer returns null before join and lists both peers after the second joins", () => {
  const rooms = new RoomRegistry({ maxPeers: 2 });
  const a = socket();
  const b = socket();

  assert.equal(rooms.peer(a), null);

  const aJoin = rooms.join("ABCD-EFGH", a);
  const bJoin = rooms.join("ABCD-EFGH", b);

  assert.deepEqual(rooms.peer(a), {
    room: "ABCD-EFGH",
    peerId: aJoin.peerId,
    peers: [{ id: aJoin.peerId }, { id: bJoin.peerId }],
  });
});
