// Phase 1 spike — local Express backend supervisor.
//
// Spawns the existing repo-root main.js (unmodified) as a child process,
// pointed at the local mongod instead of Atlas/Render, and waits for its
// existing GET /health route to respond before considering it ready.
//
// Deliberately does NOT reimplement or fork main.js — the whole point is
// that the backend code doesn't need to know or care whether it's running
// on Render or inside this Electron app.

const { app } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BACKEND_PORT = 3177; // matches the non-default-port convention used
                            // for mongod, for the same collision reason.
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 15000;

let backendProcess = null;

// JWT_SECRET is required by main.js whenever NODE_ENV=production (see
// root main.js's startup checks). Rather than ship a fixed secret baked
// into the installer — which would mean every install of the app shares
// one signing key — generate one on first run and persist it in the same
// userData directory as the Mongo data, so it's stable across restarts
// on that machine but unique per install.
function getOrCreateJwtSecret() {
  const secretPath = path.join(app.getPath('userData'), 'jwt-secret.txt');

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

function resolveBackendEntry() {
  // In dev this is the repo root main.js; in a packaged build it needs
  // to be shipped as an extraResource (see package.json build config —
  // not yet wired for Phase 1, since this spike targets dev/unpacked
  // testing first).
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'main.js');
  }
  return path.join(__dirname, '..', '..', 'main.js');
}

function waitForHealth(port, timeoutMs) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/health', timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        }
      );

      req.once('error', retry);
      req.once('timeout', () => {
        req.destroy();
        retry();
      });

      function retry() {
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Backend did not respond healthy on port ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, HEALTH_CHECK_INTERVAL_MS);
      }
    }

    attempt();
  });
}

async function start({ mongoPort }) {
  if (backendProcess) return { port: BACKEND_PORT };

  const entry = resolveBackendEntry();
  const jwtSecret = getOrCreateJwtSecret();

  backendProcess = spawn(
    process.execPath, // reuse Electron's own bundled Node, no separate
                       // Node install required on the client machine
    [entry],
    {
      env: {
        ...process.env,
        PORT: String(BACKEND_PORT),
        MONGO_URI: `mongodb://127.0.0.1:${mongoPort}/billing_system?directConnection=true`,
        NODE_ENV: 'production',
        JWT_SECRET: jwtSecret,
        JWT_EXPIRES_IN: '8h',
        // file:// renderer sends a literal "null" Origin header — see
        // .env.example's existing note on this from Stage 16/17.
        ALLOWED_ORIGINS: 'null',
        ELECTRON_RUN_AS_NODE: '1', // run process.execPath as plain Node,
                                    // not as another Electron instance
      },
      stdio: 'inherit',
      windowsHide: true,
    }
  );

  let exitedEarly = false;
  const earlyExitHandler = (code) => {
    exitedEarly = true;
    backendProcess = null;
    throw new Error(`Backend process exited during startup (code ${code})`);
  };
  backendProcess.once('exit', earlyExitHandler);

  try {
    await waitForHealth(BACKEND_PORT, HEALTH_CHECK_TIMEOUT_MS);
  } catch (err) {
    if (!exitedEarly && backendProcess) {
      backendProcess.kill();
      backendProcess = null;
    }
    throw err;
  }

  backendProcess.removeListener('exit', earlyExitHandler);

  backendProcess.once('exit', (code, signal) => {
    const wasProcess = backendProcess;
    backendProcess = null;
    if (wasProcess && !wasProcess.__expectedShutdown) {
      console.error(`Backend process exited unexpectedly (code ${code}, signal ${signal})`);
    }
  });

  return { port: BACKEND_PORT };
}

function stop() {
  if (!backendProcess) return Promise.resolve();

  const proc = backendProcess;
  proc.__expectedShutdown = true;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5000);

    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    proc.kill('SIGTERM'); // main.js already handles SIGTERM gracefully
  });
}

module.exports = { start, stop, BACKEND_PORT };
