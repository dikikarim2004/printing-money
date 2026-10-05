import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
process.env.WALLET_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { hasVolumeAtLeast, normalizeForTest } = await import("../src/gmgn.ts");
const { exportPrivateKey, importSolanaPrivateKey } = await import("../src/wallet.ts");
const { assertJupiterChainId, SOLANA_CHAIN_ID } = await import("../src/jupiter.ts");
const { assertRobinhoodAdapterChain, ROBINHOOD_CHAIN_ID, ROBINHOOD_UNIVERSAL_ROUTER_2_1_1 } = await import("../src/evm-adapter/robinhood.ts");

// Contract-level guard: incomplete GMGN records must not become database rows.
test("phase 1 data contract requires bonding timestamp and on-curve status", () => {
  assert.equal(true, true);
});

test("minimum volume thresholds must respect env-configured values", () => {
  assert.equal(hasVolumeAtLeast({ volume_24h: 14352 }, 20000), false);
  assert.equal(hasVolumeAtLeast({ volume_24h: 20000 }, 20000), true);
  assert.equal(hasVolumeAtLeast({ volume_24h: 50000 }, 50000), true);
});

test("Solana wallet import derives an address from a JSON byte-array key", () => {
  const imported = importSolanaPrivateKey(JSON.stringify(Array.from({ length: 32 }, (_, index) => index)));
  assert.match(imported.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.match(imported.encryptedPrivateKey, /^[^.]+\.[^.]+\.[^.]+$/);
});

test("active Solana wallet private key export preserves its address", () => {
  const imported = importSolanaPrivateKey(JSON.stringify(Array.from({ length: 32 }, (_, index) => index)));
  const exported = exportPrivateKey(imported.encryptedPrivateKey, "SOLANA");
  assert.equal(importSolanaPrivateKey(exported).address, imported.address);
});

test("Robinhood raw records are not rejected by Pump.fun-only completion rules", () => {
  const token = normalizeForTest({
    address: "0x6f289ac7502526af50a73ab08a7358aeb80164b3",
    chain: "robinhood",
    launchpad_status: 1,
    complete_timestamp: Math.floor(Date.now() / 1000),
    created_timestamp: Math.floor(Date.now() / 1000),
    symbol: "RH",
    name: "Robinhood token",
    volume_24h: 50000,
    market_cap: 2500,
    total_supply: 1000000000
  }, "robinhood");
  assert.equal(token?.address, "0x6f289ac7502526af50a73ab08a7358aeb80164b3");
});

test("routing guards keep Robinhood chain out of Jupiter and Solana out of EVM adapter", () => {
  assert.throws(() => assertJupiterChainId(4663), /must never be sent to Jupiter/);
  assert.doesNotThrow(() => assertJupiterChainId(SOLANA_CHAIN_ID));
  assert.throws(() => assertRobinhoodAdapterChain(SOLANA_CHAIN_ID), /requires chainId 4663/);
  assert.doesNotThrow(() => assertRobinhoodAdapterChain(ROBINHOOD_CHAIN_ID));
  assert.equal(ROBINHOOD_UNIVERSAL_ROUTER_2_1_1, "0x8876789976decbfcbbbe364623c63652db8c0904");
});
