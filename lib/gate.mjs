/**
 * The containment gate.
 *
 * > Every entity in the digest must appear in the fetched payload. If an entity
 * > appears in the output that is not in the input, the run fails.
 *
 * "Entity" is deliberately wider than "number", because the failure that
 * destroys trust is not always numeric. The set is
 *
 *     { advisory id, package name, version literal, numeric token }
 *
 * A hallucinated `GHSA-…` identifier, or an invented package name inside a
 * sentence that reads "you depend on X", is the same class of failure as an
 * invented version number — and a numeric-only check walks straight past both.
 *
 * WHERE THIS RUNS IS PART OF THE GATE. It is invoked only from jobs that hold
 * no model key (`scripts/commit-step.mjs`, `scripts/reply-step.mjs`). A gate
 * sharing a job with the model is a gate the model's own input can influence.
 *
 * The gate is exact and deterministic and must stay that way. A
 * paraphrase-tolerant second pass may only ever queue a sentence for human
 * review. It must never gate a commit.
 */

const ADVISORY_RE =
  /\b(?:GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,7}|OSV-20\d{2}-\d{4,7}|RUSTSEC-20\d{2}-\d{4}|PYSEC-20\d{2}-\d{4}|GHSA-[A-Za-z0-9-]{4,})\b/gi;

// A version literal: dotted numerics with an optional pre-release / build tail.
// Anchored so it cannot match the inside of an already-matched advisory id.
const VERSION_RE = /(?<![A-Za-z0-9_-])(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z][0-9A-Za-z.\-]*)?)(?![A-Za-z0-9])/g;

// Any standalone number, including the integers inside a version literal.
const NUMBER_RE = /(?<![A-Za-z0-9_.\-])(\d+(?:\.\d+)?)(?![A-Za-z0-9.])/g;

// A package-shaped token. Two classes:
//   scoped    @babel/core, @types/node
//   separated left-pad, z.std, my_lib     <- the separator is the signal
//
// A single bare word ("lodash") is only treated as a package when it is
// positioned like one — see PACKAGE_KEYWORD_RE / PACKAGE_STATE_RE below.
//
// Both patterns must start and end on an alphanumeric: a name at the end of a
// sentence is followed by a full stop, and a token that swallows that stop
// ("@babel/core.") is a token the payload can never contain.
const SCOPED_RE = /@[a-z0-9][a-z0-9-]*\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,58}[A-Za-z0-9_-])?/g;

// The leading character must be a letter, and the separator must be followed by
// a letter. Without both rules the extractor reads version literals (`4.17.15`)
// and the tail of an advisory id (`35jh-r3h4-6jhm`) as package names, and every
// grounded sentence fails the gate.
const SEPARATED_RE = /(?<![A-Za-z0-9@/])[a-z][a-z0-9]*[-._][A-Za-z](?:[A-Za-z0-9._-]{0,57}[A-Za-z0-9])?/g;

// Position, not merely presence.
//
// The first version of this file treated any lowercase word on a line
// containing package-ish language as a package. That is unusable: "affected, and
// we import it" yielded `and`, `we`, `import`, `it` as entities, so a *correct*
// digest failed the gate and narration could never commit. A gate that rejects
// everything protects nothing — it just fails loudly and gets disabled.
//
// So a bare word is a candidate only when it sits where a package name sits:
// after a package keyword ("bump lodash", "package lodash"), or immediately
// before a state verb ("lodash is pinned"). Function words are then subtracted,
// because "pinned at" and "the version is affected" are ordinary English.
const PACKAGE_KEYWORD_RE =
  /\b(?:packages?|dependenc(?:y|ies)|depend(?:s|ing|ed)?|modules?|librar(?:y|ies)|libs?|crates?|gems?|import(?:s|ed|ing)?|require[sd]?|bump(?:ed|s)?|upgrade[sd]?|downgrade[sd]?|pin(?:ned|s)?|install(?:s|ed|ing)?|use[sd]?|using)\s+`?([a-z][a-z0-9._-]{1,39})`?/gi;

