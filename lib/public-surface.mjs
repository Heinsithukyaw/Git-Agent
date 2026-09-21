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
 *   - `data/public-summary.json` — the counts the page shows, the heartbeat, the
 *     projected commands, and the drop record. Every count is derived from the
 *     **projected** set, because a count is a fact about the private stack just
 *     as a name is: `packages: 6` on a page showing two rows states the size of
 *     what was withheld.
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
 * The verb and the argument, never the author.
 *
 * `history/commands.jsonl` rows carry a GitHub login (`lib/commands.mjs:24`), and
 * this summary is rendered onto a world-readable page. `lib/render.mjs:390-394`
 * states the rule: *"a login belongs to a person rather than to this
 * repository."* The login stays in the command log, which is the audit trail and
 * the one place "who asked for this?" has to stay answerable.
 */
export function projectCommands(commands) {
  return (commands ?? []).map(({ verb, arg, outcome }) => ({ verb, arg, outcome }));
}

/**
 * Build the two public artifacts from the private inputs.
 *
 * Pure in the sense that matters: no clock, no environment, no file system — the
 * caller writes the result. `observed_at` is carried through from the payload so
 * the public page is stamped with the observation time and not the schedule
 * (I11).
 */
export function buildPublicSurface({ payload, decisions = [], stack, heartbeat = null, commands = [] }) {
  const observedAt = payload?.observed_at ?? null;
  const validation = validatePolicy(stack);
  const policy = readPolicy(stack);

  if (!validation.ok) {
    // Fail closed, and fail *distinguishably*. See the module header: the count
    // and the reason travel, the entries do not — a violation names a policy
    // entry, and a mistyped entry can be a private name.
    const denied = emptyPayload(observedAt);
    return {
      ok: false,
      violations: validation.violations,
      digest: renderDigest({
        payload: denied,
        decisions: [],
        narration: null,
        narrationStatus: null,
        commands: [],
      }),
      summary: {
        ...renderSummary({ payload: denied, decisions: [], heartbeat }),
        heartbeat: heartbeat ?? null,
        commands: [],
        withheld_reason: 'invalid-marker',
        invalid_marker: validation.violations.length,
        drop: dropRecord(payload, denied, policy),
      },
    };
  }

  const projected = projectPublishable(payload, policy);
  const projectedDecisions = projectDecisions(decisions, policy);
  const projectedCommands = projectCommands(commands);

  return {
    ok: true,
    violations: [],
    digest: renderDigest({
      payload: projected,
      decisions: projectedDecisions,
      narration: null,
      narrationStatus: null,
      commands: projectedCommands,
    }),
    summary: {
      ...renderSummary({ payload: projected, decisions: projectedDecisions, heartbeat }),
      heartbeat: heartbeat ?? null,
      commands: projectedCommands,
      drop: dropRecord(payload, projected, policy),
    },
  };
}
