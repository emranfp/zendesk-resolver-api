const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
}

function loadFreshServerWithEnv(env, options = {}) {
  const serverPath = path.resolve(__dirname, "..", "server.js");
  const storePath = path.resolve(__dirname, "..", "data", "tickets-store.json");
  delete require.cache[serverPath];
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    INTERNAL_API_KEY: process.env.INTERNAL_API_KEY,
    ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY
  };

  process.env.NODE_ENV = env.NODE_ENV;
  process.env.INTERNAL_API_KEY = env.INTERNAL_API_KEY;
  process.env.ETHERSCAN_API_KEY = env.ETHERSCAN_API_KEY;

  if (options.storeData) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(options.storeData, null, 2), "utf8");
  } else if (fs.existsSync(storePath)) {
    fs.unlinkSync(storePath);
  }

  const mod = require(serverPath);
  return {
    mod,
    storePath,
    restore: () => {
      Object.assign(process.env, original);
      delete require.cache[serverPath];
      if (fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
    }
  };
}

async function withServer(env, fn, options = {}) {
  const { mod, restore, storePath } = loadFreshServerWithEnv(env, options);
  const srv = mod.app.listen(0);
  await new Promise((resolve) => srv.once("listening", resolve));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, { storePath });
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    restore();
  }
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function main() {
  await run("healthz returns ok", async () => {
    await withServer(
      { NODE_ENV: "development", INTERNAL_API_KEY: "k1", ETHERSCAN_API_KEY: "x" },
      async (base) => {
        const res = await fetch(`${base}/healthz`);
        const body = await readJson(res);
        assert.equal(res.status, 200);
        assert.equal(body.status, "ok");
      }
    );
  });

  await run("protected endpoint returns 401 without API key", async () => {
    await withServer(
      { NODE_ENV: "development", INTERNAL_API_KEY: "k1", ETHERSCAN_API_KEY: "x" },
      async (base) => {
        const res = await fetch(`${base}/zendesk/payment-ticket`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket_id: "t1", txid: "0x1" })
        });
        const body = await readJson(res);
        assert.equal(res.status, 401);
        assert.equal(body.status, "UNAUTHORIZED");
      }
    );
  });

  await run("protected endpoint returns 400 on missing fields with valid API key", async () => {
    await withServer(
      { NODE_ENV: "development", INTERNAL_API_KEY: "k1", ETHERSCAN_API_KEY: "x" },
      async (base) => {
        const res = await fetch(`${base}/zendesk/payment-ticket`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer FUNDINGPIPS123"
          },
          body: JSON.stringify({ ticket_id: "t1" })
        });
        const body = await readJson(res);
        assert.equal(res.status, 400);
        assert.equal(body.status, "ERROR");
        assert.equal(body.message, "Missing txid");
      }
    );
  });

  await run("confirmo-input rejects invalid network", async () => {
    await withServer(
      { NODE_ENV: "development", INTERNAL_API_KEY: "k1", ETHERSCAN_API_KEY: "x" },
      async (base) => {
        const res = await fetch(`${base}/zendesk/confirmo-input`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer FUNDINGPIPS123"
          },
          body: JSON.stringify({
            ticket_id: "t1",
            confirmo_invoice_id: "inv1",
            expected_network: "BadNet",
            expected_token: "USDT",
            expected_wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          })
        });
        const body = await readJson(res);
        assert.equal(res.status, 400);
        assert.equal(body.message, "Invalid expected network");
      }
    );
  });

  await run("simulate route is blocked in production", async () => {
    await withServer(
      { NODE_ENV: "production", INTERNAL_API_KEY: "k1", ETHERSCAN_API_KEY: "x" },
      async (base) => {
        const res = await fetch(`${base}/simulate-zendesk-ticket?ticket_id=t1&txid=0x1`);
        const body = await readJson(res);
        assert.equal(res.status, 404);
        assert.equal(body.status, "NOT_FOUND");
      }
    );
  });

  await run("debug-tickets requires API key in development", async () => {
    await withServer(
      { NODE_ENV: "development", INTERNAL_API_KEY: "k1", ETHERSCAN_API_KEY: "x" },
      async (base) => {
        const noKey = await fetch(`${base}/debug-tickets`);
        assert.equal(noKey.status, 401);

        const withKey = await fetch(`${base}/debug-tickets`, {
          headers: { authorization: "Bearer FUNDINGPIPS123" }
        });
        assert.equal(withKey.status, 200);
      }
    );
  });

  await run("payment-ticket replay is idempotent for same ticket_id + txid", async () => {
    const replayState = {
      replay1: {
        ticket_id: "replay1",
        txid: "0xabc123",
        resolver_status: "FOUND",
        match_status: "needs_confirmo_input",
        actual_network: "Ethereum",
        actual_token: "USDT"
      }
    };

    await withServer(
      { NODE_ENV: "development", INTERNAL_API_KEY: "k1", ETHERSCAN_API_KEY: "x" },
      async (base) => {
        const res = await fetch(`${base}/zendesk/payment-ticket`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer FUNDINGPIPS123"
          },
          body: JSON.stringify({ ticket_id: "replay1", txid: "0xabc123" })
        });
        const body = await readJson(res);
        assert.equal(res.status, 200);
        assert.equal(body.status, "PAYMENT_TICKET_REPLAY");
        assert.equal(body.idempotent, true);
      },
      { storeData: replayState }
    );
  });

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
