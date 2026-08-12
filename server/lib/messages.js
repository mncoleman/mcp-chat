/**
 * One definition of what a message looks like on the wire.
 *
 * A message row is built in four read paths (REST history, MCP get_messages,
 * replay, and the live send paths) and they had already drifted once: replay
 * selected user_name + session_label while REST also selected user_avatar. That
 * was survivable. A reply's quoted parent is not -- if the parent join lands in
 * get_messages but not in replay, a replayed reply arrives stripped of the thing
 * it is replying to, which is exactly the live/replay asymmetry the delivery
 * design exists to prevent. So the SELECT lives here and every path imports it.
 */

// How much of the parent is carried as a preview. The quote is an affordance for
// "what is this answering", not a second copy of the message -- the original is
// one click away, and a session paging history should not pay twice for a long
// parent it can already see above.
const REPLY_PREVIEW_CHARS = 240;

// The quoted parent, on its own. Split out because the MCP get_messages path
// deliberately selects a narrow column list (no avatars, no metadata) to keep
// tool payloads small, and still needs the quote -- so it takes this without
// taking the browser's columns.
const REPLY_COLUMNS = `
  LEFT(p.content, ${REPLY_PREVIEW_CHARS}) AS reply_to_content,
  (p.id IS NOT NULL AND LENGTH(p.content) > ${REPLY_PREVIEW_CHARS}) AS reply_to_truncated,
  pu.name AS reply_to_user_name,
  ps.label AS reply_to_session_label
`;

// Columns beyond m.* that every message carries. `m.*` supplies reply_to_id.
const MESSAGE_COLUMNS = `
  u.name AS user_name,
  u.avatar_url AS user_avatar,
  s.label AS session_label,
  ${REPLY_COLUMNS}
`;

// LEFT joins throughout on the parent side: reply_to_id is nullable, the parent
// may have been deleted (FK is ON DELETE SET NULL, but a race is possible), and
// a parent sent by a human has no session row. Any of those must yield a normal
// message, never drop the row from the result.
const MESSAGE_JOINS = `
  JOIN users u ON u.id = m.user_id
  LEFT JOIN sessions s ON s.session_token = m.session_id
  LEFT JOIN messages p ON p.id = m.reply_to_id
  LEFT JOIN users pu ON pu.id = p.user_id
  LEFT JOIN sessions ps ON ps.session_token = p.session_id
`;

/**
 * Validate a reply target before insert. A reply may only point at a message in
 * the SAME channel: cross-channel parents would leak a private channel's content
 * as a quote into a public one, which no membership check downstream would catch
 * because the quote rides along inside an otherwise legitimate message.
 *
 * Returns { ok: true, replyToId } or { ok: false, error }.
 */
async function resolveReplyTo(db, channelId, rawReplyToId) {
  if (rawReplyToId === undefined || rawReplyToId === null || rawReplyToId === '') {
    return { ok: true, replyToId: null };
  }
  const replyToId = parseInt(rawReplyToId, 10);
  if (isNaN(replyToId)) {
    return { ok: false, error: 'reply_to_id must be a message id' };
  }
  const parent = await db.query(
    'SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2',
    [replyToId, channelId]
  );
  if (parent.rows.length === 0) {
    return { ok: false, error: 'reply_to_id must reference a message in this channel' };
  }
  return { ok: true, replyToId };
}

/**
 * Attach the quoted-parent fields to a freshly inserted message.
 *
 * The insert paths RETURNING * a bare row, so without this a reply would go out
 * live carrying reply_to_id but no quote, and only grow one when someone reloaded
 * history. Same shape as MESSAGE_COLUMNS, deliberately.
 */
async function attachReplyPreview(db, message) {
  if (!message.reply_to_id) return message;
  const parent = await db.query(
    `SELECT LEFT(p.content, ${REPLY_PREVIEW_CHARS}) AS reply_to_content,
            (LENGTH(p.content) > ${REPLY_PREVIEW_CHARS}) AS reply_to_truncated,
            pu.name AS reply_to_user_name,
            ps.label AS reply_to_session_label
     FROM messages p
     JOIN users pu ON pu.id = p.user_id
     LEFT JOIN sessions ps ON ps.session_token = p.session_id
     WHERE p.id = $1`,
    [message.reply_to_id]
  );
  Object.assign(message, parent.rows[0] || {});
  return message;
}

module.exports = {
  MESSAGE_COLUMNS,
  MESSAGE_JOINS,
  REPLY_COLUMNS,
  REPLY_PREVIEW_CHARS,
  resolveReplyTo,
  attachReplyPreview,
};
