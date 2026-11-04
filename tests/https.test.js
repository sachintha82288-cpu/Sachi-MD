/**
 * Round 10 — the pair site is served over HTTPS.
 *
 * The owner's requirement was "the web must be on HTTPS" and the deployment is
 * a Pterodactyl panel with ONE allocated port and no domain, so the bot has to
 * terminate TLS itself on that port. These tests assert the behaviour a phone
 * browser will actually meet:
 *
 *   • `https://ip:port/` serves the page (self-signed cert, accepted once)
 *   • `http://ip:port/` is a 301 to the https:// address, not a hang
 *   • the security headers are still there (HSTS now included)
 *   • the API works over TLS, and the owner console stays token-gated
 *   • a real certificate supplied in .env wins over the generated one
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

const server = require('../src/web/server');
const tlsMaterial = require('../src/web/tls');

const TLS_DIR = path.join(__dirname, '..', 'data', 'tls');
const hadCert = fs.existsSync(path.join(TLS_DIR, 'cert.pem'));

after(() => {
  try {
    if (!hadCert) fs.rmSync(TLS_DIR, { recursive: true, force: true });
  } catch {}
  delete process.env.PAIR_ADMIN_TOKEN;
});

/** One request that does not care that the certificate is self-signed. */
function req(mod, url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = mod.request(url, { method, rejectUnauthorized: false, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test('the site answers on https://, redirects plain http, and keeps its headers', async (t) => {
  process.env.PAIR_ADMIN_TOKEN = 'tlsowner';
  await server.start({ banner: false, port: 0 });
  t.after(() => server.stop());
  assert.equal(server.scheme(), 'https', 'the server reports https when TLS is on');
  const port = server.state.port;
  assert.ok(port > 0);

  const page = await req(https, `https://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Get a pairing code/);
  assert.match(String(page.headers['strict-transport-security']), /max-age=\d+/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);

  // A phone browser that types http:// must land on https://, not time out.
  const plain = await req(http, `http://127.0.0.1:${port}/pair?x=1`);
  assert.equal(plain.status, 301);
  assert.equal(plain.headers.location, `https://127.0.0.1:${port}/pair?x=1`);

  // API + console over TLS
  const info = await req(https, `https://127.0.0.1:${port}/api/pair/info`);
  assert.equal(info.status, 200);
  assert.equal(JSON.parse(info.text).mode, 'public');
  assert.equal((await req(https, `https://127.0.0.1:${port}/admin`)).status, 403);
  const admin = await req(https, `https://127.0.0.1:${port}/admin?token=tlsowner`);
  assert.equal(admin.status, 200);
  assert.match(admin.text, /Owner console/);
});

test('the address printed in chat is an https:// url', async () => {
  await server.start({ banner: false, port: 0 });
  try {
    const info = await server.pairUrl();
    assert.match(String(info.url), /^https:\/\//, `expected an https url, got ${info.url}`);
    assert.ok(info.port > 0, 'the port is the one actually bound');
  } finally {
    await server.stop();
  }
});

test('a certificate the owner drops in .env wins over the generated one', async (t) => {
  const dir = path.join(require('os').tmpdir(), `sachi-tls-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'my-real-domain.example' }], { days: 30, keySize: 2048 });
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private);
  process.env.SSL_CERT_PATH = certFile;
  process.env.SSL_KEY_PATH = keyFile;
  tlsMaterial.reset();
  t.after(() => {
    delete process.env.SSL_CERT_PATH;
    delete process.env.SSL_KEY_PATH;
    tlsMaterial.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const material = await tlsMaterial.load();
  assert.equal(material.tls, true);
  assert.match(material.source, /^env:/, 'the env certificate is preferred');
  assert.match(String(material.cert), /BEGIN CERTIFICATE/);
  assert.match(tlsMaterial.describe(material), /your certificate/);
});

test('an unusable stored certificate is replaced instead of breaking every request', async (t) => {
  tlsMaterial.regenerate();
  const first = await tlsMaterial.load({ extraHosts: ['10.9.9.9'] });
  assert.equal(first.tls, true);
  const dir = tlsMaterial.TLS_DIR();
  const goodKey = fs.readFileSync(path.join(dir, 'key.pem'));

  // 1. a key that does not belong to the certificate
  const crypto = require('crypto');
  const wrong = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'key.pem'), wrong);
  tlsMaterial.reset();
  const second = await tlsMaterial.load({});
  assert.equal(second.tls, true, 'a mismatched key must not leave the site dead');
  assert.notEqual(second.cert.toString(), first.cert.toString(), 'a fresh pair was generated');

  // 2. a file that is not a certificate at all
  fs.writeFileSync(path.join(dir, 'cert.pem'), 'garbage, not pem');
  fs.writeFileSync(path.join(dir, 'key.pem'), goodKey);
  tlsMaterial.reset();
  const third = await tlsMaterial.load({});
  assert.equal(third.tls, true, 'garbage on disk must not disable HTTPS');
  assert.match(String(third.cert), /BEGIN CERTIFICATE/);
});

test('tls.load() degrades to "no tls" instead of throwing when npm is missing pieces', async (t) => {
  process.env.SSL_CERT_PATH = '/definitely/not/here.pem';
  process.env.SSL_KEY_PATH = '/definitely/not/here.key';
  tlsMaterial.reset();
  t.after(() => {
    delete process.env.SSL_CERT_PATH;
    delete process.env.SSL_KEY_PATH;
    tlsMaterial.reset();
  });
  const material = await tlsMaterial.load({});
  // A missing file must not crash the boot; it falls back to the stored or a
  // freshly generated certificate, i.e. still TLS in a normal install.
  assert.equal(typeof material.tls, 'boolean');
  if (!material.tls) assert.match(tlsMaterial.describe(material), /none/);
});
