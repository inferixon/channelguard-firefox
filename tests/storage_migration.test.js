const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const sharedSource = fs.readFileSync(path.join(root, "src", "shared.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");

const noop = () => {};
const context = {
  console,
  URL,
  URLSearchParams,
  TextEncoder,
  crypto: {
    subtle: { digest: async () => new ArrayBuffer(32) },
    getRandomValues: (bytes) => bytes.fill(1)
  },
  chrome: {
    runtime: {
      getURL: (value) => value,
      getManifest: () => ({ version: "test" }),
      onInstalled: { addListener: noop },
      onMessage: { addListener: noop },
      lastError: null
    },
    storage: { local: { get: noop, set: noop } },
    tabs: { update: noop, reload: noop, query: noop, sendMessage: noop, onUpdated: { addListener: noop } },
    webNavigation: {
      onCommitted: { addListener: noop },
      onHistoryStateUpdated: { addListener: noop }
    }
  },
  fetch: async () => ({ ok: true, json: async () => ({ channels: [] }), text: async () => "" })
};

vm.createContext(context);
vm.runInContext(`${sharedSource}\n${backgroundSource}\n` +
  `globalThis.__storageMigrationApi = {
    migrateWhitelistStorageSnapshot,
    normalizeWhitelistEntry,
    STORAGE_KEY,
    SCHEMA_VERSION_KEY,
    SCHEMA_VERSION
  };`, context);

const {
  migrateWhitelistStorageSnapshot,
  STORAGE_KEY,
  SCHEMA_VERSION_KEY,
  SCHEMA_VERSION
} = context.__storageMigrationApi;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrate(channels, schemaVersion) {
  return migrateWhitelistStorageSnapshot({
    [STORAGE_KEY]: channels,
    [SCHEMA_VERSION_KEY]: schemaVersion
  });
}

{
  const result = migrate([
    "handle:@YouTube",
    "channelId:UC-9-kyTW8ZkZNDHQJ6FgpwQ"
  ], undefined);
  assert.deepStrictEqual(plain(result.entries), []);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.schemaVersion, SCHEMA_VERSION);
}

{
  const result = migrate(["https://www.youtube.com/@Kurzgesagt"], 0);
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].key, "handle:@kurzgesagt");
  assert.strictEqual(result.entries[0].enabled, true);
  assert.strictEqual(result.changed, true);
}

{
  const result = migrate({
    channels: [
      {
        channelKey: "handle:@Numberphile",
        channelName: "Numberphile",
        enabled: true,
        expires_at: "2026-07-05T10:00:00.000Z",
        created_at: "2026-07-01T10:00:00.000Z"
      }
    ]
  }, 1);
  assert.deepStrictEqual(plain(result.entries.map((entry) => entry.key)), ["handle:@numberphile"]);
  assert.strictEqual(result.entries[0].expiresAt, "2026-07-05T10:00:00.000Z");
  assert.strictEqual(result.entries[0].createdAt, "2026-07-01T10:00:00.000Z");
  assert.strictEqual(result.changed, true);
}

{
  const result = migrate({
    "handle:@veritasium": { name: "Veritasium", enabled: true },
    "name:unstable display name": true,
    "handle:@disabled": false
  }, 1);
  assert.deepStrictEqual(plain(result.entries.map((entry) => entry.key)), ["handle:@veritasium"]);
  assert.strictEqual(result.changed, true);
}

{
  const current = [{
    key: "handle:@standupmaths",
    name: "Stand-up Maths",
    enabled: true,
    expiresAt: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z"
  }];
  const result = migrate(current, SCHEMA_VERSION);
  assert.deepStrictEqual(plain(result.entries), current);
  assert.strictEqual(result.changed, false);
}

{
  const result = migrate("not-compatible", 1);
  assert.deepStrictEqual(plain(result.entries), []);
  assert.strictEqual(result.hadStoredChannels, false);
  assert.strictEqual(result.changed, true);
}

console.log("storage_migration.test.js PASS");
