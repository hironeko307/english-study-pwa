import {
  INDEXED_DB_VERSION,
  SCHEMA_VERSION,
  STORE_DEFINITIONS,
  STORE_NAMES
} from "./schema.js";

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, migrate: createInitialSchema })
]);

export function applyMigrations({
  database,
  transaction,
  oldVersion,
  newVersion,
  now = () => new Date()
}) {
  assertMigrationRange(oldVersion, newVersion);

  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === version);
    if (!migration) {
      throw new Error(`Missing IndexedDB migration for version ${version}.`);
    }
    migration.migrate({ database, transaction, now });
  }
}

function createInitialSchema({ database, transaction, now }) {
  for (const definition of STORE_DEFINITIONS) {
    const store = database.createObjectStore(definition.name, {
      keyPath: definition.keyPath
    });

    for (const index of definition.indexes) {
      store.createIndex(index.name, index.keyPath, index.options);
    }
  }

  transaction.objectStore(STORE_NAMES.appMeta).put({
    key: "schemaVersion",
    value: SCHEMA_VERSION,
    updatedAt: now().toISOString()
  });
}

function assertMigrationRange(oldVersion, newVersion) {
  if (!Number.isInteger(oldVersion) || oldVersion < 0) {
    throw new TypeError("oldVersion must be a non-negative integer.");
  }
  if (!Number.isInteger(newVersion) || newVersion < 1) {
    throw new TypeError("newVersion must be a positive integer.");
  }
  if (newVersion > INDEXED_DB_VERSION) {
    throw new Error(`IndexedDB version ${newVersion} is not supported.`);
  }
}
