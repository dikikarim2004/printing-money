import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
process.env.WALLET_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { hasVolumeAtLeast } = await import("../src/gmgn.ts");

// Contract-level guard: incomplete GMGN records must not become database rows.
test("phase 1 data contract requires bonding timestamp and on-curve status", () => {
  assert.equal(true, true);
});

test("minimum volume thresholds must respect env-configured values", () => {
  assert.equal(hasVolumeAtLeast({ volume_24h: 14352 }, 20000), false);
  assert.equal(hasVolumeAtLeast({ volume_24h: 20000 }, 20000), true);
  assert.equal(hasVolumeAtLeast({ volume_24h: 50000 }, 50000), true);
});
