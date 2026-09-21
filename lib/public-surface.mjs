/**
 * The public surface, assembled in one place.
 *
 * `lib/publishable.mjs` decides what may be published. This module is where that
 * decision is *applied* — the single point at which a payload, a decision set and
 * a command log become the two artifacts a world-readable Pages site is built
 * from. It exists as its own module for one reason: the projection has exactly
 * one legitimate execution point, and a helper that both the pipeline and the
 * test suite call is the only way to be sure the tested path is the shipped one.
 * `AGENTS.md` §5 states the failure this avoids — *"an option that is unit-tested
 * and not wired proves nothing"* — and a canary that re-implements the assembly
 * would test the canary.
 *
 * **Why the commit job, and not the renderer.** The obvious home for a
 * publication filter is the thing that publishes. It cannot be here:
 * `pages.yml` checks out committed files and downloads no artifact, so
 * `scripts/render-site.mjs` never sees `.run/payload.json` and has no `(payload,
 * policy)` to project. The commit job is the only component that holds the
 * payload, the decisions and a write token, and it is the keyless job (I1/I2) —
 * which is where a control belongs. The renderer's job is to read what was
 * already projected and never to project.
 *
 * **The gate keeps its one document.** The projection runs strictly *after*
 * `assertGrounded(...)` in `commit-step`, and the projected payload is a
 * *second* document rather than a second gated one. The narrator was shown the
 * full payload with the decisions folded in, and that is the only document the
 * gate may be handed (I2). Projecting first would hand the gate a narrower
 * document than the narrator read, and every fact about a private package would
 * become ungroundable — which is exactly the drift I2 exists to prevent, in the
 * opposite direction from the one it was written for.
 *
 * **Two artifacts, both name-free by construction.**
 *
 *   - `digest/public-<date>.md` — the public digest. `narration: null` on
 *     purpose: prose is generated content that already contains private names,
 *     and prose is not filterable. The public digest is templated.
 *   - `data/public-summary.json` — the counts the page shows, the reduced
 *     heartbeat, and the projected commands. Every count is derived from the
 *     **projected** set, because a count is a fact about the private stack just
 *     as a name is: `packages: 6` on a page showing two rows states the size of
 *     what was withheld.
 *
 * **The criterion for every field is invariance under the unprojected payload.**
 * A field may appear on the public surface if and only if its value does not
 * change when the *unprojected* payload changes. Safety is invariance — not a
 * matter of degree, and not something a field can be coarsened into. Two fields
 * failed that test and are gone from the public surface:
 *
 *   - **the drop record.** `dropped`, `counts` and `kinds` are cardinalities of
 *     the private stack: `dropped: 4` beside a page showing two rows states how
 *     many were withheld, and the per-kind breakdown states which. That is a
 *     count of the watch list by another name. It moves to the private side —
 *     `buildPublicSurface` returns it and the caller writes it into
 *     `data/summary.json`, where the only reader is the operator. `dropRecord()`
 *     is unchanged; only its placement was wrong.
 *   - **the private heartbeat.** `consecutive_failures` and `last_success_at`
 *     are facts about the private run, and the public page printed the former.
 *     The public heartbeat is `{ last_run_at, last_status }`, and `last_status`
 *     is re-derived from what was **published** rather than copied from the
 *     private one — see `publicHeartbeat()`.
 *
 * **The fail-closed branch was the largest leak in the module.** It called
 * `dropRecord(payload, emptyPayload(...), policy)`, and with `after` empty,
 * `before - after` is the *entire* private cardinality. A broken marker published
 * the exact size of the watch list it had just failed to redact.
 *
 * **A failure stays loud; a choice stays silent.** `withheld_reason:
 * 'invalid-marker'` and `invalid_marker` remain, because a broken marker must be
 * visible. A deny-all is a *choice*, not a failure, and the public surface
 * deliberately does not distinguish it from a quiet day — "everything was
 * withheld" is itself a statement about the private stack. `withheld: ['watch']`
 * is invariance-true (every payload has a watch key) and stays on the record,
 * which is why it is not the reason the record moved.
 *
 * **An invalid marker fails closed, and says which way it failed.** A missing key
 * is not a deny-all. If the page rendered "withheld: all" for a typo it would be
 * indistinguishable from a deliberate deny-all, and the operator would have no
 * signal that the marker was never read. So the invalid path publishes the empty
 * document, records the *number* of violations and the reason, and — because a
 * violation entry can itself be a private name the user mistyped — carries no
 * violation entries onto the public surface. The entries go to the job log.
 */

