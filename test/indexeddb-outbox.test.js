import assert from "node:assert/strict";
import test from "node:test";

import { indexedDB } from "fake-indexeddb";

import { Delta, IpcMessage, Outbox } from "../src/index.js";
import { IndexedDbStore } from "../src/indexeddb-outbox.js";

const frame = (epoch) => IpcMessage.delta(new Delta({ baseEpoch: epoch - 1, epoch }));

test("IndexedDbStore reloads the durable cursor and unacknowledged suffix", async () => {
  const database = `lazily-outbox-restart-${Date.now()}-${Math.random()}`;
  const firstStore = await IndexedDbStore.open({ channel: "doc", database, indexedDB });
  const first = new Outbox(firstStore);
  await first.append(1, frame(1));
  await first.append(2, frame(2));
  await first.append(3, frame(3));
  await first.ackThrough(1);
  firstStore.close();

  const reopenedStore = await IndexedDbStore.open({ channel: "doc", database, indexedDB });
  const reopened = new Outbox(reopenedStore);
  assert.equal(reopened.ackedThrough, 1);
  assert.deepEqual(reopened.retainedEpochs(), [2, 3]);
  assert.deepEqual(reopened.replayFrom(0).map(([epoch]) => epoch), [2, 3]);
  reopenedStore.close();
});

test("IndexedDbStore keeps concurrent acknowledgements monotone", async () => {
  const database = `lazily-outbox-monotone-${Date.now()}-${Math.random()}`;
  const store = await IndexedDbStore.open({ channel: "doc", database, indexedDB });
  const outbox = new Outbox(store);
  for (const epoch of [1, 2, 3, 4]) await outbox.append(epoch, frame(epoch));
  await Promise.all([outbox.ackThrough(4), outbox.ackThrough(3)]);
  assert.equal(outbox.ackedThrough, 4);
  store.close();

  const reopenedStore = await IndexedDbStore.open({ channel: "doc", database, indexedDB });
  const reopened = new Outbox(reopenedStore);
  assert.equal(reopened.ackedThrough, 4);
  assert.deepEqual(reopened.replayFrom(0), []);
  reopenedStore.close();
});

test("IndexedDbStore stale handle cannot regress serialized cursor", async () => {
  const database = `lazily-outbox-stale-${Date.now()}-${Math.random()}`;
  const staleStore = await IndexedDbStore.open({ channel: "doc", database, indexedDB });
  const currentStore = await IndexedDbStore.open({ channel: "doc", database, indexedDB });
  const stale = new Outbox(staleStore);
  const current = new Outbox(currentStore);

  await current.ackThrough(9);
  await stale.ackThrough(3);
  assert.equal(stale.ackedThrough, 9);
  staleStore.close();
  currentStore.close();

  const reopenedStore = await IndexedDbStore.open({ channel: "doc", database, indexedDB });
  assert.equal(new Outbox(reopenedStore).ackedThrough, 9);
  reopenedStore.close();
});
