import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const {
  ingestIxac41Message,
  resetIxac41Assembler,
  shindoFromIntensity,
} = await import("../src/ixac41/parser.js");
const {
  addPendingIxac41Mesh,
  attachIxac41ToEvent,
  findIxac41EventIds,
  getIxac41MeshForReport,
  pruneExpiredIxac41Meshes,
  pruneIxac41Meshes,
  resetIxac41Store,
} = await import("../src/ixac41/store.js");
const {
  IXAC41_API_BASE_URL,
  processIxac41ArchiveMessages,
} = await import("../src/ixac41/archive.js");

const SAMPLES_DIR = path.resolve(process.cwd(), "service/dmdata-proxy/data/IXAC41");
if (!fs.existsSync(SAMPLES_DIR)) {
  console.log("IXAC41 samples not found; skipping IXAC41 tests");
  process.exit(0);
}

const readSample = (name) =>
  JSON.parse(fs.readFileSync(path.resolve(SAMPLES_DIR, name), "utf8"));

console.log("=== Running IXAC41 tests ===");

resetIxac41Assembler();
const smallResult = ingestIxac41Message(
  readSample("IXAC41_RJTD_20261028151200_4d2f83d.websocket.json"),
);
assert.strictEqual(smallResult.status, "parsed");
const small = smallResult.mesh;
assert.strictEqual(small.cellCount, 7243);
assert.strictEqual(small.originTimeJstPrefix, "202610290007");
assert.strictEqual(small.epicenterCode, 340);
assert.strictEqual(small.maxShindo, "5-");
assert.strictEqual(small.classes.length, 2);
assert.strictEqual(small.classes[0].lower, 35);
assert.strictEqual(small.classes[0].upper, 44);
assert.strictEqual(small.lat.length, small.cellCount);
assert.strictEqual(small.lon.length, small.cellCount);
assert.strictEqual(small.intensity.length, small.cellCount);
assert.ok(small.bounds.minLat < small.bounds.maxLat);
assert.ok(small.bounds.minLon < small.bounds.maxLon);
assert.ok(Math.abs(small.lat[0] - 35.5604) < 0.001);
assert.ok(Math.abs(small.lon[0] - 140.3281) < 0.001);
assert.strictEqual(shindoFromIntensity(small.intensity[0], small.classes), "4");
console.log("✓ Single-message parse");

resetIxac41Assembler();
const splitA = readSample("IXAC41_RJTD_20260728073600_c504577.websocket.json");
const splitB = readSample("IXAC41_RJTD_RRA_20260728073600_2b6115d.websocket.json");
assert.strictEqual(ingestIxac41Message(splitA).status, "incomplete");
const splitResult = ingestIxac41Message(splitB);
assert.strictEqual(splitResult.status, "parsed");
assert.strictEqual(splitResult.mesh.cellCount, 315559);
assert.strictEqual(splitResult.mesh.originTimeJstPrefix, "202607281627");
assert.strictEqual(splitResult.mesh.epicenterCode, 741);
assert.strictEqual(splitResult.mesh.maxShindo, "7");
console.log("✓ Split-message reassembly");

resetIxac41Assembler();
assert.strictEqual(ingestIxac41Message(splitB).status, "incomplete");
assert.strictEqual(ingestIxac41Message(splitA).status, "parsed");
console.log("✓ Out-of-order split reassembly");

resetIxac41Assembler();
assert.strictEqual(
  ingestIxac41Message(
    readSample("IXAC41_RJTD_20260728073200_8620807.websocket.json"),
  ).status,
  "incomplete",
);
console.log("✓ Incomplete message stays incomplete");

resetIxac41Assembler();
const largeResult = ingestIxac41Message(
  readSample("IXAC41_RJTD_20261107160900_a5880c1.websocket.json"),
);
assert.strictEqual(largeResult.status, "parsed");
assert.strictEqual(largeResult.mesh.cellCount, 108635);
assert.strictEqual(largeResult.mesh.originTimeJstPrefix, "202611080104");
assert.strictEqual(largeResult.mesh.maxShindo, "5+");
console.log("✓ Larger single message parse");

const betterShindo = shindoFromIntensity(45, []);
assert.strictEqual(betterShindo, "5-");
assert.strictEqual(shindoFromIntensity(35, []), "4");

