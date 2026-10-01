# pi-jev

System One decision support for pi. The state is read once and every question is
answered from it in one request, with no generation on the server.

| Extension | Exposes | What it is for |
|---|---|---|
| `extensions/ask-jev.ts` | `ask_jev` tool, `/jev` | Typed questions about text the model never sees: inline text, files and globs, or the output of shell commands. |
| `extensions/dropper.ts` | `jev_drop` tool, `/jev-drop` | Triage a pool against a goal: keep/drop with probabilities, duplicates, importance. Reads pi-observational-memory's live pool when run as a command. |
| `extensions/file-relevance.ts` | `jev_file` tool | Typed questions about one or more files (globs allowed), chunked, with the file and character range behind each answer. |
| `extensions/bash-gate.ts` | `tool_call` hook, `/jev-allow` | Gates commands the model asks to run, by risk band. No tool of its own. |
| `extensions/model-router.ts` | `jev/auto` virtual model | Jev picks which enabled model handles each request. |

Each extension is a separate entry point, so you load exactly the ones you want.

## Install

Add the package to a settings file:

```json
{
  "packages": [
    {
      "source": "../../others/pi-jev",
      "extensions": [
        "+extensions/ask-jev.ts",
        "+extensions/model-router.ts",
        "-extensions/dropper.ts",
        "-extensions/file-relevance.ts",
        "-extensions/bash-gate.ts"
      ]
    }
  ]
}
```

`+path` includes one extension and `-path` excludes one. Inclusion is additive, so
every extension you do not want needs a `-` entry. `pi config` toggles discovered
resources interactively, and `pi -e <file>` loads one extension for a single run.

Project settings (`.pi/settings.json`) load after project trust, so a scratch
project needs `pi -a`. Use a directory that is not inside another git repository,
otherwise pi resolves the project root elsewhere and ignores them. See
`pi-jev-scratch-config.json`.

## Endpoints

Pi has no per-extension settings, so pi-jev reads a `pi-jev` key from the same
settings file (user level, then project level once trusted):

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
      "ask-jev": { "maxCommandBytes": 400000, "commandTimeoutMs": 30000 },
      "jev-bash-gate": { "askAt": 0.25, "blockAt": 0.5, "minConfidence": 0.6 },
      "jev-model-router": { "fallback": "anthropic/claude-sonnet-5" }
    }
  }
}
```

- `endpoint` picks a name from `endpoints`: switching between your local open-jev
  and the hosted service is changing that string.
- `apiKeyEnv` names an environment variable holding the bearer token.
- `overrides["<extension>"]` can also carry its own `endpoint`, so one extension can
  talk somewhere else without touching the others.

With no `pi-jev` key, everything uses `http://127.0.0.1:10610`.

## The tools

### `ask_jev`

```json
{
  "questions": [{ "instructions": "Are any tests failing?", "id": "failing" }],
  "commands": ["npm test 2>&1 | tail -40"],
  "paths": ["src/**/*.ts"],
  "state": "optional inline text",
  "perSource": false,
  "saveOutput": true,
  "model": "optional override",
  "headChars": 300
}
```

Sources are read or run here and sent to the endpoint; only the answers return, so
the command output never enters the conversation. `paths` accepts files and globs.
`perSource: true` asks each source separately, which costs one request per source
but reports which file or command each answer came from. `headChars` quotes the
start of each contributing source; the model does not report offsets, so this is
the head of the file or output, not the matching region. `saveOutput` writes each
command's full output to `tmpdir()/pi-ask-jev-<id>.log` and reports the path, so the
model can `read` the exact failing lines instead of asking again.

### `jev_drop`

```json
{
  "goal": "fix the failing retry test before the release",
  "items": [{ "id": "obs-12", "text": "npm test: 1 failing in retry" }],
  "keepAt": 0.6,
  "duplicateAt": 0.8
}
```

One request for the pool: still needed (yes/no), repeats an earlier item (yes/no),
importance (5 levels). Keep is `P(needed) >= keepAt` and not a duplicate. The
result gives per-item probabilities, kept and dropped ids, and characters saved.

`/jev-drop <goal>` runs the same triage over the observations pi-observational-memory
has recorded in the current session, and prints the verdicts. It writes nothing back
to memory. With no argument it prints usage and the current thresholds.

### `jev_file`

```json
{
  "paths": ["src/auth.ts", "src/**/*.test.ts"],
  "questions": [
    { "id": "expiry", "instructions": "Does this return 401 for an expired token?" },
    { "id": "attempts", "type": "choice", "instructions": "What controls the retries?",
      "criteria": ["attempts_arg: the parameter", "retry_env: an environment variable"] }
  ],
  "chunkChars": 16000,
  "maxChunks": 8,
  "maxFiles": 20
}
```

