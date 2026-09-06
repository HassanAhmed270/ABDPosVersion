// electron-builder's normal files+extraMetadata mechanism was silently
// failing to place package.json into resources/app/ (confirmed by
// direct inspection of a diagnostic build — every other files entry
// worked, only this one didn't). Rather than keep guessing at why,
// this writes it there ourselves, directly, after packing completes.

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  // Same override extraMetadata was supposed to apply.
  rootPackageJson.main = 'electron/main.js';

  const targetDir = path.join(context.appOutDir, 'resources', 'app');

  if (!fs.existsSync(targetDir)) {
    // asar:true case — files land inside app.asar instead of a plain
    // folder. This hook currently only handles the asar:false
    // (unpacked) case used for diagnosing this issue.
    console.warn(`afterPack: ${targetDir} does not exist — skipping (asar may be enabled).`);
    return;
  }

  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify(rootPackageJson, null, 2)
  );

  console.log(`afterPack: wrote package.json to ${targetDir}`);
};
