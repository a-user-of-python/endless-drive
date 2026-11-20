# Endless Drive — Web Edition v2: Beam Edition

**Play it here: https://a-user-of-python.github.io/endless-drive/**

An endless, randomly generating road with smooth, blended turns — and cars
built the way BeamNG builds them: out of **nodes and beams**.

## The beam system

Every car is a structure of 42 mass **nodes** held together by 330–370
**beams**. A beam is a spring/damper strut between two nodes with two failure
points:

- Push it past its **deform** strain and its rest length permanently changes —
  that's a crumple, and it stays crumpled.
- Push it past its **break** strain and it snaps. Those nodes are on their own.

There is no scripted damage. Hit something at 100 km/h and the front nodes
stop first, the front beams bend and break, and the rear of the car keeps
coming forward on its own momentum until the beams either haul it to a stop
or break trying. Press **B** in game to watch the skeleton live — green
beams are intact, orange are bent, red are broken.

## The world

- The road generates forever ahead of you, with turns whose curvature changes
  gradually, so every corner blends into the next.
- **Cliffs**: stretches of road run along a 25–40 m drop. The wall is real
  terrain, steeper than tire grip — fall in and you are not climbing back
  out; the physics won't let you. Drive to the bottom and find your way, or
  press R.
- Trees, rocks and cliff-edge posts are real obstacles the node structure
  collides with, node by node.

## The cars

Five cars, each with its own node structure, mass, stiffness, drivetrain and
a detailed modelled body that crumples with the structure:

1. **Sedan** — FWD, balanced all-rounder
2. **Pickup** — RWD, heavy, open bed
3. **Sports Coupe** — RWD, low, stiff, fastest
4. **SUV** — 4WD, tall and heavy
5. **Muscle Car** — RWD, big power, long hood

## Controls

- **W A S D / arrow keys** — drive (hold S at a full stop for reverse)
- **Space** — handbrake
- **C** — camera: chase / cockpit / freecam
- **B** — node & beam skeleton view
- **1–5** — switch car (fresh car)
- **R** — reset with a fresh car on the road
- **F** — repair, only at a full stop
- **P / Esc** — pause

## Tech

A single self-contained `index.html`. The soft-body simulation (nodes,
beams, plastic deformation, breakage, terrain and cliff physics) runs at
480 Hz in substeps, in plain JavaScript with no dependencies; rendering by
Three.js. The physics core is shared verbatim with a Node test suite that
verifies rest stability, the 100 km/h head-on crash sequence, beam
thresholds, cliff falls and unclimbability, road blending, and all five cars.

Note: v1's WebRTC multiplayer is not in this version — it was built for
v1's straight road and does not fit the new world.

## License

Copyright (c) 2026 the author. All rights reserved.

This repository is published for viewing only. No part of this work may be
used, copied, modified, or distributed without prior written permission from
the author.
