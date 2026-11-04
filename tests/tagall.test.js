/**
 * Round 6 — .tagall with the admin wall removed, plus the new options
 * (hidden tags, admins only, quoted text) and chunking for huge groups.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.REACTIONS_ENABLED = 'false';
process.env.TAGALL_CHUNK = '10';                 // small chunks so the test is readable

const tagall = require('../src/commands/group/tagall');
const tagperm = require('../src/commands/settings/tagperm');
const settings = require('../src/services/settings');
const config = require('../src/config');

const GROUP = '120363000000000001@g.us';
const OWNER = '94700000001@s.whatsapp.net';
const ADMIN = '94700000002@s.whatsapp.net';
const MEMBER = '94700000003@s.whatsapp.net';

const settingsFile = path.join(config.paths.data, 'settings.json');
const backup = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;

function people(n = 25) {
  const out = [{ id: ADMIN, admin: 'admin' }, { id: OWNER, admin: null }];
  for (let i = 4; i < n + 2; i++) out.push({ id: `947000000${String(i).padStart(2, '0')}@s.whatsapp.net`, admin: null });
  return out;
}

function ctxFor({ args = [], sender = MEMBER, isOwner = false, quoted = null, participants = people(), subject = 'Test Group' } = {}) {
  const sent = [];
  const ctx = {
    sock: { groupMetadata: async () => ({ subject, participants }) },
    jid: GROUP,
    sender,
    args,
    isOwner,
    isGroup: true,
    quotedMsg: quoted,
    target: null,
    config: { ...config, owner: OWNER },
    prefix: '.',
    send: async (to, content, opts) => {
      const out = { to, content, opts, key: { id: 'M' + (sent.length + 1) } };
      sent.push(out);
      return out;
    },
  };
  ctx.reply = async (content) => ctx.send(GROUP, content, { quoted: true, reply: true });
  ctx.edit = async (key, content) => { const out = { to: GROUP, content, edit: key, key }; sent.push(out); return out; };
  return { ctx, sent };
}

const texts = (sent) => sent.map((s) => s.content && s.content.text).filter(Boolean);
const mentionCount = (sent) => sent.reduce((n, s) => n + ((s.content && s.content.mentions) || []).length, 0);

test.after(() => {
  if (backup === null) { try { fs.unlinkSync(settingsFile); } catch {} }
  else fs.writeFileSync(settingsFile, backup);
  config.tagallPerm = 'all';
});

test('a normal member can tag everyone by default (the admin wall is gone)', async () => {
  settings.update({ tagallPerm: 'all' });
  const { ctx, sent } = ctxFor({ args: [] });
  await tagall.execute(ctx);
  assert.equal(mentionCount(sent), 25, 'every participant is mentioned');
  assert.match(texts(sent).join('\n'), /tagging all \*25\* members/i);
  assert.ok(!texts(sent).join('\n').includes('⛔'), 'no permission refusal');
});

test('the owner can always tagall, whatever the permission level is', async () => {
  settings.update({ tagallPerm: 'owner' });
  const { ctx, sent } = ctxFor({ args: ['meeting'], sender: OWNER, isOwner: true });
  await tagall.execute(ctx);
  assert.equal(mentionCount(sent), 25);
  assert.match(texts(sent).join('\n'), /meeting/);
});

test('.tagperm admin blocks members but still lets admins through', async () => {
  const owner = ctxFor({ args: ['admin'], sender: OWNER, isOwner: true });
  await tagperm.execute(owner.ctx);
  assert.match(texts(owner.sent).join('\n'), /admins \(and the owner\)/);
  assert.equal(settings.tagallPerm(), 'admin');

  const member = ctxFor({ args: [] });
  await tagall.execute(member.ctx);
  assert.match(texts(member.sent).join('\n'), /⛔/);
  assert.equal(mentionCount(member.sent), 0, 'a member tags nobody when restricted');

  const admin = ctxFor({ args: ['hi'], sender: ADMIN });
  await tagall.execute(admin.ctx);
  assert.equal(mentionCount(admin.sent), 25, 'an admin still tags everyone');
  settings.update({ tagallPerm: 'all' });
});

test('.tagperm refuses an unknown level and shows the current one', async () => {
  const bad = ctxFor({ args: ['nobody'], sender: OWNER, isOwner: true });
  await tagperm.execute(bad.ctx);
  assert.match(texts(bad.sent).join('\n'), /Unknown level/);
  const show = ctxFor({ args: [], sender: OWNER, isOwner: true });
  await tagperm.execute(show.ctx);
  assert.match(texts(show.sent).join('\n'), /Now: \*all\*/);
});

test('a custom message replaces the default notice', async () => {
  const { ctx, sent } = ctxFor({ args: ['meeting', 'at', '8pm'] });
  await tagall.execute(ctx);
  const out = texts(sent).join('\n');
  assert.match(out, /^meeting at 8pm/);
  assert.ok(!/tagging all/i.test(out), 'the default notice is gone');
});