const PACKAGE_STATE_RE =
  /(?<![A-Za-z0-9@/_.-])`?([a-z][a-z0-9._-]{1,39})`?\s+(?:is|are|was|were|be|being|has|have|had|pinned|affected|imported|reachable|vulnerable|fixed|released|upgraded|deprecated|unmaintained|watched|clear|flagged)\b/gi;

// The words that are never a package. Kept short on purpose: a miss here is a
// loud false positive, never a silent pass, because an unrecognised function
// word becomes an entity the payload cannot contain.
const STOPWORDS = new Set([
  'a', 'about', 'above', 'advisories', 'advisory', 'after', 'again', 'all', 'also', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
  'but', 'by', 'can', 'clear', 'code', 'confidence', 'could', 'day', 'days', 'decision', 'decisions',
  'detail', 'details', 'did', 'digest', 'do', 'does', 'during', 'each', 'either', 'else', 'error',
  'errors', 'even', 'every', 'exposure', 'few', 'first', 'for', 'from', 'gap', 'gaps', 'had', 'has',
  'have', 'he', 'her', 'here', 'him', 'his', 'how', 'however', 'if', 'in', 'into', 'is', 'it', 'its',
  'job', 'jobs', 'just', 'layer', 'less', 'like', 'line', 'lines', 'many', 'may', 'might', 'more',
  'most', 'much', 'must', 'need', 'needs', 'neither', 'never', 'new', 'next', 'no', 'nor', 'not',
  'now', 'of', 'off', 'old', 'on', 'once', 'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own',
  'per', 'published', 'range', 'ranges', 'reachability', 'reason', 'run', 'runs', 'same', 'second',
  'severity', 'she', 'should', 'since', 'so', 'some', 'source', 'sources', 'still', 'such', 'symbol',
  'symbols', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'third',
  'this', 'those', 'though', 'threshold', 'three', 'through', 'time', 'times', 'to', 'too', 'two',
  'under', 'until', 'up', 'us', 'use', 'used', 'uses', 'using', 'version', 'versions', 'very', 'via',
  'was', 'we', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who', 'why', 'will',
  'with', 'within', 'without', 'would', 'you', 'your',
]);

function isStopword(token) {
  return STOPWORDS.has(token.toLowerCase());
}

function maskEntities(text) {
  return text.replace(ADVISORY_RE, ' advisory ').replace(VERSION_RE, ' version ');
}

const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);

function uniq(items) {
  return [...new Set(items)];
}

function matchAll(text, re) {
  return uniq([...text.matchAll(re)].map((m) => m[1] ?? m[0]));
}

/** Collect every numeric literal present anywhere in a payload. */
function collectNumbers(node, out = new Set()) {
  if (typeof node === 'number' && Number.isFinite(node)) {
    out.add(String(node));
    return out;
  }
  if (typeof node === 'string') {
    for (const m of node.matchAll(NUMBER_RE)) out.add(m[1]);
    return out;
  }
  if (Array.isArray(node)) {
    out.add(String(node.length));
    for (const v of node) collectNumbers(v, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectNumbers(v, out);
    return out;
  }
  return out;
}

/**
 * Build the set of entities a generated text is allowed to mention.
 *
 * `derived` lets a caller pass scalars it computed from the payload itself
 * (counts, percentages). Those are arithmetic over the payload, not invention,
 * so they are legitimate — but they must be passed explicitly, never assumed.
 */
export function indexPayload(payload, { derived = [] } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});

  const packages = new Set();
  if (payload && typeof payload === 'object') {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.name === 'string') packages.add(node.name);
      if (typeof node.package === 'string') packages.add(node.package);
      if (typeof node.ecosystem === 'string' && typeof node.name === 'string') {
        packages.add(node.name);
      }
      // Symbols we import are names the digest is entitled to use: they came
      // from the payload, which is the whole test this gate applies. Without
      // this, an honest sentence like "we import merge from lodash" fails.
      if (Array.isArray(node.imported_symbols)) {
        for (const s of node.imported_symbols) if (typeof s === 'string') packages.add(s);
      }
      if (Array.isArray(node)) node.forEach(walk);
      else Object.values(node).forEach(walk);
    };
    walk(payload);
    // The watch list is payload too: the agent is allowed to name what it watches.
    if (Array.isArray(payload.watch?.packages)) {
      payload.watch.packages.forEach((p) => packages.add(typeof p === 'string' ? p : p.name));
    }
  }
  for (const m of text.matchAll(SCOPED_RE)) packages.add(m[0]);

  const numbers = collectNumbers(payload);
  for (const d of derived) numbers.add(String(d));

  return {
    advisories: new Set(matchAll(text, ADVISORY_RE).map((s) => s.toUpperCase())),
    packages,
    versions: new Set(matchAll(text, VERSION_RE)),
    numbers,
  };
}

