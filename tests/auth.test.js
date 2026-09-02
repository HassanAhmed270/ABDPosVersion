process.env.JWT_SECRET = 'test-only-secret-not-the-example-placeholder';

const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/user');
const { signToken, requireAuth } = require('../middleware/auth');

function fakeUser(passwordChangedAt) {
  return { _id: { toString: () => 'u1' }, username: 'alice', role: 'cashier', passwordChangedAt };
}

function fakeReq(token) {
  return { headers: { authorization: token ? `Bearer ${token}` : '' } };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requireAuth accepts a token when passwordChangedAt has not changed since issuance', async () => {
  const changedAt = new Date(1000);
  User.findById = () => ({ select: async () => fakeUser(changedAt) });
  const token = signToken(fakeUser(changedAt));

  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('requireAuth rejects a token issued before a later password change', async () => {
  const oldChangedAt = new Date(1000);
  const token = signToken(fakeUser(oldChangedAt));
  User.findById = () => ({ select: async () => fakeUser(new Date(2000)) });

  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth rejects a token whose user no longer exists', async () => {
  const token = signToken(fakeUser(new Date(1000)));
  User.findById = () => ({ select: async () => null });

  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth rejects a missing or malformed Authorization header', async () => {
  const req = fakeReq(null);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth rejects a garbage token', async () => {
  const req = fakeReq('not-a-real-jwt');
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});
