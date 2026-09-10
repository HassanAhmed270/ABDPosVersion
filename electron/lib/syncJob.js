

const { MongoClient, ObjectId } = require('mongodb');
const { app } = require('electron');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// Same fix as scripts/backfillTimestamps.js — this machine's default
// DNS resolver has intermittently failed to resolve the SRV records
// mongodb+srv:// connection strings require. Only affects this
// process's own DNS lookups.
dns.setServers(['8.8.8.8', '8.8.4.4']);

function getLogPath() {
  const dir = path.join(app.getPath('userData'), 'sync-logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'sync.log');
}

function log(line) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.appendFileSync(getLogPath(), stamped);
  } catch (err) {
    // Logging must never crash the sync job itself.
  }
}

const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 60000;

// Every collection listed here gets synced, in both directions.
// Deliberately excluded, with reasons:
//   - users: credentials shouldn't silently propagate between machines
//     without a deliberate admin action; out of scope for this phase.
//   - counters: purely local sequence-number bookkeeping (invoice IDs
//     etc.) — syncing these across machines would be actively wrong,
//     each machine's counter is meaningful only to itself.
//   - pendingbills: in-progress draft bills tied to whichever till is
//     actively working on them; not meant to be shared across machines.
//   - offlinesales: Stage 11's own mechanism, being retired in Phase 3.
const SYNCED_COLLECTIONS = [
  'products',
  'orders',
  'customers',
  'suppliers',
  'stockbatches',
  'refunds',
  'losses',
  'auditlogs',
];

let timer = null;
let running = false;
let localClient = null;
let atlasClient = null;

// Per-document watermark: after a successful push or pull, both sides
// end up with an identical document (including updatedAt), so "has this
// document changed since we last agreed on it" is just "does its
// current updatedAt differ from the value we recorded here." Stored
// locally, keyed by collection + document id.
async function getSyncMeta(localDb) {
  return localDb.collection('_syncMeta');
}

async function getWatermark(metaCollection, collectionName, docId) {
  const doc = await metaCollection.findOne({ collection: collectionName, docId: String(docId) });
  return doc ? doc.syncedUpdatedAt : null;
}

async function setWatermark(metaCollection, collectionName, docId, updatedAt) {
  await metaCollection.updateOne(
    { collection: collectionName, docId: String(docId) },
    { $set: { collection: collectionName, docId: String(docId), syncedUpdatedAt: updatedAt } },
    { upsert: true }
  );
}

async function parkConflict(localDb, collectionName, docId, localDoc, atlasDoc) {
  const conflicts = localDb.collection('_syncConflicts');

  // Without this check, the same unresolved pair gets re-inserted every
  // single cycle (every 60s) forever, since nothing else marks it as
  // "already flagged, don't ask again" — this collection would grow
  // unboundedly. Only park it once; an admin resolving it (or deleting
  // the record) is what should ever remove or update it.
  const existing = await conflicts.findOne({
    collection: collectionName,
    docId: String(docId),
    status: 'pending',
  });
  if (existing) return;

  await conflicts.insertOne({
    collection: collectionName,
    docId: String(docId),
    localVersion: localDoc,
    atlasVersion: atlasDoc,
    detectedAt: new Date(),
    status: 'pending', // admin review flips this to 'resolved' once handled
  });
}

