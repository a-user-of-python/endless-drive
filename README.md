# Endless Drive — Web Edition v2: Beam Edition

**Play it here: https://a-user-of-python.github.io/endless-drive/**

An endless, randomly generating road with smooth, blended turns — and cars
built the way BeamNG builds them: out of **nodes and beams**.

## The beam system

Every car is a structure of mass **nodes** held together by **beams**. A beam
is a spring/damper strut between two nodes with two failure points:

- Push it past its **deform** strain and its rest length permanently changes —
  that's a crumple, and it stays crumpled. But only up to a point: the yielded
  rest length may travel at most 70% of the way to the break displacement.
  Past that cap the beam stops folding and only springs — a crushed zone
  bottoms out against real resistance instead of collapsing to nothing.
- Push it past its **break** strain and it snaps. Those nodes are on their own.
- Short of breaking, a beam is an **elastic with a hard limit**: the further
  it is displaced past yield — stretched or compressed — the harder it pushes
  back (double rate), and an unbroken beam is never allowed to sit further
  from its rest length than its break displacement; the solver pulls it back
  to exactly that limit. The structure holds together with real strength
  instead of drifting apart.

The shell also has **flex damping at the velocity level**: every physics
step, each node's velocity is pulled slightly toward the velocity it would
have if the car were moving as one perfectly rigid body. Only the
difference — the flexing, wobbling motion — is bled off, so the car stops
ringing like jelly after bumps and landings, while its driving, turning
and falling are untouched by construction. During a crash the damping
switches itself off (impact cooldowns gate it) so crumpling stays exactly
as violent as the beams dictate, then fades back in over a quarter second.

### Materials — a strong frame, sacrificial ends

Beams are not all the same stuff. At cage generation every beam is
assigned a **zone** from where it sits (section along the car × height in
the ring) and a simplified **material** with its own stiffness, yield
strain, break strain and plastic travel:

- **Bumpers** — softest; they are there to be hit first and fold cheaply.
- **Crumple zones** (front and rear) — soft, but with the longest fold
  travel: they absorb the crash progressively, metre by metre.
- **Panels** (doors, roof, hood skin) — medium-weak; they dent and tear
  without pretending to be structure.
- **Frame** (floor, rails, low structure) — the strong spine: yield and
  break strains roughly 2.4× the crumple zones', and very little plastic
  travel — it would rather spring than fold.
- **Cabin** (pillars and the cabin ring) — the strongest of all; the
  survival cell.

