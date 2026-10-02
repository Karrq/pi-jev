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
      "jev-model-router": { "fallback": "claude-bridge/claude-sonnet-5-5" }
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

| Parameter | Meaning |
|---|---|
| `questions` | Required. Each is `{id?, instructions, type?, criteria?}`, `type` being `noul` (yes/no, the default), `choice` or `score`. `id` defaults to `q1`, `q2`. |
| `commands` | Shell commands to run. Their combined output goes to the endpoint, never to the conversation. For prose to judge, run `echo "..."`. |
| `state` | Context for interpreting the output: a scope, a constraint, what to exclude. Sent in front of the output, not saved, not attributed to any source. |
| `timeout` | Milliseconds to wait for each command before killing it, like the bash tool's `timeout`. Default 30000. |
| `perSource` | Ask each source separately. One request per source, and every answer then names the source it came from. Off by default, which is one request for everything. |

Each command's full output is written to its own `tmpdir()/pi-ask-jev-<id>.log`, one
file per command, listed with its source, so the exact failing lines are one `read`
away instead of a second request. `maxHeadChars` (300) quotes the head of each contributing source;
`maxQuestions`, `maxCommandBytes`, `commandTimeoutMs` and `model` are also settings.

```
source 0: $ npm test 2>&1 | tail -40 (1832 bytes) /tmp/pi-ask-jev-cff636f2.log
source 1: $ npm run typecheck (0 bytes) /tmp/pi-ask-jev-5e286711.log

failing: true (true 100.0%, false 0.0%)
count: some (some 100.0%, none 0.0%, many 0.0%)
```

With `perSource: true` each answer sits under the source that produced it:

```
source 0: $ cat extensions/bash-gate.ts | head -60 (2703 bytes) /tmp/pi-ask-jev-9bae38ac.log
has_gate: true (true 100.0%, false 0.0%)
who_blocks: refused (refused 100.0%, asked 0.0%, allowed 0.0%)
```

Files are not a parameter here: use `jev_file`.

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
  ]
}
```

Two parameters only: `paths` and `questions`. Chunking is not the model's decision.
Files are read internally in pieces (16k characters by default, 1k overlap) because
accuracy falls off past a few thousand tokens; per question the most confident piece
wins, and the answer names the file and character range it came from.
`details.resolvedPaths` lists the absolute paths that matched. `chunkChars`, `overlapChars`, `maxChunks`, `maxFiles`, `maxFileBytes`,
`maxQuestions` and `concurrency` live in `overrides["jev-file-relevance"]`. Chunks
run one at a time because a local server serializes requests; raise `concurrency`
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

What the knobs mean, all under `overrides["jev-bash-gate"]`:

| Setting | Default | Effect |
|---|---|---|
| `askAt` | 0.25 | Silent while `P(medium)+P(high)` is below this; above it the command is worth a question. |
| `blockAt` | 0.5 | Refused at `P(high)` at or above this, or whenever the top level wins outright. |
| `minConfidence` | 0.6 | Below this, a command that is not read-only is asked whatever the level says. |
| `nonInteractive` | `"block"` | What "asked" means when there is no terminal to ask in (RPC, print). `block` refuses, because nobody can answer the question; `run` allows it with a warning. |
| `allow` | `[]` | Command globs to skip entirely, everywhere. |
| `timeoutMs` | endpoint's | Per-request timeout override. |

There is no `mode: notify` any more; that was the old three-mode design and it is
replaced by the bands above plus `nonInteractive`.

Allowlists skip the request entirely: `allow` in settings applies everywhere,
`/jev-allow <prefix>` adds a prefix for the current session only (recorded on the
session branch, so it survives `/tree` navigation but not a new session).

## The virtual model

`jev/auto` appears in `/model`, `--model` and the allowlist like any other model.
Select it once (or set it as `defaultModel`) and every request is routed:

- `user` requests: Jev reads the latest user message and a table of the candidates,
  then answers one question per candidate plus one about depth.
- `continuation` and `retry` stay on the model that handled the turn, so prompt
  caches and thinking signatures survive.
- `direct` requests (compaction summaries, extension calls) go to `fallback`.
- If the endpoint is unreachable or the answer is unusable, `fallback` answers.

`data/aa-intelligence.json` carries Artificial Analysis figures per model *and
reasoning effort*, because the site treats those as separate entities: Opus 5.5 at
medium is index 51 for $1.34 a task, Opus 5.5 at low is 42 for $0.55, and Sonnet 5.5 at
high is 47 for $1.08. Two numbers per row, capability and cost, and they are the whole
decision.

```
[0] claude-bridge/claude-opus-5-5
    Artificial Analysis Intelligence Index and cost per task, by reasoning effort:
      low      index 42, $0.55/task
      medium   index 51, $1.34/task
      high     index 54, $1.82/task
      xhigh    index 56, $3.46/task
      max      index 58, $5.98/task
