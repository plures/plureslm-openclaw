# OpenClaw Built-in Memory — Capability Inventory

> Read-only research extract from the authoritative local docs at
> `C:\ProgramData\global-npm\node_modules\openclaw\docs`.
> Purpose: feed a gap analysis comparing **OpenClaw built-in memory (memory-core)**
> vs. a **PluresDB-backed plugin (pluresLM)**. No code was changed.
>
> Doc files read in full: `concepts/memory.md`, `concepts/memory-builtin.md`,
> `concepts/active-memory.md`, `concepts/memory-search.md`, `concepts/dreaming.md`,
> `concepts/memory-qmd.md`, `concepts/memory-honcho.md`, `reference/memory-config.md`,
> `plugins/reference/memory-core.md`, `plugins/reference/memory-lancedb.md`,
> `plugins/reference/memory-wiki.md`, `cli/memory.md`.

---

## 1) Memory architecture (slot model)

**Slot + ownership**
- Memory is a **plugin slot**: `plugins.slots.memory`. The default owner is the
  bundled **`memory-core`** plugin (package `@openclaw/memory-core`, "included in
  OpenClaw"). The `memory` CLI namespace is "available when `plugins.slots.memory`
  selects `memory-core` (the default); other memory plugins expose their own CLI
  namespaces." (`cli/memory.md`)
- Alternative slot owners are pluggable: **`memory-lancedb`** (exposes
  `memory_recall`), **QMD** (`memory.backend: "qmd"` — a sidecar, not a slot
  plugin per se), and **Honcho** (separate service plugin). Active Memory adapts
  its recall toolset by slot: `["memory_search","memory_get"]` for memory-core,
  `["memory_recall"]` when `plugins.slots.memory` is `memory-lancedb`.
  (`concepts/active-memory.md`)

**Capability contract (what a memory plugin provides)**
The agent-facing surface the active plugin must expose:
- **`memory_search`** — semantic + keyword recall over indexed notes.
- **`memory_get`** — read a specific file or line range.
  ("Both tools are provided by the active memory plugin (default: `memory-core`)."
  — `concepts/memory.md`)
- Plus the operator/CLI surface (`status`, `index`, `search`, `promote`,
  `promote-explain`, `rem-harness`, dreaming sweep) — see §6.
- The flush/sync write-path and a flush-plan resolver are internal to the plugin
  (the docs expose `sync` cadence + dreaming/promotion as the durable-write path;
  see §4–§5). The docs do not enumerate a literal `flushPlanResolver` symbol —
  the public contract is the tool + CLI surface above.

**Public artifacts (the durable, human-facing memory files)**
Plain Markdown in the agent workspace (default `~/.openclaw/workspace`):
- **`MEMORY.md`** — long-term curated layer; loaded at the start of every DM
  session. "If you want your agent to remember something, just ask it."
- **`memory/YYYY-MM-DD.md`** (and slugged `memory/YYYY-MM-DD-<slug>.md`) — daily
  working notes; today + yesterday auto-loaded; all indexed for
  `memory_search`/`memory_get` but **not** injected every turn.
- **`DREAMS.md`** (optional) — Dream Diary + dreaming-sweep summaries for human
  review (incl. grounded historical backfill). (`concepts/memory.md`)

**Corpus supplements**
- **`memorySearch.extraPaths`** — additional dirs/files (`.md`, recursive) to
  index beyond workspace memory.
- **`memory-wiki`** companion plugin — compiles durable knowledge into a wiki
  vault (deterministic pages, structured claims/evidence, contradiction &
  freshness tracking, dashboards, compiled digests; tools `wiki_search`,
  `wiki_get`, `wiki_apply`, `wiki_lint`). It does **not** replace the active
  memory plugin: "The active memory plugin still owns recall, promotion, and
  dreaming. `memory-wiki` adds a provenance-rich knowledge layer beside it."
  (`concepts/memory.md`, `plugins/reference/memory-wiki.md`)

---

## 2) Storage + search

**Storage (built-in `memory-core`)**
- **SQLite, per-agent.** "It stores your memory index in a per-agent SQLite
  database." Index location:
  `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. Source of truth is
  still the Markdown files; SQLite is the *index*. (`concepts/memory-builtin.md`,
  `reference/memory-config.md`)
- **Chunking:** `MEMORY.md` and `memory/*.md` indexed into ~400-token chunks with
  80-token overlap. (`concepts/memory-builtin.md`)
- **WAL maintenance:** SQLite WAL sidecars bounded with periodic + shutdown
  checkpoints.
- **File watching:** debounced reindex on change (**1.5s**).
- **Auto-reindex:** entire index rebuilt automatically when embedding provider,
  model, or chunking config changes. On-demand: `openclaw memory index --force`.
- **Embedding cache:** `cache.enabled: true` (default), `cache.maxEntries: 50000`
  — avoids re-embedding unchanged text on reindex/transcript updates.
- **FTS tokenizer:** `store.fts.tokenizer` default `unicode61` (or `trigram`,
  which gives CJK support). (`reference/memory-config.md`)

**Search modes**
- **Hybrid by default** when an embedding provider is configured: two retrieval
  paths run in parallel and merge —
  - **Vector search** (semantic similarity), and
  - **BM25 keyword search** (FTS5, exact IDs/error strings/config keys).
  "If only one path is available, the other runs alone." (`concepts/memory-search.md`)
- **sqlite-vec acceleration** (`store.vector.enabled: true`, default) for
  in-DB vector queries; **falls back to in-process cosine similarity** when
  sqlite-vec can't load. `--deep` status reports vector store vs. embeddings
  readiness separately. (`concepts/memory-builtin.md`, `reference/memory-config.md`)
- **FTS-only mode**: `provider: "none"` (deliberate keyword-only). Note the
  **fail-closed** rule: an explicit *remote* provider that is unavailable at
  runtime makes `memory_search` report **unavailable** rather than silently
  degrading to FTS. (`concepts/memory-search.md`)
- **QMD backend** adds `searchMode` `search` (BM25-only) / `vsearch` / `query`,
  plus **reranking + query expansion** (its key differentiators). (`concepts/memory-qmd.md`)

**Hybrid tuning (config)**
`memorySearch.query.hybrid`: `vectorWeight` 0.7, `textWeight` 0.3,
`candidateMultiplier` 4; **MMR** (`mmr.enabled` false, `mmr.lambda` 0.7 —
diversity); **temporal decay** (`temporalDecay.enabled` false,
`halfLifeDays` 30 — recency; evergreen `MEMORY.md`/non-dated files never decayed).
(`reference/memory-config.md`)

**Embedding providers supported** (built-in engine)
`bedrock`, `deepinfra` (default `BAAI/bge-m3`), `gemini` (multimodal image+audio),
`github-copilot` (Copilot sub), `local` (`@openclaw/llama-cpp-provider`, GGUF
~0.6 GB, default `embeddinggemma-300m-qat-Q8_0.gguf`), `mistral`, `ollama`,
`openai` (**default**, `text-embedding-3-small`), `openai-compatible`, `voyage`.
Selected via `agents.defaults.memorySearch.provider`. (`concepts/memory-builtin.md`,
`concepts/memory-search.md`, `reference/memory-config.md`)

**Citations**
`memory.citations` (`auto` default / `on` / `off`) → appends
`Source: <path#line>` footer to snippets (path still passed internally when off).
(`reference/memory-config.md`)

**Session-transcript indexing (experimental, opt-in)**
- Built-in: `memorySearch.experimental.sessionMemory: false`; add `"sessions"` to
  `memorySearch.sources` (default `["memory"]`); reindex thresholds
  `sync.sessions.deltaBytes` 100000, `sync.sessions.deltaMessages` 50.
  "Runs asynchronously. Results can be slightly stale." (`reference/memory-config.md`)
- QMD: `memory.qmd.sessions.enabled` → sanitized User/Assistant turns into a
  dedicated collection under `~/.openclaw/agents/<id>/qmd/sessions/`.
- **Multimodal** (Gemini Embedding 2 only, `extraPaths` only):
  `multimodal.enabled`, `modalities` (`image`/`audio`/`all`), `maxFileBytes`
  10000000; requires `gemini-embedding-2-preview`, `fallback: "none"`.

---

## 3) Active / working memory

**Bootstrap injection (the working set)**
- `MEMORY.md` is the **compact curated layer loaded at the start of every DM
  session**; daily notes for **today and yesterday** are auto-loaded.
  Slugged daily variants (e.g. written by the session-memory hook on `/new`/`/reset`)
  are now picked up alongside the date-only file. (`concepts/memory.md`)
- Daily `memory/*.md` are **indexed but not injected into the normal bootstrap
  prompt on every turn** — they surface via `memory_search`/`memory_get`.

**Token budgeting / compaction**
- "If `MEMORY.md` grows past the bootstrap file budget, OpenClaw keeps the file on
  disk intact but **truncates the copy injected into the model context**." That is
  a signal to move detail back to `memory/*.md` or raise bootstrap limits.
  Inspect with `/context list`, `/context detail`, or `openclaw doctor` (raw vs.
  injected sizes + truncation status). (`concepts/memory.md`)

**Active Memory (optional plugin) — pre-reply recall sub-agent**
- A separate, **opt-in plugin** (`plugins.entries.active-memory`), distinct from
  the storage slot. It is a **blocking memory sub-agent that runs before the main
  reply** for eligible interactive persistent chat sessions, giving "one bounded
  chance to surface relevant memory before the main reply is generated."
- Two gates: (1) plugin enabled + agent id in `config.agents`; (2) strict runtime
  eligibility (allowed chat type + eligible interactive persistent chat session).
  Does **not** run for headless one-shots, heartbeat/background, generic
  `agent-command`, or sub-agent/internal execution.
- Injects a **hidden untrusted `<active_memory_plugin>` system-context prefix**
  (returns `NONE` when weak); not shown in the client reply.
- Knobs: `queryMode` (`message`/`recent`/`full`), `promptStyle`
  (`balanced`/`strict`/`contextual`/`recall-heavy`/`precision-heavy`/`preference-only`),
  `timeoutMs` (cap 120000), `maxSummaryChars`, `toolsAllow`, model fallback
  (`model` → session model → agent primary → `modelFallback`), `thinking`
  (default `off`), `setupGraceTimeoutMs` (cold-start grace).
  (`concepts/active-memory.md`)
- Action-sensitive memory guidance: capture *when it is safe to act* (approval,
  expiry, handoff, owner authority) — but "Memory can preserve approval context,
  but it does not enforce policy." Short-lived inferred follow-ups go to
  **commitments**; exact reminders to **scheduled tasks**. (`concepts/memory.md`)

---

## 4) Flush / write path (how content gets INTO memory)

The durable write path is **not** a continuous append from chat. Two mechanisms:

**(a) Index sync (makes files searchable; does not author new facts)**
- A `memorySearch.sync` pipeline (re)indexes the Markdown files. Triggers visible
  in docs: **file-watch** (debounced 1.5s reindex), **auto-reindex** on
  provider/model/chunking change, **search-time bootstrap** (logs reference
  `memory sync failed (search-bootstrap)`), and **forced**
  (`openclaw memory index --force`). Session-transcript sync uses byte/message
  deltas (`sync.sessions.deltaBytes` 100000, `deltaMessages` 50).
  Inline embedding batch timeout: `sync.embeddingBatchTimeoutSeconds` (default
  600s local/self-hosted, 120s hosted). (`concepts/memory-builtin.md`,
  `reference/memory-config.md`, `concepts/active-memory.md`)

**(b) Promotion / dreaming (authors durable `MEMORY.md` entries) — see §5**
- The mechanism that summarizes short-term signal into durable memory is
  **promotion** (manual `openclaw memory promote`) and its automated form, the
  **dreaming deep phase**. Only the **deep phase / `memory promote --apply`**
  writes to `MEMORY.md`. (`concepts/dreaming.md`, `cli/memory.md`)

**Flush-plan-style thresholds (the "what gets promoted vs. left in daily notes")**
These are the closest analogue to a flush plan — deep-phase gates that decide
durable writes. Quoted defaults from `cli/memory.md`:

> "**Deep thresholds**: `minScore=0.8`, `minRecallCount=3`, `minUniqueQueries=3`,
> `recencyHalfLifeDays=14`, `maxAgeDays=30`"

And the promoted-snippet size cap from `reference/memory-config.md`:

> "`phases.deep.maxPromotedSnippetTokens` … default `160` … Maximum estimated
> tokens kept from each short-term recall snippet promoted into `MEMORY.md`;
> provenance metadata remains visible"

**Verbatim vs. summarized**
- Daily notes / transcripts are stored **verbatim** (as written / sanitized).
- Promotion is **selective + bounded**: it appends ranked short-term recall
  snippets (clamped to `maxPromotedSnippetTokens` ≈160) into `MEMORY.md`, with
  ranking provenance kept visible — i.e. it is extractive promotion, not a free
  LLM rewrite of memory. (`concepts/dreaming.md`)
- The **Dream Diary** is the LLM-authored narrative, but it is written to
  `DREAMS.md`, **never** to `MEMORY.md`, and is explicitly excluded from
  promotion (see §5).

---

## 5) DREAMING (deep dive) — the centerpiece

> Source files for this section: `concepts/dreaming.md`, `reference/memory-config.md`
> (§Dreaming), `cli/memory.md` (§Dreaming).

### 5.1 What it is / what it does
> "Dreaming is the **background memory consolidation system** in `memory-core`. It
> helps OpenClaw **move strong short-term signals into durable memory** while
> keeping the process explainable and reviewable." (`concepts/dreaming.md`)

It does **consolidation + selective promotion + reflection**, via three
cooperative internal phases (not user-selectable "modes"):

| Phase | Purpose                                   | Durable write     |
| ----- | ----------------------------------------- | ----------------- |
| Light | Sort and stage recent short-term material | No                |
| Deep  | Score and promote durable candidates      | Yes (`MEMORY.md`) |
| REM   | Reflect on themes and recurring ideas     | No                |

(table quoted verbatim from `concepts/dreaming.md`)

- **Light phase** "ingests recent daily memory signals and recall traces, dedupes
  them, and stages candidate lines." Reads short-term recall state, recent daily
  files, and **redacted session transcripts when available**. Writes a managed
  `## Light Sleep` block; records reinforcement signals; **never writes
  `MEMORY.md`.**
- **Deep phase** "decides what becomes long-term memory." Ranks candidates with
  weighted scoring + threshold gates; requires `minScore`, `minRecallCount`,
  `minUniqueQueries`; **rehydrates snippets from live daily files before writing,
  so stale/deleted snippets are skipped**; appends promoted entries to
  `MEMORY.md`; writes a `## Deep Sleep` summary to `DREAMS.md` and optionally
  `memory/dreaming/deep/YYYY-MM-DD.md`.
- **REM phase** "extracts patterns and reflective signals." Builds theme/reflection
  summaries; writes a managed `## REM Sleep` block; records REM reinforcement
  signals used by deep ranking; **never writes `MEMORY.md`.**

### 5.2 When it triggers
- **Opt-in, disabled by default.** > "Dreaming is **opt-in** and disabled by
  default." (`concepts/dreaming.md`)
- **One managed cron sweep** when enabled: > "When enabled, `memory-core`
  auto-manages one cron job for a full dreaming sweep. Each sweep runs phases in
  order: **light → REM → deep**." Default cadence
  **`dreaming.frequency = "0 3 * * *"`** (daily 03:00). (`concepts/dreaming.md`)
- **Heartbeat-driven**: the managed cron is driven by the **default agent
  heartbeat**. > "If `openclaw memory status` reports `Dreaming status: blocked`,
  the managed cron exists but the default agent heartbeat is not firing. Check
  that heartbeat is enabled for the default agent and that its target is not
  `none`." (`concepts/dreaming.md`)
- **Manual** entry points: `/dreaming on|off|status|help` (chat) and
  `openclaw memory promote [--apply]` / `openclaw memory rem-harness` (CLI).
  "Manual `memory promote` uses deep-phase thresholds by default unless overridden
  with CLI flags." (`concepts/dreaming.md`, `cli/memory.md`)
- **Fan-out**: "The sweep includes the primary runtime workspace and any
  configured agent workspaces, deduped by path." (`concepts/dreaming.md`)

### 5.3 What it reads / what it writes
- **Reads:** short-term recall state, recent daily `memory/YYYY-MM-DD.md`, and
  **redacted session transcripts** ("Personal and sensitive content is redacted
  before ingestion."). (`concepts/dreaming.md`)
- **Writes machine state** to **`memory/.dreams/`** (recall store, phase signals
  incl. `memory/.dreams/phase-signals.json`, ingestion checkpoints, locks).
- **Writes human-readable** output to **`DREAMS.md`** (or existing `dreams.md`)
  and optional per-phase reports `memory/dreaming/<phase>/YYYY-MM-DD.md`.
- **Durable promotion writes ONLY to `MEMORY.md`** (deep phase only).
  > "Long-term promotion still writes only to `MEMORY.md`." (`concepts/dreaming.md`)

### 5.4 Deep ranking signals (verbatim weights)
> Six weighted base signals + phase reinforcement (`concepts/dreaming.md`):

| Signal              | Weight | Description                                       |
| ------------------- | ------ | ------------------------------------------------- |
| Frequency           | 0.24   | How many short-term signals the entry accumulated |
| Relevance           | 0.30   | Average retrieval quality for the entry           |
| Query diversity     | 0.15   | Distinct query/day contexts that surfaced it      |
| Recency             | 0.15   | Time-decayed freshness score                      |
| Consolidation       | 0.10   | Multi-day recurrence strength                     |
| Conceptual richness | 0.06   | Concept-tag density from snippet/path             |

"Light and REM phase hits add a small recency-decayed boost from
`memory/.dreams/phase-signals.json`."

### 5.5 Dream Diary (LLM narrative) + model/prompt
> "After each phase has enough material, `memory-core` runs a **best-effort
> background subagent turn** and appends a short diary entry. It uses the
> **default runtime model unless `dreaming.model` is configured**. If the
> configured model is unavailable, Dream Diary retries once with the session
> default model." (`concepts/dreaming.md`)
- The docs do **not** publish the exact dreaming prompt text — it is internal.
  The narrative is generated by a subagent turn; phase ranking is deterministic
  weighted scoring (not an LLM call).
- **Crucially excluded from promotion:** > "This diary is for human reading in the
  Dreams UI, not a promotion source. Dreaming-generated diary/report artifacts are
  excluded from short-term promotion. Only grounded memory snippets are eligible
  to promote into `MEMORY.md`." (`concepts/dreaming.md`)
- **Trust gate on the model override:** > "`dreaming.model` requires
  `plugins.entries.memory-core.subagent.allowModelOverride: true`. To restrict it,
  also set `plugins.entries.memory-core.subagent.allowedModels`. Trust or
  allowlist failures stay visible instead of falling back silently; the retry only
  covers model-unavailable errors." (`concepts/dreaming.md`)

### 5.6 Grounded historical backfill lane
A reversible replay lane for review/recovery (`concepts/dreaming.md`, `cli/memory.md`):
- `memory rem-harness --path ... --grounded` — preview grounded diary output from
  historical `YYYY-MM-DD.md` notes (no writes).
- `memory rem-backfill --path ...` — write **reversible** grounded diary entries
  into `DREAMS.md`.
- `memory rem-backfill --path ... --stage-short-term` — stage grounded durable
  candidates into the same short-term evidence store the normal deep phase uses.
- `memory rem-backfill --rollback` / `--rollback-short-term` — remove those
  artifacts without touching ordinary diary entries / live short-term recall.
- Control UI **Dreams** scene mirrors this with a distinct **grounded lane**.

### 5.7 Shadow trial (report-only, not yet production)
> "Shadow-trial results can be layered on top of that base score as a **review
> signal before any durable write**. A helpful trial gives the candidate a small
> bounded boost, a neutral trial keeps it deferred, and a harmful trial marks it
> as rejected for that scoring pass. This signal is **still report-only**: it can
> change candidate ordering or review metadata, but it **does not write to
> `MEMORY.md` or promote the candidate by itself**." (`concepts/dreaming.md`)
- QA Lab carries a **report-only** scenario exploring a future shadow trial
  (compare baseline answer vs. candidate-memory answer -> local report with
  verdict/reason/risk flags). "It does **not** add production shadow-trial
  behavior or change the deep-phase promotion engine." The `memory-core`
  shadow-trial runner writes a report with `promotion action: report-only`;
  helpful->`promote`, neutral->`defer`, harmful->`reject` recommendations -- "none of
  those recommendations writes to `MEMORY.md` or applies deep-phase promotion."
  (`concepts/dreaming.md`)

### 5.8 Dreaming config surface (verbatim keys)
All under `plugins.entries.memory-core.config.dreaming` (`reference/memory-config.md`):

| Key                                    | Type      | Default       | Meaning                                                              |
| -------------------------------------- | --------- | ------------- | -------------------------------------------------------------------- |
| `enabled`                              | `boolean` | `false`       | Enable/disable dreaming entirely                                     |
| `frequency`                            | `string`  | `0 3 * * *`   | Cron cadence for the full sweep                                      |
| `timezone`                             | `string`  | --            | Timezone for the sweep cron (shown in quick-start)                   |
| `model`                                | `string`  | default model | Optional Dream Diary subagent model override (requires trust gate)   |
| `phases.deep.maxPromotedSnippetTokens` | `number`  | `160`         | Max tokens kept per promoted short-term snippet; provenance kept     |

> "Most phase policy, thresholds, and storage behavior are **internal
> implementation details**." Beyond `enabled`/`frequency`/`timezone`/`model`/
> `maxPromotedSnippetTokens`, deep-phase policy is internal; use `memory promote`
> CLI flags for one-off threshold overrides. (`reference/memory-config.md`, `cli/memory.md`)

### 5.9 Dreams UI
Gateway **Dreams** tab shows: enabled state; phase-level status + managed-sweep
presence; short-term / grounded / signal / promoted-today counts; next scheduled
run; grounded Scene lane; expandable Dream Diary reader (backed by
`doctor.memory.dreamDiary`). (`concepts/dreaming.md`)

---

## 6) Operator / CLI surface (`openclaw memory`)

Provided by `memory-core` (other slot plugins ship their own namespaces). (`cli/memory.md`)

| Command | What it does |
| --- | --- |
| `memory status` | Fast index/availability check. Reports `Dreaming status: blocked` when the heartbeat-driven cron isn't firing. |
| `memory status --deep` | Probe local vector-store, embedding-provider, and semantic vector-search readiness (separately). QMD `searchMode:"search"` skips vector probes even with `--deep`. |
| `memory status --index` | Reindex if the store is dirty (implies `--deep`). |
| `memory status --fix` | Repair stale recall locks + normalize promotion metadata. |
| `memory status --json / --agent <id> / --verbose` | JSON / scope to one agent / detailed probe logs. |
| `memory index --force` | Full reindex (also the stale-results fix). |
| `memory index --agent <id> --verbose` | Per-phase index detail (provider, model, sources, batch activity). |
| `memory search [query] / --query <text>` | Run recall. `--max-results`, `--min-score`, `--agent`, `--json` (`--query` wins if both). |
| `memory promote [--apply]` | Preview (default) or write promotions to `MEMORY.md`. `--limit`, `--min-score`, `--min-recall-count`, `--min-unique-queries`, `--include-promoted`, `--json`, `--agent`. Deep-phase thresholds by default. |
| `memory promote-explain <selector>` | Explain why a candidate would/wouldn't promote (score breakdown). `--include-promoted`, `--json`, `--agent`. |
| `memory rem-harness` | Preview REM reflections + candidate truths + deep promotion output **without writing**. `--json`, `--agent`, `--include-promoted`. |
| `memory rem-harness --path ... --grounded` | Preview grounded "What Happened / Reflections / Possible Lasting Updates" from historical notes (no writes). |
| `memory rem-backfill --path ...` | Write reversible grounded diary entries to `DREAMS.md`. `--stage-short-term` seeds durable candidates; `--rollback` / `--rollback-short-term` undo. |
| `/dreaming on\|off\|status\|help` | Chat slash-command to toggle/inspect the dreaming sweep. |

CLI caveats: if active-memory remote API keys are SecretRefs, the command
resolves them from the live gateway snapshot and **fails fast if the gateway is
unavailable**; requires a gateway supporting `secrets.resolve`. (`cli/memory.md`)

---

## 7) Stated limitations / TODOs / "not yet" (quoted)

- **Dreaming is opt-in / off by default** -- no durable consolidation until enabled. (`concepts/dreaming.md`)
- **Dreaming depends on the default-agent heartbeat** -- heartbeat off or target `none` => cron never fires (`Dreaming status: blocked`). (`concepts/dreaming.md`)
- **Shadow trial is report-only / QA-scoped** -- "does **not** add production shadow-trial behavior or change the deep-phase promotion engine." No before-promotion verification gate ships yet. (`concepts/dreaming.md`)
- **Most deep-phase policy is internal** and not user-tunable beyond a few keys. (`concepts/dreaming.md`, `reference/memory-config.md`)
- **Session-memory search is experimental + async/stale** -- "opt-in and runs asynchronously. Results can be slightly stale." (`reference/memory-config.md`)
- **`MEMORY.md` bootstrap is truncated past the file budget** (on-disk kept, injected copy clipped). (`concepts/memory.md`)
- **Fail-closed embedding providers** -- explicit remote provider down => search unavailable (no silent FTS fallback). (`concepts/memory-search.md`)
- **Memory does not enforce policy** -- "Memory can preserve approval context, but it does not enforce policy." (`concepts/memory.md`)
- **Watcher can rarely miss changes** -> `memory index --force`. (`concepts/memory-builtin.md`)
- **Builtin has no reranking / no query expansion / can't index outside workspace** without `extraPaths` -- "Consider switching to QMD if you need reranking, query expansion, or want to index directories outside the workspace." (`concepts/memory-builtin.md`)
- **Builtin ignores symlinks**; **no automatic user modeling / cross-session model** (Honcho's edge); **multi-agent not tracked** in builtin/QMD. (`reference/memory-config.md`, `concepts/memory-honcho.md`)
- **QMD on Windows** "best supported via WSL2"; first search slow (~2 GB GGUF download); QMD traversal ignores OpenClaw symlink rules (`ENAMETOOLONG` risk). (`concepts/memory-qmd.md`)

---

## 8) Alternative backends -- what each ADDS over builtin (gap framing)

| Backend | Slot/Config | Distinctive features (vs. builtin) |
| --- | --- | --- |
| **memory-core** (default) | `plugins.slots.memory: memory-core` | Per-agent SQLite index over Markdown; FTS5 BM25 + vector + hybrid; sqlite-vec; **dreaming consolidation/promotion**; full `openclaw memory` CLI. |
| **memory-lancedb** | `plugins.slots.memory: memory-lancedb` (`@openclaw/memory-lancedb`) | "**auto-recall, auto-capture, and vector search**" via LanceDB; exposes **`memory_recall`** (Active Memory auto-switches). (`plugins/reference/memory-lancedb.md`) |
| **QMD** | `memory.backend: "qmd"` (sidecar) | **Reranking + query expansion**; index **extra dirs** + **session transcripts**; fully local; auto-fallback to builtin. `searchMode` `search`/`vsearch`/`query`. (`concepts/memory-qmd.md`) |
| **Honcho** | `@honcho-ai/openclaw-honcho` | **Automatic cross-session memory**, **automatic user + agent profiles**, semantic search over conclusions/messages, **multi-agent parent/child awareness**; tools `honcho_context/ask/search_conclusions/search_messages/session`. Dedicated service. (`concepts/memory-honcho.md`) |
| **memory-wiki** (companion) | `@openclaw/memory-wiki` | **Provenance-rich wiki vault**: deterministic pages, **structured claims+evidence**, **contradiction+freshness tracking**, dashboards, compiled digests; `wiki_search/get/apply/lint`. Sits *beside* active memory. (`concepts/memory.md`, `plugins/reference/memory-wiki.md`) |

---

## 9) The 5-8 capabilities a competing plugin (pluresLM) must match or beat

1. **Hybrid retrieval out of the box** -- parallel BM25 (FTS5) + vector, weighted merge (`vectorWeight 0.7 / textWeight 0.3`), MMR + temporal decay, sqlite-vec with cosine fallback. (`memory-search.md`, `memory-config.md`)
2. **Broad embedding-provider matrix** -- 10 providers incl. OpenAI default, local GGUF (no key), Gemini multimodal, Bedrock, Copilot, Ollama, OpenAI-compatible. (`memory-builtin.md`)
3. **Dreaming = automated, explainable consolidation** -- scheduled light->REM->deep sweep, deterministic 6-signal weighted ranking, gated promotion (`minScore 0.8 / minRecallCount 3 / minUniqueQueries 3`), snippet cap (~160 tok), live re-read before write, reversible grounded backfill, Dreams UI. **Hardest single feature to match.** (`dreaming.md`, `cli/memory.md`)
4. **Clean tool + CLI contract** -- `memory_search` + `memory_get` tools and the full `openclaw memory status/index/search/promote/promote-explain/rem-harness` surface; plug into the `plugins.slots.memory` slot so Active Memory, dreaming UI, and doctor "just work." (`cli/memory.md`, `active-memory.md`)
5. **Active Memory integration** -- pre-reply blocking recall sub-agent injecting a hidden context prefix; a competitor must register a recall tool name in `config.toolsAllow` and honor the `NONE`/compact-fact contract. (`active-memory.md`)
6. **Provenance + citations + freshness** -- `Source: <path#line>` footers, and (matching memory-wiki) structured claims/evidence + contradiction/freshness tracking. (`memory-config.md`, `memory-wiki.md`)
7. **Session-transcript recall + extra-path indexing** -- opt-in transcript indexing and `extraPaths`/QMD-style external corpora. (`memory-config.md`, `memory-qmd.md`)
8. **Operational robustness** -- per-agent isolation, debounced file-watch reindex, auto-reindex on identity change, embedding cache (50k), WAL checkpointing, fail-closed provider semantics, `status --deep/--fix` health. (`memory-builtin.md`, `memory-config.md`)

**Where a PluresDB-backed pluresLM could differentiate / beat builtin:** native
cross-session persistence + automatic user modeling (Honcho's edge, absent from
builtin); built-in reranking / query-expansion (QMD's edge, absent from builtin);
a *production* before-promotion verification gate (builtin only ships a
report-only shadow trial); and first-class multi-agent memory awareness
(builtin/QMD "not tracked").