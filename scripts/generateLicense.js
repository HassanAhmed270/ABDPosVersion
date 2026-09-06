// Run this on YOUR machine only, never ship it as part of the app.
// Usage: node scripts/generateLicense.js "Customer Name"

const { generateLicenseKey } = require('../electron/lib/license');

const customerName = process.argv[2];
if (!customerName) {
  console.error('Usage: node scripts/generateLicense.js "Customer Name"');
  process.exit(1);
}

const key = generateLicenseKey(customerName);
console.log(`License key for "${customerName}":\n\n${key}\n`);