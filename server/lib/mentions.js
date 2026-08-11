/**
 * Mention resolution and the single delivery-gating rule.
 *
 * This used to live inline in server/ws/index.js as one function that did both a
 * DB lookup and the string matching. Replay needs the matching for every message
 * in a batch, and re-running the lookup per message is an N+1 against a table
 * that does not change between messages -- so the two halves are split here:
 *
 *   loadChannelLabels(db, channelId) -- one query, reusable across a batch
 *   matchMentions(content, labelMap) -- pure, no I/O, directly testable
 *   resolveMentions(db, channelId, content) -- the original compose, unchanged
 *                                              behavior for existing callers
 *
 * isDeliverable() is the ONE place the mention gate is decided. Live delivery
 * (deliverMessage) and reconnect replay both call it, so mention semantics can
 * never drift between "you were online" and "you were not".
 */

/**
 * Load the channel's label -> [session_token] map, lowercased.
 * Draws from ALL sessions ever in the channel (current + historical) so a mention
 * resolves even for a session that is not currently online.
 * On any DB error it returns an empty map -- the safe failure mode (browsers still
 * get the message; no session is pushed in error rather than over-delivering).
 */
async function loadChannelLabels(db, channelId) {
  const labelToTokens = new Map();
  let rows;
  try {
    ({ rows } = await db.query(
      'SELECT session_token, label FROM sessions WHERE channel_id = $1',
      [channelId]
    ));
  } catch (err) {
    console.error('[mentions] label lookup failed:', err.message);
    return labelToTokens;
  }
  if (!rows || rows.length === 0) return labelToTokens;

  for (const r of rows) {
    if (!r.label) continue;
    const key = String(r.label).toLowerCase();
    if (!labelToTokens.has(key)) labelToTokens.set(key, []);
    labelToTokens.get(key).push(r.session_token);
  }
  return labelToTokens;
}

/**
 * Which session tokens are @-mentioned in this content.
 * Mirrors the client's mention matching (client/src/pages/ChatPage.jsx splitMentions):
 * an "@" that begins a token (start of string or preceded by whitespace), followed by
 * a known session label (case-insensitive, longest label first so multi-word labels
 * win over shorter prefixes), where the character after the label is not a word char.
 * Pure function: no I/O, so it is the same code path live and on replay.
 */
function matchMentions(content, labelToTokens) {
  const tokens = new Set();
  if (typeof content !== 'string' || !content.includes('@')) return tokens;
  if (!labelToTokens || labelToTokens.size === 0) return tokens;

  const names = [...labelToTokens.keys()].sort((a, b) => b.length - a.length);

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '@') continue;
    if (i > 0 && !/\s/.test(content[i - 1])) continue; // must begin a token
    const rest = content.slice(i + 1);
    const lowerRest = rest.toLowerCase();
    const name = names.find((n) => {
      if (!lowerRest.startsWith(n)) return false;
      const after = rest[n.length];
      return after === undefined || !/\w/.test(after);
    });
    if (name) {
      for (const t of labelToTokens.get(name)) tokens.add(t);
      i += name.length; // skip past the matched label
    }
  }
  return tokens;
}

/**
 * Resolve which session tokens are @-mentioned in a message's content.
 * Returns a Set of matched session_tokens.
 */
async function resolveMentions(db, channelId, content) {
  if (typeof content !== 'string' || !content.includes('@')) return new Set();
  const labels = await loadChannelLabels(db, channelId);
  return matchMentions(content, labels);
}

/**
 * THE delivery gate. Given a channel's delivery mode and the mentioned-token set
 * for one message, decide whether a given session receives it.
 *
 * sessionToken null/undefined means a browser-class client: browsers always
 * receive every message in both modes (mention gating is for session push only).
 *
 * Both the live fan-out and reconnect replay route through here, deliberately:
 * a session must see on replay exactly what it would have seen live.
 */
function isDeliverable(mode, mentionedTokens, sessionToken) {
  if (!sessionToken) return true;
  if (mode !== 'mention') return true;
  return !!mentionedTokens && mentionedTokens.has(sessionToken);
}

module.exports = { loadChannelLabels, matchMentions, resolveMentions, isDeliverable };
