require('dotenv').config();
const mongoose = require('mongoose');
const { roundMoney } = require('../lib/money');

// One-time migration for the account-balance unification: Customer
// documents used to store two independent numbers — a real creditBalance
// field, and an implicit totalBalanceDue derived by summing every
// order's own balanceDue — that could never be reconciled against each
// other (see models/Customers.js's comment on accountBalance for why).
// This computes the single signed accountBalance each customer should
// start at, from whatever those two numbers already added up to, so no
// existing credit or debt is lost or double-counted in the switch.
//
// Reads via the raw collection, not the Customer model — the model's
// schema no longer declares creditBalance (it's now a virtual derived
// FROM accountBalance), so loading a not-yet-migrated document through
// the model would already only see accountBalance's default of 0 and
// silently ignore the real, still-on-disk creditBalance value.
//
// Safe to run more than once — a customer document with no leftover
// creditBalance field is already migrated and is left untouched.
//
// Usage:
//   node scripts/migrate-account-balance.js            # dry run, prints what it would do
//   node scripts/migrate-account-balance.js --apply     # actually writes

async function main() {
  const apply = process.argv.includes('--apply');
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/billing_system';
  await mongoose.connect(MONGO_URI);

  const collection = mongoose.connection.db.collection('customers');
  const cursor = collection.find({});

  let scanned = 0;
  let migrated = 0;
  let skipped = 0;

  for await (const doc of cursor) {
    scanned++;
    if (!Object.prototype.hasOwnProperty.call(doc, 'creditBalance')) {
      skipped++;
      continue;
    }

    const oldCredit = roundMoney(doc.creditBalance || 0);
    const totalBalanceDue = roundMoney((doc.orders || []).reduce((sum, o) => sum + (o.balanceDue || 0), 0));
    const accountBalance = roundMoney(totalBalanceDue - oldCredit);

    console.log(
      `${apply ? 'Migrating' : '[dry run] Would migrate'} ${doc.customerName}: ` +
        `balanceDue=${totalBalanceDue} - credit=${oldCredit} => accountBalance=${accountBalance}`
    );

    if (apply) {
      await collection.updateOne({ _id: doc._id }, { $set: { accountBalance }, $unset: { creditBalance: '' } });
    }
    migrated++;
  }

  console.log(`\nScanned ${scanned} customer(s). ${migrated} ${apply ? 'migrated' : 'would be migrated'}, ${skipped} already done.`);
  if (!apply && migrated > 0) {
    console.log('Re-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