Measured on the sedan: at 50 km/h head-on, the crumple zone deforms and
breaks doing the absorbing while the frame takes 2 deformed / 0 broken
beams and the cabin takes none at all. Every beam also tracks its live
**stress** (elastic strain relative to its material's yield), and the
**B** skeleton view colours by it: green at rest, through yellow and
orange, to red at and past yield — so you can watch a crash load the
structure before it gives.

### Suspension and tires

Suspension is per-car in character, not just in stiffness: each car has
its own spring rate **and its own damper**, sized for the body-bounce
mode (the coupe is stiff and heavily damped, the SUV soft and slower).
Dropped from 0.35 m, every car's second bounce is under 40% of its first
compression — the pogo-stick era is over.

Each tire is its own little model too: per-car grip, heating and cooling
constants, and a live temperature per wheel. Slip (burnouts, hard
cornering, locked brakes) heats the tire; grip follows temperature —
about 0.85× cold, full across the optimal window, fading again when
overheated. Warm tires measurably stop the car shorter than cold ones
(≈9% from 60 km/h in the test suite).

There is no scripted damage. Hit something at 100 km/h and the front nodes
stop first, the front beams bend and break, and the rear of the car keeps
coming forward on its own momentum until the beams either haul it to a stop
or break trying. Press **B** in game to watch the skeleton live — green
beams are intact, orange are bent, red are broken.

The cage is a **regular grid**, generated from each car's own profile:
evenly spaced cross-sections along the car, each a ring of nodes evenly
spaced by arc length around a rounded-rectangle cross-section (hood, cabin
and rear heights interpolated from the car's profile, the roof narrower
than the floor like a real shell). Rings are triangulated with chords,
adjacent sections are joined by longitudinal beams and alternating panel
diagonals, and at higher resolutions extra "skip" chord families run two
and three sections apart. On top of the grid sit two bumper nodes, four
suspension mounts, and four wheel nodes with a strut and triangulated
links each — no distance-based auto-connect anywhere; every beam is
placed by the generator and can be counted.

## Beam resolution — per car

Each car has its **own resolution setting: a target node count**. The grid
generator picks the section/ring layout that lands the total node count
( grid + bumpers + mounts + wheels ) on the target.

- **NORMAL — 150 nodes** (604 beams)
- **HIGH — 250 nodes** (1,448 beams)
- **ULTRA — 500 nodes** (2,934 beams)
- **ULTRA+ — past 500**, `]` keeps adding **+10 nodes** per press, up to
  **1000 nodes** (5,878 beams)

`[` steps back down symmetrically (above 500 in −10 steps, then
500 → 250 → 150). Changing the setting respawns the current car fresh at
its position with the new cage. Every car remembers its own setting
between sessions (localStorage), the title screen shows each car's level
on its card, and the **T** key toggles an on-screen panel with the current
car's level, target, actual node count and actual beam count, plus a
compact per-car list.

The **body scales with the setting**: there is one master body per car,
and its triangle density follows the node target — each body quad is
subdivided from 1×1 at 150 nodes (the floor: exactly the original body's
density, so the car never turns into a blob) up to 6×6 at 1000 nodes.
Body vertices are skinned to the cage **cell** they belong to (section
pair × ring segment), with their offset re-applied through the cell's own
deformed frame — so in a crash the panels move with their own piece of
cage instead of blending across the car, and the body stays matched to
the nodes (the test suite measures body-vs-cage mismatch after a
100 km/h crash; the cell skinning roughly halves it versus the old
3-nearest-nodes blend). Triangle counts per car run from
348–408 at 150 nodes to 12,528–14,688 at 1000.

Under the hood, finer cages need softer per-beam rates to stay stable at
480 Hz; beam forces are therefore subcycled (evaluated twice per step,
three times past 500 nodes) so the structure can stay stiff without
ringing, and the parallel chord families keep the shell from sagging
under its own weight at fine resolutions. Each strut mount is also
braced across the car to the opposite side's low anchors: the mount's
own web runs fore/aft and barely locates it sideways, while the
compressed strut tries to topple it inward — at fine resolutions that
used to win, the mounts swung in on their struts and the body sank
until the floor carried the car (and dragged, capping top speed). The
cross braces give the perch first-order lateral stiffness at every
resolution.

## The world

- The road generates forever ahead of you, with turns whose curvature changes
  gradually, so every corner blends into the next.
- **Cliffs**: stretches of road run along a 25–40 m drop. The wall is real
  terrain, steeper than tire grip — fall in and you are not climbing back
  out; the physics won't let you. Drive to the bottom and find your way, or
  press R.
- Trees, rocks and cliff-edge posts are real obstacles the node structure
  collides with, node by node.
- **Guardrails — sometimes**: on some stretches (favoured on the outside
  of curves and along cliff edges, always with gaps) a rail on posts runs
  at the road's edge. It is *not* scenery: the rail is modelled in the
  physics as a row of overlapping circle obstacles, so cars hit it and
  stop instead of clipping through.
- **Imperfect road**: every 150–400 m or so the road has a defect — a
  pothole (a real dip in the road surface your suspension feels, with a
  dark patch), a bump (raised, lighter patch), or a crack (visual only).
  The first stretch from spawn is kept clean.
- **Nothing decorative is ever placed on the road**: grass, rocks, bushes,
  trees and barrier posts are all placed in track space with a hard
  lateral exclusion outside the drivable width.
- **Grass and dressing**: instanced grass tufts (a few thousand alive at
  once, recycled with the terrain chunks), extra boulders, bushes and two
  tree shapes fill out the roadside — all deterministic from the world
  seed, all visual only.

### Textures

The ground, road and rocks start with procedural canvas textures, so the
game boots and plays fully offline or from a local file. On first boot it
also tries to download two real photographic textures (grass/ground and
rock) from a CORS-enabled CDN and swaps them in when they arrive; if the
download fails, nothing changes — the procedural textures stay. The road
band uses its own material, so the photographic ground texture can never
tint the asphalt or wash out the road markings.

## The cars

Five cars, each with its own profile, mass, stiffness, drivetrain and a
detailed modelled body that crumples with the structure:

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
- **[ / ]** — beam resolution down / up for the current car
- **T** — beam resolution display on/off
- **1–5** — switch car (fresh car)
- **R** — reset with a fresh car on the road
- **F** — repair, only at a full stop
- **P / Esc** — pause

## Tech

The game is split into plain JavaScript files in folders (plain `<script
src>` tags, no modules, so it still runs from `file://` and from GitHub
Pages with no build step):

```
index.html          head, CSS and DOM only (plus the script tags)
js/sim/core.js      physics core: track, beams, materials, tires, cars, skinning
js/render/car.js    car geometry, skinned mesh, B debug overlay
js/render/world.js  procedural textures, terrain/road/barrier chunks
js/game.js          input, cameras, title screen, HUD, main loop
test_sim.js         32 headless physics tests (node test_sim.js)
```

The soft-body simulation (nodes,
beams, plastic deformation, breakage, terrain and cliff physics) runs at
480 Hz in substeps, in plain JavaScript with no dependencies; rendering by
Three.js. The physics core is shared verbatim with a Node test suite
(`node test_sim.js`, 32 tests) that verifies rest stability and node/beam
counts at every preset for all five cars, the 100 km/h head-on crash
sequence at 150/250/500/620 nodes, beam thresholds, cliff falls and
unclimbability, road blending, determinism (including barriers and
defects), the 60-second drive, off-road placement audits, a pothole
drive-over, body subdivision counts, all five cars driving at 250
nodes — and, for every car at every target from 150 to 1000 nodes, a
parked-clearance audit (no chassis node may touch the ground) plus a
no-drag check that the car's driven top speed at 1000 nodes matches its
500-node speed. The suite also locks the beam behaviour described above:
the plastic cap (yield stops at 70% of break displacement, and the beam
still breaks past break strain), the hard displacement limit (a stretched
beam is projected back to exactly the limit, and the limiter is a no-op on
a parked car), elastic hold-together (a bumper displaced half a metre with
deformation disabled springs back to within a centimetre), the steering
direction (a held steer input measurably rotates the car the way the key
says), and wobble decay (after a 0.35 m drop, the shell's internal flex
motion in the final second is down to ≈0.02 m/s RMS — roughly a fifth of
what the undamped shell kept). Six further tests lock the v2.3 systems:
material ordering and the 50 km/h zone-damage pattern (frame and cabin
pristine, crumple zone spent), per-car suspension bounce (second bounce
≤ 40% of the first, every car), tire heating and the warm-vs-cold
braking gap, beam sleep (a settled parked car evaluates **zero** beams
and drifts 0 mm until input, an impact or a shove wakes it), a driving
performance ceiling, and the body-vs-cage skinning mismatch bound.
Performance, measured headlessly in Node: simulating 10 physics-seconds
of driving takes ≈2.8 s for a 500-node car and ≈6.9 s for a 1000-node
car — faster than real time; and a settled parked car costs essentially
nothing at all, because the simulation sleeps instead of staying loaded.
The 1000-node tier is the extreme
opt-in and is the first thing to cost frame rate on weaker hardware.

Ride height, stated plainly: the strut-perch collapse described above is
fixed and test-locked. Measured parked clearance (lowest chassis node,
wheels excluded) is 0.11–0.30 m for every car at every setting from 150
to 1000 nodes, with zero ground contact anywhere; the tightest case is
the SUV at 500 nodes (0.11 m). Driven top speed at 1000 nodes now matches
500 nodes for all five cars. What remains is ordinary suspension: a
parked car settles 30–60 mm onto its springs, because that is what the
springs are for. The 1000-node tier's only real cost is performance, as
noted above.

Note: v1's WebRTC multiplayer is not in this version — it was built for
v1's straight road and does not fit the new world.

## License

Copyright (c) 2026 the author. All rights reserved.

This repository is published for viewing only. No part of this work may be
used, copied, modified, or distributed without prior written permission from
the author.
