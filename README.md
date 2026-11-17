# Endless Drive — Web Edition

**Play it here: https://a-user-of-python.github.io/endless-drive/**

One endless, perfectly straight road. Real driving physics — and a car that
breaks piece by piece when you abuse it. A smashed radiator cooks the engine,
blown tires pull the car sideways, a ruptured fuel tank leaks until you run
dry, and a hard enough crash totals the car outright.

## Controls

- **W A S D / arrow keys** — drive (hold S at a full stop for reverse)
- **Space** — handbrake
- **C** — camera: chase / cockpit (with working dash gauges) / freecam
- **R** — back on the road (after a total: tow truck + full repair)
- **F** — repair, only at a full stop
- **P / Esc** — pause

## Multiplayer

Peer-to-peer over WebRTC with ICE — no server, no accounts. One player
creates an invite code and sends it to the other; the other pastes it and
sends back a reply code; the host pastes the reply and you're connected,
side by side on the same endless road.

## Tech

A single self-contained `index.html`. The physics and per-part damage model
are a faithful port of the native (C) version's simulation core. Rendering by
Three.js. The road is one straight line by construction — segments always
connect, with zero lateral offset.

## License

Copyright (c) 2026 the author. All rights reserved.

This repository is published for viewing only. No part of this work may be
used, copied, modified, or distributed without prior written permission from
the author.
