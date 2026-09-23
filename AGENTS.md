# AGENTS.md — opencode-tool-review

Working notes so findings and goals survive compaction.

## Incident (2026-09-21)

One `shell` tool call produced two contradictory reviews in the session transcript:

- `◈Tool review ALLOWED: shell (low) — ...` (synthetic audit entry)
- Tool result: `Tool review blocked execution: ask: No user message authorizes this download...`

## Verified root cause (OpenCode v2.0.11 source, tag v2.0.11)

Every `shell` tool call fires **two** plugin hooks in sequence:

1. `tool.execute.before` — fired by the tool dispatcher for every tool,
   `packages/core/src/tool.ts:103,241,271`. Payload includes `sessionID`, so the
   plugin's tool hook loads session context + user messages. It approves, and its
   `audit()` writes the synthetic ALLOWED entry.
2. `shell.create.before` — the shell tool's `execute` calls `Shell.create`
   (`packages/core/src/tool/plugin/shell.ts:195-211`), which triggers the hook
   (`packages/core/src/shell.ts`). Payload is `{command, cwd, shell, timeout, env}`
   — **no sessionID** (sessionID only in `metadata`, not in the hook payload). The
   plugin's shell hook passes `userMessages: []`, so by design it blocks anything
   beyond a low-risk read with `ask`.

A throw in the shell hook is an Effect defect (shell domain is `NoFailures`,
`packages/core/src/plugin/hooks.ts`) → aborts `Shell.create` → spawn aborted, tool
result is the denial. Net: ALLOWED audit entry + blocked result for the same command.

Also reproduced live in this project's own session: a `curl` into `/tmp/opencode`
was approved by the tool hook and blocked by the shell hook moments later.

## Fix goal

`tool.execute.before` is the ideal (and only) review pathway for shell tool calls
because it carries session context. The shell hook stays as a backstop for shell
creation that does not go through the tool path (or does not match a fresh approval).

Mechanism (implemented in `src/index.js`):

- Tool hook: after approving a `shell` call, record a short-lived, **one-shot**
  approval keyed by `digest({command, cwd})` (cwd falls back to the location
  directory when the tool input omits `workdir`). TTL 60 s, cap 64 entries.
- Shell hook: consume a matching approval and skip the second LLM review (and its
  audit). No match → full review as before (fail closed).
- One-shot consumption means each approval covers exactly one `Shell.create`; a
  repeated identical command is reviewed again.

Status (2026-09-21): complete. Implemented in `src/index.js`, tests and README
updated, `npm test` (23/23) and `npm run check` both pass. User explicitly
authorized self-edits to this repository for this work.

## Concurrency change (2026-09-21)

User report: `maxConcurrent` saturation failed tool reviews (fail-closed block)
instead of making them wait.

Mechanism (implemented in `src/index.js`):

- Guard's immediate `active >= options.maxConcurrent` denial is gone. A FIFO
  semaphore (`waiters` + `capacity()`/`release()`) queues saturated reviews.
- `take()` increments `active` synchronously inside `release()`, so the cap is
  exact under interleaving. The IIFE `finally` runs `release()` once per granted
  slot; a waiter abandoned in the queue (deadline expired, plugin unloaded)
  never increments, so the count stays balanced.
- The `timeoutMs` deadline covers queue-wait plus review, so a call that cannot
  obtain a slot in time times out like any other review failure.
- Abandoned queued waiters are left in the queue; when a slot reaches them,
  `review()` throws at its first `signal?.throwIfAborted()`, the slot churns
  once, and the queue drains. No deadlock (maxConcurrent ≥ 1).
- `closed || configError` still rejects immediately, before any capacity access.

Status: complete. README documents the queueing behavior; `npm test` (23/23,
including the reworked hung-slot test and a new queue-and-succeed test) and
`npm run check` pass. Test gotcha hit while developing: an invoke promise that
rejects before `assert.rejects` is attached fails the running test as an
unhandled rejection — attach the assertion synchronously.

## Constraints

- OpenCode **2.0.11 only** (hard-pinned in `src/index.js`), Node 24+, no npm
  dependencies, no new modules under `src/`.
- Minimal diffs, existing style (2-space indent, single quotes, semicolons).
- `npm test` and `npm run check` must pass.
- README.md and tests must stay consistent with the code; README documents the
  double-fire, the consumption mechanism, and the capacity queueing.
