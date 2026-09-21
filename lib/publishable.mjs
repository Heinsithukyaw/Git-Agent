/**
 * What may reach the world, as opposed to what may reach the model.
 *
 * This repository already has one boundary — the model boundary — and it is a
 * **denylist**: everything in the payload may be sent unless a rule says
 * otherwise, and a miss is recoverable by rotating a key. The publication
 * boundary is the other way round, and conflating the two was the original
 * defect: a denylist for the direction that has a remedy, applied to the
 * direction that does not.
 *
 *   > **The seed stack is a demo, not a placeholder.** … a seed entry that is
 *   > *specific to one organisation* does not belong here, because the demo
 *   > digest is public.
 *
 * Publication is the one act here that cannot be taken back. A repository that
 * has been made public cannot be made un-public, forks detach and persist, and
 * an append-only history that recorded a name can never be rewritten. So the
 * default for every watched entity is **not publishable**, and an entity reaches
 * the public surface only because it was listed. A denylist fails *open* in
 * exactly the direction that has no remedy; this fails closed.
 *
 * **Why the projection lives here and not in `lib/render.mjs`.** A renderer that
 * filters is a renderer that can be asked to render an unfiltered document, and
 * every future caller inherits that option. Keeping the projection in its own
 * module means `lib/render.mjs` is structurally unable to express an unredacted
 * public document: it renders what it is handed, and what it is handed has
 * already been through `projectPublishable()`. The projection is a pure function
 * of `(payload, policy)` and nothing else — no clock, no environment, no file
 * system — so it can be reasoned about as a set operation rather than as a step
 * in a pipeline.
 *
 * **Three lists, not one.** The digest renders `payload.releases` as
 * `## Upstream releases` and `payload.feeds` as `## From <hostname>`, and
 * `payload.errors` as a gap list naming `source` and `name`
 * (`lib/render.mjs:339-357`, `:376-380`). A package-only marker would publish a
 * private upstream slug or an internal feed URL while claiming to have redacted
 * the document. The marker therefore covers every list the digest can render a
 * name from.
 *
 * The second half of the module answers the operational question the design
 * review raised: *how do you know the filter ran?* `dropRecord()` carries counts
 * and kinds, and is built so that it cannot carry anything else — see its own
 * note, and the precedent at `lib/pubsafe.mjs:156-158`.
 */

/** The marker's three lists. Present in `data/stack.json`; read by nothing else. */
export const POLICY_KEYS = ['public_packages', 'public_upstreams', 'public_feeds'];

const PRESENCE_RULE =
  'publication fails closed: every policy list must be present, even when it is an empty list';
const SUBSET_RULE =
  'publication fails closed: a listed entry must exist in the stack, or the typo publishes nothing and reads as a quiet week';
const AMBIGUITY_RULE =
  'publication fails closed: an ambiguous entry is a violation, never a silent pick';

/**
 * Canonicalise a name the way its ecosystem does, before comparing.
 *
 * PyPI normalises per PEP 503: lowercase, and any run of `-`, `_` or `.`
 * collapses to a single `-`. Every other ecosystem returns the name unchanged.
 *
 * This exists because a case-sensitive comparison can let a private PyPI name
 * through: `Requests` and `requests` are the same package to PyPI, so a marker
 * listing one and a stack holding the other would disagree about whether the
 * package is published — and the disagreement resolves in whichever direction
 * the comparison happens to run. Normalising first removes the disagreement
 * rather than picking a side.
 */
export function canonicalName(name, ecosystem) {
  if (typeof name !== 'string') return name;
  if (ecosystem !== 'PyPI') return name;
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Read the marker out of a stack.
 *
 * A key that is absent stays `undefined`, rather than defaulting to `[]`. The
 * distinction is the whole validator: an explicit empty list is a deliberate
 * **deny-all**, which is a supported and legitimate configuration, while an
 * absent key is a marker that was never written — and a validator that cannot
 * tell them apart would either refuse a valid deny-all or accept a missing
 * marker as one.
 */
export function readPolicy(stack) {
  const policy = {};
  for (const key of POLICY_KEYS) {
    policy[key] = stack?.[key];
  }
  return policy;
}

/** A policy entry is a plain string, or `{ name, ecosystem }` to disambiguate. */
function entryParts(entry) {
  if (typeof entry === 'string') return { name: entry, ecosystem: undefined };
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
    return { name: entry.name, ecosystem: entry.ecosystem };
  }
  return null;
}

