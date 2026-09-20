/**
 * Rendering. Everything the user reads is produced here, from the payload and
 * the decision records — never from memory, never from the model directly.
 *
 * Two rules govern this file:
 *
 *   - **Stamp the observation time, never the schedule.** Scheduled workflows
 *     are delayed under load and may be dropped. "As of 06:12 UTC" is honest;
 *     "today's briefing" is a small lie that will eventually be caught (I11).
 *   - **A gap is rendered, not hidden.** A source that failed produces a visible
 *     row saying so. A digest that silently omits a failed source is worse than
 *     one that admits it, because it reads as complete.
 *
 * The deterministic template is the whole digest when no model is configured.
 * Narration, when present, is a paragraph on top of this — not a replacement
 * for it.
 */

import { DECISIONS } from './triage.mjs';

export const MARKER_BEGIN = '<!-- git-agent:begin -->';
export const MARKER_END = '<!-- git-agent:end -->';

const ORDER = [DECISIONS.ACT, DECISIONS.MITIGATE, DECISIONS.UNCERTAIN, DECISIONS.WATCH, DECISIONS.CLEAR];

const HEADINGS = {
  [DECISIONS.ACT]: 'Act on these',
  [DECISIONS.MITIGATE]: 'Affected, no fix published',
  [DECISIONS.UNCERTAIN]: 'Needs your call',
  [DECISIONS.WATCH]: 'Affected, not on your path',
  [DECISIONS.CLEAR]: 'Clear',
};

const WHY = {
  [DECISIONS.ACT]: 'reachable from code you import',
  [DECISIONS.MITIGATE]: 'no patched version exists yet',
  [DECISIONS.UNCERTAIN]: 'the rules could not reach a verdict',
  [DECISIONS.WATCH]: 'you do not import the affected symbol',
  [DECISIONS.CLEAR]: 'your pinned version is outside the affected range',
};

/* ---------------------------------------------------------------- facts ---- */

/**
 * The fact list handed to the narrator.
 *
 * These strings are the input to the containment gate, so every entity the
 * digest is allowed to mention must appear here. It is built from the payload
 * and the decision records only — nothing else is a permitted source.
 */
export function buildFacts(payload, decisions) {
  const facts = [];
  for (const d of decisions) {
    facts.push(
      `${d.advisory_id} affects ${d.package}${d.pinned ? ` pinned at ${d.pinned}` : ''}` +
        `${d.upgrade ? `; fixed in ${d.upgrade}` : '; no fixed version published'}` +
        `${d.severity ? `; severity ${d.severity}` : ''}` +
        `; decision ${d.decision} because ${d.reason}`,
    );
  }
  for (const r of payload.releases ?? []) {
    facts.push(`${r.slug} released ${r.tag}${r.published_at ? ` on ${r.published_at.slice(0, 10)}` : ''}`);
  }
  for (const f of payload.feeds ?? []) {
    for (const item of (f.items ?? []).slice(0, 3)) facts.push(`feed item: ${item.title}`);
  }
  for (const e of payload.errors ?? []) {
    facts.push(`source unavailable: ${e.source}${e.name ? ` (${e.name})` : ''}`);
  }
  facts.push(`observed at ${payload.observed_at}`);
  return facts;
}

/* --------------------------------------------------------------- digest ---- */

function rowsFor(decisions, decision) {
  return decisions.filter((d) => d.decision === decision);
}

