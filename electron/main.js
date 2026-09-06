const { app, BrowserWindow, screen, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { MongoClient } = require('mongodb');
const mongod = require('./lib/mongod');
const backend = require('./lib/backend');
const syncJob = require('./lib/syncJob');
const userConfig = require('./lib/userConfig');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

app.setName('BPIOLS');

const DESIGN_WIDTH = 1536;
const DESIGN_HEIGHT = 898;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;

let started = false;
let setupWindow = null;

function createWindow() {
  const { width: workAreaWidth, height: workAreaHeight } =
    screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: Math.min(DESIGN_WIDTH, workAreaWidth),
    height: Math.min(DESIGN_HEIGHT, workAreaHeight),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'frontend', 'dist-electron', 'index.html'));
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 560,
    height: 640,
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup', 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, 'setup', 'setup.html'));
}

async function verifyAtlasReachable(atlasUri) {
  const client = new MongoClient(atlasUri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } finally {
    await client.close();
  }
}

// Deliberately does NOT call bcrypt directly in this process. bcrypt is
// a native compiled module, and requiring/calling it inside Electron's
// actual main (GUI) process is a different runtime context than the
// spawned backend (which runs via ELECTRON_RUN_AS_NODE=1) — a native
// ABI mismatch here can crash the whole app instantly and silently,
// before any of our own error handling exists to catch it. Instead,
// reuse the exact same spawn mechanism already proven reliable for the
// backend itself: run scripts/createUser.js as a child process.
function createAdminAccount({ mongoPort, username, password }) {
  return new Promise((resolve, reject) => {
    const entry = app.isPackaged
      ? path.join(process.resourcesPath, 'backend', 'scripts', 'createUser.js')
      : path.join(__dirname, '..', 'scripts', 'createUser.js');

    const proc = spawn(
      process.execPath,
      [entry, username, password, 'admin'],
      {
        env: {
          ...process.env,
          MONGO_URI: `mongodb://127.0.0.1:${mongoPort}/billing_system?directConnection=true`,
          ELECTRON_RUN_AS_NODE: '1',
        },
        windowsHide: true,
      }
    );

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `createUser.js exited with code ${code}`));
      }
    });

    proc.once('error', reject);
  });
}

async function runSetupWizard() {
  return new Promise((resolve, reject) => {
    createSetupWindow();

    ipcMain.handle('setup:submit', async (event, { atlasUri, username, password }) => {
      try {
        await verifyAtlasReachable(atlasUri);

        const { port: mongoPort } = await mongod.start();
        await createAdminAccount({ mongoPort, username, password });

        userConfig.writeConfig({ atlasUri, configuredAt: new Date().toISOString() });

        ipcMain.removeHandler('setup:submit');
        setupWindow.close();
        setupWindow = null;
        resolve({ mongoPort, atlasUri });

        return { success: true };
      } catch (err) {
        return { success: false, message: err.message };
      }
    });

    setupWindow.on('closed', () => {
      if (setupWindow !== null) {
        reject(new Error('Setup was closed before completing.'));
      }
    });
  });
}

async function startLocalStack() {
  let mongoPort;

  if (userConfig.isConfigured()) {
    const config = userConfig.readConfig();
    process.env.ATLAS_MONGO_URI = config.atlasUri;
    ({ port: mongoPort } = await mongod.start());
  } else {
    const result = await runSetupWizard();
    mongoPort = result.mongoPort;
    process.env.ATLAS_MONGO_URI = result.atlasUri;
  }

  await backend.start({ mongoPort });
  syncJob.start({ mongoPort });
}

app.whenReady().then(async () => {
  try {
    await startLocalStack();
    started = true;
    createWindow();
  } catch (err) {
    console.error('Local stack failed to start:', err);
    dialog.showErrorBox(
      'BPIOLS failed to start',
      `The local database or backend service did not start correctly.\n\n${err.message}\n\n` +
        `The app will now close. If this keeps happening, check the logs in the app data folder.`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (started && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shuttingDown = false;
app.on('before-quit', async (event) => {
  if (shuttingDown || !started) return;
  shuttingDown = true;
  event.preventDefault();

  await syncJob.stop();
  await backend.stop();
  await mongod.stop();

  app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err);
  dialog.showErrorBox('BPIOLS crashed', err.message || String(err));
  app.quit();
});