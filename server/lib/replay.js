/**
 * Durable delivery: per-session cursor + missed-message replay.
 *
 * The defect this closes: delivery only ever touched currently-open sockets, so a
 * message sent during a reconnect window was lost to that session, and an @mention
 * of a session that happened to have no socket open was dropped entirely. The
 * messages themselves were never lost (they are written to `messages` before any
 * delivery is attempted) -- what was missing was any way for a session to learn it
 * missed something.
 *
 * NO SCHEMA CHANGE IS REQUIRED. The cursor is derived, not stored:
 *   - messages.id is SERIAL, so it is monotonic and is the only correct replay
 *     predicate (m.id > anchor). Timestamps are used ONLY to derive the starting
 *     id, never to compare messages against each other.
 *   - sessions already carries created_at, connected_at and disconnected_at; the
 *     most recent of the three is the last moment the session was demonstrably
 *     in sync with the channel.
 *   - a client that tracks its own last-seen id may override the derived anchor
 *     with an explicit since_id, which is both more precise and immune to the
 *     re-registration hazard below.
 *
 * HAZARD (why anchors are read before writes): both the WS connect path and MCP
 * register_session stamp connected_at = NOW() on the session row. Deriving the
 * anchor AFTER that write moves it to "now" and reports an empty gap forever. The
 * WS path therefore reads the session row BEFORE its upsert and passes it in here.
 * A client that re-registers should pass since_id from its own persisted state.
 *
 * NO SERVER-SIDE ACK: nothing here advances a stored cursor, because there is no
 * stored cursor. Repeated unseen queries return the same set until the caller
 * advances since_id itself, using the `cursor` value returned below.
 */

// Bounds. Both are deliberate:
//
// COUNT (50) matches the REST history default in server/routes/messages.js -- the
// amount of backlog this product has always considered "recent" -- and bounds the
// burst a reconnecting socket receives to one screenful rather than a channel dump.
//
// AGE (24h) is the point past which a backlog stops being actionable. A broadcast
// message a day old is noise; an unanswered @mention a day old is at the edge of
// still being worth acting on. One bound covers both rather than splitting it.
// Shared with every other read path. A replayed message must be shaped exactly
// like the live one it stands in for, quoted parent included.
const { MESSAGE_COLUMNS, MESSAGE_JOINS } = require('./messages');

const REPLAY_MAX_MESSAGES = 50;
const REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// In mention mode most candidates are filtered out, so bounding the SCAN at 50
// would let a single mention sitting behind 50 unrelated messages be missed -- the
// exact failure this feature exists to fix. Scan wider, then cap the DELIVERED set
// at REPLAY_MAX_MESSAGES.
const REPLAY_MENTION_SCAN_MAX = 500;

/**
 * The last moment this session was demonstrably in sync with the channel.
 * Newest of created_at / connected_at / disconnected_at; null if the row is absent.
 */
