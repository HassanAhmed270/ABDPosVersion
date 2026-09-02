require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('../models/user');

async function main() {
  const [, , username, password, role = 'cashier'] = process.argv;
  if (!username || !password) {
    console.error('Usage: node scripts/createUser.js <username> <password> <admin|cashier>');
    process.exit(1);
  }
  if (!['admin', 'cashier'].includes(role)) {
    console.error('Role must be "admin" or "cashier".');
    process.exit(1);
  }

  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/billing_system';
  await mongoose.connect(MONGO_URI);

  const passwordHash = await bcrypt.hash(password, 12);
  const clean = username.trim().toLowerCase();
  const user = await User.findOneAndUpdate(
    { username: clean },
    { username: clean, passwordHash, role, passwordChangedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`✅ User ready: ${user.username} (${user.role})`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Failed to create user:', err.message);
  process.exit(1);
});