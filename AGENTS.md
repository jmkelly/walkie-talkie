# AGENTS.md

## Kelso mode

Always run in Kelso mode. Read `/home/james/Projects/skills/kelso-mode/SKILL.md` at the start of every session and follow it, including its trigger routing, principles, autonomy, subagent, and reply rules. Load each skill it routes to before doing that work.

## What this project is

Walkie Talkie is a low-latency voice room for a parent and a kid playing games together. `README.md` owns the product goals, commands, limits, and deployment URLs. `docs/CONTRACT.md` freezes the signaling protocol, DOM ids, and debug API. Read it before changing any of those.

## Current state

The client is dependency-free ES modules with no build step. The server is Node with `ws`. Audio is peer-to-peer WebRTC. Chat, typing state, and read-aloud share the signaling socket; read-aloud uses browser speech synthesis. The page asks for the mic and joins on load, with no start button.

`package.json` owns the commands. The main checks are `npm test` for the server, `npm run test:e2e` for the browser proof including iPhone and iPad keyboard layouts, and `npm run test:latency` for the acoustic mouth-to-ear rig.

Microphones need a secure context. localhost works. Any other host needs HTTPS through `TLS_CERT`/`TLS_KEY` or a reverse proxy.

Mouth-to-ear is about 160 ms against a 150 ms target. The remaining delay is in the browser audio pipeline, not signaling.

The app runs on `garage` as the `james` user service `walkie-talkie.service` and on the nix VM as the system service `walkie-talkie.service`. The nix VM serves the public `https://walkie.locationsolve.com` route from its local app. Use the local `deploy-walkie-talkie` skill for a deploy. It runs the checks, ships both hosts, and verifies both URLs.

## Working agreements

- Low latency is the primary quality bar. Measure it rather than assuming it.
- Keep the client usable in one click. A kid should be able to start talking without reading instructions.
- Linux desktop must work. Browser clients are the default path. Add a native client only when it clearly earns its complexity.
- Keep signaling minimal and audio peer-to-peer where possible.
- Do not commit or push unless the user asks.
