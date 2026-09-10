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
// Bumped from 15s: a brand-new, empty local Mongo data directory
// (first run only, on the very first install) building its initial
// WiredTiger files/indexes — plus Windows Defender's real-time scan of
// a freshly-unpacked node.exe/backend bundle on its very first
// execution — can both eat into this. Every launch after the first is
// consistently fast, since neither of those costs repeats.
const HEALTH_CHECK_TIMEOUT_MS = 20000;
// Silently retries a failed cold start this many times, with a short
// pause between attempts, before actually surfacing anything to the
// user — see start(). Covers exactly the first-run-only slow cases
// above without ever showing an error dialog for something that
// resolves itself moments later.
const START_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

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

function getLogPath() {
  const dir = path.join(app.getPath('userData'), 'backend-logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'backend.log');
}

async function startOnce({ mongoPort }) {
  if (backendProcess) return { port: BACKEND_PORT };

  const entry = resolveBackendEntry();
  const jwtSecret = getOrCreateJwtSecret();
  const logPath = getLogPath();
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const proc = spawn(
    process.execPath, // reuse Electron's own bundled Node, no separate
                       // Node install required on the client machine
    [entry],
    {
      env: {
        ...process.env,
        PORT: String(BACKEND_PORT),
        MONGO_URI: `mongodb://127.0.0.1:${mongoPort}/bpiolsABD?directConnection=true`,
        NODE_ENV: 'production',
        JWT_SECRET: jwtSecret,
        JWT_EXPIRES_IN: '8h',
        // file:// renderer sends a literal "null" Origin header — see
        // .env.example's existing note on this from Stage 16/17.
        ALLOWED_ORIGINS: 'null',
        ELECTRON_RUN_AS_NODE: '1', // run process.execPath as plain Node,
                                    // not as another Electron instance
      },
      // Writing directly to a logfile via a Node stream — 'inherit' /
      // shell redirection proved unreliable for this grandchild process
      // through Electron's own console handling on Windows during Phase
      // 1 debugging. 'pipe' lets us forward the child's stdout/stderr
      // into our own writable stream explicitly.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  backendProcess = proc;

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  // If the backend dies before it's healthy, this needs to fail the
  // *same* graceful way waitForHealth's own timeout does — not throw
  // inside the event listener itself. Throwing here runs outside the
  // try/catch below entirely (event callbacks aren't part of that call
  // stack), so it became an uncaught exception that took down the whole
  // Electron main process — that was the "BPIOLS crashed" dialog.
  // Instead, track the exit and let it lose (or win) a Promise.race
  // against the health check, same as any other startup failure.
  let earlyExitError = null;
  const earlyExit = new Promise((resolveExit) => {
    proc.once('exit', (code, signal) => {
      if (backendProcess === proc) {
        earlyExitError = new Error(
          `Backend process exited during startup (code ${code}, signal ${signal})`
        );
        backendProcess = null;
      }
      resolveExit();
    });
  });

  const healthPromise = waitForHealth(BACKEND_PORT, HEALTH_CHECK_TIMEOUT_MS);
  const exitPromise = earlyExit.then(() => {
    if (earlyExitError) throw earlyExitError;
  });

  // Whichever of these loses the race below settles later on its own —
  // give it a harmless catch so that doesn't surface as an unhandled
  // promise rejection.
  healthPromise.catch(() => {});
  exitPromise.catch(() => {});

  try {
    await Promise.race([healthPromise, exitPromise]);
  } catch (err) {
    if (backendProcess === proc) {
      proc.kill();
      backendProcess = null;
    }
    throw err;
  }

  // Startup succeeded — swap to the steady-state exit handler (a crash
  // *after* this point is a genuinely different situation, logged but
  // not part of startup at all).
  proc.once('exit', (code, signal) => {
    const wasProcess = backendProcess;
    backendProcess = null;
    if (wasProcess === proc && !proc.__expectedShutdown) {
      console.error(`Backend process exited unexpectedly (code ${code}, signal ${signal})`);
    }
  });

  return { port: BACKEND_PORT };
}

// Silently retries a failed cold start a couple of times before ever
// throwing up to the caller (which is what actually shows the user an
// error dialog and quits — see the outer main.js). Covers the known
// first-run-only slow/flaky cases above so a real user essentially
// never sees the dialog for something that would have worked seconds
// later anyway; only a genuinely broken install still fails after all
// attempts, in the same amount of time as before (attempt 1) plus a
// few extra seconds.
async function start(opts) {
  let lastErr;

  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await startOnce(opts);
    } catch (err) {
      lastErr = err;
      console.error(`[backend] start attempt ${attempt} failed: ${err.message}`);

      if (attempt < START_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw lastErr;
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