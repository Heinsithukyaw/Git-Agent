/**
 * Version arithmetic. No dependency, because this code runs in a job that holds
 * a write token and every dependency is a supply-chain surface on that job.
 *
 * Deliberately covers only what the agent needs:
 *   - parse/compare SemVer and a few real-world dialects
 *   - decide whether a pinned version falls inside an OSV-style range
 *   - pick the smallest fixed version that is >= a pinned version
 *
 * It is not a general SemVer library. It refuses rather than guesses: an
 * unparseable version returns null, and callers treat null as "unknown",
 * which routes the advisory to human review rather than to a silent "safe".
 */

const NUMERIC = /^\d+$/;

/** Parse a version into comparable parts. Returns null if it is not a version. */
export function parse(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/^[vV]=?/, '');
  if (!raw || !/\d/.test(raw)) return null;

  // Build metadata is dropped before anything else, because SemVer says it does
  // not participate in precedence: `1.2.3+build.7` and `1.2.3` are the same
  // version. Go's `+incompatible` suffix arrives here too, and treating it as
  // unparseable would escalate a perfectly readable version to "unknown".
  const comparable = raw.split('+')[0];

  // release core, then optional pre-release after the first hyphen
  const hyphen = comparable.indexOf('-');
  const core = hyphen === -1 ? comparable : comparable.slice(0, hyphen);
  const pre = hyphen === -1 ? null : comparable.slice(hyphen + 1);

  const dotted = core.split('.');
  if (dotted.length > 4) return null;
  const nums = [];
  for (const part of dotted) {
    if (!NUMERIC.test(part)) return null;
    nums.push(parseInt(part, 10));
  }
  while (nums.length < 3) nums.push(0);

  return { major: nums[0], minor: nums[1], patch: nums[2], pre, raw };
}

function cmpPre(a, b) {
  // No pre-release sorts above any pre-release. Identifiers compare
  // numerically when both are numeric, lexically otherwise.
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ai = a.split('.');
  const bi = b.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i];
    const y = bi[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (NUMERIC.test(x) && NUMERIC.test(y)) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0, 1. null operands sort last so that "unknown" never looks safe. */
export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return cmpPre(pa.pre, pb.pre);
}

export const gt = (a, b) => compare(a, b) > 0;
export const gte = (a, b) => compare(a, b) >= 0;
export const lt = (a, b) => compare(a, b) < 0;
export const lte = (a, b) => compare(a, b) <= 0;
export const eq = (a, b) => compare(a, b) === 0;

/**
 * Does `pinned` fall inside a single OSV-style event range?
 *
 * OSV gives `introduced` and `fixed` (and optionally `last_affected`) per
 * affected range. `fixed` is exclusive; `last_affected` is inclusive. A missing
 * `introduced` means "from the beginning", conventionally 0.
 */
export function inRange(pinned, range = {}) {
  const p = parse(pinned);
  if (!p) return null; // unknown -> not "safe"
  const introduced = range.introduced && range.introduced !== '0' ? range.introduced : null;
  if (introduced && lt(pinned, introduced)) return false;
  if (range.last_affected) return lte(pinned, range.last_affected);
  if (range.fixed) return lt(pinned, range.fixed);
  // No upper bound at all: the range is open, so everything from `introduced`
  // onward is affected. This is the shape OSV uses for a vulnerability with no
  // published fix, and returning false here would report it as clear — which is
  // the one outcome this module exists to prevent.
  return true;
}

/** True if any range in the list contains `pinned`. Unknown -> false (not "safe"). */
export function inAnyRange(pinned, ranges = []) {
  if (!ranges.length) return false;
  return ranges.some((r) => inRange(pinned, r) === true);
}

/**
 * Smallest fixed version that is strictly greater than `pinned`.
 * Returns null when nothing in the advisory actually upgrades us.
 */
export function smallestUpgrade(pinned, ranges = []) {
  const candidates = ranges
    .map((r) => r.fixed)
    .filter((f) => typeof f === 'string' && parse(f))
    .filter((f) => gt(f, pinned));
  if (!candidates.length) return null;
  return candidates.reduce((best, cur) => (lt(cur, best) ? cur : best));
}

/** How far apart two versions are, for sorting the digest by urgency. */
export function distance(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return 'major';
  if (pa.minor !== pb.minor) return 'minor';
  if (pa.patch !== pb.patch) return 'patch';
  return 'none';
}
