// One-time backfill — run this ONCE against each database (local, then
// Atlas) to fix a real gap: documents created before `timestamps: true`
// was added to the schemas have no `updatedAt` field at all, and
// MongoDB's `$gt` comparison in the sync job's query silently excludes
// documents missing the field entirely — so old data was invisible to
// sync, not "seen as old," just never matched at all.
//
// This backfills updatedAt = createdAt (if present) or a sentinel old
// date otherwise, for any document missing it. Safe to run multiple
// times — it only touches documents that still lack the field.
//
// Usage:
//   node scripts/backfillTimestamps.js local
//   node scripts/backfillTimestamps.js atlas
//
// Run "local" first, then "atlas" — order doesn't functionally matter
// for correctness, but doing local first lets you sanity-check the
// output before touching production Atlas data.

require('dotenv').config();
const { MongoClient } = require('mongodb');

const COLLECTIONS = [
  'products',
  'orders',
  'customers',
  'suppliers',
  'stockbatches',
  'refunds',
  'losses',
  'auditlogs',
];

// A deliberately very old sentinel — anything genuinely old should sort
// before real sync activity started, so it gets picked up by the very
// next sync cycle's $gt comparison rather than needing a second pass.
const SENTINEL_DATE = new Date('2000-01-01T00:00:00.000Z');

async function main() {
  const target = process.argv[2];
  if (target !== 'local' && target !== 'atlas') {
    console.error('Usage: node scripts/backfillTimestamps.js <local|atlas>');
    process.exit(1);
  }

  const uri =
    target === 'local'
      ? 'mongodb://127.0.0.1:27117/bpiolsABD?directConnection=true'
      : process.env.ATLAS_MONGO_URI;

  if (!uri) {
    console.error('ATLAS_MONGO_URI is not set in .env — cannot run against atlas.');
    process.exit(1);
  }

  console.log(`Connecting to ${target}...`);
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('bpiolsABD');

  for (const collectionName of COLLECTIONS) {
    const col = db.collection(collectionName);

    // Backfill using createdAt where it already exists as a plain field
    // (rare, since timestamps:true wasn't in use before) — otherwise
    // fall back to the sentinel date.
    const missingCount = await col.countDocuments({ updatedAt: { $exists: false } });

    if (missingCount === 0) {
      console.log(`${collectionName}: nothing to backfill.`);
      continue;
    }

    const result = await col.updateMany(
      { updatedAt: { $exists: false }, createdAt: { $exists: true } },
      [{ $set: { updatedAt: '$createdAt' } }]
    );

    const fallbackResult = await col.updateMany(
      { updatedAt: { $exists: false } },
      { $set: { updatedAt: SENTINEL_DATE, createdAt: SENTINEL_DATE } }
    );

    console.log(
      `${collectionName}: ${missingCount} document(s) were missing updatedAt — ` +
      `${result.modifiedCount} backfilled from createdAt, ${fallbackResult.modifiedCount} set to sentinel date.`
    );
  }

  await client.close();
  console.log(`Done with ${target}.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
