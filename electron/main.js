// Registered first, before anything else, so it can catch a crash
// during module loading itself — a handler placed after other
// require() calls can't catch an error thrown by one of those requires.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  try {
    require('electron').dialog.showErrorBox('BPIOLS crashed', err.stack || err.message || String(err));
  } catch (_) {
    // If even Electron itself isn't available yet, there's nothing
    // further we can do — the console.error above is the last resort.
  }
  process.exit(1);
});

const { app, BrowserWindow, screen, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { MongoClient } = require('mongodb');
const mongod = require('./lib/mongod');
const backend = require('./lib/backend');
const syncJob = require('./lib/syncJob');
const userConfig = require('./lib/userConfig');
const { verifyLicenseKey } = require('./lib/license');

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

function sanitizeAtlasUri(rawUri) {
  const trimmed = (rawUri || '').trim();

  // Catches the most common real-world mistake: pasting several lines
  // from a .env file (URI plus whatever comes after it) into a single
  // field. A genuine connection string is one line with no whitespace.
  if (/\s/.test(trimmed)) {
    throw new Error(
      'The connection string contains spaces or line breaks — it looks like extra ' +
      'text got pasted in along with it. Copy only the mongodb:// or mongodb+srv:// ' +
      'string itself, nothing else, and try again.'
    );
  }

  if (!/^mongodb(\+srv)?:\/\//.test(trimmed)) {
    throw new Error('This does not look like a valid MongoDB connection string (it should start with "mongodb://" or "mongodb+srv://").');
  }

  return trimmed;
}

// A fresh local install's invoice counter starts at 0 — but if this
// machine is connecting to an Atlas database that already has real
// invoice history from before (a business's existing data, or simply
// an earlier install), starting from 0001 again collides with numbers
// already in use. Seed the local counter to continue from whatever the
// highest existing number in Atlas actually is, so the very first bill
// created on this machine doesn't immediately conflict.
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

async function seedInvoiceCountersFromAtlas({ mongoPort, atlasUri }) {
  const atlasClient = new MongoClient(atlasUri);
  const localClient = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/billing_system?directConnection=true`);

  try {
    await atlasClient.connect();
    await localClient.connect();

    const atlasDb = atlasClient.db('billing_system');
    const localDb = localClient.db('billing_system');

    const orders = await atlasDb.collection('orders').find({}, { projection: { orderID: 1 } }).toArray();
    const invoices = await atlasDb.collection('paymentinvoices').find({}, { projection: { invoiceNumber: 1 } }).toArray();

    const maxInvoice = highestSeq(orders, 'orderID', 'INV-');
    const maxPaymentInvoice = highestSeq(invoices, 'invoiceNumber', 'PINV-');

    const counters = localDb.collection('counters');
    for (const [counterId, max] of [['invoiceId', maxInvoice], ['paymentInvoiceId', maxPaymentInvoice]]) {
      const existing = await counters.findOne({ _id: counterId });
      const existingSeq = existing ? existing.seq : 0;
      if (existingSeq < max) {
        await counters.updateOne({ _id: counterId }, { $set: { seq: max } }, { upsert: true });
      }
    }
  } finally {
    await atlasClient.close();
    await localClient.close();
  }
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

    ipcMain.handle('setup:submit', async (event, { businessName, atlasUri: rawAtlasUri, username, password, licenseKey }) => {
      try {
        const licenseCheck = verifyLicenseKey(licenseKey, businessName);
        if (!licenseCheck.valid) {
          return { success: false, message: licenseCheck.reason };
        }

        const atlasUri = sanitizeAtlasUri(rawAtlasUri);
        await verifyAtlasReachable(atlasUri);

        const { port: mongoPort } = await mongod.start();

        // Seed invoice counters from Atlas's existing history BEFORE
        // anyone can create a bill on this machine — this is exactly
        // the fix needed for a fresh install pointed at a business's
        // pre-existing Atlas data.
        await seedInvoiceCountersFromAtlas({ mongoPort, atlasUri });

        await createAdminAccount({ mongoPort, username, password });

        userConfig.writeConfig({
          atlasUri,
          licenseKey: licenseKey.trim(),
          businessName: businessName.trim(),
          configuredAt: new Date().toISOString(),
        });

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

    const licenseCheck = verifyLicenseKey(config.licenseKey, config.businessName);
    if (!licenseCheck.valid) {
      throw new Error(
        `License check failed: ${licenseCheck.reason} This installation's license ` +
        `could not be verified — please contact support for a valid license key.`
      );
    }

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