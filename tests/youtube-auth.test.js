const test = require('node:test');
const assert = require('node:assert/strict');
const { isYoutubeAuthError } = require('../src/utils/youtube');

test('YouTube authentication errors are detected without bypassing them', () => {
  assert.equal(isYoutubeAuthError('Sign in to confirm you\'re not a bot'), true);
  assert.equal(isYoutubeAuthError('LOGIN_REQUIRED'), true);
  assert.equal(isYoutubeAuthError('network timeout'), false);
});
