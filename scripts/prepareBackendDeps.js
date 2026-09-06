// Builds a clean, minimal node_modules containing ONLY the backend's
// actual runtime dependencies, in a separate staging folder — then
// package.json's extraResources points at THAT instead of the root
// node_modules (which also contains electron, electron-builder, and
// all of their own internal tooling — Squirrel, NuGet, 7-Zip, WiX —
// none of which the backend needs, but which was getting copied into
// the shipped app anyway since it all lives in root node_modules).
//
// Run automatically as part of `npm run electron:build` (see
// package.json's script) — not meant to be run standalone otherwise.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'backend-deps');

const rootPackageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// nodemon is a dev-only file-watcher (used for `npm start` during
// development) — it has no purpose in a packaged, production build,
// and pulls in a fair amount of its own tooling. Excluded here even
// though it's currently listed under "dependencies" rather than
// "devDependencies" in the root package.json.
const RUNTIME_ONLY_EXCLUDE = ['nodemon'];

const runtimeDependencies = Object.fromEntries(
  Object.entries(rootPackageJson.dependencies || {}).filter(
    ([name]) => !RUNTIME_ONLY_EXCLUDE.includes(name)
  )
);

console.log('Preparing minimal backend dependency set for packaging...');
console.log('Runtime dependencies:', Object.keys(runtimeDependencies).join(', '));

fs.rmSync(STAGING_DIR, { recursive: true, force: true });
fs.mkdirSync(STAGING_DIR, { recursive: true });

fs.writeFileSync(
  path.join(STAGING_DIR, 'package.json'),
  JSON.stringify(
    {
      name: 'bpiols-backend-deps',
      version: '1.0.0',
      private: true,
      dependencies: runtimeDependencies,
    },
    null,
    2
  )
);

console.log('Running npm install (production only) in staging folder — this may take a minute...');
execSync('npm install --omit=dev --no-audit --no-fund', {
  cwd: STAGING_DIR,
  stdio: 'inherit',
});

console.log('Done. backend-deps/node_modules is ready for packaging.');