export function renderDigest({ payload, decisions, narration = null, commands = [] }) {
  const observed = payload.observed_at ?? new Date().toISOString();
  const counts = Object.fromEntries(ORDER.map((k) => [k, rowsFor(decisions, k).length]));
  const out = [];

  out.push(`# Dependency digest`);
  out.push('');
  out.push(`**As of ${observed}** — not "today", because a scheduled run can be delayed or dropped.`);
  out.push('');

  if (narration) {
    out.push(narration.trim());
    out.push('');
  }

  out.push(
    `**${counts[DECISIONS.ACT]} to act on** · ${counts[DECISIONS.MITIGATE]} unfixable · ` +
      `${counts[DECISIONS.UNCERTAIN]} needing your call · ${counts[DECISIONS.WATCH]} watched · ` +
      `${counts[DECISIONS.CLEAR]} clear`,
  );
  out.push('');

  for (const decision of ORDER) {
    const rows = rowsFor(decisions, decision);
    if (!rows.length) continue;
    out.push(`## ${HEADINGS[decision]}`);
    out.push('');
    out.push(`_${WHY[decision]}._`);
    out.push('');
    out.push('| Advisory | Package | Pinned | Fixed | Severity | Why |');
    out.push('|---|---|---|---|---|---|');
    for (const d of rows) {
      // Severity is either the score the source published or the word it
      // published. Both are quoted; neither is invented.
      const severity = d.severity ?? d.severity_label ?? '—';
      out.push(
        `| \`${d.advisory_id}\` | \`${d.package ?? '—'}\` | ${d.pinned ? `\`${d.pinned}\`` : '—'} | ` +
          `${d.upgrade ? `\`${d.upgrade}\`` : '—'} | ${severity} | ${d.reason} |`,
      );
    }
    out.push('');
  }

  if ((payload.releases ?? []).length) {
    out.push('## Upstream releases');
    out.push('');
    for (const r of payload.releases) {
      if (!r.tag) continue;
      out.push(`- **${r.slug}** — ${r.tag}${r.published_at ? ` (${r.published_at.slice(0, 10)})` : ''}${r.url ? ` — ${r.url}` : ''}`);
    }
    out.push('');
  }

  for (const f of payload.feeds ?? []) {
    if (!(f.items ?? []).length) continue;
    out.push(`## From ${new URL(f.url).hostname}`);
    out.push('');
    for (const item of f.items.slice(0, 5)) {
      out.push(`- ${item.title}${item.link ? ` — ${item.link}` : ''}`);
    }
    out.push('');
  }

  // A gap is rendered, not hidden.
  if ((payload.errors ?? []).length) {
    out.push('## Gaps in this run');
    out.push('');
    out.push('These sources did not answer. The digest is incomplete in exactly these places:');
    out.push('');
    for (const e of payload.errors) {
      out.push(`- \`${e.source}\`${e.name ? ` — ${e.name}` : ''}: ${e.error}`);
    }
    out.push('');
  }

  if (commands.length) {
    out.push('## Commands received');
    out.push('');
    for (const c of commands) {
      out.push(`- \`/agent ${c.verb}${c.arg ? ` ${c.arg}` : ''}\` — ${c.outcome ?? 'recorded'} (${c.author})`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    'Reply in the rolling issue to talk to it: `/agent why <pkg>`, `/agent bump <pkg>`, ' +
      '`/agent explain <GHSA-…>`, `/agent wrong <pkg>`, `/agent pause`.',
  );
  out.push('');

  return out.join('\n');
}

/* --------------------------------------------------------------- README ---- */

/** Replace the region between the markers, leaving everything else untouched. */
export function replaceBetweenMarkers(existing, section) {
  const begin = existing.indexOf(MARKER_BEGIN);
  const end = existing.indexOf(MARKER_END);
  if (begin === -1 || end === -1 || end < begin) {
    return `${existing.trimEnd()}\n\n${MARKER_BEGIN}\n${section}\n${MARKER_END}\n`;
  }
  return `${existing.slice(0, begin)}${MARKER_BEGIN}\n${section}\n${MARKER_END}${existing.slice(end + MARKER_END.length)}`;
}

/** The README region. Small: it is the daily surface, not the whole digest. */
export function renderReadmeSection({ payload, decisions, heartbeat }) {
  const observed = payload?.observed_at ?? heartbeat?.last_run_at ?? new Date().toISOString();
  const act = rowsFor(decisions ?? [], DECISIONS.ACT);
  const uncertain = rowsFor(decisions ?? [], DECISIONS.UNCERTAIN);
  const lines = [];

  lines.push(`### As of ${observed}`);
  lines.push('');
  if (!act.length && !uncertain.length) {
    lines.push('Nothing needs a decision today.');
  } else {
    if (act.length) {
      lines.push(`**${act.length} to act on**`);
      lines.push('');
      for (const d of act.slice(0, 8)) {
        lines.push(
          `- \`${d.advisory_id}\` — \`${d.package}\` ${d.pinned ? `\`${d.pinned}\`` : ''}` +
            `${d.upgrade ? ` → \`${d.upgrade}\`` : ''} · ${d.reason}`,
        );
      }
      lines.push('');
    }
    if (uncertain.length) {
      lines.push(`**${uncertain.length} needing your call**`);
      lines.push('');
      for (const d of uncertain.slice(0, 8)) {
        lines.push(`- \`${d.advisory_id}\` — \`${d.package}\` · ${d.reason}`);
      }
      lines.push('');
    }
  }
  const errors = payload?.errors ?? [];
  if (errors.length) {
    lines.push(`_${errors.length} source(s) did not answer this run — see the digest._`);
    lines.push('');
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------- summary ---- */

/** Small scalars for badges and the liveness signal. */
export function renderSummary({ payload, decisions, heartbeat }) {
  return {
    generated_at: new Date().toISOString(),
    observed_at: payload?.observed_at ?? null,
    advisories: decisions?.length ?? 0,
    actionable: rowsFor(decisions ?? [], DECISIONS.ACT).length,
    uncertain: rowsFor(decisions ?? [], DECISIONS.UNCERTAIN).length,
    clear: rowsFor(decisions ?? [], DECISIONS.CLEAR).length,
    packages: payload?.packages?.length ?? 0,
    sources_failed: payload?.errors?.length ?? 0,
    last_run_at: heartbeat?.last_run_at ?? null,
    last_status: heartbeat?.last_status ?? null,
  };
}

/* --------------------------------------------------------------- events ---- */

/**
 * Events are transitions, not snapshots. Compare the previous item set with the
 * current one and emit only what moved — history records what happened, not
 * that the clock ticked.
 */
export function diffEvents(previous = [], current = [], { observed_at } = {}) {
  const prev = new Map(previous.map((p) => [p.advisory_id, p]));
  const events = [];
  for (const c of current) {
    const before = prev.get(c.advisory_id);
    if (!before) {
      events.push({ at: observed_at, kind: 'flagged', advisory_id: c.advisory_id, package: c.package, decision: c.decision });
      continue;
    }
    if (before.decision !== c.decision) {
      events.push({
        at: observed_at,
        kind: 'reclassified',
        advisory_id: c.advisory_id,
        package: c.package,
        from: before.decision,
        to: c.decision,
      });
    }
    if (before.pinned !== c.pinned) {
      events.push({ at: observed_at, kind: 'bumped', advisory_id: c.advisory_id, package: c.package, from: before.pinned, to: c.pinned });
    }
  }
  for (const [id, p] of prev) {
    if (!current.some((c) => c.advisory_id === id)) {
      events.push({ at: observed_at, kind: 'cleared', advisory_id: id, package: p.package });
    }
  }
  return events;
}

/* --------------------------------------------------------------- replies --- */

const UNGROUNDED_NOTICE =
  '> ⚠️ **This answer is not verified.** It is reasoning over the stored record, ' +
  'not a quote of a fetched payload, so it is not covered by the containment gate.';

/**
 * Build the reply body for a command.
 *
 * Lookups are rendered from stored records, which is why seven of the eight verbs
 * cannot hallucinate: there is no generation in them at all.
 */
export function renderReply({ verb, arg, decisions = [], events = [], commands = [], modelAnswer = null }) {
  switch (verb) {
    case 'why': {
      const { name, version } = arg;
      const rows = decisions.filter((d) => d.package === name && (!version || d.pinned === version));
      if (!rows.length) {
        return `No stored decision for \`${name}\`${version ? `@${version}` : ''}. ` +
          `Either it has no advisory on record, or it is not in the watch list.`;
      }
      const lines = rows.map((d) => {
        const parts = [
          `- **\`${d.advisory_id}\`** — decision \`${d.decision}\` (${d.layer} layer)`,
          `  - pinned \`${d.pinned ?? 'unknown'}\`, fixed \`${d.upgrade ?? 'none published'}\``,
          `  - ${d.reason}`,
        ];
        if (d.typed) {
          // No `confidence` here: a `noul` answer has no such field. No single
          // `score` either — the band is read per answer, so the honest thing to
          // print is both answers, the band each was read against, and which
          // question the model declined to call.
          const unsure = Array.isArray(d.typed.unsure) && d.typed.unsure.length
            ? `, unsure about ${d.typed.unsure.join(' and ')}`
            : '';
          parts.push(
            `  - typed layer: reachability ${fmt(d.typed.reaches_a_trust_boundary)}, ` +
              `component ${fmt(d.typed.we_use_the_vulnerable_component)}, ` +
              `band ${fmt(1 - d.tau)}–${fmt(d.tau)} read per answer${unsure}` +
              `${d.model_version ? `, model \`${d.model_version}\`` : ''}`,
          );
        }
        return parts.join('\n');
      });
      return [`### Why \`${name}\`${version ? `@${version}` : ''} is where it is`, '', ...lines].join('\n');
    }

    case 'what-changed': {
      const since = arg;
      const rows = since ? events.filter((e) => (e.at ?? '') >= since) : events.slice(-25);
      if (!rows.length) return since ? `Nothing changed since ${since}.` : 'No transitions recorded yet.';
      const lines = rows.slice(-25).map((e) => {
        if (e.kind === 'reclassified') return `- \`${e.advisory_id}\` reclassified ${e.from} → ${e.to}`;
        if (e.kind === 'bumped') return `- \`${e.package}\` bumped ${e.from ?? '—'} → ${e.to ?? '—'}`;
        if (e.kind === 'cleared') return `- \`${e.advisory_id}\` cleared`;
        return `- \`${e.advisory_id}\` flagged as ${e.decision}`;
      });
      return [`### Changes${since ? ` since ${since}` : ''}`, '', ...lines].join('\n');
    }

    case 'wrong': {
      const { name, version } = arg;
      return [
        '### Label recorded',
        '',
        `You disagree with the stored decision for \`${name}\`${version ? `@${version}` : ''}. Recorded.`,
        '',
        'This is the only signal that makes the system better over time: a label is a human ' +
          'disagreeing with a machine, and it is what the threshold gets tuned against.',
      ].join('\n');
    }

    case 'pause':
      return 'Paused. The schedule is skipped from the next run until `/agent resume`.';

    case 'resume':
      return 'Resumed. The next scheduled run proceeds.';

    case 'explain': {
      const d = decisions.find((x) => x.advisory_id === arg);
      const head = [`### \`${arg}\``, ''];
      if (!d) {
        return [...head, 'No stored decision for that advisory id in this repository.'].join('\n');
      }
      const stored = [
        `- package \`${d.package ?? '—'}\`, pinned \`${d.pinned ?? '—'}\`, fixed \`${d.upgrade ?? '—'}\``,
        `- decision \`${d.decision}\` — ${d.reason}`,
        `- layer: ${d.layer}${d.tau ? `, τ ${d.tau}` : ''}${d.model_version ? `, model \`${d.model_version}\`` : ''}`,
      ];
      if (!modelAnswer) {
        return [...head, ...stored, '', '_No model endpoint configured, so no narrative was generated._'].join('\n');
      }
      // The notice is permanent and visible: the digest is verified, help is not.
      return [...head, ...stored, '', UNGROUNDED_NOTICE, '', modelAnswer.trim()].join('\n');
    }

    default:
      return `Unknown verb \`${verb}\`.`;
  }
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : '—';
}

/* ----------------------------------------------------------- markdown ---- */

/**
 * Markdown to HTML, for the Pages surface.
 *
 * The subset is the one this repository actually emits: headings, paragraphs,
 * lists, pipe tables, rules, blockquotes, and inline code/bold/links. Anything
 * else is escaped and passed through as text — a partial render beats a
 * dependency, because this runs in the job that publishes a public page.
 *
 * Escaping happens first and unconditionally: upstream advisory summaries and
 * feed titles are attacker-shaped text, and they reach this function.
 */
export function markdownToHtml(md) {
  const lines = String(md ?? '').split('\n');
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  const openList = (tag) => {
    if (list !== tag) {
      closeList();
      out.push(`<${tag}>`);
      list = tag;
    }
  };

  const isTableSeparator = (l) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(l) && l.includes('-');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      continue;
    }

    // Pipe table: a header row, a separator, then body rows.
    if (line.trim().startsWith('|') && isTableSeparator(lines[i + 1] ?? '')) {
      closeList();
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body.push(cells(lines[i]));
        i++;
      }
      i--;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
      );
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      openList('ul');
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      openList('ol');
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  return out.join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" rel="noopener noreferrer nofollow">$1</a>',
    );
}

/* --------------------------------------------------------------- errors ---- */

/** Render a parse/validation failure as a reply, without echoing the body back. */
export function renderError(err) {
  const code = err?.code ?? 'error';
  const known = {
    'not-a-command': 'That comment is not a command. Commands start with `/agent`.',
    unparsable: 'No known verb. Try `/agent why <pkg>`, or `/agent pause`.',
    'unsafe-arg': 'That argument contains characters outside the allowed set. Rejected.',
    'bad-arg': err.message,
    'not-watched': err.message,
    'unknown-verb': err.message,
    'unknown-id': err.message,
    unauthorised: 'Only repository owners, members and collaborators may issue commands.',
  };
  return known[code] ?? `Command rejected (\`${code}\`).`;
}
