# OpenCode tool review

An OpenCode **V2-only** plugin that blocks tool execution until an independent model reviews it. Targets **2.0.11**. No npm dependencies, build step, command executor, or V1 adapter.

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
        "evidenceFiles": []
      }
    }
  ]
}
```

The review model must already be configured in OpenCode. Use the exact model ID exposed by your provider. The reviewer must return JSON without markdown or thinking text. Its decision includes a concise `analysis` field explaining the evidence and policy behind the result; raw private model thinking is not available through this API. The decision also classifies the action's `effect` as `read`, `write`, or `other`; even a low-risk write requires user authorization. Malformed output is rejected rather than repaired into an approval. Model suitability has **not** been established by the mocked tests in this repository.

Load the reviewer after plugins that modify tool arguments or shell settings. After approval, relevant event fields are locked against changes; a subsequent mutator will cause rejection. Keep OpenCode's native permissions enabled: review does not grant or override native permission approvals.

Missing/invalid options and unsupported versions install blocking hooks. Confirm the plugin is **active** in OpenCode before using the agent. OpenCode can continue if a plugin fails to load; an absent plugin cannot enforce anything. Configuration changes require a plugin reload/restart.

`maxRisk` defaults to `medium` so authorized, bounded project changes can proceed even when the reviewer rates them medium. Set it to `low` for a read and routine-write-only gate. High risk is always rejected. `ask` blocks and explains the need for new authorization; it does not create an interactive approval prompt or cache a prior approval. An explicit `"maxRisk": "low"` in an existing OpenCode configuration still applies until you change it and reload the plugin.

The reviewer’s `authorized` field means the user’s request covers the proposed action. It does **not** mean the action passes operator policy. A requested but forbidden action can have `authorized: true` and `decision: deny`; the denial blocks execution, and high risk is rejected even if the reviewer says `allow`.

`evidenceFiles` is an operator-controlled list of relative paths, such as `package.json` or `scripts/check.js`. The reviewer may read these files from the plugin's workspace, at most 16 KB each. Symlinks, path escapes, binary content, oversized files, and nonregular files are rejected. Do not list secrets. The contents are sent to the configured review provider. Every review has a bounded step count, total input size, response size, deadline, and concurrent-request limit. Hung model requests continue occupying a slot until they settle; the V2 Promise generation API cannot cancel them.

## Enforcement

1. `tool.execute.before` reviews every tool, without a tool-name exemption. This includes V2's `shell`, tools named `bash`, custom/MCP tools, subagent requests, the `execute` code-mode wrapper, and its child calls. Each call has its own decision; there is no prefix or session approval cache.
2. The reviewer receives the complete proposed arguments, current user-message text, tool description, and operator policy. Synthetic/assistant messages cannot supply authorization. Missing history after compaction or in child sessions can result in denial.
3. `shell.create.before` separately reviews actual shell command, working directory, executable, timeout, and environment variable **names**, including shell creation outside the normal tool path. Environment values are not sent to the provider, but changes during review invalidate the decision.
4. Errors, malformed JSON, over-budget input, uncertain decisions, exceeded risk thresholds, and timeouts throw before execution. Mutation during review also rejects the call.

For session-attributed tool calls, the plugin appends a synthetic review entry to the session. Its visible description starts with the actual outcome, tool, risk, reason, and analysis; the full text also includes the effect classification, user-intent assessment, and evidence requests. This entry does not start another agent turn. Denials and review failures also produce an audit entry when the session API is available. An allowed tool is blocked if its audit entry cannot be written. The independent `shell.create.before` hook has no session ID, so shell-only reviews cannot be attached to a session; their denials still surface as hook errors.

V2's shell hook does not expose session identity. Shell reviews therefore receive **no user authorization**, even when a tool review just approved the same command. This deliberately makes medium-risk shell operations unavailable through this hook; they cannot safely borrow a different session's authorization. Review applies to shell creation, not subsequent writes into an existing interactive terminal.

## Boundaries

This is a model-based review gate, not an OS sandbox or proof that arbitrary code is safe. The host, operator policy, plugin code, other plugins, tool implementations, provider, and runtime are trusted. A malicious plugin can spawn processes directly or bypass the OpenCode dispatcher. MCP startup, language-server startup, repository hooks used internally by OpenCode, and arbitrary native process creation do not necessarily traverse either hook. Use OS-level confinement if those need enforcement.

Shell startup files, executable resolution through PATH, inherited environment values, and files changed after review can affect behavior. A model should deny operations when these uncertainties matter; the plugin does not resolve all such dependencies. Read-only evidence inspection does not make mutable scripts immutable. Evidence-path checks are not a security boundary against another process racing directory replacement.

The plugin sends proposed arguments and user text to the review provider. These may contain sensitive information; select and configure a provider suitable for that data. Provider errors are sanitized before returning to the coding agent. Nothing is installed into your global OpenCode configuration by this repository.

## Verification

```sh
npm test
npm run check
```

Tests require Node.js 24+ and use an in-memory execution counter. Potentially dangerous commands are inert strings: they are never given to a subprocess, shell, interpreter, real tool, or live OpenCode execution path. File-inspection tests only create small fixtures in temporary directories. No package installation is required.

Source review is pinned to OpenCode 2.0.11:

- [V2 plugin shape](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/plugin/src/promise/plugin.ts)
- [Tool dispatcher and code-mode child hooks](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/tool.ts)
- [Shell hook before process creation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/shell.ts)
- [Hook failure propagation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/plugin/hooks.ts)
- [Promise adapter](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/plugin/src/promise/adapter.ts)

In 2.0.11 the Promise adapter treats thrown hook errors as Effect defects. They abort the operation but may surface as session errors rather than friendly tool errors. A production rollout still needs a live provider quality check. Unit tests do not establish model judgment quality.

`npm run test:native` additionally uses the installed OpenCode CLI and a temporary loopback server, isolated configuration, and temporary data directories. It checks actual plugin loading and a deny/allow/deny sequence through the native shell hook with a deterministic reviewer. An unconditional final stop hook prevents every process spawn; the only native command input is the harmless shell no-op `:`. Dangerous fixtures never enter this path. This check passed on OpenCode 2.0.11. It requires permission to listen on loopback and does not contact a review provider.