/**
 * Does one `public_packages` entry name this `(name, ecosystem)`?
 *
 * An entry that declares an ecosystem is compared only against that ecosystem,
 * and both names are canonicalised under it. An entry that does not is compared
 * against every package, each name canonicalised under *that package's*
 * ecosystem — which is what makes a bare `Requests` match the PyPI package
 * `requests` while a bare `Requests` still does not match an npm package named
 * `requests` (npm is case-sensitive, and its names are lowercase anyway).
 *
 * A bare entry that matches in two ecosystems is ambiguous, and `validatePolicy`
 * refuses it. This function deliberately does not resolve that — it reports
 * every match, and the refusal happens upstream rather than being hidden in a
 * `find()` that returns whichever package happened to be first.
 */
function packageMatches(entry, pkg) {
  const parts = entryParts(entry);
  if (!parts || !pkg || typeof pkg.name !== 'string') return false;
  if (parts.ecosystem !== undefined && parts.ecosystem !== pkg.ecosystem) return false;
  return canonicalName(parts.name, pkg.ecosystem) === canonicalName(pkg.name, pkg.ecosystem);
}

/** The name an entry names, whether it is a string or a `{ name }` object. */
function entryName(entry) {
  return entryParts(entry)?.name ?? null;
}

/**
 * Membership for the two non-package lists.
 *
 * `canonicalName(name, undefined)` is the identity, so this is an exact match in
 * practice: an upstream is a repository slug and a feed is a URL, and neither has
 * an ecosystem that normalises it. The call is still routed through
 * `canonicalName` so that if a list ever gains a normalising ecosystem the
 * comparison changes in one place.
 */
function listContains(list, value) {
  if (typeof value !== 'string') return false;
  return list.some((entry) => {
    const name = entryName(entry);
    return name !== null && canonicalName(name, undefined) === canonicalName(value, undefined);
  });
}

/**
 * Is this package name on the publication allowlist?
 *
 * The same comparison `packageMatches` makes, for a record that carries a name
 * and **no ecosystem** — an error row (`gather()` records `{source, name,
 * error}`) and a decision row (`triage.mjs` writes `package` and `ecosystem` on
 * some paths and not others). With no ecosystem to canonicalise against, a bare
 * entry must match exactly, and an entry that declares an ecosystem gets the
 * canonical comparison because it has said which rule applies.
 *
 * The strict half is deliberate: the unsafe direction here is over-matching,
 * because a kept row publishes the name it is about. Under-matching hides a gap,
 * which the digest's own gaps section already treats as the lesser evil.
 */
export function isPublishedPackageName(name, policy) {
  if (typeof name !== 'string') return false;
  return (policy?.public_packages ?? []).some((entry) => {
    const parts = entryParts(entry);
    if (!parts) return false;
    if (parts.ecosystem !== undefined) {
      return canonicalName(parts.name, parts.ecosystem) === canonicalName(name, parts.ecosystem);
    }
    return parts.name === name;
  });
}

/**
 * Is this entity name published under *any* of the three lists?
 *
 * The name of a record that is not itself a package can be a package name, an
 * upstream slug or a feed URL, depending on which source or verb produced it. So
 * the test is membership in any of the three lists, and not
 * `isPublishedPackageName`.
 *
 * Two callers, and both are the same defect class — an entity-bearing field
 * rendered to a world-readable surface:
 *
 *   - `projectPublishable` filters an error row by its `name` (`gather()` records
 *     a failed source as `{ source, name, error }`).
 *   - `projectCommands` filters a command row by its `arg`. The argument's
 *     meaning depends on the verb — a package for `why`, an upstream slug for an
 *     upstream read, a feed URL for a feed read — which is exactly why the
 *     package-only predicate is the wrong one here.
 *
 * A record with no name at all is not entity-bound: a whole-source failure, and
 * `/agent pause`, name nothing. Both callers keep those without asking.
 *
 * The strict half is deliberate: the unsafe direction here is over-matching,
 * because a kept row publishes the name it is about. Under-matching hides a gap,
 * which the digest's own gaps section already treats as the lesser evil.
 */