```

`notes` in `profiles` is still there for anything the numbers do not say, and is passed
through verbatim.

Refresh the file by hand when you want new numbers:

```
node tools/aa-intelligence.mjs
```

The page list in that script is the only thing to edit. It reads the four stat tiles
and the pricing sentence each model page server-renders. Latency is not among them, so
it is absent rather than guessed, and a model Artificial Analysis has not evaluated yet
comes back as `index not measured` (Sonnet 5.5 at low, as of 2026-10-01).

The questions are:

- **depth**, one score over the levels `jev/auto` advertises (`off` through `max`), so
  the answer is a level pi can send. Each model's own levels narrow it, and a model that
  cannot think gets `off`. With Artificial Analysis data present the instructions also ask
  it to weigh what each step up costs, since the table shows where a step is not worth
  its price.
- **fit**, one score per candidate: "How well should this model handle this task,
  weighing what it costs? Judge it against what the task needs, not against the model's
  reputation." Levels are `cannot`, `poorly`, `adequately`, `well`, `expertly`.

Depth is decided first, because what a task costs depends on the effort it runs at.
Then the highest fit wins, and models within `tieMargin` (0.5, half a level) of it count
as tied: the cheapest of those takes it, priced at the effort each would run at. That is
where the cost preference lands, and it is what sends low-intelligence work to cheap
models. A model Artificial Analysis has not measured falls back to its catalog price, so
a free local model still wins what it can do.

### Not switching away mid-conversation

Every candidate carries a prompt cache, and a new model starts with none. So before
leaving the model that just answered, the router prices both paths for the turn it is
about to run:

```
jev router: proposed claude-sonnet-5-5@medium (fit 2.95, $0.1600 over 1 turn(s))
           against claude-opus-5-5@medium (fit 3.00, $0.1760 warm,
           $0.0800 to write the cache). Switching to claude-sonnet-5-5.
```

Staying pays a warm cache read every turn. Switching writes the cache once and is warm
from then on. Both are totalled over `horizon` turns, and the turn is sized from the
transcript: the prompt is the largest `input + cacheRead + cacheWrite` the last
assistant message reported, the answer is the mean of its output tokens, and
`expectedOutputTokens` (2000) stands in when no usage is recorded.

That is why a long turn changes the answer. With a 40k prompt, Opus at medium against
Sonnet at medium:

| answer tokens | staying on Opus | switching to Sonnet | |
|---|---|---|---|
| 400 | $0.024 | $0.104 | stay |
| 4000 | $0.096 | $0.120 | stay |
| 8000 | $0.176 | $0.160 | switch |
| 60000 | $1.216 | $0.700 | switch |

Switching is also refused when the proposal is more than `downgradeMargin` (0.25, half
of the tie margin) behind on fit. Capability is not priced here, so that is the guard
rail: a meaningfully worse model stays put however much it saves.

`horizon` (1) is how many turns to amortise over. Larger values make the decision about
per-turn cost alone, since the one-off write stops mattering; 1 keeps the write decisive.

**When nothing is priced.** Subscription bridges and free routers report every rate as
zero in pi's catalog, which is the case for every model on this machine. There are no
cache economics to compare, so `zeroCostPolicy` decides:

| policy | behaviour |
|---|---|
| `stick` (default) | Once a pair has answered, a different one is not proposed again unless it is meaningfully better. |
| `aa` | Compare Artificial Analysis cost per task instead, and switch only for a real saving. |
| `switch` | No stickiness at all; every turn routes on fit. |

Settings: `fallback` (a `provider/id`), `candidates` (defaults to your enabled models),
`profiles`, `thinkingLevels`, `maxCandidates`, `taskChars`, `tieMargin`, `stick`,
`horizon`, `downgradeMargin`, `switchCostFactor`, `expectedOutputTokens`,
`zeroCostPolicy`. Each routing decision is one request, 450-550ms locally. Set
`PI_JEV_ROUTER_DEBUG=1` to have the router print each stickiness decision to stderr.

```json
"jev-model-router": {
  "fallback": "anthropic/claude-sonnet-5-5",
  "profiles": {
    "anthropic/claude-opus-5-5": "much better at formal proofs and unfamiliar codebases",
    "google/gemini-3-flash": "fast and cheap, single-step work only"
  },
  "tieMargin": 0.25
}
```

With no benchmark data at all, opus and sonnet landed 0.06 apart on every task, which is
inside the noise, and the router always bought the same one. With the table in the state
and ties going to the cheaper option, four candidates route like this:

| prompt | fits (opus, sonnet, haiku, space-bunny) | routed |
|---|---|---|
| rename a variable across 40 files | 2.94, 2.74, 1.50, 0.13 | opus 5.5 at low, $0.55/task |
| what is the capital of France? | 2.84, 1.82, 3.24, 3.02 | space-bunny at off, free |
| design a distributed lock protocol | opus well ahead | opus 5.5 |

The second row is the point of the cost column: haiku and the free model lead on a
factual question, and neither is in contention on the refactor. Free-text notes swing
hard in the other direction, so prefer the numbers: "struggles with multi-step
reasoning" dropped one model from 2.88 to 1.42 on a rename that was never multi-step.

## Question types

- `noul` — yes/no probability. Best for "is X needed", "is this safe".
- `choice` — a label distribution over named options.
- `score` — a distribution over ordered levels plus the mean level.

Criteria are plain strings; a choice criterion may carry its own text as
`"label: description"`.

## Gotchas

- Pi's `ExtensionContext` declares `getScopedModels()`, and at runtime in 0.99.2 that
  function does not exist on the context a virtual model's `route()` receives. The
  enabled models are there as the `scopedModels` property instead. Asking for the
  function returns nothing, every candidate disappears, and the router throws "no
  candidate models". The router reads `scopedModels`, falls back to `getScopedModels`
  if a future version adds it, and finally to the `enabledModels` patterns in settings.
- A `route()` context is created per request and goes stale after a session
  replacement, so do not capture one.

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