resetIxac41Store();
addPendingIxac41Mesh(largeResult.mesh);
const report = {
  eventId: "20261108010441",
  originTime: Date.parse("2026-11-08T01:04:41+09:00") / 1000,
  hypocenterCode: 443,
  coordinates: { latitude: 34.9, longitude: 137.6 },
};
assert.strictEqual(getIxac41MeshForReport(report), largeResult.mesh);
assert.deepStrictEqual(
  findIxac41EventIds(largeResult.mesh, ["20261108010441", "20261108010500"]),
  ["20261108010441"],
);
console.log("✓ Mesh/report matching");

attachIxac41ToEvent("20261108010441", largeResult.mesh);
pruneIxac41Meshes(new Set(["20261108010441"]));
assert.strictEqual(getIxac41MeshForReport(report), null);
console.log("✓ Mesh pruning");

// Newer IXAC41 wins over an older one for the same event.
resetIxac41Assembler();
resetIxac41Store();
const earlier = ingestIxac41Message(
  readSample("IXAC41_RJTD_20261107160900_a5880c1.websocket.json"),
).mesh;
resetIxac41Assembler();
const later = ingestIxac41Message(
  readSample("IXAC41_RJTD_20261107161300_80cc285.websocket.json"),
).mesh;
attachIxac41ToEvent("20261108010441", later);
assert.strictEqual(attachIxac41ToEvent("20261108010441", earlier), later);
assert.strictEqual(getIxac41MeshForReport(report).cellCount, 109286);
resetIxac41Store();
attachIxac41ToEvent("20261108010441", earlier);
assert.strictEqual(attachIxac41ToEvent("20261108010441", later), later);
assert.strictEqual(getIxac41MeshForReport(report).cellCount, 109286);
console.log("✓ Newer IXAC41 supersedes older");

// Expiry follows the sidebar's 30-day window.
resetIxac41Store();
attachIxac41ToEvent("20261108010441", later);
addPendingIxac41Mesh(earlier);
const removed = pruneExpiredIxac41Meshes(Date.parse("2027-01-15T00:00:00Z"));
assert.ok(removed >= 1);
assert.strictEqual(getIxac41MeshForReport(report), null);
console.log("✓ Mesh expiry");

// Archive loader keeps only matched, newest messages.
resetIxac41Assembler();
resetIxac41Store();
const archiveMessages = [
  {
    id: "IXAC41_RJTD_20261107161300",
    time: "2026-11-07T16:13:00.000Z",
    complete: true,
  },
  {
    id: "IXAC41_RJTD_20261107160900",
    time: "2026-11-07T16:09:00.000Z",
    complete: true,
  },
  {
    id: "IXAC41_RJTD_20261028151200",
    time: "2026-10-28T15:12:00.000Z",
    complete: true,
  },
];
const partsById = {
  IXAC41_RJTD_20261107161300: [
    readSample("IXAC41_RJTD_20261107161300_80cc285.websocket.json"),
  ],
  IXAC41_RJTD_20261107160900: [
    readSample("IXAC41_RJTD_20261107160900_a5880c1.websocket.json"),
  ],
  IXAC41_RJTD_20261028151200: [
    readSample("IXAC41_RJTD_20261028151200_4d2f83d.websocket.json"),
  ],
};
const archiveResult = await processIxac41ArchiveMessages(archiveMessages, {
  reports: [report],
  fetchParts: async (message) => partsById[message.id],
  now: Date.parse("2026-11-24T00:00:00Z"),
});
assert.deepStrictEqual(archiveResult.matchedEventIds, ["20261108010441"]);
assert.strictEqual(getIxac41MeshForReport(report).cellCount, 109286);
assert.strictEqual(
  getIxac41MeshForReport({
    eventId: "20261029000759",
    originTime: Date.parse("2026-10-29T00:07:59+09:00") / 1000,
    hypocenterCode: 340,
    coordinates: { latitude: 35.6, longitude: 140.7 },
  }),
  null,
  "unmatched API meshes are dropped",
);
assert.match(IXAC41_API_BASE_URL, /^https:\/\/ws\.kyoquake\.hainaut\.xyz\//);
console.log("✓ Archive matching and dropping");

// Archive messages outside the sidebar age window are not loaded.
resetIxac41Assembler();
resetIxac41Store();
const expiredArchiveResult = await processIxac41ArchiveMessages(archiveMessages, {
  reports: [report],
  fetchParts: async (message) => partsById[message.id],
  now: Date.parse("2027-01-15T00:00:00Z"),
});
assert.deepStrictEqual(expiredArchiveResult.matchedEventIds, []);
assert.strictEqual(getIxac41MeshForReport(report), null);
console.log("✓ Archive expiry");

resetIxac41Assembler();
resetIxac41Store();

console.log("\n=== ALL IXAC41 TESTS PASSED SUCCESSFULLY! ===");