/** Pull candidate entities out of a generated text. */
export function extract(text) {
  const packages = new Set(matchAll(text, SCOPED_RE));

  // Advisory ids and version literals are masked before the package rules run,
  // so their fragments can never be read as names. They are still extracted
  // below, from the original text.
  const masked = maskEntities(text);

  for (const m of masked.matchAll(SEPARATED_RE)) {
    const tok = m[0];
    if (MONTHS.has(tok.toLowerCase())) continue;
    packages.add(tok);
  }

  // Bare words, but only where a package name would sit.
  //
  // `import merge from lodash` names a *symbol*, not a package, so a token
  // followed by a `from` clause is skipped. Symbols are separately allowed via
  // imported_symbols in indexPayload, so nothing is lost by skipping here.
  for (const [re, skipFromClause] of [
    [PACKAGE_KEYWORD_RE, true],
    [PACKAGE_STATE_RE, false],
  ]) {
    for (const m of masked.matchAll(re)) {
      const tok = m[1];
      if (!tok || isStopword(tok)) continue;
      if (skipFromClause && /^`?\s+from\b/i.test(masked.slice(m.index + m[0].length))) continue;
      packages.add(tok);
    }
  }

  return {
    advisories: new Set(matchAll(text, ADVISORY_RE).map((s) => s.toUpperCase())),
    packages,
    versions: new Set(matchAll(text, VERSION_RE)),
    numbers: new Set(matchAll(text, NUMBER_RE)),
  };
}

function contextOf(text, token) {
  const i = text.indexOf(token);
  if (i === -1) return '';
  return text.slice(Math.max(0, i - 45), i + token.length + 45).replace(/\s+/g, ' ').trim();
}

/**
 * Run the gate.
 *
 * @param {string} prose    generated text
 * @param {object} payload  the fetched payload it is supposed to describe
 * @param {object} [opts]   { derived: number[], allowPackages: string[] }
 * @returns {{ok: boolean, violations: Array, checked: object}}
 */
export function check(prose, payload, { derived = [], allowPackages = [] } = {}) {
  if (typeof prose !== 'string') {
    return { ok: false, violations: [{ kind: 'input', token: typeof prose, context: 'prose is not a string' }], checked: {} };
  }

  const allowed = indexPayload(payload, { derived });
  for (const p of allowPackages) allowed.packages.add(p);
  const found = extract(prose);
  const violations = [];

  const kinds = [
    ['advisory', 'advisories'],
    ['package', 'packages'],
    ['version', 'versions'],
    ['number', 'numbers'],
  ];

  for (const [singular, plural] of kinds) {
    for (const token of found[plural]) {
      if (allowed[plural].has(token)) continue;
      // A version literal is also a number; if the exact version is known, the
      // bare-number check has already been satisfied by it.
      if (plural === 'numbers' && allowed.versions.has(token)) continue;
      violations.push({
        kind: singular,
        token,
        context: contextOf(prose, token),
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checked: {
      advisories: found.advisories.size,
      packages: found.packages.size,
      versions: found.versions.size,
      numbers: found.numbers.size,
    },
  };
}

/** Fail loudly. Used by the commit job. */
export function assertGrounded(prose, payload, opts = {}) {
  const result = check(prose, payload, opts);
  if (result.ok) return result;
  const lines = result.violations
    .slice(0, 25)
    .map((v) => `::error::ungrounded ${v.kind} "${v.token}" — …${v.context}…`);
  throw new Error(
    `containment gate FAILED: ${result.violations.length} entity(ies) in the output are absent from the payload\n` +
      lines.join('\n'),
  );
}
