# Endless Drive — Web Edition v2: Beam Edition

**Play it here: https://a-user-of-python.github.io/endless-drive/**

An endless, randomly generating road with smooth, blended turns — and cars
built the way BeamNG builds them: out of **nodes and beams**.

## What changed in v2.6

Three mechanics adapted from BeamNG.drive's documented JBeam model
(researched from BeamNG's official documentation — the ideas and
their roles are theirs; the numbers are ours, tuned for a 480 Hz
core instead of BeamNG's 2,000 Hz, because their raw stiffness
values assume that rate), plus a detail pass on the models.

- **Support beams** (BeamNG's SUPPORT type): compression-only
  slack limiters. A support exerts *no* force while it is longer
  than 85% of its rest length and acts as a stiff spring-damper in
  compression only below that — it can never pull in tension.
  They guard the configurations a crash tries to reach: each
  (thinned) ring gets top-centre → floor-quarter and bottom-centre
  → roof-quarter limiters, and the cabin band gets longitudinal
  roof → floor limiters. Because they are slack in every normal
  configuration they add no parked stiffness (test 37: zero
  supports engaged on a parked car; tests 35/36 unchanged). What
  they change is the violent fold: dropped upside down onto its
  roof from 1.2 m, the sedan's worst cabin top-row crush is
  **48 mm with limiters vs 222 mm without** (test 38, which builds
  the same car both ways). Counts after the optimisation pass
  below thinned the supported-ring stride at mid/fine grids
  (every ~16 sections instead of ~28): 36–122 supports per car
  by resolution (sedan: 80 @150, 104 @500, 120 @1000) inside
  totals of 796 / 3,828 / 7,755 beams.
- **Band-limited damping** (BeamNG's `dampCutoffHz` idea): beam
  damping force used to be the instantaneous relative velocity ×
  rate — at 480 Hz on stiff beams that signal is mostly step-rate
  noise. The damping force now passes through a per-beam
  first-order low-pass (state in a typed array, cutoff 60 Hz,
  dt-aware coefficient). Real damper motion (shell modes ~3 Hz,
  wheel hop ~10–15 Hz) passes; step-rate jitter is attenuated to
  ~37% (test 39). One deliberate exception: an **impact bypass** —
  if the raw force jumps more than 2.5 kN in a step, the filter
  snaps to it, because delaying genuine crash damping by even a
  few steps measurably deepened the 100 km/h crush (1.38 m with a
  pure filter vs 1.10 m with the bypass — the bypassed build is
  also slightly better than v2.5's unfiltered 1.12–1.15 m). The
  wobble test's flex RMS improved from 0.021 (v2.5) to ~0.003 m/s.
  One scoping note from the optimisation pass: in the hot loop
  the filter runs only on the high-damping beams (c ≥ 1,000
  N·s/m — in this fleet exactly the four strut dampers, whose raw
  force is the one large enough to carry the step-rate noise;
  every other beam's c tops out near 600 and it takes its raw
  damping force, with its filter state still written so it stays
  coherent). The standalone force law (`beamAxialForce`, pinned
  by test 39) is unscoped. Measured effect of the scoping: wobble
  flex RMS 0.0031 → 0.0034 m/s, 100 km/h compression 1.10 →
  1.12 m — both well inside their bands.
- **Pressured struts** (BeamNG's PRESSURED beam idea, simplified):
  this engine's wheels are single nodes — there are no hub/rim
  radial beams — so the term went on the element that actually
  carries the corner load, the strut: an extra outward force
  ∝ pressure × (rest/current length − 1), capped so it can never
  reach the 1/L singularity, and asymmetric (full force while
  shortening, 35% while extending — a symmetric version returned
  its energy into the suspension's second bounce: pickup drop
  test 42% of first compression vs 33% asymmetric, 31% with no
  pressure at all). The corner now stiffens progressively as it
  compresses instead of staying a pure linear spring, and parked
  strut compression eased from 0.928 to 0.937 of rest length
  (test 41 pins the force law: 6× the pure-spring force at 80%
  length, pressure component exactly at its cap at 50%).

**Optimization, measured:** an ablation pass over the driving
loop (beam forces ≈ 45% of the loop, ground queries ≈ 35%) found
the cost was not where the first v2.6 build assumed, and the
fixes are mostly exact — same floats, cheaper storage and fewer
redundant evaluations:

- **Height-only ground queries in the collision pass.** Every
  node, every substep used to pay for a full ground query —
  centre height plus two gradient taps (three terrain-height
  evaluations, nine trig calls) plus surface and normal — but
  the normal is only consumed when the node actually penetrates,
  which is a handful of nodes per substep. The pass now asks for
  the height alone (the identical float the full query's centre
  tap computes) and runs the full query only for penetrating
  nodes. This was the single biggest win (~700 ms of the @500
  test-31 run). The ground scan window also narrowed 40 m →
  20 m (the car's nodes are never more than ~15 m of along-track
  from its centre), and `defectOffset` got an exact fast reject
  (outside a defect bucket's s-window the offset is identically
  zero).
- **Flat storage for the hot loop.** The force buffers are now
  flat `Float64Array`s refilled from a gravity template with one
  typed-array copy per substep (they were arrays of per-node
  objects), and every per-beam constant the force loop reads —
  rates, damping, yield displacement, pressure, engagement
  geometry, force-buffer offsets, node pos/vel references — is
  copied once at build time into flat arrays, so
  `addBeamForces` and `enforceBeamLimits` read array slots
  instead of property chains. `beamEvals` accumulates in a local.
- **Guarded plasticity bookkeeping.** `checkDeform` is a strict
  no-op below the deform strain, so the loop only calls it when
  the strain it already measured passes that threshold (the
  break threshold is higher still for every material) — most
  beams, most substeps, skip the call.
- **Thinned supports and scoped damping filter** (see the two
  sections above): supports at 500/1000 nodes dropped 160 → 104
  and 176 → 120 per sedan, and the damping filter's per-beam
  load/blend/store now runs only on the struts.

On the render side, `computeVertexNormals` (per mesh, per frame)
is replaced by a hand-rolled flat-normal pass into the existing
normal attribute — for this non-indexed geometry the face normal
*is* the vertex normal, so the parked picture is identical, with
no per-frame allocation — and the skin meshes no longer recompose
their (identity) matrices.

**Final perf, test-31 procedure standalone, medians of 3 reps,
both trees measured back-to-back in one session on this shared
box:** at 500 nodes **v2.6 2,472 ms vs v2.5 2,872 ms** per 10
physics-seconds (−14%); at 1000 nodes **v2.6 5,038 ms vs v2.5
6,017 ms** (−16%). The full suite passes **41/41**, with test 31
in-suite at 2,455 ms @500 (ceiling 3,200) and 5,317 ms @1000
(ceiling 7,200) — the earlier v2.6 build failed that guard
in-suite at ~3,300 ms. Beam evaluations per driving frame at
820 nodes: 101,264 (v2.5: 99,728; +1.5% — the remaining support
beams, most of which early-out). The only physics that moved is
the damping-filter scoping's: 100 km/h compression 1.10 →
1.12 m, wobble flex RMS 0.0031 → 0.0034 m/s, test 34's
sacrificial share 86% → 85% — all inside their bands, and the
parked matrices (tests 35/36) and the roof-crush margin
(test 38: −48 mm vs −222 mm) are byte-identical to before the
pass. No test assertion was changed or weakened.

**Model detail:** the bodies were still one flat prism per panel.
Now: segmented hood and trunk (two angled panels each), windshield
header + A-pillar trims + wiper line, front valance / splitter /
fog lights, a full-width tail strip (new deep-red material) +
rear valance / diffuser / plate / muffler, rocker trim, door shut
lines and handles, roof antenna; per car — pickup bed rails and a
rear-window header, SUV rear spoiler lip (roof rails kept), coupe
ducktail lip, muscle centre-stripe pair over hood/roof/trunk.
Wheels: 8 spokes instead of 5, a brake disc behind them, hub cap,
slightly wider tire. Every added piece is ordinary bucket
geometry, so it is skinned to the cage and crumples with the body
(test 40 anchors every vertex). Skinned vertex totals at the
master plan: sedan 1,044 → **1,980**, pickup 1,188 → **2,160**,
coupe 1,224 → **2,196**, SUV 1,080 → **2,016**, muscle 1,188 →
**2,340** (+79–97%); at the game's render subdivision that is
17,820–21,060 vertices per car.

## What changed in v2.5

Two reports from driving v2.4: at high beam resolutions the shell
**sagged and draped** — a visible W-dip across the roof's front edge
and a crease down the trunk — "the elasticity didn't go through";
and the game was **a lot laggier** than v2.3.

The sag was measured before it was fixed (parked on the real track,
every node's height compared against the car's own frame): at 820
nodes the muscle car's roof-front ring dipped ~140 mm corner-to-centre
and its end rings ~200 mm, while the same car at 150 nodes sat within
a few mm. Three causes, all in the ring structure:

- **The ring chords changed geometry with resolution.** The chords
  that triangulate each ring stepped a fixed 2 nodes. At 10 nodes per
  ring that chord lands on the upper *side* nodes — a steep diagonal
  that holds the roof centre up. At 18 nodes per ring it lands on the
  flat top edge itself, leaving the centre held only by horizontal
  beams, which have no first-order stiffness against a vertical load.
  The chord step now scales with the ring size (⅓ of the ring), so a
  chord lands at the same physical place at every resolution, and
  fine grids keep the local step-2 chords as a second family, so
  concentrated loads (the strut-mount links land on the floor
  corners) average out across the ring instead of dragging single
  nodes by ~40 mm.
- **Ring beams had no series compensation.** Longitudinal beams get
  stiffer per-beam as sections multiply (they are series chains);
  ring beams got nothing, so each ring — a thinner slice of the
  shell at fine grids — was the softest path in the cage. Ring beams
  now carry a matching factor (√ of the section-count ratio, capped).
- **The end rings are free ends.** First and last rings have
  neighbours on one side only; their top centres sagged even at 150
  nodes (the coupe's trunk ring: 43 mm). They now get bulkhead
  chords from the top-centre node down to the floor quarters.

A new test (36) locks the parked shape in: within every ring of every
car at 150/500/820/1000 nodes, the top row must sit level to 30 mm,
and the rendered roof front row of the 820-node muscle car to 40 mm.
Measured on this build: worst ring in the whole matrix is the coupe
at 820 nodes, **21 mm**; most cars sit at 1–13 mm; the skin roof row
measures **1 mm** (v2.4: ~110 mm). The v2.4 crash behaviour is
unchanged where it matters — same test thresholds, all passing:
100 km/h integrity 85%, zero broken frame/cabin beams, 50 km/h
frame/cabin deformation 0/0.

The lag had two sources. Beam evaluations per frame while driving an
820-node car were 130k (v2.4's extra bracing plus a 3× beam
subcycle past 500 nodes). The subcycle is now sized from the built
cage instead of the node target: 2 for almost every car, raised to
3 only when the cage's stiffest nodal frequency (√(summed beam
rate ÷ node mass), worst node) says 2 runs too close to the
integration edge — in the current fleet only the 1000-node SUV
(lightest roof nodes) needs 3. And the rendered skin no longer
subdivides past 3× (9× base facets): at 820 nodes it was building
25× facets and recomputing every vertex normal every frame, for a
cage the skin already follows exactly through its cell anchors.
Result: beam evaluations per driving frame at 820 nodes
**130k → 100k (−24%)**, and the suite's driving perf guard measures
6,648 ms per 10 physics-seconds at 1000 nodes (was ~6,890 ms at
v2.4's beam count, now with ~15% more beams). One honest trade: at
500 nodes the extra chord family costs ~10% of driving-loop time
(~3,150 ms vs ~2,830 ms per 10 s, still inside the test ceiling) —
that is where the 500-node sag went (worst car 54 mm → 6 mm).

## What changed in v2.4

Two reports drove this release: the soft-body cars **folded instead of
crushing** ("it's like the frame does not exist, and the materials are
made of wet sponge"), and the scene **never rendered in Firefox**.

**Real internal framing.** The cage used to be a single shell — the
"frame" was only a material label on the low beams. It now has actual
structure inside the shell: sill rails along both sides, floor
cross-members at every section, roof bars closing the cabin cell, an
upper load path along the shoulders of the overhangs, and a second
stage of bumper rails landing on the second section. Every side quad
also has **both** diagonals now: the old alternating single diagonal
braces a quad against shear in only one direction, and measurement
showed the sections rotating through the unbraced direction and
telescoping into the cabin at the firewall. Materials were retuned to
match — panels tear far less readily, crumple zones yield later and
fold shorter, frame/cabin plastic travel is cut hard, and crumple
strength is staged (softest at the tip, strongest at the cabin edge).

Measured on the sedan by the test suite: at 50 km/h head-on the
cabin's own deformation is ~0.07 m RMS (was 0.46 m) and the firewall
gap shortens 0.03 m (was 0.53 m); at 100 km/h integrity is 85% (was
77%) with **zero** broken frame or cabin beams. Three new tests lock
this in: a fold test (the crush must run front-to-back, not sideways
or into the cabin), a 100 km/h zone-order test, and a parked
stability + sleep check for every car at every resolution.

**Firefox / startup hardening.** The renderer now tries progressively
plainer WebGL setups before giving up (browsers differ in which
context options they accept, and the old single attempt failed
silently), a failed three.js download falls back to a second CDN, a
lost graphics context says so on screen, and any startup failure
shows a plain-words message with the technical error instead of a
blank page. Optional visuals degrade instead of killing the scene:
chunk building and the blob shadow now fail soft, like the
photo-texture upgrade already did.

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
breaks doing the absorbing while the frame and cabin take no deformed
or broken beams at all. Every beam also tracks its live
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
adjacent sections are joined by longitudinal beams and panel diagonals —
both diagonals on the side quads since v2.4, plus the internal framing
described above — and at higher resolutions extra "skip" chord families
run two and three sections apart. On top of the grid sit two bumper nodes, four
suspension mounts, and four wheel nodes with a strut and triangulated
links each — no distance-based auto-connect anywhere; every beam is
placed by the generator and can be counted.

## Beam resolution — per car

Each car has its **own resolution setting: a target node count**. The grid
generator picks the section/ring layout that lands the total node count
( grid + bumpers + mounts + wheels ) on the target.

- **NORMAL — 150 nodes** (about 716 beams)
- **HIGH — 250 nodes** (about 1,626 beams)
- **ULTRA — 500 nodes** (about 3,724 beams)
- **ULTRA+ — past 500**, `]` keeps adding **+10 nodes** per press, up to
  **1000 nodes** (about 7,640 beams)

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
density, so the car never turns into a blob) up to 3×3 in the built mesh.
(The bucket builder itself scales to 6×6 — the test suite locks that
range — but since v2.5 the game caps the built mesh at 3×: past that the
extra facets cost real frame time in per-frame normal recomputation and
buy nothing the eye can see, because the skin follows the cage through
its cell anchors either way.) Body vertices are skinned to the cage
**cell** they belong to (section pair × ring segment), with their offset
re-applied through the cell's own deformed frame — so in a crash the
panels move with their own piece of cage instead of blending across the
car, and the body stays matched to the nodes (the test suite measures
body-vs-cage mismatch after a 100 km/h crash; the cell skinning roughly
halves it versus the old 3-nearest-nodes blend). Triangle counts per car
run from 348–408 at 150 nodes to 3,132–3,672 at the 3× cap.

Under the hood, finer cages need softer per-beam rates to stay stable at
480 Hz; beam forces are therefore subcycled — twice per step at every
target above Normal, and three times for a cage whose stiffest nodal
frequency (measured at build time from the actual beams and node
masses) runs too close to the integration edge at two; in the current
fleet only the 1000-node SUV needs the third cycle — so the structure
can stay stiff without ringing, and the parallel chord families keep
the shell from sagging under its own weight at fine resolutions. Each strut mount is also
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
test_sim.js         36 headless physics tests (node test_sim.js)
```

The soft-body simulation (nodes,
beams, plastic deformation, breakage, terrain and cliff physics) runs at
480 Hz in substeps, in plain JavaScript with no dependencies; rendering by
Three.js. The physics core is shared verbatim with a Node test suite
(`node test_sim.js`, 36 tests) that verifies rest stability and node/beam
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
motion in the final second is down to ≈0.001 m/s RMS). Three further
tests lock the v2.4 structure: the fold test (a 50 km/h head-on must
crush front-to-back — cabin deformation ≈0.07 m RMS, firewall intrusion
0.03 m, sideways section motion under a centimetre), the 100 km/h
zone-order test (sacrificial zones absorb ≥75% of all beam damage, no
frame or cabin beam breaks, integrity ≥82%), and the parked matrix
(every car at every resolution settles undamaged, falls asleep, and
then evaluates zero beams). Six further tests lock the v2.3 systems:
material ordering and the 50 km/h zone-damage pattern (frame and cabin
pristine, crumple zone spent), per-car suspension bounce (second bounce
≤ 40% of the first, every car), tire heating and the warm-vs-cold
braking gap, beam sleep (a settled parked car evaluates **zero** beams
and drifts 0 mm until input, an impact or a shove wakes it), a driving
performance ceiling, and the body-vs-cage skinning mismatch bound.
A further test locks the v2.5 parked shape: within every ring of every
car at 150/500/820/1000 nodes the top row must sit level to 30 mm in
the car's own frame, and the rendered roof front row of the 820-node
muscle car to 40 mm (this build measures a 21 mm worst ring and a
1 mm roof row).
Performance, measured headlessly in Node: simulating 10 physics-seconds
of driving takes ≈3.1 s for a 500-node car and ≈6.6 s for a 1000-node
car — faster than real time; and a settled parked car costs essentially
nothing at all, because the simulation sleeps instead of staying loaded.
The 1000-node tier is the extreme
opt-in and is the first thing to cost frame rate on weaker hardware.

Ride height, stated plainly: the strut-perch collapse described above is
fixed and test-locked. Measured parked clearance (lowest chassis node,
wheels excluded) is 0.14–0.31 m for every car at every setting from 150
to 1000 nodes, with zero ground contact anywhere; the tightest case is
the SUV at 500 nodes (0.14 m). Driven top speed at 1000 nodes now matches
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
