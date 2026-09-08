# GPT-6 Lite Fast subagent preset

A single-target combo provides a selectable GPT-6 preset that pins low reasoning
and priority service independently of the caller's effort and Fast preference.
The existing per-target routing fields support this without a runtime patch.

```sh
ocx combo set gpt-6-fast \
  --targets '[{"provider":"openai","model":"gpt-6-astra","effort":"low","serviceTier":"priority","weight":1}]' \
  --effort low \
  --display-name 'GPT-6 Lite Fast' \
  --json
```

The public model ID is `combo/gpt-6-fast`. Bare GPT-family aliases are reserved
for supported native model names. The target's `effort` enforces low reasoning;
the combo's `defaultEffort` alone would only apply when the caller omits effort.
`serviceTier: priority` takes precedence over caller and global Fast settings.
There is one target and no fallback to another model or standard-speed target.

An example five-model subagent roster is:

```sh
ocx agent subagents set \
  'gpt-6-astra,combo/gpt-6-fast,claude-fable-5-1,sol-5.6-litellm,claude-opus-5' \
  --json
```

This roster assumes the three non-GPT-6 aliases already exist. The ordinary
`gpt-6-astra` slot can select xhigh or ultra reasoning when spawning; those
choices do not require separate model slots. Existing Codex app-server sessions
may need a reload to advertise the refreshed roster.

## Verification

- `bun test tests/combos.test.ts tests/server-combo-failover-e2e.test.ts`:
  145 passed, 0 failed, 815 assertions.
- An authenticated live Responses request to `combo/gpt-6-fast`, with caller
  effort `xhigh` and service tier `default`, completed with HTTP 200. The
  resolved model was `gpt-6-astra`, the resolved effort was `low`, and proxy
  telemetry recorded outgoing priority service with Fast applied.
- The Codex backend echoed default service tier. The proxy records scheduling
  confirmation as assumed; the evidence verifies outgoing priority policy,
  not a measured latency improvement or guaranteed priority scheduling.
- The generated catalog placed the preset second in the five-model roster.

Use the CLI belonging to the running proxy and its configured OpenCodex home.
An older global installation may lack the per-target effort and service-tier
fields even when the active source runtime supports them.
