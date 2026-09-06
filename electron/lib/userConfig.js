const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function getConfigPath() {
  return path.join(app.getPath('userData'), 'install-config.json');
}

function isConfigured() {
  return fs.existsSync(getConfigPath());
}

function readConfig() {
  if (!isConfigured()) return null;
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

module.exports = { isConfigured, readConfig, writeConfig, getConfigPath };
