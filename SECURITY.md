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

## If you are running an instance

This template is public and holds nothing worth protecting. **Your instance is where the
security decisions are**, and there are three the template cannot make for you.

**1. The repository's visibility is the first control.** Everything the agent collects is
committed — `digest.yml` stages it with `git add -A` — and only the two files Pages serves are
projected. The **unredacted** digest is rendered into your instance's own `README.md` and
`digest/`, and your watch list is `data/stack.json`. A public instance repository therefore
discloses your stack on its front page, with Pages disabled and nothing configured. Keep the
instance private.

**2. Enabling Pages publishes, whatever the repository's visibility.** A Pages site built from a
**private** repository is world-readable: privately published sites require GitHub Enterprise
Cloud, and access control is available only for organisation-owned project sites. If your stack
must stay private, do not enable `pages.yml`.

**3. The publication lists are yours to narrow.** `public_packages`, `public_upstreams` and
`public_feeds` in `data/stack.json` name the subset that may reach the Pages surface. The seed
file lists all six packages because the seed is a public demo; an instance should list only what
it is willing to publish. An explicit empty list is a valid deny-all — and a **missing** list is
not one: it withholds the entire surface and records why.

README §*Where it runs* is the operator-facing version of all three. None of them is a defect in
the template — they are the configuration it cannot choose for you, and a report that an
instance was configured permissively is a report about that instance.

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
- **This template's demo digest being public.** It is supposed to be: the seed
  stack watches widely-used packages and one public feed, so the digest is
  derived from public data. **That is a statement about this repository, not
  about your instance** — see *If you are running an instance* above.
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
