// Simple offline license key scheme — deliberately not a "phone home"
// server-based system (that was explicitly ruled out as more than
// needed). A license key is a customer name plus an HMAC-SHA256
// signature over that name, using a secret only Hassan holds. The app
// can verify a key is genuine without ever contacting a server, but
// generating a NEW valid key requires the secret, which only
// scripts/generateLicense.js (run on Hassan's own machine) has access
// to in practice.
//
// Honest limitation: the verification secret ships inside the app
// itself (see LICENSE_SECRET below), so a sufficiently determined
// person could extract it from the installed files and forge their own
// keys. This raises the bar significantly above "just supply any Atlas
// URI" — which was the actual gap being closed — without requiring
// Hassan to stand up and maintain a licensing server. Matches the
// agreed "deterrent, not bulletproof" scope.

const crypto = require('crypto');

// CHANGE THIS to your own random secret before distributing the app —
// this exact placeholder value must never ship in a real release, since
// anyone who has seen this file (including in this conversation) could
// otherwise forge valid license keys against the placeholder.
const LICENSE_SECRET = 'CHANGE-ME-BEFORE-SHIPPING-a8f3d9c2e1b4567890abcdef1234567890';

function sign(customerName) {
  return crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(customerName.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32); // full 64-char HMAC is unnecessarily long for a key
                   // someone has to type/paste; 32 hex chars (128 bits)
                   // is still effectively unforgeable without the secret
}

// License key format: "<customerName>.<signature>", base64-encoded as
// a whole so it's one clean token to copy/paste rather than something
// that looks like it has structure to poke at.
function generateLicenseKey(customerName) {
  const clean = customerName.trim().toLowerCase();
  const signature = sign(clean);
  const raw = `${clean}.${signature}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function verifyLicenseKey(licenseKey, expectedBusinessName) {
  try {
    const raw = Buffer.from((licenseKey || '').trim(), 'base64').toString('utf8');
    const [customerName, providedSignature] = raw.split('.');
    if (!customerName || !providedSignature) {
      return { valid: false, reason: 'Malformed license key.' };
    }

    const expectedSignature = sign(customerName);

    const expected = Buffer.from(expectedSignature);
    const provided = Buffer.from(providedSignature);
    const signatureValid =
      expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided);

    if (!signatureValid) {
      return { valid: false, reason: 'Invalid license key.' };
    }

    // The key's signature is authentic, but it must also have been
    // issued for the business name the client actually typed in —
    // this means a leaked key is only usable by someone who also knows
    // (or can guess) the exact business name it was issued for.
    if (expectedBusinessName) {
      const cleanExpected = expectedBusinessName.trim().toLowerCase();
      if (cleanExpected !== customerName) {
        return {
          valid: false,
          reason: 'This license key was not issued for the business name entered.',
        };
      }
    }

    return { valid: true, customerName };
  } catch (err) {
    return { valid: false, reason: 'Malformed license key.' };
  }
}

module.exports = { generateLicenseKey, verifyLicenseKey };