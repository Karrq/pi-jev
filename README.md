# pi-jev

Five independent pi extensions that answer typed questions about text in one
request, through a TypeSafe-compatible System One endpoint. No generation on the
server: the state is read once and every question is answered from it.

| Extension | Tool | What it is for |
|---|---|---|
| `extensions/decider.ts` | `jev_decide` | The general one. Any state, any typed questions. |
| `extensions/dropper.ts` | `jev_drop` | Triage a pool of 200 items against a goal: keep/drop with probabilities, duplicate detection, importance. |
| `extensions/file-relevance.ts` | `jev_file` | Answer questions about a file, chunked, reporting the character range each answer came from. |
| `extensions/bash-gate.ts` | `jev_gate_bash` + `user_bash`/`tool_call` hooks | Check a command's safety and side effects before it runs. |
| `extensions/model-router.ts` | `jev_route` + `/jev-route` | Pick which enabled model should handle a task, and how much reasoning depth it needs. |

Each extension is a separate entry point, so you load exactly the ones you want.

## Install

Add the package to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "../../others/pi-jev",
      "extensions": [
        "+extensions/decider.ts",
        "+extensions/bash-gate.ts",
        "-extensions/dropper.ts",
        "-extensions/file-relevance.ts",
        "-extensions/model-router.ts"
      ]
    }
  ]
}
```

`+path` includes one extension and `-path` excludes one. Inclusion is additive: listing
only the two `+` entries above still loads all five, so every extension you do not
want needs a `-` entry. Dropping an entry from the list is also fine, as long as
the ones you keep are spelled out.

Every extension can also be loaded for a single run with
`pi -e ~/others/pi-jev/extensions/dropper.ts`, and `pi config` toggles discovered
resources interactively.

## Point it at an endpoint

Pi has no per-extension settings, so pi-jev reads a `pi-jev` key from the same
`settings.json` it already reads (user level, then project level `.pi/settings.json`
once project trust is granted):

```json
{
  "pi-jev": {
    "endpoint": "local",
    "endpoints": {
      "local": { "url": "http://127.0.0.1:10610" },
      "prod":  { "url": "https://api.typesafe.ai", "apiKeyEnv": "JEV_API_KEY" }
    },
    "model": "gemma-4-26b-a4b",
    "timeoutMs": 120000,
    "overrides": {
      "jev-bash-gate": { "mode": "ask", "autoAllowAt": 0.9, "maxRiskAt": 0.5 },
      "jev-dropper":    { "keepAt": 0.5, "duplicateAt": 0.8, "maxItems": 200 },
      "jev-file-relevance": { "chunkChars": 16000, "maxChunks": 8 }
    }
  }
}
```

- `endpoint` picks a name from `endpoints`. Switching between your local open-jev
  and the hosted service is changing that one string.
- `apiKeyEnv` names an environment variable holding the bearer token; the token
  itself never goes in settings.
- `model` is sent with every request. Omit it and the server picks.
- `overrides["<extension>"]` can also carry its own `endpoint` or `endpoints`, so
  one extension can talk somewhere else without touching the rest.

With no `pi-jev` key at all, every extension uses `http://127.0.0.1:10610`.

## Per-extension settings

Defaults are in each extension's header comment. Summary:

- `jev-decider`: `maxQuestions` (32), `maxStateChars` (200000).
- `jev-dropper`: `keepAt` (0.5), `duplicateAt` (0.8), `maxItems` (200), `maxStateChars` (80000), `includeImportance` (true).
- `jev-file-relevance`: `chunkChars` (16000), `overlapChars` (1000), `maxChunks` (8), `concurrency` (4), `maxQuestions` (12).
- `jev-bash-gate`: `mode` (`ask` for user commands), `modelMode` (`notify` for model commands), `autoAllowAt` (0.9), `maxRiskAt` (0.5), `timeoutMs` (endpoint default), `blockWhenUncertain` (false), `allowlist` (prefixes).
- `jev-model-router`: `maxCandidates` (24), `thinkingLevels` (all), `alwaysApply` (false).

## What the questions look like

Three kinds, matching the System One contract:

- `noul` — a yes/no probability. Best for "is X still needed", "is this safe".
- `choice` — a label distribution over named options.
- `score` — a distribution over ordered levels plus the mean level.

Tool input accepts criteria as plain strings, so a choice question is
`["build: builds software", "delete: deletes files"]`.

## Accuracy

About 0.73 on typed yes/no questions (LocalLLaMA/typed-decisions, Gemma 4 26B A4B),
and lower on long states. Treat probabilities as evidence, not as truth. That is why
the bash gate defaults to asking rather than blocking.

## Caveats

## Two prompt findings

- Do not put `criteria` text on yes/no questions. With criteria ("Still needed:
  contributes information the goal does not have elsewhere"), Gemma 4 answered
  "not needed" with 98-100% confidence for all five items in a test pool, including
  the item that stated the failure being fixed. The same questions without criteria
  separated them cleanly.
- Asking many questions in one request does not degrade the others. A 15-question
  request (keep, duplicate and importance per item) gave the same probabilities as
  the same questions asked alone or in pairs.
- The local letter readout reads up to 26 option labels; the hosted endpoint
  accepts more. Keep router candidate lists short.
## Two things to know about the local server

- Idle unload is off by default in the launchd service. With it on
  (`OPENJEV_IDLE_UNLOAD_S`), the first request after a long idle gap reloaded the
  weights in 36s because macOS had dropped them from the file cache, against 2-3s
  when the weights were still cached. For an interactive bash gate that stall lands
  on a user waiting to run a command.
- Requests are serialized. A 200-item dropper holds the model for about a minute.
- `model-router` only switches the session model from `/jev-route --apply`; the
  tool itself only advises.

## Development

```bash
node test/load.mjs          # load every extension with pi's jiti, print what registers
node test/load.mjs --live   # also send one real request per extension to the endpoint
```
## Trying it without touching your settings

Put the package in a scratch project's `.pi/settings.json` and run pi from there
with `-a` (trust project files for one process). Use a directory that is not inside
another git repository, otherwise pi resolves the project root elsewhere and the
project settings are ignored:

```bash
mkdir -p ~/pi-jev-scratch/.pi
cp -r ~/others/pi-jev-scratch-config.json ~/pi-jev-scratch/.pi/settings.json
cd ~/pi-jev-scratch && pi -a          # interactive
cd ~/pi-jev-scratch && pi -a list
```

`~/pi-jev-scratch` is set up that way already. Nothing under `~/.pi/agent` is
touched, so your other pi instances are unaffected.
