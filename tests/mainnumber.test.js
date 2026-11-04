const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const mainNumber = require('../src/utils/mainNumber');
const config = require('../src/config');
const { setEnvValue } = require('../src/utils/envLoader');

test('digits() strips every separator', () => {
  assert.equal(mainNumber.digits('+94 (0) 771-234-567'), '94771234567');
  assert.equal(mainNumber.digits(' 947 712 345 67 '), '94771234567');
  assert.equal(mainNumber.digits(''), '');
  assert.equal(mainNumber.digits(null), '');
});

test('isValid() accepts 8–15 digits only', () => {
  assert.equal(mainNumber.isValid('94771234567'), true);
  assert.equal(mainNumber.isValid('12345678'), true);
  assert.equal(mainNumber.isValid('123456789012345'), true);
  assert.equal(mainNumber.isValid('1234567'), false, 'too short');
  assert.equal(mainNumber.isValid('1234567890123456'), false, 'too long');
  assert.equal(mainNumber.isValid(''), false);
});

test('without a terminal the number is taken from the env and nothing is asked', async () => {
  mainNumber.reset();
  const t = Date.now();
  const n = await mainNumber.resolve({ force: true, save: false });
  assert.match(n, /^\d{8,15}$/, 'a usable number');
  assert.ok(Date.now() - t < 1000, 'no waiting for input');
});

test('the interactive prompt accepts a typed number and remembers it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sachi-env-'));
  const fake = new PassThrough();
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const origIn = process.stdin;
  const origOut = process.stdout;
  const origTty = process.stdout.isTTY;
  const origPhone = config.phoneNumber;
  const origOwner = config.ownerNumber;
  const origEnv = process.env.WA_PHONE_NUMBER;
  try {
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
    Object.defineProperty(fake, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.WA_ASK_PHONE = 'always';
    mainNumber.reset();
    const p = mainNumber.resolve({ force: true, save: false });
    setTimeout(() => fake.write('94771234567\n'), 30);
    const n = await p;
    assert.equal(n, '94771234567');
    // the value is remembered for the next boot
    setEnvValue('WA_PHONE_NUMBER', n, dir);
    const saved = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.ok(saved.includes('WA_PHONE_NUMBER=94771234567'));
  } finally {
    if (origStdin) Object.defineProperty(process, 'stdin', origStdin);
    else process.stdin = origIn;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
    config.phoneNumber = origPhone;
    config.ownerNumber = origOwner;
    if (origEnv === undefined) delete process.env.WA_PHONE_NUMBER;
    else process.env.WA_PHONE_NUMBER = origEnv;
    mainNumber.reset();
  }
});

test('an invalid number is refused and the prompt asks again', async () => {
  const fake = new PassThrough();
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const origIn = process.stdin;
  const origTty = process.stdout.isTTY;
  const origPhone = config.phoneNumber;
  const origOwner = config.ownerNumber;
  const origEnv = process.env.WA_PHONE_NUMBER;
  try {
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
    Object.defineProperty(fake, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.WA_ASK_PHONE = 'always';
    mainNumber.reset();
    const p = mainNumber.resolve({ force: true, save: false });
    setTimeout(() => fake.write('123\n94771234567\n'), 30);
    const n = await p;
    assert.equal(n, '94771234567', 'the second (valid) answer wins');
  } finally {
    if (origStdin) Object.defineProperty(process, 'stdin', origStdin);
    else process.stdin = origIn;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
    config.phoneNumber = origPhone;
    config.ownerNumber = origOwner;
    if (origEnv === undefined) delete process.env.WA_PHONE_NUMBER;
    else process.env.WA_PHONE_NUMBER = origEnv;
    mainNumber.reset();
  }
});

test('an unattended terminal gives up after the timeout instead of hanging', async () => {
  const fake = new PassThrough();
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const origIn = process.stdin;
  const origTty = process.stdout.isTTY;
  const origTimeout = process.env.WA_ASK_TIMEOUT_MS;
  const origPhone = config.phoneNumber;
  const origOwner = config.ownerNumber;
  const origEnv = process.env.WA_PHONE_NUMBER;
  try {
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
    Object.defineProperty(fake, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.WA_ASK_PHONE = 'always';
    process.env.WA_ASK_TIMEOUT_MS = '300';
    mainNumber.reset();
    const t = Date.now();
    const n = await mainNumber.resolve({ force: true, save: false });
    assert.equal(n, '94750404115', 'the configured default is kept');
    assert.ok(Date.now() - t < 5000, 'it did not wait forever');
  } finally {
    if (origStdin) Object.defineProperty(process, 'stdin', origStdin);
    else process.stdin = origIn;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
    if (origTimeout === undefined) delete process.env.WA_ASK_TIMEOUT_MS;
    else process.env.WA_ASK_TIMEOUT_MS = origTimeout;
    mainNumber.reset();
  }
});

test('setEnvValue creates .env, updates the key and keeps the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sachi-env-'));
  const file = path.join(dir, '.env');
  setEnvValue('WA_PHONE_NUMBER', '94771234567', dir);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'WA_PHONE_NUMBER=94771234567');
  fs.writeFileSync(file, 'BOT_NAME=Sachi MD\nWA_PHONE_NUMBER=94750404115\nSERVER_PORT=3000\n');
  setEnvValue('WA_PHONE_NUMBER', '94770000000', dir);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal((text.match(/WA_PHONE_NUMBER=/g) || []).length, 1, 'no duplicate line');
  assert.ok(text.includes('WA_PHONE_NUMBER=94770000000'));
  assert.ok(text.includes('BOT_NAME=Sachi MD'), 'other keys survive');
  assert.ok(text.includes('SERVER_PORT=3000'), 'other keys survive');
});
