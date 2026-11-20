# v1.2 build contract

Two people, one room, browser audio over WebRTC plus text chat and typing state over the signaling socket. This file is the frozen interface between the server, client, and e2e work. Do not edit it. If something here is wrong or impossible, report it instead of changing it.

## Product shape

- One page, no accounts, no build step, no external assets or CDNs.
- First visit generates a room code and puts it in the URL as `/?room=ABCD-EFGH`.
- The other person opens the same link, allows the mic, and talks. The page asks for the mic and joins the room on load; there is no start button.
- Click-to-talk. Clicking the compact Talk control or pressing Space toggles the mic. It stays open until toggled again.
- Both people can exchange text messages over the signaling socket while they are in the room. A small typing indicator appears while the other person is composing.
- Two peers per room. The third connection is rejected.
- Audio is peer-to-peer. The server only relays signaling, chat, and typing, and serves files.

## File ownership

| Path | Owner | May write |
| --- | --- | --- |
| `server/**` | server agent | yes |
| `test/rooms.test.js`, `test/signaling.test.js` | server agent | yes |
| `client/**` | client agent | yes |
| `test/e2e.mjs` | e2e agent | yes |
| `package.json`, `README.md`, `docs/**` | integrator | no one else |

Do not add dependencies. `ws` is the only runtime dependency.

## Server

Node ESM. `server/index.js` exports `startServer(options)` and also runs as a CLI when executed directly.

```js
const { port, url, close } = await startServer({
  port: 8787,        // 0 means pick a free port
  host: "0.0.0.0",
  tls: null,         // or { cert, key } as Buffers/strings
});
```

- Serves `client/` at `/`, with `index.html` for `/`.
- Sends `Content-Type` by extension. Rejects path traversal. Returns 404 for missing files.
- Sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP that allows only self plus `ws:`/`wss:` connections.
- `GET /health` returns `200` with body `ok`.
- `GET /api/config` returns `{"iceServers":[...]}`.
  - `STUN_URLS` is a comma-separated list, default `stun:stun.l.google.com:19302`.
  - When `TURN_URL`, `TURN_USER`, and `TURN_PASS` are set, append `{urls: TURN_URL, username, credential}`.
- WebSocket endpoint is `/ws`. Any other upgrade path is closed.
- On listen, print exactly one line containing `listening on <url>` to stdout.
- Log startup and shutdown only. Never log room codes, peer ids, or IP addresses.
- Handle `SIGINT` and `SIGTERM` with a clean `close()` and exit 0.
- TLS is used when `TLS_CERT` and `TLS_KEY` are set (read as file paths). `wss:` follows automatically.
- Heartbeat with WebSocket ping every 30 s, terminate a peer that missed the last pong.

### Rooms

`server/rooms.js` exports a `RoomRegistry` with no I/O and no timers. It is unit-testable on its own.

```js
const rooms = new RoomRegistry({ maxPeers: 2 });
rooms.join("ABCD-EFGH", socketLike) // => { peerId } or { error: "room-full" }
rooms.leave(socketLike)              // => { room, peerId, remaining } | null
rooms.peer(socketLike)               // => { room, peerId, peers: [{id}] } | null
```

- Room ids match `/^[A-Z2-9]{4}-[A-Z2-9]{4}$/`. Invalid ids are rejected with `bad-room`.
- Peer ids are 8 lowercase hex characters.
- Room state disappears when the last peer leaves. No persistence, no timers.
- A socket may belong to one room only.

### WebSocket messages

Client to server:

```json
{ "t": "join", "room": "ABCD-EFGH" }
{ "t": "signal", "data": { "kind": "description|candidate", "...": "..." } }
{ "t": "chat", "text": "hello" }
{ "t": "typing", "active": true }
```

Server to client:

```json
{ "t": "joined", "room": "ABCD-EFGH", "peerId": "a1b2c3d4", "peerCount": 1 }
{ "t": "peer-join", "peerId": "e5f6a7b8", "initiator": true }
{ "t": "signal", "from": "e5f6a7b8", "data": { "...": "..." } }
{ "t": "chat", "from": "e5f6a7b8", "text": "hello", "at": 1760000000000 }
{ "t": "typing", "from": "e5f6a7b8", "active": true }
{ "t": "peer-leave", "peerId": "e5f6a7b8" }
{ "t": "error", "code": "room-full|bad-room|bad-message", "message": "human readable" }
```

Rules:

