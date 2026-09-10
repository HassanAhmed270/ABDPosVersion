require('dotenv').config();
const { MongoClient } = require('mongodb');

const COLLECTIONS = [
  'products', 'orders', 'customers', 'suppliers',
  'stockbatches', 'refunds', 'losses', 'auditlogs',
];

async function main() {
  const client = new MongoClient('mongodb://127.0.0.1:27117/bpiolsABD?directConnection=true');
  await client.connect();
  const db = client.db('bpiolsABD');
  const meta = db.collection('_syncMeta');

  for (const collectionName of COLLECTIONS) {
    const result = await meta.updateOne(
      { collection: collectionName, docId: '__collection__' },
      { $set: { lastScannedAt: new Date(0) } }
    );
    console.log(`${collectionName}: watermark reset (matched ${result.matchedCount})`);
  }

  await client.close();
  console.log('Done. Next sync cycle will do a full rescan.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
