#requires -Version 7
$ErrorActionPreference = 'Stop'
$repo = 'plures/plureslm-openclaw'

# Epic body
$epicBody = @'
**Epic doc (source of truth):** `epic/EPIC-MEMORY-SUPERIORITY.md`
**Gap analysis:** `GAP-ANALYSIS.md` (+ `GAP-OPENCLAW-MEMORY.md`, `GAP-PLURESDB-SIDE.md`)

Realize pluresLM's latent structural advantage over memory-core as shipped plugin capability,
**augment-then-replace** (memory-core stays the fallback until the graph/reactive tracks are proven).
pluresLM is **not superior today** but **superior-capable**: the PluresDB native binding already
exposes graph (AutoLink/GraphNeighbors/PageRank/Clusters), reactive (agensTimer/agensStateWatch/
subscribe), and constraint (pxOnAction) primitives that a flat SQLite store structurally cannot match.

### Children
- [ ] P0 — Own the memory slot safely (Path B) — **IN FLIGHT** (real sync() write path + slot flip)
- [ ] P1 — Graph-native associative recall (AutoLink + GraphNeighbors) — marquee win
- [ ] P2 — Structural promotion signal (PageRank/cluster) → deep-phase consolidation
- [ ] P3 — Reactive in-DB consolidation (agensTimer + agensStateWatch + subscribe)
- [ ] P4 — Constraint-governed writes (pxOnAction)
- [ ] H  — Headroom token-compression port (agens-brought .px ActionHandler + Hook)

### Rules
`.px`-first (pure logic in PluresDB, IO at the boundary), no stubs (C-NOSTUB-001),
channel-agnostic verification (C-TEST-002), test-before-deploy, verify-closes-loop,
never disable memory-core until the replacement track is proven.
'@

$epicUrl = gh issue create --repo $repo --title 'EPIC: PluresLM Memory Superiority' --label enhancement --body $epicBody
$epicNum = ($epicUrl -split '/')[-1]
Write-Output "EPIC=#$epicNum ($epicUrl)"

function New-Child($title, $body) {
  $full = "$body`n`n---`nParent epic: #$epicNum"
  $url = gh issue create --repo $repo --title $title --label enhancement --body $full
  Write-Output "CHILD=$(($url -split '/')[-1]) :: $title"
}

New-Child 'P1: Graph-native associative recall (AutoLink + GraphNeighbors)' @'
On `sync()`, after `put`, run an AutoLink `.px` procedure to create typed edges between related
memory nodes; at recall, expand hits via GraphNeighbors/GraphPath to surface associatively-related
memory a flat store cannot reach. `.px`-first: linking + expansion are procedures; native only triggers.
Depends on P0 write path. Spike spec: `epic/P1-associative-recall-SPEC.md`. The marquee structural win.
'@

New-Child 'P2: Structural promotion signal (PageRank/cluster) -> deep-phase consolidation' @'
A deep-phase `.px` procedure scoring promotion candidates by GraphPagerank/GraphClusters as an
*evidence signal* feeding a dreaming-style consolidation — additional structural signal alongside an
LLM reflection pass, not a replacement. Depends on P1 (needs the graph edges). Spec: `epic/P2-structural-promotion-SPEC.md`.
'@

New-Child 'P3: Reactive in-DB consolidation (agensTimer + agensStateWatch + subscribe)' @'
Replace the external-cron/heartbeat consolidation assumption with an in-DB reactive sweep: the store
consolidates itself from inside PluresDB (C-PLURES-004 — a write causes reactive procedure execution).
Depends on P0. Combined spike spec: `epic/P3-P4-reactive-governed-SPEC.md`.
'@

New-Child 'P4: Constraint-governed writes (pxOnAction)' @'
Express promotion/redaction/retention rules as `.px` constraints enforced via pxOnAction at memory-write
time: declarative, auditable, reversible governance. Aligns with the Headroom port (also `.px`). Depends
on P0. Combined spike spec: `epic/P3-P4-reactive-governed-SPEC.md`.
'@

New-Child 'H: Headroom token-compression port (agens-brought IP)' @'
Port the pares-agens Headroom capability (already PluresDB-native + `.px`-based) into the pluresLM/OpenClaw
context path: `HeadroomActionHandler` (tiktoken token counting + compression strategies) + `HeadroomHook`
(compresses a ChatMessage list before a model call). Decide home (plugin memory-write compression vs
standalone context hook vs both) in the analysis. Spec: `epic/H-headroom-port-SPEC.md`.
'@

Write-Output 'DONE'
