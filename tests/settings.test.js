const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const mode = require('../src/services/mode');
const settings = require('../src/services/settings');
const router = require('../src/router/router');
const menu = require('../src/menu/menu');
const mb = require('../src/services/menubuttons');

router.loadCommands();
const COMMANDS = router.list();

/**
 * Apply a settings patch for the duration of a test and put the persisted
 * file back exactly as it was afterwards.
 */
function withSettings(patch, fn) {
  const file = config.paths.settings;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const before = { ...settings.get() };
  try {
    settings.update(patch);
    return fn();
  } finally {
    settings.update(before);
    if (backup === null) { try { fs.rmSync(file, { force: true }); } catch {} }
    else fs.writeFileSync(file, backup);
  }
}

test('the mode list is exactly the four modes plus "all"', () => {
  for (const m of ['self', 'inbox', 'public', 'groups', 'all']) {
    assert.equal(mode.isValid(m), true, m);
    assert.ok(mode.label(m).length > 3, m + ' has a label');
  }
  assert.equal(mode.isValid('nope'), false);
  assert.equal(mode.MODES.length, 5);
});

test('each mode listens to the right chats', () => {
  const cases = {
    self: { self: true, dm: false, group: false },
    inbox: { self: true, dm: true, group: false },
    public: { self: false, dm: true, group: true },
    groups: { self: false, dm: false, group: true },
    all: { self: true, dm: true, group: true }
  };
  for (const [m, expect] of Object.entries(cases)) {
    mode.set(m);
    assert.equal(mode.current(), m);
    assert.equal(mode.chatAllowed({ isSelf: true, isGroup: false }), expect.self, `${m} · self chat`);
    assert.equal(mode.chatAllowed({ isSelf: false, isGroup: false }), expect.dm, `${m} · private chat`);
    assert.equal(mode.chatAllowed({ isSelf: false, isGroup: true }), expect.group, `${m} · group chat`);
  }
  mode.set('all');
});

test('the owner chat stays a control channel in every mode', () => {
  for (const m of mode.MODES) {
    mode.set(m);
    assert.equal(
      mode.allows({ isSelf: true, isGroup: false, isOwner: true, isOwnerCommand: true }),
      true,
      `${m}: owner commands always work in the own chat`
    );
  }
  mode.set('all');
});

test('mode.set() only accepts known modes', () => {
  const before = mode.current();
  assert.equal(mode.set('nope'), null);
  assert.equal(mode.current(), before);
  assert.equal(mode.set('groups'), 'groups');
  assert.equal(mode.current(), 'groups');
  mode.set('all');
});

test('the name, header, footer and logo are configurable', () => {
  withSettings({ botName: 'Test Bot', header: 'My Header', footer: 'My Footer' }, () => {
    assert.equal(settings.name(), 'Test Bot');
    assert.equal(settings.header(), 'My Header');
    assert.equal(settings.footer(), 'My Footer');
    // the card uses them
    const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true });
    const im = p.content.viewOnceMessage.message.interactiveMessage;
    assert.equal(im.header.title, 'My Header');
    assert.equal(im.footer.text, 'My Footer');
    // the classic text menu uses the name
    const text = menu.main({ commands: COMMANDS, name: 'T', isOwner: true });
    assert.ok(text.includes(menu.sansB('TEST BOT')), 'custom name in the crest');
  });
});

test('a custom logo wins over the shipped one', () => {
  const dir = path.join(config.paths.data, 'branding');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'logo.test.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    withSettings({}, () => {
      settings.update({ logo: path.relative(config.paths.root, file) });
      assert.equal(settings.logoFile(), file);
      assert.equal(mb.logoPath(), file, 'the menu uses the custom logo');
      const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true });
      assert.equal(p.media.image.url, file, 'the card carries the custom logo');
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('without a custom logo the shipped one is used', () => {
  withSettings({ logo: '' }, () => {
    assert.equal(settings.logoFile(), '');
    assert.ok(mb.logoPath().endsWith('logo.jpg') || mb.logoPath().endsWith('logo.png'));
  });
});

test('the settings commands are registered and owner-only', () => {
  for (const name of ['mode', 'settings', 'setname', 'setheader', 'setfooter', 'setlogo', 'resetlogo']) {
    const c = COMMANDS.find((x) => x.name === name);
    assert.ok(c, name + ' exists');
    assert.equal(c.ownerOnly, true, name + ' is owner only');
    assert.equal(c.category, 'settings', name + ' lives in the settings category');
  }
});

test('the mode command switches the mode and refuses unknown values', async () => {
  const replies = [];
  const ctx = {
    args: [], prefix: '.', reply: async (c) => replies.push(c.text)
  };
  const cmd = COMMANDS.find((c) => c.name === 'mode');
  await cmd.execute(ctx);
  assert.ok(replies[0].includes('self') && replies[0].includes('groups'), 'lists the modes');
  replies.length = 0;
  await cmd.execute({ ...ctx, args: ['nope'] });
  assert.ok(/Unknown mode/.test(replies[0]), 'refuses an unknown mode');
  replies.length = 0;
  await cmd.execute({ ...ctx, args: ['groups'] });
  assert.ok(/Mode changed/.test(replies[0]), 'switches the mode');
  assert.equal(mode.current(), 'groups');
  mode.set('all');
});
