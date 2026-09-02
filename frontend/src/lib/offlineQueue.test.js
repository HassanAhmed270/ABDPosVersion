import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueSale,
  listQueue,
  updateSale,
  clearSynced,
  saveLocalDraft,
  getLocalDraft,
  clearLocalDraft,
} from './offlineQueue.js';

function resetDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('pos-offline-queue');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // no open connections should remain, but don't hang the suite if one does
  });
}

test.beforeEach(resetDB);

test('enqueueSale persists a sale with pending status and local bookkeeping', async () => {
  const sale = { idempotencyKey: 'k1', customerName: 'Walk-in / Unknown', items: [], paidInput: 100, paymentMethod: 'cash' };
  const record = await enqueueSale(sale);

  assert.equal(record.status, 'pending');
  assert.equal(record.resultingOrderID, null);
  assert.ok(record.queuedAt);

  const all = await listQueue();
  assert.equal(all.length, 1);
  assert.equal(all[0].idempotencyKey, 'k1');
});

test('listQueue returns every queued sale regardless of status', async () => {
  await enqueueSale({ idempotencyKey: 'a', items: [] });
  await enqueueSale({ idempotencyKey: 'b', items: [] });

  const all = await listQueue();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((s) => s.idempotencyKey).sort(), ['a', 'b']);
});

test('updateSale patches an existing entry and returns the updated record', async () => {
  await enqueueSale({ idempotencyKey: 'k1', items: [] });

  const updated = await updateSale('k1', { status: 'synced', resultingOrderID: '#0001' });
  assert.equal(updated.status, 'synced');
  assert.equal(updated.resultingOrderID, '#0001');

  const all = await listQueue();
  assert.equal(all[0].status, 'synced');
});

test('updateSale returns null for a key that was never enqueued', async () => {
  const result = await updateSale('missing', { status: 'synced' });
  assert.equal(result, null);
});

test('clearSynced removes only synced entries, leaving pending/conflict untouched', async () => {
  await enqueueSale({ idempotencyKey: 'done', items: [] });
  await enqueueSale({ idempotencyKey: 'still-pending', items: [] });
  await enqueueSale({ idempotencyKey: 'bad', items: [] });
  await updateSale('done', { status: 'synced' });
  await updateSale('bad', { status: 'conflict' });

  await clearSynced();

  const remaining = await listQueue();
  assert.equal(remaining.length, 2);
  assert.deepEqual(remaining.map((s) => s.idempotencyKey).sort(), ['bad', 'still-pending']);
});

test('saveLocalDraft then getLocalDraft round-trips the draft cart', async () => {
  const draft = {
    billingItems: { 1: { productCode: '0001', itemName: 'Widget', unitPrice: 100, quantity: 2, discount: 0 } },
    customer: 'unknown',
    billId: null,
    paid: '200',
    paymentMethod: 'cash',
  };
  await saveLocalDraft(draft);

  const restored = await getLocalDraft();
  assert.deepEqual(restored.billingItems, draft.billingItems);
  assert.equal(restored.customer, 'unknown');
  assert.equal(restored.paid, '200');
  assert.ok(restored.savedAt);
});

test('saveLocalDraft overwrites the previous draft rather than accumulating entries', async () => {
  await saveLocalDraft({ billingItems: { 1: { itemName: 'First' } }, customer: 'unknown', billId: null, paid: '', paymentMethod: 'cash' });
  await saveLocalDraft({ billingItems: { 1: { itemName: 'Second' } }, customer: 'unknown', billId: null, paid: '', paymentMethod: 'cash' });

  const restored = await getLocalDraft();
  assert.equal(restored.billingItems[1].itemName, 'Second');
});

test('getLocalDraft returns undefined when nothing has been saved', async () => {
  const restored = await getLocalDraft();
  assert.equal(restored, undefined);
});

test('clearLocalDraft removes the draft so a later getLocalDraft finds nothing', async () => {
  await saveLocalDraft({ billingItems: { 1: {} }, customer: 'unknown', billId: null, paid: '', paymentMethod: 'cash' });
  await clearLocalDraft();

  const restored = await getLocalDraft();
  assert.equal(restored, undefined);
});

test('the drafts store and the sales queue are independent of each other', async () => {
  await enqueueSale({ idempotencyKey: 'k1', items: [] });
  await saveLocalDraft({ billingItems: { 1: {} }, customer: 'unknown', billId: null, paid: '', paymentMethod: 'cash' });

  await clearLocalDraft();
  const queue = await listQueue();
  assert.equal(queue.length, 1, 'clearing the draft must not touch the sales queue');

  await clearSynced();
  const draft = await getLocalDraft();
  assert.equal(draft, undefined, 'draft was already cleared and stays cleared');
});
