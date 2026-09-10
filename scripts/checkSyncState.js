require('dotenv').config();
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient('mongodb://127.0.0.1:27117/bpiolsABD?directConnection=true');
  await client.connect();
  const db = client.db('bpiolsABD');

  const products = await db.collection('products').countDocuments();
  const customers = await db.collection('customers').countDocuments();
  const conflicts = await db.collection('_syncConflicts').find().toArray();

  console.log('products:', products);
  console.log('customers:', customers);
  console.log('conflicts parked:', conflicts.length);
  conflicts.forEach((c) => {
    console.log(`  - collection: ${c.collection}, docId: ${c.docId}, status: ${c.status}`);
  });

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