Files over `chunkChars` are split with 1k overlap and asked per chunk; the most
confident chunk wins per question. Every answer names its file and character range,
and `details.resolvedPaths` lists the absolute paths that matched. Chunks run one at
a time by default, because a local server serializes requests; raise `concurrency`
for a hosted endpoint.

### The bash gate (hook, no tool)

Every command the model asks to run is assessed in one request: what it primarily
does, and a distribution over four risk levels. The decision reads the distribution,
not the mean, because the model's "high" comes back as 2.998 and a mean comparison
against 3.0 never fires.

| Command | P(medium)+P(high) | P(high) | Confidence | Outcome |
|---|---|---|---|---|
| `ls -la` | 0.00 | 0.00 | 0.88 | silent |
| `npm test` | 0.11 | 0.00 | 0.57 | silent |
| `grep -rn TODO src` | 0.00 | 0.00 | 0.54 | silent (read-only, exempt from the confidence floor) |
| `rm -rf /tmp/x` | 0.21 | 0.06 | 0.42 | asked |
| `rm -rf node_modules` | 0.51 | 0.07 | 0.34 | asked |
| `rm -rf ~` | 1.00 | 1.00 | 0.99 | refused |
| `git push --force origin main` | 1.00 | 1.00 | 1.00 | refused |

Bands: refused when the top level wins or `P(high) >= blockAt` (0.5); silent when the
level is none/low and `P(medium)+P(high) < askAt` (0.25); asked in between. A
non-read-only command with confidence below `minConfidence` (0.6) is asked whatever
the level says. With no interactive terminal the ask band follows `nonInteractive`:
run with a warning (default) or refuse.

Allowlists skip the request entirely: `allow` in settings applies everywhere,
`/jev-allow <prefix>` adds a prefix for the current session only (recorded on the
session branch, so it survives `/tree` navigation but not a new session).

## The virtual model

`jev/auto` appears in `/model`, `--model` and the allowlist like any other model.
Select it once (or set it as `defaultModel`) and every request is routed:

- `user` requests: Jev reads the latest user message and the candidate list, then
  answers which model fits, how much reasoning depth it needs, and whether the
  cheapest candidate is enough.
- `continuation` and `retry` stay on the model that handled the turn, so prompt
  caches and thinking signatures survive.
- `direct` requests (compaction summaries, extension calls) go to `fallback`.
- If the endpoint is unreachable or the answer is unusable, `fallback` answers.

Settings: `fallback` (a `provider/id`), `candidates` (defaults to your enabled
models), `thinkingLevels`, `maxCandidates`. Each routing decision costs one request,
300-400ms locally.

## Question types

- `noul` — yes/no probability. Best for "is X needed", "is this safe".
- `choice` — a label distribution over named options.
- `score` — a distribution over ordered levels plus the mean level.

Criteria are plain strings; a choice criterion may carry its own text as
`"label: description"`.

## Caveats

- About 0.73 accuracy on typed yes/no questions (LocalLLaMA/typed-decisions, Gemma 4
  26B A4B), lower on long states. Treat probabilities as evidence.
- Do not put `criteria` text on yes/no questions. With criteria, Gemma 4 answered
  "not needed" at 98-100% confidence for all five items in a test pool, including the
  item stating the failure being fixed. The same questions without criteria separated
  them correctly, so the dropper sends none.
- A separate "is this safe" question next to a risk score is redundant: across 18
  commands it never vetoed where risk did not, and cleared four that risk flagged,
  including `git push origin main` (safe 0.92, risk 1.9). The gate decides on risk.
- Asking many questions in one request does not degrade the others: 15 questions gave
  the same probabilities as the same questions asked alone or in pairs.
- Source attribution is best effort. With chunks asked independently, the winning
  chunk can differ from where the model actually took the answer from.
- The gate's decisions are only as stable as the model. Between two runs on the
  same command it has not disagreed on the obvious cases, but `rm -rf /tmp/x` sits
  at 0.21 elevated against a 0.25 threshold, so tuning `askAt` moves real commands.
- The local letter readout reads up to 26 option labels; the hosted endpoint accepts
  more. Keep router candidate lists short.
- Requests are serialized by the local server. A 200-item dropper holds the model for
  about a minute and nothing else runs meanwhile.
- The local server frees its 14.5GB of weights after 15 idle minutes. The next
  request reloads them: 2-3s if macOS still has them cached, up to 36s if not.

## Development

```bash
node test/load.mjs          # load every extension with pi's jiti, print registrations
node test/load.mjs --live   # one real request per extension
node test/load.mjs --tools  # execute each tool end to end
node test/load.mjs --route  # call jev/auto's route() with a stub registry
node test/load.mjs --gate   # drive the bash hook across commands and modes
```