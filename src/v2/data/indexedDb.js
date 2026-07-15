import { applyMigrations } from "./migrations.js";
import { DATABASE_NAME, INDEXED_DB_VERSION } from "./schema.js";

export function openVersion2Database({
  indexedDBFactory = globalThis.indexedDB,
  name = DATABASE_NAME,
  version = INDEXED_DB_VERSION,
  now = () => new Date()
} = {}) {
  if (!indexedDBFactory?.open) {
    return Promise.reject(new Error("IndexedDB is not available in this environment."));
  }
  if (!Number.isInteger(version) || version < 1) {
    return Promise.reject(new TypeError("IndexedDB version must be a positive integer."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDBFactory.open(name, version);
    let settled = false;

    request.onupgradeneeded = (event) => {
      try {
        applyMigrations({
          database: request.result,
          transaction: request.transaction,
          oldVersion: event.oldVersion,
          newVersion: event.newVersion,
          now
        });
      } catch (error) {
        request.transaction?.abort();
        settled = true;
        reject(error);
      }
    };

    request.onerror = () => {
      if (!settled) reject(request.error ?? new Error("Unable to open IndexedDB."));
    };

    request.onblocked = () => {
      if (!settled) {
        settled = true;
        reject(new Error("IndexedDB upgrade is blocked by another open connection."));
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }

      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction was aborted.")
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed.")
    );
  });
}
