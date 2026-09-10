require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.ATLAS_MONGO_URI);

  try {
    await client.connect();

    const db = client.db('bpiolsABD');
    const customers = db.collection('customers');

    // Move Hassan temporarily so #0001 becomes available
    const hassan = await customers.findOne({
      customerName: 'Hassan',
      customerID: '#0002',
    });

    if (hassan) {
      await customers.updateOne(
        { _id: hassan._id },
        {
          $set: {
            customerID: '#9999',
          },
        }
      );
    }

    // Move Haris from #0001 to #0002
    const haris = await customers.findOne({
      customerName: 'Haris',
      customerID: '#0001',
    });

    if (haris) {
      const orders = (haris.orders || []).map((order) => ({
        ...order,
        customerID: '#0002',
      }));

      await customers.updateOne(
        { _id: haris._id },
        {
          $set: {
            customerID: '#0002',
            orders,
          },
        }
      );
    }

    // Move Hassan from temporary ID to #0001
    if (hassan) {
      const orders = (hassan.orders || []).map((order) => ({
        ...order,
        customerID: '#0001',
      }));

      await customers.updateOne(
        { _id: hassan._id },
        {
          $set: {
            customerID: '#0001',
            orders,
          },
        }
      );
    }

    console.log('Atlas customer IDs fixed.');
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
})();v