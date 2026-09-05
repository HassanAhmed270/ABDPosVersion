const { app, BrowserWindow, screen, dialog } = require('electron');
const path = require('path');
const mongod = require('./lib/mongod');
const backend = require('./lib/backend');
const syncJob = require('./lib/syncJob');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

app.setName('BPIOLS');

const DESIGN_WIDTH = 1536;
const DESIGN_HEIGHT = 898;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;

let started = false;

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

async function startLocalStack() {
  const { port: mongoPort } = await mongod.start();
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