require('dotenv').config();
const { MongoClient } = require('mongodb');

async function migrate(target) {
  const uri =
    target === 'local'
      ? 'mongodb://127.0.0.1:27117/bpiolsABD?directConnection=true'
      : process.env.ATLAS_MONGO_URI;

  if (!uri) {
    throw new Error('ATLAS_MONGO_URI is not set.');
  }

  const client = new MongoClient(uri);
  await client.connect();

  const db = client.db('bpiolsABD');
  const customers = db.collection('customers');

  const allCustomers = await customers
    .find({})
    .sort({ customerID: 1, customerName: 1 })
    .toArray();

  const usedIDs = new Set(
    allCustomers
      .map((c) => c.customerID)
      .filter(Boolean)
  );

  let nextNumber = 1;

  for (const customer of allCustomers) {
    if (customer.customerID) {
      continue;
    }

    while (usedIDs.has(`#${String(nextNumber).padStart(4, '0')}`)) {
      nextNumber += 1;
    }

    const customerID = `#${String(nextNumber).padStart(4, '0')}`;
    usedIDs.add(customerID);
    nextNumber += 1;

    const orders = (customer.orders || []).map((order) => ({
      ...order,
      customerID,
    }));

    await customers.updateOne(
      { _id: customer._id },
      {
        $set: {
          customerID,
          orders,
          updatedAt: new Date(),
        },
      }
    );

    console.log(
      `${target}: ${customer.customerName} -> ${customerID}`
    );
  }

  await client.close();
  console.log(`Done with ${target}.`);
}

async function main() {
  const target = process.argv[2];

  if (target !== 'local' && target !== 'atlas') {
    console.error(
      'Usage: node scripts/migrateCustomerIDs.js <local|atlas>'
    );
    process.exit(1);
  }

  await migrate(target);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});