export function nameIsPublished(name, policy) {
  if (typeof name !== 'string') return false;
  return (
    isPublishedPackageName(name, policy) ||
    listContains(policy.public_upstreams ?? [], name) ||
    listContains(policy.public_feeds ?? [], name)
  );
}

/**
 * Validate the marker against the stack it is written on.
 *
 * Three rules, each of which is a way a redaction silently does nothing:
 *
 *   1. **Presence, not length.** A missing key is a violation that names the key.
 *      An explicit `[]` is a valid deny-all and is *not* a violation — the
 *      vacuous truth `[] ⊆ packages` is why a length check would pass the worst
 *      case, and the presence check is why the fix is not "refuse empty lists".
 *   2. **Subset.** Each entry must exist in the source set it claims to name.
 *      A typo would otherwise publish nothing while reading as a quiet week.
 *   3. **No ambiguity.** An entry matching more than one package (the same
 *      canonical name in two ecosystems) is refused, and the message says to
 *      disambiguate with `{ name, ecosystem }`. Picking one silently is the
 *      failure mode this rule exists to prevent, and it is invisible: the run is
 *      green either way.
 *
 * Returns `{ ok, violations }`, where each violation names the `list`, the
 * offending `entry` when there is one, a human `error`, and the `rule` it broke.
 */