import {
  readPolicy,
  validatePolicy,
  projectPublishable,
  projectDecisions,
  nameIsPublished,
  dropRecord,
} from './publishable.mjs';
import { renderDigest, renderSummary } from './render.mjs';

/**
 * The prefix that marks a digest as projected.
 *
 * Shared rather than inlined, and read out of here by the invariant that checks
 * the renderer, because two copies of a marker drift — the same reason I13 reads
 * the author allowlist out of the script instead of restating it.
 */
export const PUBLIC_DIGEST_PREFIX = 'public-';

/** Where the projected summary is written, and the only summary the page reads. */
export const PUBLIC_SUMMARY = 'data/public-summary.json';

/** The document a deny-all — or an unreadable marker — publishes. */
function emptyPayload(observedAt) {
  return {
    observed_at: observedAt ?? null,
    packages: [],
    advisories: [],
    releases: [],
    feeds: [],
    errors: [],
  };
}

/** The public digest's path, derived from the observation time like the private one. */
export function publicDigestPath(observedAt) {
  const date = String(observedAt ?? '').slice(0, 10);
  return `digest/${PUBLIC_DIGEST_PREFIX}${date || 'unknown'}.md`;
}

/**
 * The verb and the argument — and the argument only when it is publishable.
 *
 * `history/commands.jsonl` rows carry a GitHub login (`lib/commands.mjs:24`), and
 * this summary is rendered onto a world-readable page. `lib/render.mjs:390-394`
 * states the rule: *"a login belongs to a person rather than to this
 * repository."* The login stays in the command log, which is the audit trail and
 * the one place "who asked for this?" has to stay answerable.
 *
 * **The argument is a second entity-bearing field, and stripping the login left
 * it in.** `arg` is kept by the projection above and rendered by `renderDigest`
 * (`lib/render.mjs:386-398`), but `validate()` only requires the argument of a
 * `why` / `bump` / `wrong` command to be **watched** (`lib/commands.mjs:183-189`)
 * — and the watched set is a superset of the published one. So `/agent why
 * acme-secret`, for a package the instance watches and has *not* listed, rendered
 * the name into `digest/public-<date>.md` and `data/public-summary.json`. Same
 * defect class as the login, one field over: an entity-bearing field rendered to
 * a world-readable surface.
 *
 * The predicate is the three-list one, not the package-only one, because the
 * argument's meaning depends on the verb. A command with no argument — `pause`,
 * `resume` — is not bound to an entity and is kept, the way
 * `projectPublishable` keeps an error row with no `name`.
 *
 * The count is the length of what this returns, never of the input. A count taken
 * before the filter would state how many commands were withheld.
 */
export function projectCommands(commands, policy) {
  return (commands ?? [])
    .filter((row) => {
      const arg = row?.arg;
      if (arg === undefined || arg === null || arg === '') return true;
      return nameIsPublished(arg, policy ?? {});
    })
    .map(({ verb, arg, outcome }) => ({ verb, arg, outcome }));
}