test('hide mode notifies everyone without the visible @list', async () => {
  const { ctx, sent } = ctxFor({ args: ['hide', 'quiet', 'notice'] });
  await tagall.execute(ctx);
  const out = texts(sent).join('\n');
  assert.equal(mentionCount(sent), 25, 'mentions are still attached');
  assert.ok(!out.includes('@9470'), 'no @numbers are printed');
  assert.match(out, /quiet notice/);
});

test('the admins flag tags only the admins', async () => {
  const { ctx, sent } = ctxFor({ args: ['admins', 'check', 'this'] });
  await tagall.execute(ctx);
  assert.deepEqual(sent[0].content.mentions, [ADMIN]);
  assert.match(texts(sent).join('\n'), /check this/);
});

test('a quoted message becomes the tagall text', async () => {
  const quoted = { conversation: 'read the rules please' };
  const { ctx, sent } = ctxFor({ args: [], quoted });
  await tagall.execute(ctx);
  assert.match(texts(sent).join('\n'), /read the rules please/);
  assert.equal(mentionCount(sent), 25);
});

test('huge groups are chunked inside a message budget, never one impossible message', async () => {
  const big = people(250);
  const { ctx, sent } = ctxFor({ args: ['roll call'], participants: big });
  await tagall.execute(ctx);
  const tagMessages = sent.filter((s) => s.content && s.content.mentions);
  assert.equal(mentionCount(sent), 250, 'everybody is tagged');
  assert.ok(tagMessages.length <= 10, `the tag is split over ${tagMessages.length} messages (budget 10)`);
  for (const m of tagMessages) {
    assert.ok(m.content.text.length < 4000, 'each message stays inside the WhatsApp text limit');
    assert.ok(m.content.mentions.length > 0);
  }
  assert.match(texts(sent).join('\n'), /Tagged \*250\* member\(s\) in \*\d+\* messages/);
});

test('a 20 000-member group is tagged silently instead of firing 200 messages', async () => {
  const huge = people(20000);
  const { ctx, sent } = ctxFor({ args: ['census'], participants: huge });
  await tagall.execute(ctx);
  const tagMessages = sent.filter((s) => s.content && s.content.mentions);
  assert.equal(mentionCount(sent), 20000, 'all 20 000 are mentioned');
  assert.ok(tagMessages.length <= 10, `${tagMessages.length} messages — the rate limiter could never keep up with more`);
  for (const m of tagMessages) assert.ok(m.content.text.length < 4000, 'no over-long message');
  assert.match(texts(sent).join('\n'), /Too many people to print every @/, 'the user is told why the list is hidden');
});

test('an over-long announcement is clamped, not rejected by WhatsApp', async () => {
  const { ctx, sent } = ctxFor({ args: ['x'.repeat(9000)], participants: people(5) });
  await tagall.execute(ctx);
  const body = sent.find((s) => s.content && s.content.mentions);
  assert.ok(body.content.text.length < 4000, `text is ${body.content.text.length} chars`);
  assert.match(body.content.text, /…/, 'the clamp is visible');
  assert.equal(mentionCount(sent), 5, 'the tag still went out');
});

test('broken participant rows cannot poison the mention list', async () => {
  const broken = [{ id: OWNER, admin: null }, {}, null, { id: 42 }, { id: 'not-a-jid' }, { id: '94700000003@s.whatsapp.net' }];
  const { ctx, sent } = ctxFor({ args: ['hi'], participants: broken });
  await tagall.execute(ctx);
  const mentions = sent.flatMap((s) => (s.content && s.content.mentions) || []);
  assert.deepEqual(mentions, [OWNER, '94700000003@s.whatsapp.net']);
  assert.ok(!mentions.some((m) => String(m).includes('[object')), 'no [object Object] mentions');
});

test('device-suffixed and duplicate participant ids are collapsed', async () => {
  const dupes = [
    { id: '94700000002@s.whatsapp.net', admin: 'admin' },
    { id: '94700000002:12@s.whatsapp.net', admin: null },
    { id: '94700000003@s.whatsapp.net', admin: null },
  ];
  const { ctx, sent } = ctxFor({ args: [], participants: dupes });
  await tagall.execute(ctx);
  assert.deepEqual(sent[0].content.mentions, ['94700000002@s.whatsapp.net', '94700000003@s.whatsapp.net']);
});

test('a group metadata failure is reported, not thrown', async () => {
  const { ctx, sent } = ctxFor({ args: [] });
  ctx.sock.groupMetadata = async () => { throw new Error('403 not in group'); };
  await tagall.execute(ctx);
  assert.match(texts(sent).join('\n'), /Could not read the group info/);
});

test('an empty group does not crash the command', async () => {
  const { ctx, sent } = ctxFor({ args: [], participants: [] });
  await tagall.execute(ctx);
  assert.match(texts(sent).join('\n'), /no readable participant list/i);
});