export function validatePolicy(stack) {
  const violations = [];
  const packages = Array.isArray(stack?.packages) ? stack.packages : [];
  const upstreams = Array.isArray(stack?.watch?.upstreams) ? stack.watch.upstreams : [];
  const feeds = Array.isArray(stack?.watch?.feeds) ? stack.watch.feeds : [];

  for (const list of POLICY_KEYS) {
    const present = stack !== null && typeof stack === 'object' && Object.hasOwn(stack, list);
    if (!present) {
      violations.push({ list, error: 'missing', rule: PRESENCE_RULE });
      continue;
    }
    if (!Array.isArray(stack[list])) {
      violations.push({ list, error: 'must be an array', rule: PRESENCE_RULE });
      continue;
    }

    for (const entry of stack[list]) {
      if (list === 'public_packages') {
        const matches = packages.filter((pkg) => packageMatches(entry, pkg));
        if (matches.length === 0) {
          violations.push({ list, entry, error: 'not a member of stack.packages', rule: SUBSET_RULE });
        } else if (matches.length > 1) {
          violations.push({
            list,
            entry,
            error: 'matches more than one package; disambiguate with { name, ecosystem }',
            rule: AMBIGUITY_RULE,
          });
        }
        continue;
      }

      const source = list === 'public_upstreams' ? upstreams : feeds;
      if (!listContains(source, entryName(entry))) {
        const member = list === 'public_upstreams' ? 'stack.watch.upstreams' : 'stack.watch.feeds';
        violations.push({ list, entry, error: `not a member of ${member}`, rule: SUBSET_RULE });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Project a payload down to the publishable subset.
 *
 * A new object, always; the input is never mutated. The result is built
 * field-by-field rather than by spreading the payload, so a field added to the
 * payload in future does not silently survive the projection — the permission
 * list is the constructor, not a subtraction from it.
 *
 * The five lists are filtered against the policy. The sixth thing that happens
 * is the one that is easy to miss:
 *
 *   **`watch` is dropped entirely.** `gather()` returns `watch: stack.watch` —
 *   the instance's full private watch list, upstreams and feeds included. Nothing
 *   in `lib/render.mjs` reads it, so it is invisible in the rendered output and
 *   would therefore be invisible in review. But it is a real leak route: any
 *   consumer that serialises the payload to the public surface publishes the
 *   watch list itself, which is the one document this module exists to keep
 *   private. `observed_at` is preserved, because a digest must be honest about
 *   when it observed the world (I11).
 *
 * Assumes a policy that has passed `validatePolicy()`. Projection is total and
 * fail-closed regardless — an absent or empty list matches nothing, so an
 * unvalidated policy publishes less, never more.
 */
export function projectPublishable(payload, policy) {
  const p = policy ?? {};
  const publicPackages = Array.isArray(p.public_packages) ? p.public_packages : [];
  const publicUpstreams = Array.isArray(p.public_upstreams) ? p.public_upstreams : [];
  const publicFeeds = Array.isArray(p.public_feeds) ? p.public_feeds : [];
  const packagesPublished = (name, ecosystem) =>
    publicPackages.some((entry) => packageMatches(entry, { name, ecosystem }));

  return {
    observed_at: payload?.observed_at ?? null,
    packages: (payload?.packages ?? []).filter((pkg) => packagesPublished(pkg.name, pkg.ecosystem)),
    advisories: (payload?.advisories ?? []).filter((a) => packagesPublished(a.package, a.ecosystem)),
    releases: (payload?.releases ?? []).filter((r) => listContains(publicUpstreams, r.slug)),
    feeds: (payload?.feeds ?? []).filter((f) => listContains(publicFeeds, f.url)),
    // An error with no `name` is not bound to an entity — `{source:'osv', error}`
    // is a whole-source failure, not a statement about one package — so it is
    // kept. An entity-bound error is kept only when its entity is published.
    errors: (payload?.errors ?? []).filter(
      (e) => e?.name === undefined || e?.name === null || nameIsPublished(e.name, p),
    ),
  };
}

/**
 * Project the decision rows as well as the payload.
 *
 * A projected payload is **not** enough, and this is the half that is easy to
 * miss: `renderDigest` renders a decision table whose Package column is
 * `decision.package` (`lib/render.mjs:325-335`), and the decision rows are a
 * separate document that reaches the renderer beside the payload. A run that
 * projected the payload and passed the decisions through unchanged would publish
 * a private package name in the table while every check on the payload said the
 * document was clean.
 *
 * A decision carries `package` and, on some paths, `ecosystem`. The name
 * comparison is therefore the same one `isPublishedPackageName` makes for an
 * error row — exact for a bare entry, canonical for an entry that declares its
 * ecosystem — and it is deliberately the strict direction, because a kept
 * decision publishes the package it names.
 */
export function projectDecisions(decisions, policy) {
  return (decisions ?? []).filter((d) => isPublishedPackageName(d?.package, policy ?? {}));
}

/** The kinds a drop record may name. A frozen vocabulary, never a value. */
const DROP_KINDS = Object.freeze(['packages', 'advisories', 'releases', 'feeds', 'errors']);

/**
 * What the projection removed — as counts and kinds, never as names.
 *
 * This record exists to answer "did the filter run, and what did it do?" — the
 * question with no detector until it was written down (FM-b in the design
 * review). It is written whether or not anything was dropped, because a
 * component that published nothing must say so rather than read as a quiet week
 * (I11).
 *
 * **It is structurally incapable of carrying a name**, rather than relying on
 * whoever writes the next field to remember. Every count is a `Math.max(0, n)`
 * over an array `.length` difference; every kind is drawn from the frozen
 * `DROP_KINDS` vocabulary; the object is frozen. No code path in this function
 * reads a `.name`, a `.slug` or a `.url` into the result. The precedent is
 * `lib/pubsafe.mjs:156-158`, which truncates a matched token because *"a finding
 * must not become a second copy of the thing it is reporting"* — a drop record
 * that named the package it dropped would be a second copy of the watch list,
 * committed or published by the very component that just decided not to.
 *
 * `watch` is the exception that proves the rule: its size is the size of the
 * private watch list, so the record says it was withheld and not how large it
 * was.
 */
export function dropRecord(payload, projected, policy) {
  const counts = {};
  let dropped = 0;
  for (const kind of DROP_KINDS) {
    const before = Array.isArray(payload?.[kind]) ? payload[kind].length : 0;
    const after = Array.isArray(projected?.[kind]) ? projected[kind].length : 0;
    counts[kind] = Math.max(0, before - after);
    dropped += counts[kind];
  }

  // Deny-all means every list is present *and* empty. A missing key is not a
  // deny-all — it is an invalid marker, and `validatePolicy` refuses it — so the
  // distinction survives into the record.
  const denyAll = POLICY_KEYS.every((key) => Array.isArray(policy?.[key]) && policy[key].length === 0);
  const withheldWatch =
    payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'watch') &&
    !(projected !== null && typeof projected === 'object' && Object.hasOwn(projected, 'watch'));

  return Object.freeze({
    deny_all: denyAll,
    dropped,
    counts: Object.freeze(counts),
    kinds: Object.freeze(DROP_KINDS.filter((kind) => counts[kind] > 0)),
    withheld: Object.freeze(withheldWatch ? ['watch'] : []),
  });
}