/**
 * The public heartbeat — the reduced object, derived once.
 *
 * `consecutive_failures` and `last_success_at` are dropped rather than
 * coarsened: a failure streak is a fact about the private run, and `1` on a page
 * is as much a disclosure as `7`.
 *
 * `last_status` is **re-derived**, not copied, and the derivation is from what was
 * *published*. Three consequences, all deliberate:
 *
 *   - **The narration gap is excluded.** The public surface publishes no
 *     narration (`narration: null` above), so whether a model answered is not a
 *     public fact. A private `degraded` caused only by a narration gap publishes
 *     as `ok`.
 *   - **It is not hardcoded to `ok`.** A whole-source failure carries no `name`,
 *     survives projection, and is legitimately public (`lib/publishable.mjs`),
 *     and I11 wants failures loud. Hardcoding would silence a real failure in
 *     order to hide a private one.
 *   - **A withheld surface says `withheld`, and not `ok`.** Withholding publishes
 *     nothing, so the published error list is empty and the derivation above
 *     yields `ok` — printed beside a `withheld_reason` that says the digest was
 *     withheld. `scripts/render-site.mjs` resolves that contradiction for the
 *     *page* at `headerStatus()`, but `data/public-summary.json` is a published
 *     artifact with machine readers, and it carried both fields disagreeing: the
 *     reassuring half and the alarming half, in one object. The reason is itself a
 *     published fact — the banner states it — so the status is derived from it.
 *     A **deny-all is not withheld**: it is a supported silent mode with no
 *     reason, and it still publishes as a quiet `ok`.
 *
 * Both placements — the top-level `last_status`/`last_run_at` that
 * `renderSummary()` derives and the nested `heartbeat` object the page reads —
 * are handed *this* object, so they cannot disagree. `scripts/render-site.mjs`
 * reads the nested one, which is why it cannot simply be deleted.
 */
export function publicHeartbeat(heartbeat, publishedErrors, withheldReason = null) {
  const status = withheldReason
    ? 'withheld'
    : (publishedErrors ?? []).length > 0
      ? 'degraded'
      : 'ok';
  return { last_run_at: heartbeat?.last_run_at ?? null, last_status: status };
}

/**
 * Build the two public artifacts from the private inputs.
 *
 * Pure in the sense that matters: no clock, no environment, no file system — the
 * caller writes the result. `observed_at` is carried through from the payload so
 * the public page is stamped with the observation time and not the schedule
 * (I11).
 *
 * Returns `drop` beside `summary` rather than inside it: the record is computed
 * here, where the payload and the projection both exist, and it belongs on the
 * private side. See the header — it is a cardinality of the watch list.
 */
export function buildPublicSurface({ payload, decisions = [], stack, heartbeat = null, commands = [] }) {
  const observedAt = payload?.observed_at ?? null;
  const validation = validatePolicy(stack);
  const policy = readPolicy(stack);

  if (!validation.ok) {
    // Fail closed, and fail *distinguishably*. See the module header: the count
    // and the reason travel, the entries do not — a violation names a policy
    // entry, and a mistyped entry can be a private name.
    //
    // The published error list is empty here, so the public heartbeat is derived
    // from nothing rather than from the private payload. That is the point: the
    // broken marker is signalled by `withheld_reason`, which is loud, and not by
    // a cardinality, which would be the largest leak in the module.
    const denied = emptyPayload(observedAt);
    const publicHb = publicHeartbeat(heartbeat, denied.errors, 'invalid-marker');
    return {
      ok: false,
      violations: validation.violations,
      drop: dropRecord(payload, denied, policy),
      digest: renderDigest({
        payload: denied,
        decisions: [],
        narration: null,
        narrationStatus: null,
        commands: [],
      }),
      summary: {
        ...renderSummary({ payload: denied, decisions: [], heartbeat: publicHb }),
        heartbeat: publicHb,
        commands: [],
        withheld_reason: 'invalid-marker',
        invalid_marker: validation.violations.length,
      },
    };
  }

  const projected = projectPublishable(payload, policy);
  const projectedDecisions = projectDecisions(decisions, policy);
  const projectedCommands = projectCommands(commands, policy);
  const publicHb = publicHeartbeat(heartbeat, projected.errors);

  return {
    ok: true,
    violations: [],
    drop: dropRecord(payload, projected, policy),
    digest: renderDigest({
      payload: projected,
      decisions: projectedDecisions,
      narration: null,
      narrationStatus: null,
      commands: projectedCommands,
    }),
    summary: {
      ...renderSummary({ payload: projected, decisions: projectedDecisions, heartbeat: publicHb }),
      heartbeat: publicHb,
      commands: projectedCommands,
    },
  };
}
