# OpenCode tool review

An OpenCode **V2-only** plugin that gates an opt-in list of tool calls on an independent model review before execution. Supports **2.0.x**. No npm dependencies, build step, command executor, or V1 adapter.

The main coding agent can use qwen3.8-27b. Review uses an explicitly configured OpenCode provider/model through `ctx.generate.text`; it does not inherit the coding agent's tools or session. The reviewer can request bounded file inspection and then return a structured safety decision. It cannot execute a proposed command.

## Configure

Place this repository outside the agent-writable project, then add it to your trusted OpenCode V2 configuration:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-tool-review",
      "options": {
        "model": { "providerID": "YOUR_PROVIDER_ID", "id": "YOUR_REVIEW_MODEL_ID" },
        "policy": "This is a production machine. Do not modify production services or disclose credentials.",
        "maxRisk": "medium",
        "maxSteps": 4,
        "timeoutMs": 30000,
        "maxConcurrent": 4,
        "evidenceFiles": [],
        "tools": ["shell", "execute"]
      }
    }
  ]
}
```

The review model must already be configured in OpenCode. Use the exact model ID exposed by your provider. The reviewer must return JSON without markdown or thinking text. Its decision includes a concise `analysis` field explaining the evidence and policy behind the result; raw private model thinking is not available through this API. The decision also classifies the action's `effect` as `read`, `write`, or `other`; even a low-risk write requires user authorization. Malformed output is rejected rather than repaired into an approval. Model suitability has **not** been established by the mocked tests in this repository.

Load the reviewer after plugins that modify tool arguments or shell settings. After approval, relevant event fields are locked against changes; a subsequent mutator will cause rejection. Keep OpenCode's native permissions enabled: review does not grant or override native permission approvals.

Missing/invalid options install blocking hooks. Versions outside the supported 2.0.x range emit a warning and still install the hooks; compatibility with those versions is not guaranteed. Confirm the plugin is **active** in OpenCode before using the agent. OpenCode can continue if a plugin fails to load; an absent plugin cannot enforce anything. Configuration changes require a plugin reload/restart.

`maxRisk` defaults to `medium` so authorized, bounded project changes can proceed even when the reviewer rates them medium. Set it to `low` for a read and routine-write-only gate. High risk is always rejected. `ask` blocks and explains the need for new authorization; it does not create an interactive approval prompt or cache a prior approval. An explicit `"maxRisk": "low"` in an existing OpenCode configuration still applies until you change it and reload the plugin.

The reviewer’s `authorized` field means the user’s request covers the proposed action. It does **not** mean the action passes operator policy. A requested but forbidden action can have `authorized: true` and `decision: deny`; the denial blocks execution, and high risk is rejected even if the reviewer says `allow`.

`evidenceFiles` is an operator-controlled list of relative paths, such as `package.json` or `scripts/check.js`. The reviewer may read these files from the plugin's workspace, at most 16 KB each. Symlinks, path escapes, binary content, oversized files, and nonregular files are rejected. Do not list secrets. The contents are sent to the configured review provider. Every review has a bounded step count, total input size, response size, deadline, and concurrent-request limit. When all `maxConcurrent` slots are busy, additional reviews queue for a free slot; the `timeoutMs` deadline covers the wait as well as the review, so a call that cannot obtain a slot in time times out like any other review failure. Hung model requests continue occupying a slot until they settle; the V2 Promise generation API cannot cancel them.

`tools` is the opt-in list of tool names the plugin reviews; it defaults to `["shell", "execute"]`, covering V2's shell tool and the code-mode execution wrapper. Tools outside the list — for example `read`, subagent, custom/MCP tools, or any other name — pass through without an LLM call, audit entry, or delay. The list must contain 1 to 32 non-empty strings; invalid values keep blocking hooks installed.

## Enforcement

1. `tool.execute.before` reviews only the tools on the opt-in `tools` list — by default the V2 `shell` tool and the `execute` code-mode wrapper — and passes every other tool without review, audit, or delay. Each reviewed call has its own decision; there is no prefix or session approval cache.
2. The reviewer receives the complete proposed arguments, current user-message text, tool description, and operator policy. Synthetic/assistant messages cannot supply authorization. Missing history after compaction or in child sessions can result in denial.
3. Errors, malformed JSON, over-budget input, uncertain decisions, exceeded risk thresholds, and timeouts throw before execution. Mutation during review also rejects the call.

For session-attributed tool calls, the plugin appends a synthetic review entry to the session. Its visible description starts with the actual outcome, tool, risk, reason, and analysis; the full text also includes the effect classification, user-intent assessment, and evidence requests. This entry does not start another agent turn. Denials and review failures also produce an audit entry when the session API is available. An allowed tool is blocked if its audit entry cannot be written.

In the supported 2.0.x releases, the dispatcher fires `tool.execute.before` with a `sessionID` for every agent tool call, and the tool hook is the only hook this plugin registers. User shell commands entered with `!` take a different path: the `session.shell` API calls `Shell.create` directly, which never fires a tool hook, so those commands are intentionally not reviewed — the plugin gates the agent's tool calls, and a user typing their own command already has the terminal. Review applies to shell creation through the tool path, not to subsequent writes into an existing interactive terminal.

## Boundaries

This is a model-based review gate, not an OS sandbox or proof that arbitrary code is safe. The host, operator policy, plugin code, other plugins, tool implementations, provider, and runtime are trusted. A malicious plugin can spawn processes directly or bypass the OpenCode dispatcher. MCP startup, language-server startup, repository hooks used internally by OpenCode, and arbitrary native process creation do not necessarily traverse the tool hook. Use OS-level confinement if those need enforcement.

Shell startup files, executable resolution through PATH, inherited environment values, and files changed after review can affect behavior. A model should deny operations when these uncertainties matter; the plugin does not resolve all such dependencies. Read-only evidence inspection does not make mutable scripts immutable. Evidence-path checks are not a security boundary against another process racing directory replacement.

The plugin sends proposed arguments and user text to the review provider. These may contain sensitive information; select and configure a provider suitable for that data. Provider errors are sanitized before returning to the coding agent. Nothing is installed into your global OpenCode configuration by this repository.

## Verification

```sh
npm test
npm run check
```

Tests require Node.js 24+ and use an in-memory execution counter. Potentially dangerous commands are inert strings: they are never given to a subprocess, shell, interpreter, real tool, or live OpenCode execution path. File-inspection tests only create small fixtures in temporary directories. No package installation is required.

Source review began with OpenCode 2.0.11 and is validated against the 2.0.x API:

- [V2 plugin shape](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/plugin/src/promise/plugin.ts)
- [Tool dispatcher and code-mode child hooks](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/tool.ts)
- [Shell tool routing through `Shell.create`](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/tool/plugin/shell.ts)
- [Shell hook before process creation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/shell.ts)
- [Hook failure propagation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/plugin/hooks.ts)
- [Promise adapter](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/plugin/src/promise/adapter.ts)

In the supported 2.0.x releases, the Promise adapter treats thrown hook errors as Effect defects. They abort the operation but may surface as session errors rather than friendly tool errors. A production rollout still needs a live provider quality check. Unit tests do not establish model judgment quality.

`npm run test:native` additionally uses the installed OpenCode CLI and a temporary loopback server, isolated configuration, and temporary data directories. It checks actual plugin loading and that repeated user shell calls through the native API bypass plugin review entirely; the fixture's deterministic reviewer would fail the check if it ever ran. An unconditional final stop hook prevents every process spawn; the only native command input is the harmless shell no-op `:`. Dangerous fixtures never enter this path. This check passed on OpenCode 2.0.11. It requires permission to listen on loopback and does not contact a review provider.