- `join` must be the first message. A second `join` gets `bad-message`.
- Invalid JSON, an unknown `t`, `signal`, `chat`, or `typing` before `join`, malformed chat text, or a non-boolean typing state gets `bad-message` and the socket closes with code 4003.
- Room full gets `error` with `room-full` and close code 4001. Bad room gets `bad-room` and close code 4002.
- First peer in a room receives `joined` with `peerCount: 1` and no `peer-join`.
- Second peer receives `joined` with `peerCount: 2`, then `peer-join` with `initiator: false`.
- The first peer receives `peer-join` with the second peer's id and `initiator: true`.
- `signal` is relayed only to the other peer in the room, with `from` set to the sender's peer id. Never echo to the sender. Drop if the room has one peer.
- `chat` text is trimmed and must be 1 to 2000 characters. Relay only to the other peer with `from` and a server `at` timestamp. Never echo to the sender. Drop if the room has one peer. Keep no history.
- `typing` with `active` true or false is relayed only to the other peer, with `from`. Never echo to the sender. Drop if the room has one peer. Keep no state.
- On disconnect, the remaining peer receives `peer-leave`.
- `data` is passed through unmodified. Do not inspect it.
- Never log room codes, peer ids, IP addresses, chat text, or typing state.

## Client

`client/index.html`, `client/app.js`, `client/rtc.js`, `client/audio.js`, `client/styles.css`. Plain ES modules. No framework, no bundler, no inline scripts (CSP).

### Flow

1. On load, read `?room=`; validate `/^[A-Z2-9]{4}-[A-Z2-9]{4}$/`; otherwise generate one and replace the URL.
2. Render the room code and a share link immediately.
3. On load, request `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl`, `channelCount: 1`, then open the WebSocket to `/ws` and send `join`. With `?probe=1`, all three processing flags are false so latency measurements see the raw microphone. Do not require a start click. If the mic fails, show `error` and a "Try again" button.
4. `joined` with `peerCount: 1` shows `waiting`.
5. On `peer-join`, the initiator creates the peer connection and offers; the responder waits for the offer, then answers.
6. When the peer connection reaches `connected`, show `live` and enable `#ptt`.
7. `peer-leave` closes the peer connection and returns to `waiting`, keeping the mic and socket.
8. WebSocket close returns to `reconnecting` and retries with backoff `0.5, 1, 2, 5` seconds, capped at 5 s. Rejoin the same room.
9. Peer connection `failed` closes the socket and uses the same reconnect path, so a fresh peer-join creates a fresh connection.
10. Chat is enabled exactly while another peer is in the room and the signaling socket is open. Submitting the composer sends `chat`; an incoming `chat` renders immediately. Render message text with `textContent`, never `innerHTML`. Keep up to 300 messages locally for the page session. Chat history is cleared on "New room".
11. While the composer has non-whitespace text and the user keeps typing, send `typing` with `active: true`. Stop after 2 s without input, on send, on blur, or when chat becomes unavailable. An incoming `typing` shows `#typing` and hides `#chat-state`; `active: false`, a chat message, a peer leave, or a 3 s fallback hides it.

### Peer connection

- ICE servers from `/api/config`, with a `stun:` default fallback.
- `bundlePolicy: "max-bundle"`, one audio transceiver, send only the mic track.
- Audio track `contentHint = "speech"`.
- Set `receiver.jitterBufferTarget = 0` when the property exists (lowest playout delay).
- Set the audio sender `maxBitrate` to 32000 in `setParameters` after negotiation, wrapped in try/catch.
- Trickle ICE. Buffer remote candidates until `setRemoteDescription` resolves.
- Remote stream plays through one `<audio autoplay playsinline>` element. Keep it out of the tap gesture path. Because the page starts without a gesture, resume the audio context and retry playback on the first pointer or key event. If playback is still blocked, show `#sound`, and hide it once play resolves.

### Click to talk

- Clicking `#ptt` toggles the mic. It stays open until clicked again. The visible label is `Talk` while closed and `Talking` while open.
- Space toggles the mic when focus is not on a control. When `#ptt` has focus, its native activation handles Space through the same toggle path.
- Implement with `track.enabled`. Never renegotiate on toggle.
- Ignore key repeat. Do not close the mic on blur or visibility change.
- Leaving the live state, a second click, or the microphone ending closes the mic.
- Before the mic exists, `#ptt` is disabled and inert.

### Required DOM contract

The e2e test depends on these exact ids and attributes.

```html
<body data-state="idle">
  <span id="room-code">ABCD-EFGH</span>
  <button id="copy-link">Copy link</button>
  <svg id="qr-code" role="img" aria-label="QR code for the room link">...</svg>
  <div id="status" data-state="idle" role="status" aria-live="polite">...</div>
  <button id="retry" hidden>Try again</button>
  <button id="new-room" hidden>New room</button>
  <button id="ptt" disabled aria-pressed="false">Talk</button>
  <div id="messages" role="log" aria-live="polite">...</div>
  <span id="typing" role="status" hidden>...</span>
  <button id="sound" type="button" hidden>Tap to hear them</button>
  <form id="chat-form">
    <input id="chat-input" disabled>
    <button id="chat-send" type="submit" disabled>Send</button>
  </form>
  <div id="local-level"></div>
  <div id="remote-level"></div>
  <div id="stats" hidden>...</div>
</body>
```

