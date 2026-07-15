import { requestToPromise, transactionToPromise } from "./indexedDb.js";
import { SCHEMA_VERSION, STORE_DEFINITIONS, STORE_NAMES } from "./schema.js";

const VALID_STORE_NAMES = new Set(STORE_DEFINITIONS.map(({ name }) => name));

export class Version2Repository {
  constructor(database) {
    assertDatabase(database);
    this.database = database;

    for (const storeName of VALID_STORE_NAMES) {
      this[storeName] = createStoreFacade(this, storeName);
    }
  }

  async runTransaction(storeNames, mode, operation) {
    const names = normalizeStoreNames(storeNames);
    if (mode !== "readonly" && mode !== "readwrite") {
      throw new TypeError("Transaction mode must be readonly or readwrite.");
    }
    if (typeof operation !== "function") {
      throw new TypeError("Transaction operation must be a function.");
    }

    const transaction = this.database.transaction(names, mode);
    const completion = transactionToPromise(transaction);
    const context = Object.freeze({
      store: (storeName) => {
        assertStoreIncluded(storeName, names);
        return createTransactionalStore(transaction.objectStore(storeName));
      }
    });

    try {
      const result = await operation(context);
      await completion;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because an IDB request failed.
      }
      await completion.catch(() => undefined);
      throw error;
    }
  }

  async getSchemaVersion() {
    const record = await this.appMeta.get("schemaVersion");
    return record?.value ?? null;
  }

  async assertSchemaVersion() {
    const actual = await this.getSchemaVersion();
    if (actual !== SCHEMA_VERSION) {
      throw new Error(
        `IndexedDB schemaVersion mismatch: expected ${SCHEMA_VERSION}, received ${actual}.`
      );
    }
    return actual;
  }

  async recoverSendingSyncItems() {
    return this.runTransaction([STORE_NAMES.syncQueue], "readwrite", async ({ store }) => {
      const syncQueue = store(STORE_NAMES.syncQueue);
      const sendingItems = await syncQueue.getAllByIndex("status", "sending");

      for (const item of sendingItems) {
        await syncQueue.put({ ...item, status: "pending" });
      }

      return sendingItems.length;
    });
  }

  close() {
    this.database.close();
  }
}

export function createVersion2Repository(database) {
  return new Version2Repository(database);
}

function createStoreFacade(repository, storeName) {
  return Object.freeze({
    get: (key) => repository.runTransaction(
      [storeName],
      "readonly",
      ({ store }) => store(storeName).get(key)
    ),
    getAll: (query, count) => repository.runTransaction(
      [storeName],
      "readonly",
      ({ store }) => store(storeName).getAll(query, count)
    ),
    getAllByIndex: (indexName, query, count) => repository.runTransaction(
      [storeName],
      "readonly",
      ({ store }) => store(storeName).getAllByIndex(indexName, query, count)
    ),
    add: (value) => repository.runTransaction(
      [storeName],
      "readwrite",
      ({ store }) => store(storeName).add(value)
    ),
    put: (value) => repository.runTransaction(
      [storeName],
      "readwrite",
      ({ store }) => store(storeName).put(value)
    ),
    delete: (key) => repository.runTransaction(
      [storeName],
      "readwrite",
      ({ store }) => store(storeName).delete(key)
    )
  });
}

function createTransactionalStore(objectStore) {
  return Object.freeze({
    get: (key) => requestToPromise(objectStore.get(key)),
    getAll: (query, count) => requestToPromise(objectStore.getAll(query, count)),
    getAllByIndex: (indexName, query, count) => requestToPromise(
      objectStore.index(indexName).getAll(query, count)
    ),
    add: (value) => requestToPromise(objectStore.add(value)),
    put: (value) => requestToPromise(objectStore.put(value)),
    delete: (key) => requestToPromise(objectStore.delete(key))
  });
}

function normalizeStoreNames(storeNames) {
  const names = typeof storeNames === "string" ? [storeNames] : [...(storeNames ?? [])];
  if (!names.length) throw new TypeError("At least one store is required.");

  const uniqueNames = [...new Set(names)];
  for (const storeName of uniqueNames) {
    if (!VALID_STORE_NAMES.has(storeName)) {
      throw new Error(`Unknown Version2 store: ${storeName}`);
    }
  }
  return uniqueNames;
}

function assertStoreIncluded(storeName, includedStoreNames) {
  if (!includedStoreNames.includes(storeName)) {
    throw new Error(`Store is not part of this transaction: ${storeName}`);
  }
}

function assertDatabase(database) {
  if (!database?.transaction || !database?.objectStoreNames) {
    throw new TypeError("A valid IDBDatabase is required.");
  }

  const missing = [...VALID_STORE_NAMES].filter(
    (storeName) => !database.objectStoreNames.contains(storeName)
  );
  if (missing.length) {
    throw new Error(`IndexedDB is missing required stores: ${missing.join(", ")}`);
  }
}
