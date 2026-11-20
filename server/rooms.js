import { randomBytes } from "node:crypto";

const ROOM_ID = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export class RoomRegistry {
  #maxPeers;
  #rooms = new Map();
  #memberships = new Map();

  constructor({ maxPeers = 2 } = {}) {
    this.#maxPeers = maxPeers;
  }

  join(room, socket) {
    if (typeof room !== "string" || !ROOM_ID.test(room)) {
      return { error: "bad-room" };
    }

    const existing = this.#memberships.get(socket);
    if (existing) {
      return existing.room === room ? { peerId: existing.peerId } : { error: "already-joined" };
    }

    let peers = this.#rooms.get(room);
    if (!peers) {
      peers = new Map();
      this.#rooms.set(room, peers);
    } else if (peers.size >= this.#maxPeers) {
      return { error: "room-full" };
    }

    const peerId = this.#newPeerId(peers);
    peers.set(socket, peerId);
    this.#memberships.set(socket, { room, peerId });
    return { peerId };
  }

  leave(socket) {
    const membership = this.#memberships.get(socket);
    if (!membership) return null;

    const { room, peerId } = membership;
    this.#memberships.delete(socket);

    const peers = this.#rooms.get(room);
    peers.delete(socket);
    const remaining = peers.size;
    if (remaining === 0) this.#rooms.delete(room);

    return { room, peerId, remaining };
  }

  peer(socket) {
    const membership = this.#memberships.get(socket);
    if (!membership) return null;

    const peers = this.#rooms.get(membership.room);
    return {
      room: membership.room,
      peerId: membership.peerId,
      peers: [...peers.values()].map((id) => ({ id })),
    };
  }

  #newPeerId(peers) {
    let peerId;
    do {
      peerId = randomBytes(4).toString("hex");
    } while ([...peers.values()].includes(peerId));
    return peerId;
  }
}
