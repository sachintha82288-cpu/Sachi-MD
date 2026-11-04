const test = require('node:test');
const assert = require('node:assert/strict');
const { splitThink, isInThink, mdToWhatsApp } = require('../src/utils/aiText');

test('splitThink separates reasoning from answer', () => {
  const r = splitThink('<think>user wants a summary</think>Here is the summary.');
  assert.equal(r.reasoning, 'user wants a summary');
  assert.equal(r.answer, 'Here is the summary.');
});

test('splitThink handles <thinking> variant and multiple blocks', () => {
  const r = splitThink('<thinking>one</thinking>A<think>two</think>B');
  assert.equal(r.reasoning, 'one\ntwo');
  assert.equal(r.answer, 'AB');
});

test('splitThink handles unterminated <think> (stream cut mid-reasoning)', () => {
  const r = splitThink('partial answer <think>still deciding what to');
  assert.equal(r.reasoning, 'still deciding what to');
  assert.equal(r.answer, 'partial answer');
});

test('splitThink passes plain text through untouched', () => {
  const r = splitThink('Just an answer, no reasoning.');
  assert.equal(r.reasoning, '');
  assert.equal(r.answer, 'Just an answer, no reasoning.');
});

test('isInThink detects open vs closed think blocks', () => {
  assert.equal(isInThink('<think>mid thought'), true);
  assert.equal(isInThink('<think>done</think> answer'), false);
  assert.equal(isInThink('plain'), false);
});

test('mdToWhatsApp converts markdown to WhatsApp formatting', () => {
  const out = mdToWhatsApp('## Title\n**bold** and *italic* and ~~gone~~\n- one\n- two\n[site](https://x.com)');
  assert.ok(out.includes('*Title*'));
  assert.ok(out.includes('*bold*'));
  assert.ok(out.includes('_italic_'));
  assert.ok(out.includes('~gone~'));
  assert.ok(out.includes('• one'));
  assert.ok(out.includes('site (https://x.com)'));
});

test('mdToWhatsApp keeps bold intact when italics are also present', () => {
  const out = mdToWhatsApp('**bold** *it*');
  assert.equal(out, '*bold* _it_');
});

test('mdToWhatsApp strips code fence language tags', () => {
  const out = mdToWhatsApp('```js\nconst x = 1;\n```');
  assert.ok(out.includes('```'));
  assert.ok(!out.includes('```js'));
});

test('mdToWhatsApp leaves spaced asterisks (math) untouched', () => {
  assert.equal(mdToWhatsApp('5 * 3 * 2 = 30'), '5 * 3 * 2 = 30');
  assert.equal(mdToWhatsApp('multiply a * b * c now'), 'multiply a * b * c now');
  assert.equal(mdToWhatsApp('**bold** and *it*'), '*bold* and _it_');
});
