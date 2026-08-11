/**
 * Replay / durable-delivery harness.
 *
 * The repo has no test framework. This runs on plain node:
 *   node server/test-replay.js
 *
 * It exercises server/lib/replay.js against a fake pg client that answers the
 * four queries collectMissed issues, backed by an in-memory message fixture, so
 * the cursor arithmetic and the bounds are really evaluated rather than stubbed.
 */

const { collectMissed, deriveAnchorTime, REPLAY_MAX_MESSAGES } = require('./lib/replay');
const { matchMentions, isDeliverable } = require('./lib/mentions');

const NOW = new Date('2026-08-11T12:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Fake pg client. query() pattern-matches on SQL shape (the same four statements
 * collectMissed issues) and evaluates them against the fixture arrays.
 */
function fakeDb({ messages, sessions, mode }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));

      if (/delivery_mode FROM channels/.test(sql)) {
        return { rows: [{ delivery_mode: mode }] };
      }

      if (/COALESCE\(MAX\(id\), 0\)/.test(sql)) {
        const [, at] = params;
        const cutoff = new Date(at).getTime();
        const ids = messages.filter((m) => m.created_at.getTime() <= cutoff).map((m) => m.id);
        return { rows: [{ anchor_id: ids.length ? Math.max(...ids) : 0 }] };
      }

      if (/SELECT 1 FROM messages/.test(sql)) {
        const [, anchorId, ageCutoff] = params;
        const hit = messages.some(
          (m) => m.id > anchorId && m.created_at.getTime() < new Date(ageCutoff).getTime()
        );
        return { rows: hit ? [{ '?column?': 1 }] : [] };
      }

      if (/FROM messages m/.test(sql)) {
        const [, anchorId, ageCutoff, limit] = params;
        const cutoff = new Date(ageCutoff).getTime();
        const rows = messages
          .filter((m) => m.id > anchorId && m.created_at.getTime() >= cutoff)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((m) => Object.assign({}, m, { user_name: 'Human', session_label: null }));
        return { rows };
      }

      if (/FROM sessions WHERE channel_id/.test(sql)) {
        return { rows: sessions };
      }

      throw new Error(`fakeDb: unmatched SQL: ${sql}`);
    },
  };
}

function msg(id, minutesAgo, content) {
  return {
    id,
    channel_id: 7,
    user_id: 1,
    session_id: null,
    content,
    message_type: 'info',
    metadata: {},
    created_at: new Date(NOW.getTime() - minutesAgo * MIN),
  };
}

const SESSIONS = [
  { session_token: 'tok-a', label: 'QA Agent' },
  { session_token: 'tok-b', label: 'Session 2' },
];

