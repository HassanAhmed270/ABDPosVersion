const { app } = require('electron');
const { spawn } = require('child_process');
const { MongoClient } = require('mongodb');
const net = require('net');
const path = require('path');
const fs = require('fs');

const MONGO_PORT = 27117;
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 20000;
const SHUTDOWN_TIMEOUT_MS = 10000;

let mongodProcess = null;

function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'mongodb-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLogPath() {
  const dir = path.join(app.getPath('userData'), 'mongodb-logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'mongod.log');
}

function resolveMongodBinary() {
  const bundledName = process.platform === 'win32' ? 'mongod.exe' : 'mongod';

  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'mongodb-bin', bundledName);
    if (fs.existsSync(bundled)) return bundled;
    throw new Error(
      `Bundled mongod binary not found at ${bundled}. ` +
      `It must be placed under electron/resources/mongodb-bin/ before ` +
      `running electron-builder.`
    );
  }

  if (process.env.MONGOD_PATH && fs.existsSync(process.env.MONGOD_PATH)) {
    return process.env.MONGOD_PATH;
  }

  const devBundled = path.join(__dirname, '..', 'resources', 'mongodb-bin', bundledName);
  if (fs.existsSync(devBundled)) {
    return devBundled;
  }

  throw new Error(
    `Development mongod binary not found at ${devBundled}. ` +
    `Expected mongod.exe under electron/resources/mongodb-bin/.`
  );
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
      '--bind_ip', '127.0.0.1',
      '--replSet', 'rs0',
      '--logpath', logPath,
      '--logappend',
    ],
    { stdio: 'ignore' }
  );

  let exitedEarly = false;

  const earlyExitHandler = (code) => {
    exitedEarly = true;
    mongodProcess = null;

    if (code === 3221225785) {
      throw new Error(
        'mongod could not start because the Visual C++ Redistributable is not ' +
        'installed on this machine. This should install automatically when using ' +
        'the real BPIOLS installer. If you copied the app folder directly instead, ' +
        'please run the actual Setup.exe installer, or install the Visual C++ ' +
        'Redistributable manually from the mongodb-bin folder (vc_redist.x64.exe) ' +
        'and try again.'
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

  mongodProcess.once('exit', (code, signal) => {
    const wasProcess = mongodProcess;
    mongodProcess = null;
    if (wasProcess && !wasProcess.__expectedShutdown) {
      console.error(`mongod exited unexpectedly (code ${code}, signal ${signal}). Check log at ${logPath}`);
    }
  });

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
      return;
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
      proc.kill('SIGKILL');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);

    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    proc.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
  });
}

module.exports = { start, stop, MONGO_PORT };