const pool = require('../db/pool');

/**
 * Session label allocation.
 *
 * A session's label is its identity: it is stamped on every message in history
 * (messages JOIN sessions on session_token) and it is what @-mentions resolve
 * against, drawing from every session ever in the channel -- not just the
 * connected ones. Two sessions sharing a label in one channel therefore corrupts
 * attribution retroactively and fans a mention out to the wrong session.
 *
 * So uniqueness is per channel, across ALL session rows, connected or not.
 *
 * A UNIQUE (channel_id, label) index would be the obvious enforcement, but live
 * data already violates it (duplicate "Session N" rows from the old count-based
 * allocator, plus the 'Claude Code Session' rows inserted by the SSE and browser-WS
 * paths), so the index would fail to build. Allocation is serialized with a
 * transaction-scoped advisory lock keyed on the channel instead.
 */

const MAX_LABEL_LENGTH = 100;
const LOCK_NAMESPACE = 8724; // arbitrary, fixed: identifies the session-label lock class

/**
 * Run fn inside a transaction holding the per-channel label lock.
 * The lock MUST be taken on the same connection as the reads and the write, so
 * this checks out a dedicated client -- bare pool.query calls land on different
 * connections and the lock would be meaningless.
 */
async function withChannelLabelLock(channelId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Namespaced two-arg form so this lock cannot collide with another feature's
    // advisory lock that happens to use the same channel id.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, channelId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Every label currently in use in a channel, lowercased, excluding one session.
 * excludeToken lets a session re-register or rename without colliding with itself.
 */
async function usedLabels(client, channelId, excludeToken) {
  const result = await client.query(
    'SELECT label FROM sessions WHERE channel_id = $1 AND ($2::text IS NULL OR session_token <> $2)',
    [channelId, excludeToken || null]
  );
  return new Set(result.rows.map(r => String(r.label || '').trim().toLowerCase()).filter(Boolean));
}

/**
 * Lowest N >= 1 for which "Session N" is free in this channel.
 * Numbering is not reused while a row survives, so N grows monotonically in
 * long-lived channels. That is deliberate: reusing a number would re-point old
 * messages at a new session.
 */
function nextAutoLabel(taken) {
  let n = 1;
  while (taken.has(`session ${n}`)) n += 1;
  return `Session ${n}`;
}

/**
 * Make a requested label unique in the channel by appending " (2)", " (3)", ...
 * Returns the requested label untouched when it is free.
 */
function disambiguate(requested, taken) {
  const base = requested.trim().slice(0, MAX_LABEL_LENGTH);
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, MAX_LABEL_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base; // pathological; better a duplicate than an infinite loop
}

/**
 * Resolve the label a session should carry in a channel.
 *
 * requested: the caller's preferred label, or null/undefined to auto-assign.
 * A requested label is honored when free and suffixed when taken -- it is a
 * request, never a guarantee, so callers must use the returned value rather than
 * assuming they got what they asked for.
 *
 * Runs inside the caller's locked transaction client.
 */
async function resolveLabel(client, { channelId, requested, excludeToken }) {
  const taken = await usedLabels(client, channelId, excludeToken);
  const wanted = typeof requested === 'string' ? requested.trim() : '';
  if (!wanted) return { label: nextAutoLabel(taken), autoAssigned: true };
  return { label: disambiguate(wanted, taken), autoAssigned: false };
}

module.exports = {
  withChannelLabelLock,
  resolveLabel,
  MAX_LABEL_LENGTH,
};
