// test/pinterest-sandbox.test.js
//
// Unit tests for the Pinterest Phase A pure helpers. Run: `npm test`
// (node --test). These cover the two fail-closed security invariants:
//   1. OAuth state (CSRF) verification.
//   2. Sandbox-host enforcement (production targets must be refused).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyOAuthState,
  assertSandboxUrl,
  PINTEREST_SANDBOX_HOST,
} from '../lib/pinterest-sandbox.js';

test('verifyOAuthState accepts matching non-empty states', () => {
  assert.equal(verifyOAuthState('abc123', 'abc123'), true);
});

test('verifyOAuthState rejects mismatched states', () => {
  assert.equal(verifyOAuthState('abc123', 'xyz789'), false);
});

test('verifyOAuthState rejects empty / missing / non-string inputs (fail closed)', () => {
  assert.equal(verifyOAuthState('', ''), false);
  assert.equal(verifyOAuthState('abc', ''), false);
  assert.equal(verifyOAuthState('', 'abc'), false);
  assert.equal(verifyOAuthState(undefined, 'abc'), false);
  assert.equal(verifyOAuthState('abc', undefined), false);
  assert.equal(verifyOAuthState(null, null), false);
  assert.equal(verifyOAuthState(123, 123), false);
});

test('assertSandboxUrl allows the Sandbox host', () => {
  assert.equal(assertSandboxUrl(`https://${PINTEREST_SANDBOX_HOST}/v5/pins`), true);
  assert.equal(assertSandboxUrl(`https://${PINTEREST_SANDBOX_HOST}/v5/oauth/token`), true);
});

test('assertSandboxUrl refuses the production Pinterest host', () => {
  assert.throws(() => assertSandboxUrl('https://api.pinterest.com/v5/pins'), /non-Sandbox/);
});

test('assertSandboxUrl refuses non-HTTPS (http) Sandbox host', () => {
  assert.throws(() => assertSandboxUrl(`http://${PINTEREST_SANDBOX_HOST}/v5/pins`), /non-HTTPS/);
});

test('assertSandboxUrl refuses look-alike / subdomain-spoof hosts', () => {
  assert.throws(() => assertSandboxUrl('https://api-sandbox.pinterest.com.evil.com/v5/pins'), /non-Sandbox/);
  assert.throws(() => assertSandboxUrl('https://evil.com/api-sandbox.pinterest.com'), /non-Sandbox/);
});

test('assertSandboxUrl refuses malformed URLs', () => {
  assert.throws(() => assertSandboxUrl('not a url'), /invalid API URL/);
});
