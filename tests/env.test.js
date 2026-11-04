const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshLoader() {
  delete require.cache[require.resolve('../src/utils/envLoader')];
  return require('../src/utils/envLoader');
}
function tmpEnvFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n'));
  return dir;
}

test('envLoader: parses KEY=VALUE, quotes, comments, export prefix', () => {
  const { loadEnv } = freshLoader();
  const dir = tmpEnvFile([
    '# comment line',
    'TEST_KEY_A=hello',
    'TEST_KEY_B="quoted value"',
    "TEST_KEY_C='single'",
    'export TEST_KEY_D=exported',
    'TEST_KEY_E=value # inline comment',
    'BAD LINE WITHOUT EQUALS',
    '',
  ]);
  const applied = loadEnv(dir);
  assert.equal(process.env.TEST_KEY_A, 'hello');
  assert.equal(process.env.TEST_KEY_B, 'quoted value');
  assert.equal(process.env.TEST_KEY_C, 'single');
  assert.equal(process.env.TEST_KEY_D, 'exported');
  assert.equal(process.env.TEST_KEY_E, 'value');
  assert.ok(applied.TEST_KEY_A === 'hello', 'applied map reports what was set');
  delete process.env.TEST_KEY_A; delete process.env.TEST_KEY_B; delete process.env.TEST_KEY_C;
  delete process.env.TEST_KEY_D; delete process.env.TEST_KEY_E;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('envLoader: never overrides real environment variables', () => {
  const { loadEnv } = freshLoader();
  const dir = tmpEnvFile(['TEST_KEY_F=from-file']);
  process.env.TEST_KEY_F = 'from-real-env';
  const applied = loadEnv(dir);
  assert.equal(process.env.TEST_KEY_F, 'from-real-env');
  assert.ok(!('TEST_KEY_F' in applied), 'existing env var not reported as applied');
  delete process.env.TEST_KEY_F;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('envLoader: missing .env and broken .env are silently tolerated', () => {
  const applied = freshLoader().loadEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-')));
  assert.deepEqual(applied, {});
  const dir = tmpEnvFile(['=broken', '&&&', 'A=']); // A= empty value is legal
  const applied2 = freshLoader().loadEnv(dir);
  assert.equal(process.env.A, '');
  delete process.env.A;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(applied2);
});
