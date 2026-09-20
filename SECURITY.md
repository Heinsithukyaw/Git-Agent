# Security policy

This repository is a **template**, and it is also a **live demo instance**. Both
facts shape what is worth reporting.

## What this repository is

- **The public template holds no secrets.** There is no key in this tree, in its
  history, or in any workflow that runs from it. The demo instance runs the
  digest against the seed watch list in `data/stack.json` — a handful of
  widely-used packages and one public feed — and writes the result to `data/`,
  `history/`, `digest/` and `site/`. Everything it publishes is derived from
  public data.
- **Nothing private is reachable from here.** The instance a user creates from
  this template is a *separate repository* with its own secrets. A finding here
  cannot read another repository's secrets.
- **The sandbox ships off** (`SANDBOX_ENABLED=false`). The default
  instantiation executes no third-party code at all.

## What is in scope

Anything that breaks an invariant in `AGENTS.md`. Concretely, roughly in the
order the consequences would matter:

| Class | The property that must hold |
|---|---|
| **Gate bypass** | Prose reaching a commit or a comment while an entity in it is absent from the fetched payload (I2) |
| **Author gate bypass** | A user who is not OWNER / MEMBER / COLLABORATOR getting a command to act (I6) |
| **Write escape** | A run writing outside `data/`, `history/`, `digest/`, `assets/`, `site/`, `README.md` (I3) |
| **Secret exposure** | A secret reaching a job that holds a write token, or reaching the sandbox (I1, I7) |
| **Chain break** | Appending to `history/runs.jsonl` in a way the hash chain does not cover (I5) |
| **Supply chain** | An action in `.github/workflows/` not pinned to a commit (I12) |

A prompt injection that produces a **false but plausible sentence** is in scope
even when the gate stops it. The gate is the last line, and a report about the
sentence that got close is still a report about the gate.

## What is not in scope

- **The endpoint you point it at.** `LLM_BASE_URL` is the user's own. The agent
  has no opinion about it (I8) and no default. Report model behaviour to whoever
  runs the model.
- **The contents of a user's own instance** — their watch list, their digests,
  their repository. That is theirs, not a defect here.
- **Anything requiring existing write access.** If you can already push to the
  default branch, you are inside the trust boundary, not attacking it.
- **The public digest being public.** It is supposed to be. It contains advisory
  data about public packages.
- **Cost, missing features, or model quality.** Those are issues. Open a normal
  issue.

## How to report

Use **GitHub's private vulnerability reporting**: the repository's **Security**
tab → **Report a vulnerability**. That opens a private advisory only the
maintainer can see.

Please do not open a public issue for anything in the table above, and please do
not test against anyone else's instance — instantiate your own from the template
first. That is a two-minute job and it is the reason the template exists.

A useful report says which invariant is broken, the smallest input that breaks
it, and what you observed. A reproduction beats a description.

## What to expect

Maintained by one person, best effort. Expect an acknowledgement within a few
days. There is no bounty and no guaranteed timeline — but a confirmed break of
I1, I2, I3 or I7 gets fixed before anything else on the list, because those four
are the ones that turn a bad sentence into a bad commit.