async function run() {
  // -- deriveAnchorTime: newest of the three timestamps wins ------------------
  {
    const t = deriveAnchorTime({
      created_at: new Date('2026-08-10T00:00:00Z'),
      connected_at: new Date('2026-08-11T00:00:00Z'),
      disconnected_at: new Date('2026-08-11T06:00:00Z'),
    });
    eq('anchor time takes the newest timestamp', t.toISOString(), '2026-08-11T06:00:00.000Z');
    eq('anchor time is null for a missing row', deriveAnchorTime(null), null);
    const onlyCreated = deriveAnchorTime({ created_at: new Date('2026-08-10T00:00:00Z'), connected_at: null, disconnected_at: null });
    eq('anchor time falls back to created_at', onlyCreated.toISOString(), '2026-08-10T00:00:00.000Z');
  }

  // -- 1. session that was NEVER connected -----------------------------------
  {
    const messages = [msg(1, 90, 'before it existed'), msg(2, 30, 'after it existed'), msg(3, 10, 'also after')];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out = await collectMissed(db, {
      channelId: 7,
      sessionToken: 'tok-a',
      sessionRow: { created_at: new Date(NOW.getTime() - 60 * MIN), connected_at: null, disconnected_at: null },
      now: NOW,
    });
    eq('never-connected: anchor derived from created_at', out.anchor_id, 1);
    eq('never-connected: anchor source', out.anchor_source, 'session');
    eq('never-connected: count', out.count, 2);
    eq('never-connected: first replayed id', out.messages[0].id, 2);
    eq('never-connected: cursor', out.cursor, 3);
    eq('never-connected: not truncated', out.truncated_by, null);
  }

  // -- 2. reconnect uses disconnected_at, not created_at ----------------------
  {
    const messages = [msg(1, 120, 'old'), msg(2, 20, 'during the gap'), msg(3, 5, 'during the gap too')];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out = await collectMissed(db, {
      channelId: 7,
      sessionToken: 'tok-a',
      sessionRow: {
        created_at: new Date(NOW.getTime() - 5 * HOUR),
        connected_at: new Date(NOW.getTime() - 4 * HOUR),
        disconnected_at: new Date(NOW.getTime() - 30 * MIN),
      },
      now: NOW,
    });
    eq('reconnect: anchor is the disconnect point', out.anchor_id, 1);
    eq('reconnect: replays the gap only', out.count, 2);
  }

  // -- 3. mention mode: only the missed mentions come back --------------------
  {
    const messages = [
      msg(10, 50, 'unrelated chatter'),
      msg(11, 40, 'hey @QA Agent please look'),
      msg(12, 30, 'talking to @Session 2 instead'),
      msg(13, 20, 'more chatter'),
      msg(14, 10, 'and @qa agent again, case-insensitively'),
    ];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'mention' });
    const out = await collectMissed(db, {
      channelId: 7,
      sessionToken: 'tok-a',
      sessionRow: { created_at: new Date(NOW.getTime() - 60 * MIN), connected_at: null, disconnected_at: null },
      now: NOW,
    });
    eq('mention mode: mode reported', out.mode, 'mention');
    eq('mention mode: only mentions replayed', out.count, 2);
    eq('mention mode: first mention id', out.messages[0].id, 11);
    eq('mention mode: second mention id', out.messages[1].id, 14);
    check('mention mode: un-mentioned message absent', !out.messages.some((m) => m.id === 12 || m.id === 13));
    eq('mention mode: cursor is the last SCANNED id', out.cursor, 14);
    const labelLookups = db.calls.filter((c) => /FROM sessions WHERE channel_id/.test(c)).length;
    eq('mention mode: one label lookup for the whole batch', labelLookups, 1);
  }

  // -- 4. mention mode: the other session sees its own mention, not yours -----
  {
    const messages = [msg(20, 30, 'ping @QA Agent'), msg(21, 20, 'ping @Session 2')];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'mention' });
    const out = await collectMissed(db, {
      channelId: 7,
      sessionToken: 'tok-b',
      sessionRow: { created_at: new Date(NOW.getTime() - 60 * MIN), connected_at: null, disconnected_at: null },
      now: NOW,
    });
    eq('mention mode: per-session filtering', out.count, 1);
    eq('mention mode: correct message for tok-b', out.messages[0].id, 21);
    eq('mention mode: mentioned flag set', out.messages[0].mentioned, true);
  }

  // -- 5. empty gap -----------------------------------------------------------
  {
    const messages = [msg(1, 120, 'long before')];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out = await collectMissed(db, {
      channelId: 7,
      sessionToken: 'tok-a',
      sessionRow: { created_at: new Date(NOW.getTime() - 5 * MIN), connected_at: null, disconnected_at: new Date(NOW.getTime() - 5 * MIN) },
      now: NOW,
    });
    eq('empty gap: count is zero', out.count, 0);
    eq('empty gap: messages is an empty array', out.messages.length, 0);
    eq('empty gap: not truncated', out.truncated_by, null);
    eq('empty gap: cursor falls back to the anchor', out.cursor, out.anchor_id);
  }

  // -- 6. count bound ---------------------------------------------------------
  {
    const messages = [];
    for (let i = 1; i <= 60; i++) messages.push(msg(i, 60 - i, `msg ${i}`));
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out = await collectMissed(db, {
      channelId: 7,
      sessionToken: 'tok-a',
      sinceId: 0,
      now: NOW,
    });
    eq('count bound: capped at the max', out.count, REPLAY_MAX_MESSAGES);
    eq('count bound: reported as count', out.truncated_by, 'count');
    eq('count bound: last delivered id', out.messages[out.count - 1].id, 50);
    eq('count bound: cursor pages forward from the cap', out.cursor, 50);
  }

  // -- 7. age bound (distinct from the count bound) ---------------------------
  {
    const messages = [
      msg(1, 30 * 60, 'thirty hours old'),
      msg(2, 20, 'inside the window'),
      msg(3, 10, 'also inside'),
    ];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out = await collectMissed(db, { channelId: 7, sessionToken: 'tok-a', sinceId: 0, now: NOW });
    eq('age bound: only the in-window messages', out.count, 2);
    eq('age bound: reported as age', out.truncated_by, 'age');
    check('age bound: the stale message is absent', !out.messages.some((m) => m.id === 1));
  }

  // -- 8. explicit since_id overrides the derived anchor ----------------------
  {
    const messages = [msg(1, 50, 'a'), msg(2, 40, 'b'), msg(3, 30, 'c'), msg(4, 20, 'd')];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out = await collectMissed(db, {
      channelId: 7,
      sessionToken: 'tok-a',
      sinceId: 3,
      // A session row whose timestamps would have produced a much later anchor:
      // the client cursor must win, or a restamped connected_at silently swallows
      // the gap.
      sessionRow: { created_at: NOW, connected_at: NOW, disconnected_at: NOW },
      now: NOW,
    });
    eq('since_id: anchor comes from the client', out.anchor_id, 3);
    eq('since_id: anchor source', out.anchor_source, 'client');
    eq('since_id: only newer messages', out.count, 1);
    eq('since_id: correct message', out.messages[0].id, 4);

    // A string since_id (query-string form) parses the same way.
    const db2 = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out2 = await collectMissed(db2, { channelId: 7, sessionToken: 'tok-a', sinceId: '3', now: NOW });
    eq('since_id: string form parses', out2.anchor_id, 3);

    // Junk since_id falls back to the derived anchor rather than replaying all.
    const db3 = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out3 = await collectMissed(db3, {
      channelId: 7,
      sessionToken: 'tok-a',
      sinceId: 'not-a-number',
      sessionRow: { created_at: new Date(NOW.getTime() - 35 * MIN), connected_at: null, disconnected_at: null },
      now: NOW,
    });
    eq('since_id: junk falls back to the session anchor', out3.anchor_source, 'session');
    eq('since_id: junk anchor id', out3.anchor_id, 2); // 35 min ago sits between msg 2 (40m) and msg 3 (30m)
    eq('since_id: junk replays from the session anchor', out3.count, 2);
  }

  // -- 9. a mention sitting behind more than 50 non-mentions is still found ---
  {
    const messages = [];
    for (let i = 1; i <= 80; i++) messages.push(msg(i, 100 - i, i === 70 ? 'urgent @QA Agent' : `noise ${i}`));
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'mention' });
    const out = await collectMissed(db, { channelId: 7, sessionToken: 'tok-a', sinceId: 0, now: NOW });
    eq('mention scan: deep mention still delivered', out.count, 1);
    eq('mention scan: correct id', out.messages[0].id, 70);
    eq('mention scan: not falsely truncated', out.truncated_by, null);
  }

  // -- 10. no session row at all (anchor unknown) -----------------------------
  {
    const messages = [msg(1, 20, 'x'), msg(2, 10, 'y')];
    const db = fakeDb({ messages, sessions: SESSIONS, mode: 'broadcast' });
    const out = await collectMissed(db, { channelId: 7, sessionToken: 'tok-a', sessionRow: null, now: NOW });
    eq('no session row: anchor source', out.anchor_source, 'none');
    eq('no session row: anchor id', out.anchor_id, 0);
    eq('no session row: everything in the age window', out.count, 2);
  }

  // -- 11. the shared gate itself --------------------------------------------
  {
    const labels = new Map([['qa agent', ['tok-a']]]);
    const mentioned = matchMentions('ping @QA Agent now', labels);
    check('gate: broadcast delivers to any session', isDeliverable('broadcast', new Set(), 'tok-a'));
    check('gate: browsers always deliver in mention mode', isDeliverable('mention', new Set(), null));
    check('gate: mention mode delivers to the mentioned session', isDeliverable('mention', mentioned, 'tok-a'));
    check('gate: mention mode blocks an un-mentioned session', !isDeliverable('mention', mentioned, 'tok-b'));
    check('gate: email-style @ mid-token does not match', matchMentions('mail me at x@QA Agent', labels).size === 0);
    check('gate: label prefix does not match a longer word', matchMentions('@QA Agentx', labels).size === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