`#status[data-state]` and `body[data-state]` share one value from `idle | requesting-mic | waiting | connecting | live | reconnecting | error`. `#status` text is short and human readable. `#room-code` is the code with the hyphen. `#copy-link` copies `location.origin + "/?room=" + code` and shows a confirmation in `#status` temporarily (then restores the real state text). `#qr-code` encodes that same URL as a scannable QR code while the share panel is visible; the link remains the source of truth for assistive tech.

Chat messages render as `.message` elements. Each carries `data-from="self"` or `data-from="peer"`, with the text in a `.message-text` child. The e2e test uses these selectors. `#typing` replaces `#chat-state` while the other peer types.

### Debug API

Expose a small object for the e2e harness and humans:

```js
window.__walkie = {
  state: () => ({ uiState, connectionState, room, peerId, talking, probe, micSettings, chatEnabled, messageCount, peerTyping }),
  stats: async () => ({
    rttMs,            // current candidate pair, null if unknown
    jitterMs,         // inbound audio jitter
    packetsLost,      // inbound audio cumulative
    bytesReceived,    // inbound audio cumulative
    bitrateKbps,      // inbound audio over the last sample window
    jitterBufferMs,   // receiver.jitterBufferTarget if supported, else null
    jitterBufferDelayMs, // average inbound jitter buffer delay, null if unknown
    localLevel,       // 0..1
    remoteLevel,      // 0..1
  }),
  toggle: () => {},   // same path as the button
};
```

`stats()` resolves with nulls when nothing is connected; it must never throw.

### Look and feel

Dark, high contrast, one accent. Messaging is the primary surface: a message thread fills the page and the composer sits below it. The compact Talk control lives in a slim dock and clearly changes when the mic is open. Show a small animated typing bubble while the other person types. Show local and remote audio levels while live. Show "Waiting for the other person" with the share link and a small QR code while alone. Errors are plain sentences, e.g. "Microphone permission was denied. Allow it in the browser and try again." No spinners that hide state. Works at 360 px wide and on desktop. Focus states are visible. Use system fonts only.

### Errors

- Mic denied or unavailable: `error` state, message says how to fix it, `#retry` is visible as "Try again".
- `room-full`: `error` state with "This room already has two people."
- `bad-room`: `error` state and offer a fresh room link.
- Socket errors: `reconnecting`, then `error` after three failed attempts with a retry button. The e2e test only requires the first reconnect cycle.

## E2E harness

`test/e2e.mjs` is the proof. It must:

1. Spawn the server with `PORT=0`, parse the `listening on <url>` line, and always kill the child in `finally`.
2. Launch Chromium through Playwright with:
   `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--autoplay-policy=no-user-gesture-required`.
   Use `PLAYWRIGHT_CHROMIUM` when set, else try the browser Playwright installed, else `/usr/bin/chromium`.
3. Two isolated contexts, A and B. A opens the base URL, waits for `data-state="waiting"`, reads the room code from `#room-code`, and asserts `#chat-input` is disabled. No start click is used.
4. B opens `/?room=<code>`. Assert both pages reach `data-state="live"` within 15 s.
5. A types into `#chat-input` without sending. Assert B sees `#typing`. A presses Enter. Assert B sees the message as `.message[data-from="peer"] .message-text` and `#typing` hides. B replies and assert A sees the reply the same way.
6. On A, click `#ptt`. Poll `window.__walkie.stats()` on B for up to 5 s until `bytesReceived` grows by at least 4000 and `bitrateKbps > 0`. Then click `#ptt` again and assert A's `state().talking` is false and its local level falls to 0 within 2 s.
7. Press Space once on A and assert `state().talking` becomes true and the local level rises. Press Space again and assert both return to false and 0. This proves the real key path latches.
8. Read A stats and assert `rttMs` is a number below 100 on loopback. Print the measured values. Note in the output that this is network RTT, not mouth-to-ear.
9. Close B. Assert A returns to `waiting` within 5 s. Also assert A's `state().talking` is false after the peer leaves.
10. Open C with the same room and wait for `live`, assert A and C reach `live` within 15 s.
11. Save `test-results/e2e-live.png` from A. Print one `PASS` line with the room code and measured stats.
12. Exit 1 with a clear message on the first failed assertion. Every wait has a timeout.

`test-results/` is gitignored.

## Definition of done

- `npm test` green, covering room capacity, leave cleanup, bad ids, signal, chat, and typing relay targeting, validation, and close codes.
- `npm run test:e2e` green against a real Chromium and real fake mic, including chat and typing both ways.
- `npm start` serves a usable page at `http://localhost:8787`.
- README explains running, HTTPS for non-localhost, TURN, measured latency, messaging limits, and known gaps.