// Reconcile one collection between local and Atlas. Returns counts for
// logging/visibility — this job runs silently in the background, so
// these numbers matter for anyone debugging sync behavior later.
async function reconcileCollection(localDb, atlasDb, collectionName) {
  const localCol = localDb.collection(collectionName);
  const atlasCol = atlasDb.collection(collectionName);
  const meta = await getSyncMeta(localDb);

  const stats = { pushed: 0, pulled: 0, conflicts: 0, checked: 0 };

  // Pull the job's own last-run watermark for this collection so we
  // only scan documents that could plausibly have changed, rather than
  // every document in the collection on every run.
  const jobMeta = await meta.findOne({ collection: collectionName, docId: '__collection__' });
  const since = jobMeta ? jobMeta.lastScannedAt : new Date(0);
  const scanStartedAt = new Date();

  const [changedLocal, changedAtlas] = await Promise.all([
    localCol.find({
      $or: [{ updatedAt: { $gt: since } }, { updatedAt: { $exists: false } }],
    }).toArray(),
    atlasCol.find({
      $or: [{ updatedAt: { $gt: since } }, { updatedAt: { $exists: false } }],
    }).toArray(),
  ]);

  const idsToCheck = new Set([
    ...changedLocal.map((d) => String(d._id)),
    ...changedAtlas.map((d) => String(d._id)),
  ]);

  const localById = new Map(changedLocal.map((d) => [String(d._id), d]));
  const atlasById = new Map(changedAtlas.map((d) => [String(d._id), d]));

  for (const idStr of idsToCheck) {
    stats.checked += 1;
    const id = ObjectId.isValid(idStr) ? new ObjectId(idStr) : idStr;

    // Only fetch fresh if not already in our changed-set batch above
    // (it will be, in virtually all cases — this covers the rare edge
    // where a doc changed again between the two find() calls above).
    let localDoc = localById.get(idStr) || (await localCol.findOne({ _id: id }));
    let atlasDoc = atlasById.get(idStr) || (await atlasCol.findOne({ _id: id }));

    // Documents created before `timestamps: true` was added to the
    // schema have no updatedAt at all. Give them one now so they get a
    // stable comparison point going forward instead of being treated as
    // "changed" on every single cycle forever.
    if (localDoc && !localDoc.updatedAt) {
      const now = new Date();
      await localCol.updateOne({ _id: localDoc._id }, { $set: { updatedAt: now } });
      localDoc = { ...localDoc, updatedAt: now };
    }
    if (atlasDoc && !atlasDoc.updatedAt) {
      const now = new Date();
      await atlasCol.updateOne({ _id: atlasDoc._id }, { $set: { updatedAt: now } });
      atlasDoc = { ...atlasDoc, updatedAt: now };
    }

    if (localDoc && !atlasDoc) {
      // New locally, doesn't exist on Atlas yet — push.
      try {
        await atlasCol.insertOne(localDoc);
        await setWatermark(meta, collectionName, idStr, localDoc.updatedAt);
        stats.pushed += 1;
      } catch (err) {
        if (err.code === 11000) {
          // A document with the same business key (productID,
          // customerID, etc.) already exists on Atlas under a
          // different _id — these two databases had independent data
          // before sync existed. Never guess which one is "right";
          // park it and stop retrying this exact pair every cycle.
          await parkConflict(localDb, collectionName, idStr, localDoc, { identityConflict: true, error: err.message });
          await setWatermark(meta, collectionName, idStr, localDoc.updatedAt);
          stats.conflicts += 1;
        } else {
          throw err;
        }
      }
      continue;
    }

    if (!localDoc && atlasDoc) {
      // New on Atlas (e.g. another machine), doesn't exist here — pull.
      try {
        await localCol.insertOne(atlasDoc);
        await setWatermark(meta, collectionName, idStr, atlasDoc.updatedAt);
        stats.pulled += 1;
      } catch (err) {
        if (err.code === 11000) {
          await parkConflict(localDb, collectionName, idStr, { identityConflict: true, error: err.message }, atlasDoc);
          await setWatermark(meta, collectionName, idStr, atlasDoc.updatedAt);
          stats.conflicts += 1;
        } else {
          throw err;
        }
      }
      continue;
    }

    if (!localDoc && !atlasDoc) {
      // Deleted from both, or a transient race — nothing to do.
      continue;
    }

    // Document exists on both sides. Compare each side's updatedAt
    // against what we last agreed on to determine what actually
    // changed since the last successful sync of THIS document.
    const watermark = await getWatermark(meta, collectionName, idStr);
    const localUpdatedAt = localDoc.updatedAt || null;
    const atlasUpdatedAt = atlasDoc.updatedAt || null;
    const localChanged =
      !watermark || !localUpdatedAt || localUpdatedAt.getTime() !== new Date(watermark).getTime();
    const atlasChanged =
      !watermark || !atlasUpdatedAt || atlasUpdatedAt.getTime() !== new Date(watermark).getTime();

    if (localChanged && atlasChanged) {
      // Both sides genuinely changed since we last reconciled this
      // document — this is exactly the case we agreed to never guess
      // on. Park it, touch neither side, let an admin decide.
      await parkConflict(localDb, collectionName, idStr, localDoc, atlasDoc);
      stats.conflicts += 1;
      continue;
    }

    if (localChanged) {
      await atlasCol.replaceOne({ _id: id }, localDoc);
      await setWatermark(meta, collectionName, idStr, localDoc.updatedAt);
      stats.pushed += 1;
      continue;
    }

    if (atlasChanged) {
      await localCol.replaceOne({ _id: id }, atlasDoc);
      await setWatermark(meta, collectionName, idStr, atlasDoc.updatedAt);
      stats.pulled += 1;
      continue;
    }
    // Neither actually changed (watermark already current) — nothing to do.
  }

  await meta.updateOne(
    { collection: collectionName, docId: '__collection__' },
    { $set: { collection: collectionName, docId: '__collection__', lastScannedAt: scanStartedAt } },
    { upsert: true }
  );

  return stats;
}

async function runOnce({ mongoPort }) {
  const atlasUri = process.env.ATLAS_MONGO_URI;
  if (!atlasUri) {
    log('[syncJob] ATLAS_MONGO_URI not set — skipping this sync cycle.');
    return;
  }

  if (!localClient) {
    localClient = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`);
    await localClient.connect();
  }
  if (!atlasClient) {
    atlasClient = new MongoClient(atlasUri);
    await atlasClient.connect();
  }

  const localDb = localClient.db('bpiolsABD');
  const atlasDb = atlasClient.db('bpiolsABD');

  for (const collectionName of SYNCED_COLLECTIONS) {
    try {
      const stats = await reconcileCollection(localDb, atlasDb, collectionName);
      log(
        `[syncJob] ${collectionName}: pushed ${stats.pushed}, pulled ${stats.pulled}, ` +
        `conflicts ${stats.conflicts} (checked ${stats.checked})`
      );
    } catch (err) {
      // A failure syncing one collection (e.g. transient network drop
      // mid-cycle) must never crash the job or block other collections
      // — sync failures are invisible to billing by design, they just
      // mean more to push next successful cycle.
      log(`[syncJob] Failed to reconcile ${collectionName}: ${err.message}`);
    }
  }
}

function start({ mongoPort }) {
  if (running) return;
  running = true;
  log(`[syncJob] Starting. ATLAS_MONGO_URI is ${process.env.ATLAS_MONGO_URI ? 'set' : 'NOT SET'}.`);

  const tick = () => {
    runOnce({ mongoPort }).catch((err) => {
      log(`[syncJob] Sync cycle failed: ${err.message}`);
    });
  };

  tick(); // run once immediately, then on the interval
  timer = setInterval(tick, SYNC_INTERVAL_MS);
}

async function stop() {
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (localClient) {
    await localClient.close();
    localClient = null;
  }
  if (atlasClient) {
    await atlasClient.close();
    atlasClient = null;
  }
}

module.exports = { start, stop };