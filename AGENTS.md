# AGENTS.md

## What this project is

Walkie Talkie is a low-latency voice chat app for two people (a parent and a kid) playing games together. See `README.md` for goals and constraints.

## Current state

A working v1. The stack is a dependency-free browser client (plain ES modules, no build step) plus a small Node signaling server using `ws`, with WebRTC audio peer-to-peer. `docs/CONTRACT.md` freezes the signaling protocol, DOM ids, and debug API; read it before changing any of those.

- `npm start` serves the app on `http://localhost:8787`.
- `npm test` runs server tests. `npm run test:e2e` runs the Playwright proof harness. `npm run test:latency` runs the real acoustic mouth-to-ear rig.
- Microphone capture requires a secure context: localhost works, other hosts need HTTPS (`TLS_CERT`/`TLS_KEY`).
- Mouth-to-ear is measured at about 160 ms, missing the 150 ms target. The bottleneck is the client browser audio pipeline, not signaling.

## Working agreements

- Low latency is the primary quality bar. Measure it rather than assuming.
- Keep the client dead simple to use; a kid should be able to start talking in one click.
- Linux desktop must work. Browser clients are the default path; native clients only if they clearly earn their complexity.
- Keep signaling minimal and keep audio peer-to-peer where possible.
- Use `bd` for task tracking if the project adopts Beads; otherwise keep the project's chosen tracker up to date.
- Do not commit or push unless the user asks.
