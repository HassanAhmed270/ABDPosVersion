const Customer = require('../models/Customers');

async function generateCustomerID() {
  const customers = await Customer.find({}, 'customerID').lean();

  let maxID = 0;

  for (const customer of customers) {
    const match = /^#(\d{4})$/.exec(customer.customerID || '');
    if (match) {
      maxID = Math.max(maxID, Number(match[1]));
    }
  }

  return `#${String(maxID + 1).padStart(4, '0')}`;
}

module.exports = { generateCustomerID };