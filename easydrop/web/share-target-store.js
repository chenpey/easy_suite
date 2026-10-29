// Single-slot local mailbox shared by the service worker (writer) and the page
// (reader). It stores only received-but-unconfirmed shares and never talks to
// the network, so a plain app launch with an empty slot stays silent.
import {
  SHARE_TARGET_DB_NAME,
  SHARE_TARGET_PENDING_KEY,
  SHARE_TARGET_STORE_NAME,
  expiredTombstone,
  inspectPendingShare,
} from "./share-target.js";

function openDatabase(indexedDb) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDb.open(SHARE_TARGET_DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SHARE_TARGET_STORE_NAME)) {
        request.result.createObjectStore(SHARE_TARGET_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Share target storage is blocked."));
  });
}

function transactionOutcome(indexedDb, run) {
  return openDatabase(indexedDb).then((db) => new Promise((resolve, reject) => {
    let outcome;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    let transaction;
    try {
      transaction = db.transaction(SHARE_TARGET_STORE_NAME, "readwrite");
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      db.close();
      settle(resolve, outcome);
    };
    transaction.onabort = () => {
      db.close();
      settle(reject, transaction.error || new Error("Share target transaction aborted."));
    };
    transaction.onerror = () => {
      db.close();
      settle(reject, transaction.error || new Error("Share target transaction failed."));
    };
    try {
      run(transaction.objectStore(SHARE_TARGET_STORE_NAME), (value) => { outcome = value; });
    } catch (error) {
      try { transaction.abort(); } catch { /* Already finished. */ }
      db.close();
      settle(reject, error);
    }
  }));
}

// Replaces the whole slot atomically; a failed write keeps the previous share.
export function savePendingShare(record, indexedDb = indexedDB) {
  return transactionOutcome(indexedDb, (store) => {
    store.put(record, SHARE_TARGET_PENDING_KEY);
  });
}

// Reads and removes the slot inside one write transaction. The clock is read in
// the read callback, because the transaction may wait behind another writer and
// a time captured before that wait could let an expired share through.
export function claimPendingShare(readNow = () => Date.now(), indexedDb = indexedDB) {
  return transactionOutcome(indexedDb, (store, setOutcome) => {
    const request = store.get(SHARE_TARGET_PENDING_KEY);
    request.onsuccess = () => {
      try {
        const record = request.result;
        const inspected = inspectPendingShare(record, readNow());
        if (inspected.status === "ready") {
          store.delete(SHARE_TARGET_PENDING_KEY);
          setOutcome(inspected);
          return;
        }
        if (inspected.status === "expired") {
          store.put(expiredTombstone(record, true), SHARE_TARGET_PENDING_KEY);
          setOutcome({ status: "expired" });
          return;
        }
        if (inspected.status === "invalid") {
          store.delete(SHARE_TARGET_PENDING_KEY);
        }
        setOutcome(inspected);
      } catch (error) {
        try { request.transaction.abort(); } catch { /* Already finished. */ }
        setOutcome({ status: "invalid" });
      }
    };
  });
}

// Service-worker activation cleanup: expired content becomes a silent tombstone
// until a page claims it and reports the expiry once.
export function expirePendingShare(readNow = () => Date.now(), indexedDb = indexedDB) {
  return transactionOutcome(indexedDb, (store) => {
    const request = store.get(SHARE_TARGET_PENDING_KEY);
    request.onsuccess = () => {
      try {
        const record = request.result;
        const inspected = inspectPendingShare(record, readNow());
        if (inspected.status === "expired") {
          store.put(expiredTombstone(record, false), SHARE_TARGET_PENDING_KEY);
        }
      } catch (error) {
        try { request.transaction.abort(); } catch { /* Already finished. */ }
      }
    };
  });
}
