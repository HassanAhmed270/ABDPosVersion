// Run this once, right after first setup, whenever a fresh local
// install is pointed at an Atlas database that already has real
// invoice/order history from before local Mongo existed. Without this,
// the local Counter starts at 0 and hands out "INV-0001" again, which
// collides with whatever record already has that number in Atlas.
//
// Usage: node scripts/seedInvoiceCounter.js

require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const { MongoClient } = require('mongodb');

function highestSeq(docs, field, prefix) {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const doc of docs) {
    const match = re.exec(doc[field] || '');
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

async function seedCounter(db, counterId, currentMax) {
  const counters = db.collection('counters');
  const existing = await counters.findOne({ _id: counterId });
  const existingSeq = existing ? existing.seq : 0;

  if (existingSeq >= currentMax) {
    console.log(`${counterId}: already at ${existingSeq}, no change needed (Atlas max is ${currentMax}).`);
    return;
  }

  await counters.updateOne(
    { _id: counterId },
    { $set: { seq: currentMax } },
    { upsert: true }
  );
  console.log(`${counterId}: seeded from ${existingSeq} to ${currentMax}.`);
}

async function main() {
  const atlasUri = process.env.ATLAS_MONGO_URI;
  if (!atlasUri) {
    console.error('ATLAS_MONGO_URI not set in .env — cannot check Atlas history.');
    process.exit(1);
  }

  console.log('Connecting to Atlas...');
  const atlasClient = new MongoClient(atlasUri);
  await atlasClient.connect();
  const atlasDb = atlasClient.db('bpiolsABD');

  const orders = await atlasDb.collection('orders').find({}, { projection: { orderID: 1 } }).toArray();
  const invoices = await atlasDb.collection('paymentinvoices').find({}, { projection: { invoiceNumber: 1 } }).toArray();

  const maxInvoice = highestSeq(orders, 'orderID', 'INV-');
  const maxPaymentInvoice = highestSeq(invoices, 'invoiceNumber', 'PINV-');

  await atlasClient.close();

  console.log(`Highest existing INV- number in Atlas: ${maxInvoice}`);
  console.log(`Highest existing PINV- number in Atlas: ${maxPaymentInvoice}`);

  console.log('Connecting to local mongod...');
  const localClient = new MongoClient('mongodb://127.0.0.1:27117/bpiolsABD?directConnection=true');
  await localClient.connect();
  const localDb = localClient.db('bpiolsABD');

  await seedCounter(localDb, 'invoiceId', maxInvoice);
  await seedCounter(localDb, 'paymentInvoiceId', maxPaymentInvoice);

  await localClient.close();
  console.log('Done. The next invoice generated will continue from here, not restart at 0001.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
