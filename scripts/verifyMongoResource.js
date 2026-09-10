const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MONGO_DIR = path.join(ROOT, 'electron', 'resources', 'mongodb-bin');
const required = ['mongod.exe', 'vc_redist.x64.exe'];

if (!fs.existsSync(MONGO_DIR)) {
  console.error(`MongoDB resource directory is missing: ${MONGO_DIR}`);
  process.exit(1);
}

const missing = required.filter((file) => !fs.existsSync(path.join(MONGO_DIR, file)));
if (missing.length) {
  console.error('MongoDB runtime resources are incomplete. Missing:');
  for (const file of missing) console.error(`  - ${file}`);
  console.error(`Expected directory: ${MONGO_DIR}`);
  console.error('Populate it with the genuine MongoDB 6.0.29 Windows x64 runtime before building the installer.');
  process.exit(1);
}

const entries = fs.readdirSync(MONGO_DIR, { withFileTypes: true });
const forbiddenDataDirs = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => /^(data|diagnostic\.data|logs?)$/i.test(name));

if (forbiddenDataDirs.length) {
  console.error(`MongoDB data/log directories must not be packaged: ${forbiddenDataDirs.join(', ')}`);
  process.exit(1);
}

console.log('MongoDB runtime resource check passed.');
console.log(`  Directory: ${MONGO_DIR}`);
console.log('  Required: mongod.exe, vc_redist.x64.exe');
console.log('  Database data is intentionally excluded from the installer.');
