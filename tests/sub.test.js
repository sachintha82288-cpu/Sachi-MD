/**
 * `.sub <channel|group link>` — follow / join from EVERY connected session.
 *
 * The routing is the interesting part and it is pure, so it is tested without
 * WhatsApp: one link, two protocols (newsletter API for channels, invite API
 * for groups), N sockets, and a per-session report that must survive one
 * number failing.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const channels = require('../src/services/channels');
const sessionManager = require('../src/whatsapp/sessionManager');
const command = require('../src/commands/owner/sub');

const CHANNEL = 'https://whatsapp.com/channel/0029VbAbCdEfGhIjKlMnOp12';
const GROUP = 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv';

/** A session whose socket records what was asked of it. */
function fakeSession(phone, { channel = null, group = null, isPrimary = false } = {}) {
  const calls = { follow: [], join: [] };
  return {
    id: phone || 'primary', phone, isPrimary, connected: true,
    calls,
    sock: {
      newsletterFollow: async (jid) => { calls.follow.push(jid); if (channel) throw new Error(channel); return { id: jid }; },
      groupAcceptInvite: async (code) => { calls.join.push(code); if (group) throw new Error(group); return '123-456@g.us'; },
      newsletterMetadata: async () => ({ name: 'Sri Lanka News', subscriberCount: 120000 }),
    },
  };
}

test('link parsing: channels, groups, bare codes, and everything else', () => {
  assert.deepEqual(channels.parseLink(CHANNEL), { kind: 'channel', value: '0029VbAbCdEfGhIjKlMnOp12' });
  assert.deepEqual(channels.parseLink('0029VbAbCdEfGhIjKlMnOp12'), { kind: 'channel', value: '0029VbAbCdEfGhIjKlMnOp12' });
  assert.deepEqual(channels.parseLink(GROUP), { kind: 'group', value: 'AbCdEfGhIjKlMnOpQrStUv' });
  assert.deepEqual(channels.parseLink('  https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv  '), { kind: 'group', value: 'AbCdEfGhIjKlMnOpQrStUv' });
  for (const bad of ['', 'nonsense', 'https://youtube.com/watch?v=x', 'https://whatsapp.com/channel/', null]) {
    const r = channels.parseLink(bad);
    assert.equal(r.kind, null, `${bad} must be rejected`);
    assert.ok(r.error && r.error.length > 10, 'a rejection explains itself');
  }
});

test('a channel link is followed by every session, via the newsletter API', async () => {
  const sessions = [fakeSession('94750404115', { isPrimary: true }), fakeSession('94771234567'), fakeSession('94770001111')];
  const r = await channels.joinAll(sessions, channels.parseLink(CHANNEL));
  assert.equal(r.ok.length, 3);
  assert.equal(r.failed.length, 0);
  for (const s of sessions) {
    assert.deepEqual(s.calls.follow, ['0029VbAbCdEfGhIjKlMnOp12@newsletter'], `${s.id} followed the channel`);
    assert.deepEqual(s.calls.join, [], 'a channel never goes through the group API');
  }
});

test('a group link is joined by every session, via the invite API', async () => {
  const sessions = [fakeSession('94750404115', { isPrimary: true }), fakeSession('94771234567')];
  const r = await channels.joinAll(sessions, channels.parseLink(GROUP));
  assert.equal(r.ok.length, 2);
  for (const s of sessions) {
    assert.deepEqual(s.calls.join, ['AbCdEfGhIjKlMnOpQrStUv'], `${s.id} used the invite code`);
    assert.deepEqual(s.calls.follow, [], 'a group never goes through the newsletter API');
  }
});

test('one failing number does not stop the others', async () => {
  const sessions = [
    fakeSession('94750404115', { isPrimary: true }),
    fakeSession('94771234567', { channel: 'item-not-found: channel does not exist' }),
    fakeSession('94770001111'),
  ];
  const r = await channels.joinAll(sessions, channels.parseLink(CHANNEL));
  assert.equal(r.ok.length, 2, 'the other two still followed');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].name, /94771234567/);
  assert.match(r.failed[0].reason, /no longer exists|expired/i, 'the reason is human-readable');
  assert.deepEqual(sessions[2].calls.follow.length, 1, 'the last number was still asked');
});

test('the report names the channel and lists who succeeded and who did not', async (t) => {
  const sessions = [fakeSession('94750404115', { isPrimary: true }), fakeSession('94771234567', { channel: 'not-authorized' })];
  const realConnected = sessionManager.connectedSessions;
  sessionManager.connectedSessions = () => sessions;
  t.after(() => { sessionManager.connectedSessions = realConnected; });
  let sent = null;
  await command.execute({
    args: [CHANNEL], prefix: '.', jid: '9477@s.whatsapp.net',
    reply: async (c) => { sent = c.text; return { key: { id: 'p' } }; },
    send: async () => ({ key: { id: 'p' } }),
    // the command edits its placeholder when the work is done; the final text
    // is what the owner ends up looking at
    edit: async (_key, text) => { sent = text; },
    msg: { key: { id: 'm' } },
  });
  // NOTE: `bold()` renders mathematical-bold Unicode, so assert on the plain
  // parts of the report rather than on the styled heading.
  assert.match(sent, /1\/2 numbers now follow/);
  assert.match(sent, /Sri Lanka News/, 'the channel name is resolved and shown');
  assert.match(sent, /94750404115|main/);
  assert.match(sent, /refused|not allowed|banned/i);
  assert.ok(sent.includes('⚠️'), 'a partial result is never dressed up as a clean success');
});

test('a bad link is refused with the usage, and nothing is contacted', async () => {
  let sent = null;
  const sessionsBefore = channels.joinAll;
  let contacted = false;
  channels.joinAll = async () => { contacted = true; return { ok: [], failed: [] }; };
  try {
    await command.execute({
      args: ['https://youtube.com/watch?v=x'], prefix: '.',
      reply: async (c) => { sent = c.text; return { key: { id: 'p' } }; },
      send: async () => ({ key: { id: 'p' } }), edit: async () => {},
    });
    assert.ok(!contacted, 'no WhatsApp call for an unusable link');
    assert.match(sent, /Unrecognised link/);
    assert.match(sent, /chat\.whatsapp\.com/);
  } finally { channels.joinAll = sessionsBefore; }
});

test('the command is owner-only and main-only (it acts on every number)', () => {
  assert.equal(command.ownerOnly, true);
  assert.equal(command.mainOnly, true);
  assert.equal(command.name, 'sub');
});
