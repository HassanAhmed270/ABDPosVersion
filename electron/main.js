const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

// The React app's own layout is a fixed 1536x898 design canvas (see
// frontend/src/components/AppCanvas.jsx + index.css) that scales itself
// down proportionally via CSS when it has less room than this. Electron
// just needs to give that canvas as close to its native 1536x898 as the
// display allows — never force a window bigger than the screen's usable
// area, and never stop the user from resizing smaller, since the app's
// own CSS scaling (not a separate Electron-only layout) handles that.
const DESIGN_WIDTH = 1536;
const DESIGN_HEIGHT = 898;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;

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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
