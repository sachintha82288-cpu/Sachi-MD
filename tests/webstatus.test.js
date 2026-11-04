const test = require('node:test');
const assert = require('node:assert/strict');

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload || ''; },
  };
}

test('status handler: token gate open/closed behavior', async () => {
  const web = require('../src/web/status');
  const handler = web.createRequestHandler('secret-token-1');
  // no token → 403
  let res = fakeRes();
  handler({ url: '/', headers: {} }, res);
  assert.equal(res.statusCode, 403);
  // wrong token → 403
  res = fakeRes();
  handler({ url: '/?token=nope', headers: {} }, res);
  assert.equal(res.statusCode, 403);
  // query token → 200 with payload
  res = fakeRes();
  handler({ url: '/?token=secret-token-1', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.bot, require('../src/config').botName);
  assert.ok('whatsapp' in body && 'downloader' in body);
  // bearer token → 200
  res = fakeRes();
  handler({ url: '/', headers: { authorization: 'Bearer secret-token-1' } }, res);
  assert.equal(res.statusCode, 200);
});

test('status handler: no token configured → open (back-compat)', () => {
  const web = require('../src/web/status');
  const handler = web.createRequestHandler('');
  const res = fakeRes();
  handler({ url: '/', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).bot);
});
