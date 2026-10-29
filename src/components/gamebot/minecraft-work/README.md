# Minecraft work scheduler (offline slice)

This package implements **construction scheduling** (claims, materials, workspace envelopes, reconciliation) for GameBot chat tools. It is **not** a real Minecraft driver and **not** multi-bot production construction yet.

## Supported in this milestone

- **Raw block import** (`raw-blocks.mjs`, `fixtures/two-block-diorite.json`): decoded `{position, block_id, properties}` → `kind:block` parts with explicit `depends_on` (two-block floor→stair slice).
- **Block state rotation** (`state-rotate.mjs`) is separate from what this slice will place (`build-scope.mjs`). Rotation turns horizontal `facing` with the same offset as coordinates, swaps `axis` x/z, and keeps `facing` up/down, `axis` y, `half`, and straight `shape`. Corner stair shapes throw. Other properties are copied through. This does not claim to cover every Minecraft state family.
- **This slice places only** `minecraft:polished_diorite` (no facing) and `minecraft:polished_diorite_stairs` with horizontal facing, `half=bottom`, `shape=straight`. Extra properties such as `waterlogged` are kept and must match on read-back. Anything else is refused before placement.
- Deterministic **in-memory simulator** (`simulation.mjs`) with delayed actions, fresh observation, and per-worker positions.
- **World/save scoped** project files (`world_id__project_id.json`); legacy `project_id.json` loads as `legacy_blocked` until bound to a `world_id`.
- **Red carpet handover** offline demo (`red-carpet.mjs`) exercising the same `schedule.mjs` / `loop.mjs` / `store.mjs` paths as `createWorkRuntime`.
- Verified placement progress (block id **and** state) via **fresh observation** after each action; the generic runtime adapter does not mutate local snapshots on `confirmed`.
- `mc_task_claim` and the red-carpet demo both route through **`claimWork` / `scheduledClaim`** (materials + workspace + claim atomically).
- `createWorkTools` uses **`runtime.now()`** when provided (tests/demo injected clocks); background `tick` resolves **world-scoped** running keys and observes via the **active claim holder** when `observeMember` is configured.
- Reconciliation keeps workspace reservations until adapter evidence shows **no pending sim ops** and **worker body/head clear of the envelope**.
- Collected materials decrement **warehouse stock**; carried stock is not available to other workers.
- `mc_work` background **tick** applies loop results inside the serialized store queue (control revision + stale merge); the simulator enforces **operation idempotency** and **authority** at mutation time.
- **Claim material demand** and handover shortage reports count only **observed unfinished** cells (carried stock on departed workers is not warehouse-available).

## Run tests

```bash
node --test src/components/gamebot/minecraft-work/*.test.mjs
```

Two-block closure (offline sim, labeled in test output):

```bash
node --test src/components/gamebot/minecraft-work/two-block-closure.test.mjs src/components/gamebot/minecraft-work/rotation-regression.test.mjs
```

Rotation regression evidence:

- `verification/two-block-rotation/red-reconstructed.txt` is a reconstructed defect reproduction (state passed through unchanged). It is not a historical pre-fix capture.
- `verification/two-block-rotation/red-run.txt` was already in the tree. Its origin cannot be verified, so it is not treated as the pre-fix record.
- `verification/two-block-rotation/green-run.txt` is the rotation test file after the facing fix.

## Real two-block exercise

Not run unless the owner supplies a disposable site, a live Minaret member, and a bridge that advertises both `minecraft.world.place_block` and `minecraft.world.probe_blocks`. The offline oracle `100,64,100` is not a build site. Missing either variable prints the invocation and exits 2. The script does not pick coordinates, spawn items, dig, or change gamemode.

```powershell
$env:MC_TWO_BLOCK_MEMBER_ID = "your-seat-id"
$env:MC_TWO_BLOCK_ANCHOR = '{"dimension":"minecraft:overworld","x":0,"y":64,"z":0,"facing":"east"}'
# Optional ledger. If set, each count must equal the NPC hotbar (slots 0-8). It is not a substitute for the hotbar.
$env:MC_TWO_BLOCK_STOCK = '{"minecraft:polished_diorite":1,"minecraft:polished_diorite_stairs":1}'
$env:GAMEBOT_URL = "http://127.0.0.1:8766"
node src/components/gamebot/minecraft-work/two-block-live.mjs
```

Member id must match `^[a-z0-9][a-z0-9-]{0,31}$`. Before any placement the script probes the support under the floor, both target cells, and the stair's four side neighbors plus the cell above. Targets must be explicit `minecraft:air`. An unloaded cell is unknown, not air. The NPC must be within 4.5 blocks. `nearby_blocks` is not a completion reading.

A task is marked done only when a probe issued after the placement has a newer `probe_seq`, `game_time` at least the action receipt, the anchor dimension, and every target cell's id and properties (including `shape`) match. Mismatch, unknown, denial, or the 50-step cap exits non-zero and leaves the task unfinished. The printed handover keeps cells already verified, the cells still open, shortages, and unresolved operations.

`probe_blocks` and the facing-aware place path are in the NeoForge mod. A previously installed jar does not have them until that mod is rebuilt and the game is loaded with it. This tree does not copy the jar into a live mods folder.

`FacingPlacementTest` runs `StairBlock.getStateForPlacement` inside the NeoForge unit-test harness (Mockito level, not a live world). An isolated up-face click yields the requested horizontal facing, `half=bottom`, `shape=straight`, and `waterlogged=false`, and the same context is used for the second read. That is not a live `BlockItem.place` and not a world read-back.

## Run demo trace

```bash
node --input-type=module -e "import { runRedCarpetHandover } from './src/components/gamebot/minecraft-work/red-carpet.mjs'; runRedCarpetHandover().then(r => console.log(JSON.stringify(r.record, null, 2)));"
```

## Real driver still required

- NeoForge `place_block` / acknowledged actions wired into `createWorkRuntime({ observe, act })`.
- Navigation, fluids, scaffolding planners, and schematic import are out of scope here.