function deriveAnchorTime(sessionRow) {
  if (!sessionRow) return null;
  const times = [sessionRow.created_at, sessionRow.connected_at, sessionRow.disconnected_at]
    .filter((t) => t !== null && t !== undefined)
    .map((t) => (t instanceof Date ? t : new Date(t)))
    .filter((d) => !isNaN(d.getTime()));
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

function parseSinceId(sinceId) {
  if (sinceId === null || sinceId === undefined || sinceId === '') return null;
  const n = typeof sinceId === 'number' ? sinceId : parseInt(String(sinceId), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Resolve the message id the session has already seen up to.
 * Returns { anchorId, source: 'client' | 'session' | 'none' }.
 */
async function resolveAnchorId(db, { channelId, sinceId, sessionRow }) {
  const explicit = parseSinceId(sinceId);
  if (explicit !== null) return { anchorId: explicit, source: 'client' };

  const anchorTime = deriveAnchorTime(sessionRow);
  if (!anchorTime) return { anchorId: 0, source: 'none' };

  const { rows } = await db.query(
    'SELECT COALESCE(MAX(id), 0) AS anchor_id FROM messages WHERE channel_id = $1 AND created_at <= $2',
    [channelId, anchorTime]
  );
  return { anchorId: Number(rows[0]?.anchor_id || 0), source: 'session' };
}

async function lookupMode(db, channelId) {
  try {
    const { rows } = await db.query('SELECT delivery_mode FROM channels WHERE id = $1', [channelId]);
    return rows[0]?.delivery_mode === 'mention' ? 'mention' : 'broadcast';
  } catch (err) {
    console.error('[replay] mode lookup failed, defaulting to broadcast:', err.message);
    return 'broadcast';
  }
}

/**
 * Everything this session missed, bounded and mode-filtered.
 *
 * Membership is NOT checked here -- every caller has already enforced it (the WS
 * connect path gates at connection time, the MCP tool gates like get_messages,
 * with no admin auto-join carve-out). Do not add a redundant check; do not call
 * this from anywhere that has not gated first.
 *
 * Returns:
 *   { messages, count, mode, anchor_id, anchor_source, cursor, truncated_by }
 * where each message carries `mentioned` (true when this session was @-mentioned)
 * and truncated_by is 'count' | 'age' | null.
 */
async function collectMissed(db, { channelId, sessionToken, sinceId, sessionRow, mode, now, mentions }) {
  const m = mentions || require('./mentions');
  const resolvedMode = mode || (await lookupMode(db, channelId));
  const { anchorId, source } = await resolveAnchorId(db, { channelId, sinceId, sessionRow });

  const nowMs = now ? new Date(now).getTime() : Date.now();
  const ageCutoff = new Date(nowMs - REPLAY_MAX_AGE_MS);
  const scanLimit = resolvedMode === 'mention' ? REPLAY_MENTION_SCAN_MAX : REPLAY_MAX_MESSAGES;

  // Fetch one extra row to distinguish "exactly at the bound" from "more waiting".
  const { rows } = await db.query(
    `SELECT m.*, ${MESSAGE_COLUMNS}
     FROM messages m
     ${MESSAGE_JOINS}
     WHERE m.channel_id = $1 AND m.id > $2 AND m.created_at >= $3
     ORDER BY m.id ASC
     LIMIT $4`,
    [channelId, anchorId, ageCutoff, scanLimit + 1]
  );

  let scanned = rows;
  let scanTruncated = false;
  if (scanned.length > scanLimit) {
    scanned = scanned.slice(0, scanLimit);
    scanTruncated = true;
  }

  // Mode filter, through the same gate live delivery uses.
  let delivered = scanned;
  if (resolvedMode === 'mention') {
    // One label lookup for the whole batch, not one per message.
    const labels = await m.loadChannelLabels(db, channelId);
    delivered = [];
    for (const row of scanned) {
      const mentioned = m.matchMentions(row.content, labels);
      if (m.isDeliverable(resolvedMode, mentioned, sessionToken)) {
        delivered.push(Object.assign({}, row, { mentioned: mentioned.has(sessionToken) }));
      }
    }
  } else {
    delivered = scanned.map((row) => Object.assign({}, row, { mentioned: false }));
  }

  let truncatedBy = null;
  if (delivered.length > REPLAY_MAX_MESSAGES) {
    delivered = delivered.slice(0, REPLAY_MAX_MESSAGES);
    truncatedBy = 'count';
  } else if (scanTruncated) {
    truncatedBy = 'count';
  }

  // The cursor is the newest id the caller can safely consider handled: the last
  // message SCANNED (not merely delivered), so a client does not re-scan messages
  // the mode filter already discarded. When truncated it is the last delivered id,
  // so the caller can page forward from exactly where it stopped.
  let cursor;
  if (truncatedBy === 'count') {
    cursor = delivered.length > 0 ? Number(delivered[delivered.length - 1].id) : anchorId;
  } else {
    cursor = scanned.length > 0 ? Number(scanned[scanned.length - 1].id) : anchorId;
  }

  // Age truncation: only meaningful when the count bound was not the binding one.
  // Something newer than the anchor but older than the cutoff exists and will
  // never be replayed, and the caller deserves to know which bound bit.
  if (!truncatedBy) {
    const older = await db.query(
      'SELECT 1 FROM messages WHERE channel_id = $1 AND id > $2 AND created_at < $3 LIMIT 1',
      [channelId, anchorId, ageCutoff]
    );
    if (older.rows.length > 0) truncatedBy = 'age';
  }

  return {
    messages: delivered,
    count: delivered.length,
    mode: resolvedMode,
    anchor_id: anchorId,
    anchor_source: source,
    cursor,
    truncated_by: truncatedBy,
  };
}

module.exports = {
  collectMissed,
  resolveAnchorId,
  deriveAnchorTime,
  REPLAY_MAX_MESSAGES,
  REPLAY_MAX_AGE_MS,
  REPLAY_MENTION_SCAN_MAX,
};
