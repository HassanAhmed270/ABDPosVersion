const { app } = require('electron');
const { spawn } = require('child_process');
const { MongoClient } = require('mongodb');
const net = require('net');
const path = require('path');
const fs = require('fs');

const MONGO_PORT = 27117; // deliberately non-default 27017, so this never
                           // collides with a developer's own local MongoDB
                           // install running for something unrelated.
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 20000;
const SHUTDOWN_TIMEOUT_MS = 10000;

let mongodProcess = null;

function getDataDir() {
  // app.getPath('userData') resolves to e.g.
  // C:\Users\<user>\AppData\Roaming\BPIOLS on Windows — outside
  // Program Files, so an NSIS uninstall never touches it.
  const dir = path.join(app.getPath('userData'), 'mongodb-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLogPath() {
  const dir = path.join(app.getPath('userData'), 'mongodb-logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'mongod.log');
}

// Resolution order:
//   1. Bundled binary shipped as an extraResource (packaged build).
//   2. MONGOD_PATH env var override (useful for local dev/testing).
//   3. Whatever `mongod` resolves to on PATH (dev convenience only —
//      never assume this exists on a client machine).
function resolveMongodBinary() {
  const bundledName = process.platform === 'win32' ? 'mongod.exe' : 'mongod';

  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'mongodb-bin', bundledName);
    if (fs.existsSync(bundled)) return bundled;
    throw new Error(
      `Bundled mongod binary not found at ${bundled}. ` +
      `It must be placed under electron/resources/mongodb-bin/ before ` +
      `running electron-builder — see package.json build.extraResources.`
    );
  }

  if (process.env.MONGOD_PATH && fs.existsSync(process.env.MONGOD_PATH)) {
    return process.env.MONGOD_PATH;
  }

  return bundledName; // rely on PATH in dev
}

function waitForPort(port, timeoutMs) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ port, host: '127.0.0.1' });

      socket.once('connect', () => {
        socket.end();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`mongod did not start accepting connections on port ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, HEALTH_CHECK_INTERVAL_MS);
      });
    }

    attempt();
  });
}

// If a previous session crashed or was killed uncleanly, WiredTiger
// usually recovers on next start by itself. The one thing worth checking
// explicitly is a stale lock file from a process that no longer exists —
// mongod already handles this correctly on its own in virtually all
// cases, so we deliberately do NOT try to manually delete lock files
// here (that's how real data loss happens). We just let mongod attempt
// startup and surface whatever it logs if it refuses to start.
async function start() {
  if (mongodProcess) return { port: MONGO_PORT };

  const binary = resolveMongodBinary();
  const dbPath = getDataDir();
  const logPath = getLogPath();

  mongodProcess = spawn(
    binary,
    [
      '--dbpath', dbPath,
      '--port', String(MONGO_PORT),
      '--bind_ip', '127.0.0.1', // never listen beyond localhost
      '--replSet', 'rs0', // required: backend uses transactions for
                          // order checkout, which MongoDB only allows
                          // on a replica set — a bare standalone mongod
                          // rejects them outright. Atlas is always a
                          // replica set under the hood, which is why
                          // this never surfaced until now.
      '--logpath', logPath,
      '--logappend',
    ],
    { stdio: 'ignore' }
  );

  let exitedEarly = false;
  const earlyExitHandler = (code) => {
    exitedEarly = true;
    mongodProcess = null;

    // 3221225785 / 0xC0000135 = STATUS_DLL_NOT_FOUND — mongod.exe
    // requires the Visual C++ Redistributable runtime. The installer
    // is supposed to install this automatically (see
    // build/installer.nsh), but this happens if the app was copied
    // directly rather than installed through the real Setup.exe, or
    // the redistributable install itself failed for some reason.
    if (code === 3221225785) {
      throw new Error(
        'mongod could not start because the Visual C++ Redistributable is not ' +
        'installed on this machine. This should install automatically when using ' +
        'the real BPIOLS installer — if you copied the app folder directly instead, ' +
        'please run the actual Setup.exe installer, or install the Visual C++ ' +
        'Redistributable manually from the mongodb-bin folder ' +
        '(vc_redist.x64.exe) and try again.'
      );
    }

    throw new Error(
      `mongod exited during startup (code ${code}). Check log at ${logPath}`
    );
  };
  mongodProcess.once('exit', earlyExitHandler);

  try {
    await waitForPort(MONGO_PORT, HEALTH_CHECK_TIMEOUT_MS);
  } catch (err) {
    if (!exitedEarly && mongodProcess) {
      mongodProcess.kill();
      mongodProcess = null;
    }
    throw new Error(`${err.message}. Check log at ${logPath}`);
  }

  mongodProcess.removeListener('exit', earlyExitHandler);

  // If mongod dies later (not during startup), surface it loudly rather
  // than silently leaving the app running against a dead database.
  mongodProcess.once('exit', (code, signal) => {
    const wasProcess = mongodProcess;
    mongodProcess = null;
    if (wasProcess && !wasProcess.__expectedShutdown) {
      console.error(`mongod exited unexpectedly (code ${code}, signal ${signal}). Check log at ${logPath}`);
    }
  });

  // A mongod started with --replSet doesn't become a *usable* replica
  // set until rs.initiate() has been called on it once. Without this,
  // the port accepts connections fine (waitForPort above succeeds) but
  // every actual query fails or hangs, since the node considers itself
  // an unconfigured replica set member. This only needs to happen once
  // per data directory — on every later launch it's already initiated
  // and this is a fast no-op check.
  await ensureReplicaSetInitiated();

  return { port: MONGO_PORT, dbPath, logPath };
}

async function ensureReplicaSetInitiated() {
  const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}/?directConnection=true`);
  try {
    await client.connect();
    const admin = client.db('admin');

    try {
      await admin.command({ replSetGetStatus: 1 });
      return; // already initiated, nothing to do
    } catch (err) {
      if (!/no replset config|NotYetInitialized/i.test(err.message || '')) {
        throw err;
      }
    }

    await admin.command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: `127.0.0.1:${MONGO_PORT}` }],
      },
    });

    // Give the node a moment to elect itself primary after initiation
    // before the backend tries to connect and immediately start a
    // transaction against it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    await client.close();
  }
}

function stop() {
  if (!mongodProcess) return Promise.resolve();

  const proc = mongodProcess;
  proc.__expectedShutdown = true;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Did not exit cleanly in time — escalate rather than hang app quit.
      proc.kill('SIGKILL');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);

    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    // SIGINT is what mongod's shutdown path expects for a clean flush;
    // SIGTERM works too but SIGINT matches mongod's own documented
    // graceful-shutdown handling most reliably across platforms.
    proc.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
  });
}

module.exports = { start, stop, MONGO_PORT };