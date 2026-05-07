const assert = require("node:assert/strict");
const {
  matchPayment,
  normalizeWalletForCompare,
  computeMatchStatusWithWallet,
  computeMatchDetails
} = require("../lib/paymentDecision");

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

run("matchPayment returns tx_not_found when actual is missing or not FOUND", () => {
  assert.equal(matchPayment({ network: "Ethereum", token: "USDT" }, null), "tx_not_found");
  assert.equal(
    matchPayment({ network: "Ethereum", token: "USDT" }, { status: "NOT_FOUND" }),
    "tx_not_found"
  );
});

run("matchPayment returns funds_lost_wrong_asset for opBNB or BNB actuals", () => {
  assert.equal(
    matchPayment(
      { network: "Ethereum", token: "USDT" },
      { status: "FOUND", network: "opBNB", token: "USDT" }
    ),
    "funds_lost_wrong_asset"
  );
  assert.equal(
    matchPayment(
      { network: "BSC", token: "USDT" },
      { status: "FOUND", network: "BSC", token: "BNB" }
    ),
    "funds_lost_wrong_asset"
  );
});

run("matchPayment returns wrong_network when network mismatches", () => {
  assert.equal(
    matchPayment(
      { network: "Ethereum", token: "USDT" },
      { status: "FOUND", network: "Tron", token: "USDT" }
    ),
    "wrong_network"
  );
});

run("matchPayment returns wrong_asset when token mismatches", () => {
  assert.equal(
    matchPayment(
      { network: "Ethereum", token: "USDT" },
      { status: "FOUND", network: "Ethereum", token: "USDC" }
    ),
    "wrong_asset"
  );
});

run("matchPayment returns payment_valid when network and token match", () => {
  assert.equal(
    matchPayment(
      { network: "Ethereum", token: "USDT" },
      { status: "FOUND", network: "Ethereum", token: "USDT" }
    ),
    "payment_valid"
  );
});

run("normalizeWalletForCompare trims and lowercases", () => {
  assert.equal(
    normalizeWalletForCompare("  0xAaBbCcDdEeFf0011223344556677889900AABBcc  "),
    "0xaabbccddeeff0011223344556677889900aabbcc"
  );
  assert.equal(normalizeWalletForCompare(""), "");
  assert.equal(normalizeWalletForCompare(null), "");
});

run("computeMatchStatusWithWallet returns wrong_wallet_address when receiver mismatches", () => {
  const status = computeMatchStatusWithWallet({
    expected: { network: "Ethereum", token: "USDT" },
    actual: { status: "FOUND", network: "Ethereum", token: "USDT" },
    expectedWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    actualReceiver: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  assert.equal(status, "wrong_wallet_address");
});

run("computeMatchStatusWithWallet delegates to payment matcher when wallet matches", () => {
  const status = computeMatchStatusWithWallet({
    expected: { network: "Ethereum", token: "USDT" },
    actual: { status: "FOUND", network: "Ethereum", token: "USDT" },
    expectedWallet: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
    actualReceiver: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  assert.equal(status, "payment_valid");
});

run("computeMatchStatusWithWallet prioritizes wrong_network over wallet mismatch", () => {
  const status = computeMatchStatusWithWallet({
    expected: { network: "Tron", token: "USDT" },
    actual: { status: "FOUND", network: "Ethereum", token: "USDT" },
    expectedWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    actualReceiver: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  assert.equal(status, "wrong_network");
});

run("computeMatchDetails returns explicit wallet/network/token match flags", () => {
  const details = computeMatchDetails({
    expected: { network: "Tron", token: "USDT" },
    actual: { status: "FOUND", network: "Ethereum", token: "USDT" },
    expectedWallet: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    actualReceiver: "0xdac17f958d2ee523a2206206994597c13d831ec7"
  });
  assert.equal(details.status, "wrong_network");
  assert.equal(details.wallet_match, true);
  assert.equal(details.network_match, false);
  assert.equal(details.token_match, true);
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
