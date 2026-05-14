require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createZendeskClient } = require("./zendeskClient");
const {
  matchPayment,
  normalizeWalletForCompare,
  computeMatchDetails
} = require("./lib/paymentDecision");

// Force-disable proxy env so local broken proxy settings (e.g. 127.0.0.1:9)
// cannot hijack outbound blockchain API calls.
[
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "GLOBAL_AGENT_HTTP_PROXY"
].forEach((k) => {
  delete process.env[k];
});

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  const started = Date.now();
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  logEvent("info", "request_start", {
    request_id: requestId,
    method: req.method,
    path: req.path
  });
  res.on("finish", () => {
    logEvent("info", "request_end", {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: Date.now() - started
    });
  });
  next();
});

const APP_VERSION = "zendesk-post-v1";
const PORT = process.env.PORT || 3000;
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
const INTERNAL_API_KEY = String(process.env.INTERNAL_API_KEY || "");

const USDT_ETH_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC_ETH_CONTRACT = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT_BSC_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
const USDC_BSC_CONTRACT = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const USDT_POLYGON_CONTRACT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const USDC_POLYGON_CONTRACT = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDC_POLYGON_NATIVE_CONTRACT = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || ETHERSCAN_API_KEY;
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || ETHERSCAN_API_KEY;
const AXIOS_HTTP_OPTIONS = { proxy: false, timeout: 15000 };
const http = axios.create(AXIOS_HTTP_OPTIONS);
const RETRY_BASE_DELAY_MS = Number(process.env.HTTP_RETRY_BASE_DELAY_MS || 300);
const RETRY_MAX_ATTEMPTS = Number(process.env.HTTP_RETRY_MAX_ATTEMPTS || 3);
const EVM_RPC_URLS = {
  Ethereum: [
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com"
  ],
  BSC: ["https://bsc-dataseed.binance.org", "https://bsc-rpc.publicnode.com"],
  Polygon: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
  opBNB: ["https://opbnb-rpc.publicnode.com", "https://opbnb-mainnet-rpc.bnbchain.org"]
};
const SOLANA_RPC_URLS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoN3dV5fVYwSdhLkY6";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const TICKETS_STORE_PATH = path.join(__dirname, "data", "tickets-store.json");
const tickets = loadTicketsFromDisk();

const zendesk = createZendeskClient();

function nowIso() {
  return new Date().toISOString();
}

function logEvent(level, message, meta = {}) {
  const payload = {
    ts: nowIso(),
    level,
    message,
    ...meta
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryAxiosError(error) {
  const status = error && error.response ? Number(error.response.status) : 0;
  if (!status) return true; // network/dns/timeout
  return status === 429 || (status >= 500 && status <= 599);
}

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error && error.config ? error.config : null;
    if (!config) throw error;
    config.__retryCount = Number(config.__retryCount || 0);
    if (!shouldRetryAxiosError(error) || config.__retryCount >= RETRY_MAX_ATTEMPTS - 1) {
      throw error;
    }
    config.__retryCount += 1;
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, config.__retryCount - 1);
    await sleep(delay);
    return http.request(config);
  }
);

function ensureTicketsStoreDir() {
  const dir = path.dirname(TICKETS_STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadTicketsFromDisk() {
  try {
    if (!fs.existsSync(TICKETS_STORE_PATH)) {
      return {};
    }
    const raw = fs.readFileSync(TICKETS_STORE_PATH, "utf8");
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn(`[startup] Failed to read ticket store: ${error.message}`);
    return {};
  }
}

function persistTicketsToDisk() {
  try {
    ensureTicketsStoreDir();
    const tmpPath = `${TICKETS_STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(tickets, null, 2), "utf8");
    fs.renameSync(tmpPath, TICKETS_STORE_PATH);
  } catch (error) {
    console.error(`[storage] Failed to persist ticket store: ${error.message}`);
  }
}

function saveTicketState(ticketId, nextState) {
  tickets[ticketId] = nextState;
  persistTicketsToDisk();
  return tickets[ticketId];
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedNetworkName(network) {
  const allowed = new Set(["Ethereum", "BSC", "Polygon", "opBNB", "Tron", "Solana"]);
  return allowed.has(String(network || ""));
}

function requireInternalApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    return res.status(503).json({
      version: APP_VERSION,
      status: "MISCONFIGURED",
      message: "INTERNAL_API_KEY is not configured on server"
    });
  }

  const headerKey = req.get("x-api-key");
  const authHeader = req.get("authorization");
  const bearerKey =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
  const incomingKey = headerKey || bearerKey;

  if (!incomingKey || incomingKey !== INTERNAL_API_KEY) {
    return res.status(401).json({
      version: APP_VERSION,
      status: "UNAUTHORIZED",
      message: "Missing or invalid API key"
    });
  }

  return next();
}

function blockInProduction(req, res, next) {
  if (!IS_PRODUCTION) {
    return next();
  }

  return res.status(404).json({
    version: APP_VERSION,
    status: "NOT_FOUND",
    message: "Endpoint disabled in production"
  });
}

function validatePaymentTicketBody(req, res, next) {
  const ticketId = req.body && req.body.ticket_id;
  const txid = req.body && req.body.txid;

  if (!hasNonEmptyString(ticketId)) {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Missing ticket_id" });
  }
  if (!hasNonEmptyString(txid)) {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Missing txid" });
  }

  return next();
}

function validateConfirmoInputBody(req, res, next) {
  const ticketId = req.body && req.body.ticket_id;
  const confirmoInvoiceId = req.body && req.body.confirmo_invoice_id;
  const expectedWalletAddress = req.body && req.body.expected_wallet_address;
  const expectedAssetNetworkRaw =
    (req.body && (req.body.expected_asset_network || req.body.expected_payment_method || req.body.expected_asset)) ||
    "";
  const expectedNetworkRaw = (req.body && req.body.expected_network) || "";
  const expectedTokenRaw = (req.body && req.body.expected_token) || "";
  const parsed = parseExpectedAssetNetwork(expectedAssetNetworkRaw);
  const normalizedNetwork = normalizeExpectedNetworkName(expectedNetworkRaw || parsed.network);
  const normalizedToken = normalizeExpectedTokenName(expectedTokenRaw || parsed.token);

  if (!hasNonEmptyString(ticketId)) {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Missing ticket_id" });
  }
  if (!hasNonEmptyString(confirmoInvoiceId)) {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Missing confirmo_invoice_id" });
  }
  if (!hasNonEmptyString(expectedWalletAddress)) {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Missing expected_wallet_address" });
  }
  if (!normalizedToken || normalizedToken === "UNKNOWN") {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Invalid expected token" });
  }
  if (!isAllowedNetworkName(normalizedNetwork)) {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Invalid expected network" });
  }

  return next();
}

function validateWalletReplyBody(req, res, next) {
  const ticketId = req.body && req.body.ticket_id;
  const hasMessage = hasNonEmptyString(req.body && req.body.message);
  const hasRefundWallet = hasNonEmptyString(req.body && req.body.refund_wallet);

  if (!hasNonEmptyString(ticketId)) {
    return res.status(400).json({ version: APP_VERSION, status: "ERROR", message: "Missing ticket_id" });
  }
  if (!hasMessage && !hasRefundWallet) {
    return res.status(400).json({
      version: APP_VERSION,
      status: "ERROR",
      message: "Missing message or refund_wallet"
    });
  }

  return next();
}

function createTicketState(ticketId) {
  return {
    ticket_id: String(ticketId),
    txid: null,

    // Actual (from blockchain resolver)
    actual_network: null,
    actual_token: null,
    actual_amount: null,
    actual_amount_usd: null,
    token_standard: null,
    explorer_link: null,
    sender: null,
    receiver: null,
    resolver_status: null, // FOUND / NOT_FOUND

    // Expected (manual ops input from Confirmo)
    confirmo_invoice_id: null,
    expected_network: null,
    expected_token: null,
    expected_wallet_address: null,

    // Match result
    match_status: null, // payment_valid / wrong_network / wrong_asset / tx_not_found
    needs_wallet: false,

    // Wallet flow
    refund_wallet: null,
    wallet_ready_for_recovery: false,

    // Ops/Confirmo flow (manual v1)
    ops_approved: false,
    confirmo_ready: false,
    confirmo_recovery_payload: null,

    created_at: new Date().toISOString(),
    updated_at: null
  };
}

function upsertTicket(ticketId) {
  if (!tickets[ticketId]) {
    saveTicketState(ticketId, createTicketState(ticketId));
  }
  return tickets[ticketId];
}

function formatUnitsFromBase(valueLike, decimals) {
  try {
    if (valueLike === null || valueLike === undefined) return null;
    const raw = String(valueLike).trim();
    if (!raw) return null;
    const base = raw.startsWith("0x") || raw.startsWith("0X") ? BigInt(raw) : BigInt(raw.replace(/[^\d-]/g, ""));
    const scale = Number.isFinite(Number(decimals)) ? Number(decimals) : 0;
    if (!Number.isInteger(scale) || scale < 0) return base.toString();
    const neg = base < 0n;
    const abs = neg ? -base : base;
    const div = 10n ** BigInt(scale);
    const whole = abs / div;
    const frac = abs % div;
    if (frac === 0n) return `${neg ? "-" : ""}${whole.toString()}`;
    const fracStr = frac.toString().padStart(scale, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
  } catch (error) {
    return null;
  }
}

function extractAmountFromTransfer(transfer) {
  if (!transfer || typeof transfer !== "object") return null;
  const raw = transfer.value ?? transfer.amount ?? transfer.amount_str ?? transfer.quant ?? null;
  const decimals = transfer.tokenDecimal ?? transfer.token_decimals ?? transfer.decimals ?? 0;
  return formatUnitsFromBase(raw, decimals);
}

function pickBestTransferWithAmount(transfers) {
  if (!Array.isArray(transfers) || transfers.length === 0) return null;
  const withRecipient = transfers.filter((t) => pickTransferRecipient(t));
  const candidates = withRecipient.length ? withRecipient : transfers;
  const nonZero = candidates.find((t) => {
    const amt = extractAmountFromTransfer(t);
    return amt !== null && amt !== "0";
  });
  return nonZero || candidates[0];
}

function normalizeEthereumResult(txid, tx, tokenDetection) {
  if (!tx) {
    return {
      status: "NOT_FOUND",
      network: "Ethereum",
      token: null,
      token_standard: null,
      explorer_link: `https://etherscan.io/tx/${txid}`,
      from: null,
      to: null,
      amount: null
    };
  }

  return {
    status: "FOUND",
    network: "Ethereum",
    token: tokenDetection?.token || "UNKNOWN",
    token_standard: tokenDetection?.token_standard || "UNKNOWN",
    explorer_link: `https://etherscan.io/tx/${txid}`,
    from: tx.from || null,
    to: tokenDetection?.to || tx.to || null,
    amount: tokenDetection?.amount || formatUnitsFromBase(tx.value, 18)
  };
}

function normalizeEvmTokenSymbol(network, tokenSymbol, contractAddress) {
  const symbol = tokenSymbol ? String(tokenSymbol).toUpperCase() : "";
  const contract = contractAddress ? String(contractAddress).toLowerCase() : "";

  if (symbol === "USDT" || symbol === "USDTS") return "USDT";
  if (symbol === "USDC" || symbol === "USDC.E") return "USDC";

  if (network === "BSC") {
    if (contract === USDT_BSC_CONTRACT) return "USDT";
    if (contract === USDC_BSC_CONTRACT) return "USDC";
  }

  if (network === "Polygon") {
    if (contract === USDT_POLYGON_CONTRACT) return "USDT";
    if (contract === USDC_POLYGON_CONTRACT) return "USDC";
    if (contract === USDC_POLYGON_NATIVE_CONTRACT) return "USDC";
  }

  return symbol || "UNKNOWN";
}

function getKnownEvmTokenByContract(network, contractAddress) {
  const contract = contractAddress ? String(contractAddress).toLowerCase() : "";

  if (network === "BSC") {
    if (contract === USDT_BSC_CONTRACT) return "USDT";
    if (contract === USDC_BSC_CONTRACT) return "USDC";
  }

  if (network === "Polygon") {
    if (contract === USDT_POLYGON_CONTRACT) return "USDT";
    if (contract === USDC_POLYGON_CONTRACT) return "USDC";
  }

  return null;
}

function decodeTopicAddress(topicValue) {
  const clean = String(topicValue || "").toLowerCase().replace(/^0x/, "");
  if (clean.length < 40) return null;
  return `0x${clean.slice(-40)}`;
}

function pickTransferRecipient(transfer) {
  if (!transfer || typeof transfer !== "object") return null;
  return (
    transfer.to ||
    transfer.toAddress ||
    transfer.to_address ||
    transfer.receiver ||
    transfer.recipient ||
    (transfer.transferToAddressList && transfer.transferToAddressList[0]) ||
    null
  );
}

async function detectEvmTransferRecipientFromReceipt({ chainId, network, txid }) {
  let receipt = await fetchEvmTransactionReceiptFromEtherscanV2({
    chainId,
    apiKey: ETHERSCAN_API_KEY,
    txid
  });
  if (!receipt) {
    receipt = await fetchEvmReceiptFromRpc({ network, txid });
  }
  if (!receipt || !Array.isArray(receipt.logs)) {
    return null;
  }
  const transferLog = receipt.logs.find((log) => {
    if (!log || !Array.isArray(log.topics) || !log.topics[0]) {
      return false;
    }
    return String(log.topics[0]).toLowerCase() === ERC20_TRANSFER_TOPIC;
  });
  if (!transferLog || !Array.isArray(transferLog.topics) || !transferLog.topics[2]) {
    return null;
  }
  return decodeTopicAddress(transferLog.topics[2]);
}

async function fetchErc20TransfersFromEtherscan(txid) {
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&txhash=${txid}&apikey=${ETHERSCAN_API_KEY}`;
  let response;
  try {
    response = await http.get(url, AXIOS_HTTP_OPTIONS);
  } catch (error) {
    return [];
  }

  if (
    response.data &&
    response.data.status === "1" &&
    Array.isArray(response.data.result)
  ) {
    return response.data.result;
  }

  return [];
}

async function fetchTokenTransfersFromScanApi({ baseUrl, apiKey, txid }) {
  if (!baseUrl || !apiKey) {
    return [];
  }

  const url = `${baseUrl}?module=account&action=tokentx&txhash=${txid}&apikey=${apiKey}`;
  let response;
  try {
    response = await http.get(url, AXIOS_HTTP_OPTIONS);
  } catch (error) {
    return [];
  }

  if (response.data && response.data.status === "1" && Array.isArray(response.data.result)) {
    return response.data.result;
  }

  return [];
}

async function fetchTokenTransfersFromEtherscanV2({ chainId, apiKey, txid }) {
  if (!chainId || !apiKey) {
    return [];
  }

  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&txhash=${txid}&apikey=${apiKey}`;
  let response;
  try {
    response = await http.get(url, AXIOS_HTTP_OPTIONS);
  } catch (error) {
    return [];
  }

  if (response.data && response.data.status === "1" && Array.isArray(response.data.result)) {
    return response.data.result;
  }

  return [];
}

async function fetchEvmTransactionFromEtherscanV2({ chainId, apiKey, txid }) {
  if (!chainId || !apiKey) {
    return null;
  }

  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${apiKey}`;
  let response;
  try {
    response = await http.get(url, AXIOS_HTTP_OPTIONS);
  } catch (error) {
    return null;
  }
  return response.data && typeof response.data.result === "object" ? response.data.result : null;
}

async function fetchEvmTransactionReceiptFromEtherscanV2({ chainId, apiKey, txid }) {
  if (!chainId || !apiKey) {
    return null;
  }

  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=eth_getTransactionReceipt&txhash=${txid}&apikey=${apiKey}`;
  let response;
  try {
    response = await http.get(url, AXIOS_HTTP_OPTIONS);
  } catch (error) {
    return null;
  }
  return response.data && typeof response.data.result === "object" ? response.data.result : null;
}

async function callJsonRpc(rpcUrl, method, params) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  };
  const response = await http.post(rpcUrl, body, AXIOS_HTTP_OPTIONS);
  if (response.data && response.data.error) {
    return null;
  }
  return response.data ? response.data.result : null;
}

async function fetchEvmTransactionFromRpc({ network, txid }) {
  const urls = EVM_RPC_URLS[network] || [];
  for (const rpcUrl of urls) {
    try {
      const tx = await callJsonRpc(rpcUrl, "eth_getTransactionByHash", [txid]);
      if (tx && typeof tx === "object") {
        return tx;
      }
    } catch (error) {
      // try next endpoint
    }
  }
  return null;
}

async function fetchEvmReceiptFromRpc({ network, txid }) {
  const urls = EVM_RPC_URLS[network] || [];
  for (const rpcUrl of urls) {
    try {
      const receipt = await callJsonRpc(rpcUrl, "eth_getTransactionReceipt", [txid]);
      if (receipt && typeof receipt === "object") {
        return receipt;
      }
    } catch (error) {
      // try next endpoint
    }
  }
  return null;
}

async function callSolanaRpc(rpcUrl, method, params) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  };
  const response = await http.post(rpcUrl, body, AXIOS_HTTP_OPTIONS);
  if (response.data && response.data.error) {
    return null;
  }
  return response.data ? response.data.result : null;
}

async function fetchSolanaTransactionFromRpc(txid) {
  const paramVariants = [
    { encoding: "jsonParsed", commitment: "confirmed" },
    { encoding: "jsonParsed", commitment: "finalized" },
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }
  ];

  for (const rpcUrl of SOLANA_RPC_URLS) {
    for (const opts of paramVariants) {
      try {
        const tx = await callSolanaRpc(rpcUrl, "getTransaction", [txid, opts]);
        if (tx && typeof tx === "object") {
          return tx;
        }
      } catch (error) {
        // try next variant/endpoint
      }
    }
  }
  return null;
}

function detectSolanaToken(tx) {
  const meta = tx && tx.meta ? tx.meta : null;
  const pre = Array.isArray(meta && meta.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta && meta.postTokenBalances) ? meta.postTokenBalances : [];
  const allBalances = pre.concat(post);
  const mintSet = new Set(allBalances.map((b) => String((b && b.mint) || "")));

  function pickLargestDeltaForMint(mint) {
    const byAccount = new Map();
    for (const b of pre) {
      if (!b || String(b.mint || "") !== mint) continue;
      const key = String(b.accountIndex ?? `${b.owner || ""}:${b.mint || ""}`);
      byAccount.set(key, {
        pre: Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount ? b.uiTokenAmount.uiAmount : 0),
        post: 0
      });
    }
    for (const b of post) {
      if (!b || String(b.mint || "") !== mint) continue;
      const key = String(b.accountIndex ?? `${b.owner || ""}:${b.mint || ""}`);
      const row = byAccount.get(key) || { pre: 0, post: 0 };
      row.post = Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount ? b.uiTokenAmount.uiAmount : 0);
      byAccount.set(key, row);
    }
    let best = 0;
    for (const row of byAccount.values()) {
      const delta = Math.abs((row.post || 0) - (row.pre || 0));
      if (delta > best) best = delta;
    }
    return best > 0 ? String(best) : null;
  }

  if (mintSet.has(SOLANA_USDT_MINT)) {
    return { token: "USDT", token_standard: "SPL", amount: pickLargestDeltaForMint(SOLANA_USDT_MINT) };
  }
  if (mintSet.has(SOLANA_USDC_MINT)) {
    return { token: "USDC", token_standard: "SPL", amount: pickLargestDeltaForMint(SOLANA_USDC_MINT) };
  }

  const message = tx && tx.transaction && tx.transaction.message ? tx.transaction.message : null;
  const instructions = Array.isArray(message && message.instructions) ? message.instructions : [];
  for (const ix of instructions) {
    const parsed = ix && ix.parsed ? ix.parsed : null;
    const info = parsed && parsed.info ? parsed.info : null;
    const lamports = Number(info && info.lamports ? info.lamports : 0);
    if (ix.program === "system" && parsed && parsed.type === "transfer" && lamports > 0) {
      return { token: "SOL", token_standard: "NATIVE", amount: formatUnitsFromBase(String(lamports), 9) };
    }
  }

  return { token: "UNKNOWN", token_standard: "UNKNOWN", amount: null };
}

function toNumberAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return null;
  return value.toFixed(2);
}

async function fetchUsdPriceForToken(network, token) {
  const t = String(token || "").toUpperCase();
  const n = String(network || "");
  if (t === "USDT" || t === "USDC") {
    return 1;
  }

  const coinIdMap = {
    ETH: "ethereum",
    BNB: "binancecoin",
    MATIC: "matic-network",
    SOL: "solana",
    TRX: "tron"
  };
  const id = coinIdMap[t];
  const symbolMap = {
    ETH: "ETH",
    BNB: "BNB",
    MATIC: "MATIC",
    SOL: "SOL",
    TRX: "TRX"
  };
  const symbol = symbolMap[t];
  if (!id && !symbol) return null;

  // Source 1: CoinGecko
  if (id) {
    const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    try {
      const response = await http.get(cgUrl, AXIOS_HTTP_OPTIONS);
      const usd = response.data && response.data[id] ? Number(response.data[id].usd) : null;
      if (Number.isFinite(usd) && usd > 0) return usd;
    } catch (error) {
      // fallback below
    }
  }

  // Source 2: CryptoCompare
  if (symbol) {
    const ccUrl = `https://min-api.cryptocompare.com/data/price?fsym=${symbol}&tsyms=USD`;
    try {
      const response = await http.get(ccUrl, AXIOS_HTTP_OPTIONS);
      const usd = response.data ? Number(response.data.USD) : null;
      if (Number.isFinite(usd) && usd > 0) return usd;
    } catch (error) {
      // fallback below
    }
  }

  // Source 3: Binance ticker (USDT proxy for USD)
  if (symbol) {
    const pair = `${symbol}USDT`;
    const binanceUrl = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
    try {
      const response = await http.get(binanceUrl, AXIOS_HTTP_OPTIONS);
      const usd = response.data ? Number(response.data.price) : null;
      if (Number.isFinite(usd) && usd > 0) return usd;
    } catch (error) {
      // no more fallbacks
    }
  }

  return null;
}

async function computeAmountUsd({ network, token, amount }) {
  const amt = toNumberAmount(amount);
  if (!Number.isFinite(amt)) return null;
  const px = await fetchUsdPriceForToken(network, token);
  if (!Number.isFinite(px)) return null;
  return formatUsd(amt * px);
}

function getKnownTokenDecimalsByContract(network, contractAddress) {
  const contract = String(contractAddress || "").toLowerCase();
  if (network === "Ethereum") {
    if (contract === USDT_ETH_CONTRACT.toLowerCase()) return 6;
    if (contract === USDC_ETH_CONTRACT.toLowerCase()) return 6;
  }
  if (network === "BSC") {
    if (contract === USDT_BSC_CONTRACT) return 18;
    if (contract === USDC_BSC_CONTRACT) return 18;
  }
  if (network === "Polygon") {
    if (contract === USDT_POLYGON_CONTRACT) return 6;
    if (contract === USDC_POLYGON_CONTRACT) return 6;
    if (contract === USDC_POLYGON_NATIVE_CONTRACT) return 6;
  }
  return null;
}

function extractAmountFromTransferLog(network, transferLog) {
  if (!transferLog || typeof transferLog !== "object") return null;
  const decimals = getKnownTokenDecimalsByContract(network, transferLog.address);
  if (decimals === null) return null;
  return formatUnitsFromBase(transferLog.data, decimals);
}

function getSolanaFromTo(tx) {
  const message = tx && tx.transaction && tx.transaction.message ? tx.transaction.message : null;
  const instructions = Array.isArray(message && message.instructions) ? message.instructions : [];
  for (const ix of instructions) {
    const parsed = ix && ix.parsed ? ix.parsed : null;
    const info = parsed && parsed.info ? parsed.info : null;
    if (!info) {
      continue;
    }
    const from = info.source || info.authority || info.owner || info.signer || null;
    const to = info.destination || info.account || null;
    if (from || to) {
      return { from, to };
    }
  }

  // Fallback for SPL / parsed-missing variants: infer owners from token balances.
  const meta = tx && tx.meta ? tx.meta : null;
  const pre = Array.isArray(meta && meta.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta && meta.postTokenBalances) ? meta.postTokenBalances : [];
  const preOwner = pre.find((b) => b && b.owner && String(b.owner).trim())?.owner || null;
  const postOwner = post.find((b) => b && b.owner && String(b.owner).trim())?.owner || null;
  if (preOwner || postOwner) {
    return { from: preOwner, to: postOwner };
  }

  // Native fallback: pick first signer as from and first non-signer key as to.
  const keys = Array.isArray(message && message.accountKeys) ? message.accountKeys : [];
  if (keys.length) {
    const mapped = keys.map((k) => {
      if (typeof k === "string") {
        return { pubkey: k, signer: false };
      }
      return {
        pubkey: k && (k.pubkey || k.address || null),
        signer: Boolean(k && (k.signer || k.isSigner))
      };
    });
    const from = mapped.find((k) => k.signer && k.pubkey)?.pubkey || null;
    const to = mapped.find((k) => !k.signer && k.pubkey)?.pubkey || null;
    if (from || to) {
      return { from, to };
    }
  }

  return { from: null, to: null };
}

async function fetchErc20SymbolFromRpc({ network, contractAddress }) {
  const urls = EVM_RPC_URLS[network] || [];
  for (const rpcUrl of urls) {
    try {
      const result = await callJsonRpc(rpcUrl, "eth_call", [
        { to: contractAddress, data: "0x95d89b41" },
        "latest"
      ]);
      const symbol = decodeSolidityStringReturn(result);
      if (symbol) {
        return symbol.toUpperCase();
      }
    } catch (error) {
      // try next endpoint
    }
  }
  return null;
}

function decodeHexToUtf8(hex) {
  if (!hex || hex === "0x") return "";
  const clean = String(hex).replace(/^0x/, "");
  if (!clean) return "";
  const bytes = Buffer.from(clean, "hex");
  return bytes.toString("utf8").replace(/\u0000/g, "").trim();
}

function decodeSolidityStringReturn(hex) {
  if (!hex || hex === "0x") return "";
  const clean = String(hex).replace(/^0x/, "");
  if (!clean) return "";

  // bytes32-style return (common non-standard symbol implementations)
  if (clean.length === 64) {
    return decodeHexToUtf8(clean);
  }

  // dynamic string ABI encoding:
  // 0x + 32 bytes offset + 32 bytes length + N bytes data
  if (clean.length >= 192) {
    const lengthHex = clean.slice(64, 128);
    const length = parseInt(lengthHex, 16);
    if (!Number.isNaN(length) && length > 0) {
      const dataHex = clean.slice(128, 128 + length * 2);
      return decodeHexToUtf8(dataHex);
    }
  }

  return "";
}

async function fetchErc20SymbolFromContract({ chainId, contractAddress }) {
  if (!chainId || !contractAddress || !ETHERSCAN_API_KEY) {
    return null;
  }

  // symbol() selector: 0x95d89b41
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}` +
    `&module=proxy&action=eth_call&to=${contractAddress}&data=0x95d89b41&tag=latest&apikey=${ETHERSCAN_API_KEY}`;

  try {
    const response = await http.get(url, AXIOS_HTTP_OPTIONS);
    const raw = response.data && typeof response.data.result === "string" ? response.data.result : "";
    const symbol = decodeSolidityStringReturn(raw);
    return symbol ? symbol.toUpperCase() : null;
  } catch (error) {
    return null;
  }
}

async function detectEvmTokenFromReceipt({ chainId, network, txid }) {
  let receipt = await fetchEvmTransactionReceiptFromEtherscanV2({
    chainId,
    apiKey: ETHERSCAN_API_KEY,
    txid
  });
  if (!receipt) {
    receipt = await fetchEvmReceiptFromRpc({ network, txid });
  }

  if (!receipt || !Array.isArray(receipt.logs)) {
    return null;
  }

  const transferLog = receipt.logs.find((log) => {
    if (!log || !Array.isArray(log.topics) || !log.topics[0]) {
      return false;
    }
    return String(log.topics[0]).toLowerCase() === ERC20_TRANSFER_TOPIC;
  });

  if (!transferLog || !transferLog.address) {
    return null;
  }
  const transferRecipient = decodeTopicAddress(transferLog.topics[2]) || null;

  const token = getKnownEvmTokenByContract(network, transferLog.address);
  let contractSymbol = token || (await fetchErc20SymbolFromContract({
    chainId,
    contractAddress: transferLog.address
  }));
  if (!contractSymbol) {
    contractSymbol = await fetchErc20SymbolFromRpc({
      network,
      contractAddress: transferLog.address
    });
  }

  if (!contractSymbol) {
    return {
      token: "UNKNOWN",
      token_standard: network === "BSC" ? "BEP20" : "ERC20",
      to: transferRecipient,
      amount: extractAmountFromTransferLog(network, transferLog)
    };
  }

  return {
    token: contractSymbol,
    token_standard: network === "BSC" ? "BEP20" : "ERC20",
    to: transferRecipient,
    amount: extractAmountFromTransferLog(network, transferLog)
  };
}

async function detectEthereumTokenSimple(txid, tx) {
  if (!txid || !tx) {
    return {
      token: "UNKNOWN",
      token_standard: "UNKNOWN"
    };
  }

  // Simple safe version:
  // - Fast fallback: if tx.to is the USDT contract -> USDT (ERC20)
  // - If Etherscan reports any ERC20 transfer in this tx -> use the token symbol (ERC20)
  // - Else if native value > 0 -> ETH (native)
  // - Else -> UNKNOWN (could be contract interaction)
  if (tx.to && String(tx.to).toLowerCase() === USDT_ETH_CONTRACT.toLowerCase()) {
    const directTransfers = await fetchErc20TransfersFromEtherscan(txid);
    const directTransfer = pickBestTransferWithAmount(directTransfers);
    const tokenFromReceipt = await detectEvmTokenFromReceipt({
      chainId: 1,
      network: "Ethereum",
      txid
    });
    return {
      token: "USDT",
      token_standard: "ERC20",
      to: (tokenFromReceipt && tokenFromReceipt.to) || tx.to || null,
      amount:
        extractAmountFromTransfer(directTransfer) ||
        (tokenFromReceipt && tokenFromReceipt.amount) ||
        null
    };
  }

  const erc20Transfers = await fetchErc20TransfersFromEtherscan(txid);
  const firstTransfer = pickBestTransferWithAmount(erc20Transfers);

  if (firstTransfer && firstTransfer.tokenSymbol) {
    return {
      token: String(firstTransfer.tokenSymbol).toUpperCase(),
      token_standard: "ERC20",
      to: pickTransferRecipient(firstTransfer) || tx.to || null,
      amount: extractAmountFromTransfer(firstTransfer)
    };
  }

  const tokenFromReceipt = await detectEvmTokenFromReceipt({
    chainId: 1,
    network: "Ethereum",
    txid
  });
  if (tokenFromReceipt) {
    return tokenFromReceipt;
  }

  if (tx.value && tx.value !== "0x0" && tx.value !== "0") {
    return {
      token: "ETH",
      token_standard: "NATIVE",
      amount: formatUnitsFromBase(tx.value, 18)
    };
  }

  return {
    token: "UNKNOWN",
    token_standard: "UNKNOWN"
  };
}

async function resolveEthereum(txid) {
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${ETHERSCAN_API_KEY}`;
  let tx = null;
  try {
    const response = await http.get(url, AXIOS_HTTP_OPTIONS);
    tx =
      response.data && typeof response.data.result === "object" ? response.data.result : null;
  } catch (error) {
    tx = null;
  }
  if (!tx) {
    tx = await fetchEvmTransactionFromRpc({ network: "Ethereum", txid });
  }

  if (tx) {
    const tokenDetection = await detectEthereumTokenSimple(txid, tx);
    const receiptRecipient = await detectEvmTransferRecipientFromReceipt({
      chainId: 1,
      network: "Ethereum",
      txid
    });
    const normalized = normalizeEthereumResult(txid, tx, tokenDetection);
    normalized.to = receiptRecipient || normalized.to;
    return normalized;
  }

  return normalizeEthereumResult(txid, null, null);
}

async function resolveBsc(txid) {
  // Prefer Etherscan V2 multi-chain API for single-key setups.
  let tx = await fetchEvmTransactionFromEtherscanV2({
    chainId: 56,
    apiKey: ETHERSCAN_API_KEY,
    txid
  });
  let transfers = tx
    ? await fetchTokenTransfersFromEtherscanV2({
        chainId: 56,
        apiKey: ETHERSCAN_API_KEY,
        txid
      })
    : [];

  // Fallback to BscScan endpoint if needed.
  if (!tx) {
    const url = `https://api.bscscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${BSCSCAN_API_KEY}`;
    try {
      const response = await http.get(url, AXIOS_HTTP_OPTIONS);
      tx = response.data && typeof response.data.result === "object" ? response.data.result : null;
    } catch (error) {
      tx = null;
    }

    if (tx) {
      transfers = await fetchTokenTransfersFromScanApi({
        baseUrl: "https://api.bscscan.com/api",
        apiKey: BSCSCAN_API_KEY,
        txid
      });
    }
  }
  if (!tx) {
    tx = await fetchEvmTransactionFromRpc({ network: "BSC", txid });
  }

  if (tx) {
    const firstTransfer = pickBestTransferWithAmount(transfers);
    if (firstTransfer && firstTransfer.tokenSymbol) {
      const normalized = normalizeEvmTokenSymbol(
        "BSC",
        firstTransfer.tokenSymbol,
        firstTransfer.contractAddress
      );
      if (normalized !== "UNKNOWN") {
        return {
          status: "FOUND",
          network: "BSC",
          token: normalized,
          token_standard: "BEP20",
          explorer_link: `https://bscscan.com/tx/${txid}`,
          from: tx.from || null,
          to: pickTransferRecipient(firstTransfer) || tx.to || null,
          amount: extractAmountFromTransfer(firstTransfer)
        };
      }
    }

    const tokenFromReceipt = await detectEvmTokenFromReceipt({
      chainId: 56,
      network: "BSC",
      txid
    });
    if (tokenFromReceipt) {
      return {
        status: "FOUND",
        network: "BSC",
        token: tokenFromReceipt.token,
        token_standard: tokenFromReceipt.token_standard,
        explorer_link: `https://bscscan.com/tx/${txid}`,
        from: tx.from || null,
        to: tokenFromReceipt.to || tx.to || null,
        amount: formatUnitsFromBase(tx.value, 18)
      };
    }

    const tokenFromTxTo = getKnownEvmTokenByContract("BSC", tx.to);
    if (tokenFromTxTo) {
      return {
        status: "FOUND",
        network: "BSC",
        token: tokenFromTxTo,
        token_standard: "BEP20",
        explorer_link: `https://bscscan.com/tx/${txid}`,
        from: tx.from || null,
        to: tx.to || null,
        amount: formatUnitsFromBase(tx.value, 18)
      };
    }

    const isNative = tx.value && tx.value !== "0x0" && tx.value !== "0";
    return {
      status: "FOUND",
      network: "BSC",
      token: isNative ? "BNB" : "UNKNOWN",
      token_standard: isNative ? "NATIVE" : "UNKNOWN",
      explorer_link: `https://bscscan.com/tx/${txid}`,
      from: tx.from || null,
      to: tx.to || null,
      amount: formatUnitsFromBase(tx.value, 18)
    };
  }

  return {
    status: "NOT_FOUND",
    network: "BSC",
    token: null,
    token_standard: null,
    explorer_link: `https://bscscan.com/tx/${txid}`,
    from: null,
    to: null,
    amount: null
  };
}

async function resolvePolygon(txid) {
  // Prefer Etherscan V2 multi-chain API for single-key setups.
  let tx = await fetchEvmTransactionFromEtherscanV2({
    chainId: 137,
    apiKey: ETHERSCAN_API_KEY,
    txid
  });
  let transfers = tx
    ? await fetchTokenTransfersFromEtherscanV2({
        chainId: 137,
        apiKey: ETHERSCAN_API_KEY,
        txid
      })
    : [];

  // Fallback to PolygonScan endpoint if needed.
  if (!tx) {
    const url = `https://api.polygonscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${POLYGONSCAN_API_KEY}`;
    try {
      const response = await http.get(url, AXIOS_HTTP_OPTIONS);
      tx = response.data && typeof response.data.result === "object" ? response.data.result : null;
    } catch (error) {
      tx = null;
    }

    if (tx) {
      transfers = await fetchTokenTransfersFromScanApi({
        baseUrl: "https://api.polygonscan.com/api",
        apiKey: POLYGONSCAN_API_KEY,
        txid
      });
    }
  }
  if (!tx) {
    tx = await fetchEvmTransactionFromRpc({ network: "Polygon", txid });
  }

  if (tx) {
    const firstTransfer = pickBestTransferWithAmount(transfers);
    if (firstTransfer && firstTransfer.tokenSymbol) {
      const normalized = normalizeEvmTokenSymbol(
        "Polygon",
        firstTransfer.tokenSymbol,
        firstTransfer.contractAddress
      );
      if (normalized !== "UNKNOWN") {
        return {
          status: "FOUND",
          network: "Polygon",
          token: normalized,
          token_standard: "ERC20",
          explorer_link: `https://polygonscan.com/tx/${txid}`,
          from: tx.from || null,
          to: pickTransferRecipient(firstTransfer) || tx.to || null,
          amount: extractAmountFromTransfer(firstTransfer)
        };
      }
    }

    const tokenFromReceipt = await detectEvmTokenFromReceipt({
      chainId: 137,
      network: "Polygon",
      txid
    });
    if (tokenFromReceipt) {
      return {
        status: "FOUND",
        network: "Polygon",
        token: tokenFromReceipt.token,
        token_standard: tokenFromReceipt.token_standard,
        explorer_link: `https://polygonscan.com/tx/${txid}`,
        from: tx.from || null,
        to: tokenFromReceipt.to || tx.to || null,
        amount: formatUnitsFromBase(tx.value, 18)
      };
    }

    const tokenFromTxTo = getKnownEvmTokenByContract("Polygon", tx.to);
    if (tokenFromTxTo) {
      return {
        status: "FOUND",
        network: "Polygon",
        token: tokenFromTxTo,
        token_standard: "ERC20",
        explorer_link: `https://polygonscan.com/tx/${txid}`,
        from: tx.from || null,
        to: tx.to || null,
        amount: formatUnitsFromBase(tx.value, 18)
      };
    }

    const isNative = tx.value && tx.value !== "0x0" && tx.value !== "0";
    return {
      status: "FOUND",
      network: "Polygon",
      token: "MATIC",
      token_standard: "NATIVE",
      explorer_link: `https://polygonscan.com/tx/${txid}`,
      from: tx.from || null,
      to: tx.to || null,
      amount: formatUnitsFromBase(tx.value, 18)
    };
  }

  return {
    status: "NOT_FOUND",
    network: "Polygon",
    token: null,
    token_standard: null,
    explorer_link: `https://polygonscan.com/tx/${txid}`,
    from: null,
    to: null,
    amount: null
  };
}

async function resolveTron(txid) {
  const url = `https://apilist.tronscanapi.com/api/transaction-info?hash=${txid}`;
  let data = null;
  try {
    const response = await http.get(url, AXIOS_HTTP_OPTIONS);
    data = response.data && typeof response.data === "object" ? response.data : null;
  } catch (error) {
    data = null;
  }

  if (data && (data.hash || data.transactionHash || data.id)) {
    const trc20Transfers = Array.isArray(data.trc20TransferInfo) ? data.trc20TransferInfo : [];
    const firstTransfer = pickBestTransferWithAmount(trc20Transfers);

    if (firstTransfer) {
      const tokenSymbol =
        firstTransfer.symbol ||
        (firstTransfer.tokenInfo && firstTransfer.tokenInfo.tokenAbbr) ||
        "UNKNOWN";

      return {
        status: "FOUND",
        network: "Tron",
        token: String(tokenSymbol).toUpperCase(),
        token_standard: "TRC20",
        explorer_link: `https://tronscan.org/#/transaction/${txid}`,
        from: data.ownerAddress || null,
        to: pickTransferRecipient(firstTransfer) || data.toAddress || null,
        amount: extractAmountFromTransfer(firstTransfer)
      };
    }

    const contractType = String(data.contractType || "");
    const amount = Number(data.amount || 0);
    const isNative = contractType === "TransferContract" && amount > 0;

    return {
      status: "FOUND",
      network: "Tron",
      token: isNative ? "TRX" : "UNKNOWN",
      token_standard: isNative ? "NATIVE" : "UNKNOWN",
      explorer_link: `https://tronscan.org/#/transaction/${txid}`,
      from: data.ownerAddress || null,
      to: data.toAddress || null,
      amount: isNative ? formatUnitsFromBase(data.amount, 6) : null
    };
  }

  return {
    status: "NOT_FOUND",
    network: "Tron",
    token: null,
    token_standard: null,
    explorer_link: `https://tronscan.org/#/transaction/${txid}`,
    from: null,
    to: null,
    amount: null
  };
}

async function resolveSolana(txid) {
  const tx = await fetchSolanaTransactionFromRpc(txid);
  if (!tx) {
    return {
      status: "NOT_FOUND",
      network: "Solana",
      token: null,
      token_standard: null,
      explorer_link: `https://solscan.io/tx/${txid}`,
      from: null,
      to: null,
      amount: null
    };
  }

  const tokenDetection = detectSolanaToken(tx);
  const participants = getSolanaFromTo(tx);
  return {
    status: "FOUND",
    network: "Solana",
    token: tokenDetection.token,
    token_standard: tokenDetection.token_standard,
    explorer_link: `https://solscan.io/tx/${txid}`,
    from: participants.from,
    to: participants.to,
    amount: tokenDetection.amount || null
  };
}

async function resolveOpbnb(txid) {
  let tx = await fetchEvmTransactionFromEtherscanV2({
    chainId: 204,
    apiKey: ETHERSCAN_API_KEY,
    txid
  });
  let transfers = tx
    ? await fetchTokenTransfersFromEtherscanV2({
        chainId: 204,
        apiKey: ETHERSCAN_API_KEY,
        txid
      })
    : [];

  if (!tx) {
    tx = await fetchEvmTransactionFromRpc({ network: "opBNB", txid });
  }

  if (tx) {
    const firstTransfer = pickBestTransferWithAmount(transfers);
    if (firstTransfer && firstTransfer.tokenSymbol) {
      return {
        status: "FOUND",
        network: "opBNB",
        token: String(firstTransfer.tokenSymbol).toUpperCase(),
        token_standard: "BEP20",
        explorer_link: `https://opbnbscan.com/tx/${txid}`,
        from: tx.from || null,
        to: pickTransferRecipient(firstTransfer) || tx.to || null,
        amount: extractAmountFromTransfer(firstTransfer)
      };
    }

    const tokenFromReceipt = await detectEvmTokenFromReceipt({
      chainId: 204,
      network: "opBNB",
      txid
    });
    if (tokenFromReceipt) {
      return {
        status: "FOUND",
        network: "opBNB",
        token: tokenFromReceipt.token,
        token_standard: tokenFromReceipt.token_standard,
        explorer_link: `https://opbnbscan.com/tx/${txid}`,
        from: tx.from || null,
        to: tokenFromReceipt.to || tx.to || null,
        amount: formatUnitsFromBase(tx.value, 18)
      };
    }

    const isNative = tx.value && tx.value !== "0x0" && tx.value !== "0";
    return {
      status: "FOUND",
      network: "opBNB",
      token: isNative ? "BNB" : "UNKNOWN",
      token_standard: isNative ? "NATIVE" : "UNKNOWN",
      explorer_link: `https://opbnbscan.com/tx/${txid}`,
      from: tx.from || null,
      to: tx.to || null,
      amount: formatUnitsFromBase(tx.value, 18)
    };
  }

  return {
    status: "NOT_FOUND",
    network: "opBNB",
    token: null,
    token_standard: null,
    explorer_link: `https://opbnbscan.com/tx/${txid}`,
    from: null,
    to: null,
    amount: null
  };
}

async function resolveTransaction(txid) {
  // Check supported chains in priority order and stop on first match.
  const eth = await resolveEthereum(txid);
  if (eth.status === "FOUND") return eth;

  const bsc = await resolveBsc(txid);
  if (bsc.status === "FOUND") return bsc;

  const polygon = await resolvePolygon(txid);
  if (polygon.status === "FOUND") return polygon;

  const opbnb = await resolveOpbnb(txid);
  if (opbnb.status === "FOUND") return opbnb;

  const solana = await resolveSolana(txid);
  if (solana.status === "FOUND") return solana;

  const tron = await resolveTron(txid);
  if (tron.status === "FOUND") return tron;

  return eth; // default to Ethereum NOT_FOUND shape
}

function normalizeExpectedNetworkName(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "eth" || v === "ethereum") return "Ethereum";
  if (v === "opbnb" || v === "op bnb") return "opBNB";
  if (v === "bsc" || v === "binance smart chain" || v === "bnb smart chain") return "BSC";
  if (v === "polygon" || v === "matic") return "Polygon";
  if (v === "tron" || v === "trx") return "Tron";
  if (v === "sol" || v === "solana") return "Solana";
  return String(value || "").trim();
}

function normalizeExpectedTokenName(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "ether" || v === "eth") return "ETH";
  if (v === "sol") return "SOL";
  if (v === "trx") return "TRX";
  if (v === "matic") return "MATIC";
  return String(value || "").trim().toUpperCase();
}

function parseExpectedAssetNetwork(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { token: null, network: null };
  }

  const tokenAliases = [
    { re: /\busdt\b/i, token: "USDT" },
    { re: /\busdc\b/i, token: "USDC" },
    { re: /\beth(?:er)?\b/i, token: "ETH" },
    { re: /\bsol\b/i, token: "SOL" },
    { re: /\btrx\b/i, token: "TRX" },
    { re: /\bbnb\b/i, token: "BNB" },
    { re: /\bmatic\b/i, token: "MATIC" }
  ];
  const networkAliases = [
    { re: /\beth(?:ereum)?\b/i, network: "Ethereum" },
    { re: /\bopbnb\b|\bop bnb\b/i, network: "opBNB" },
    { re: /\bbsc\b|\bbinance smart chain\b|\bbnb smart chain\b/i, network: "BSC" },
    { re: /\bpolygon\b|\bmatic\b/i, network: "Polygon" },
    { re: /\btron\b|\btrx\b/i, network: "Tron" },
    { re: /\bsolana\b|\bsol\b/i, network: "Solana" }
  ];

  const pickToken = (text) => {
    for (const t of tokenAliases) {
      if (t.re.test(text)) return t.token;
    }
    return null;
  };
  const pickNetwork = (text) => {
    for (const n of networkAliases) {
      if (n.re.test(text)) return n.network;
    }
    return null;
  };

  // 1) TOKEN (NETWORK)
  let m = raw.match(/^(.+?)\s*\((.+)\)$/);
  if (m) {
    return {
      token: normalizeExpectedTokenName(m[1]),
      network: normalizeExpectedNetworkName(m[2])
    };
  }

  // 2) TOKEN on NETWORK
  m = raw.match(/^(.+?)\s+on\s+(.+)$/i);
  if (m) {
    return {
      token: normalizeExpectedTokenName(m[1]),
      network: normalizeExpectedNetworkName(m[2])
    };
  }

  // 3) TOKEN - NETWORK or TOKEN / NETWORK
  m = raw.match(/^(.+?)\s*[-/|,]\s*(.+)$/);
  if (m) {
    const leftToken = pickToken(m[1]);
    const rightNetwork = pickNetwork(m[2]);
    if (leftToken && rightNetwork) {
      return { token: leftToken, network: rightNetwork };
    }
    const leftNetwork = pickNetwork(m[1]);
    const rightToken = pickToken(m[2]);
    if (leftNetwork && rightToken) {
      return { token: rightToken, network: leftNetwork };
    }
  }

  // 4) Key/value style: "Network: Tron, Asset: USDT"
  const kvNetwork = raw.match(/\bnetwork\s*:\s*([A-Za-z ]+)/i);
  const kvAsset = raw.match(/\b(asset|token|coin)\s*:\s*([A-Za-z0-9.]+)/i);
  if (kvNetwork && kvAsset) {
    return {
      token: normalizeExpectedTokenName(kvAsset[2]),
      network: normalizeExpectedNetworkName(kvNetwork[1])
    };
  }

  // 5) Free text fallback by aliases (e.g. "TRON USDT", "USDT ERC20 TRON")
  const token = pickToken(raw);
  const network = pickNetwork(raw);
  if (token && network) {
    return { token, network };
  }

  return { token: null, network: null };
}

function getZendeskTags(matchStatus) {
  if (matchStatus === "payment_valid") {
    return ["crypto_payment_valid"];
  }

  if (matchStatus === "wrong_network") {
    return ["crypto_wrong_network", "crypto_wallet_needed"];
  }

  if (matchStatus === "wrong_asset") {
    return ["crypto_wrong_asset", "crypto_wallet_needed"];
  }

  if (matchStatus === "funds_lost_wrong_asset") {
    return ["crypto_wrong_asset", "crypto_funds_lost"];
  }

  if (matchStatus === "wrong_wallet_address") {
    return ["crypto_wrong_wallet_address", "crypto_wallet_needed"];
  }

  if (matchStatus === "tx_not_found") {
    return ["crypto_tx_not_found"];
  }

  return ["crypto_needs_manual_review"];
}

function getZendeskInternalNote(matchStatus) {
  if (matchStatus === "payment_valid") {
    return "Payment found and matches expected asset/network.";
  }

  if (matchStatus === "wrong_network") {
    return "Payment found, but network does not match expected invoice network. Ask user for refund wallet.";
  }

  if (matchStatus === "wrong_asset") {
    return "Payment found, but asset does not match expected invoice asset. Ask user for refund wallet.";
  }

  if (matchStatus === "wrong_wallet_address") {
    return "Payment found, but paid-to wallet address does not match expected invoice wallet. Ask user for refund wallet.";
  }

  if (matchStatus === "funds_lost_wrong_asset") {
    return "Payment was made using BNB/opBNB. Funds are considered lost and recovery is not supported. Inform the user and close the case.";
  }

  if (matchStatus === "tx_not_found") {
    return "Transaction was not found on Ethereum/BSC/Polygon/opBNB/Solana/Tron. Ask user to confirm TXID or network.";
  }

  return "Payment requires manual review.";
}

function getEmailToUser(matchStatus) {
  if (matchStatus === "payment_valid") {
    return "Hi, we found your payment and it matches the expected asset and network. Your payment can now be processed.";
  }

  if (
    matchStatus === "wrong_network" ||
    matchStatus === "wrong_asset" ||
    matchStatus === "wrong_wallet_address"
  ) {
    return "Hi, we found your payment, but it does not match the expected payment details. Please reply with the wallet address where you would like the recovery/refund to be sent.";
  }

  if (matchStatus === "funds_lost_wrong_asset") {
    return "Hi, we found your payment, but it was sent using BNB/opBNB (wrong asset/network). Unfortunately, these funds are considered lost and cannot be recovered.";
  }

  if (matchStatus === "tx_not_found") {
    return "Hi, we could not find this transaction on Ethereum, BSC, Polygon, opBNB, Solana, or Tron. Please check the transaction hash and send it again.";
  }

  return "Hi, your payment requires manual review. Our team will check it and follow up with you.";
}

function buildPaymentTicketInternalNote(ticketState) {
  return [
    `:white_check_mark: Blockchain Scan Result`,
    `- Network: ${ticketState.actual_network || "UNKNOWN"}`,
    `- Asset: ${ticketState.actual_token || "UNKNOWN"}`,
    `- Amount: ${ticketState.actual_amount || "UNKNOWN"}`,
    `- Amount (USD): ${ticketState.actual_amount_usd || "UNKNOWN"}`,
    `- Paid To: ${ticketState.receiver || "UNKNOWN"}`,
    `- TXID: ${ticketState.txid || "UNKNOWN"}`,
    `- Status: ${ticketState.resolver_status || "UNKNOWN"}`,
    `- Token Standard: ${ticketState.token_standard || "UNKNOWN"}`,
    `- Explorer: ${ticketState.explorer_link || "N/A"}`,
    "",
    "Next step: Ops should fill Confirmo expected fields (invoice id, expected network, expected asset, expected wallet address)."
  ].join("\n");
}

function buildConfirmoMatchInternalNote(ticketState) {
  return [
    "Confirmo Expected (Ops input):",
    `- invoice_id: ${ticketState.confirmo_invoice_id || "MISSING"}`,
    `- expected_network: ${ticketState.expected_network || "MISSING"}`,
    `- expected_token: ${ticketState.expected_token || "MISSING"}`,
    `- expected_wallet_address: ${ticketState.expected_wallet_address || "MISSING"}`,
    "",
    "Blockchain Actual (Auto):",
    `- actual_network: ${ticketState.actual_network || "UNKNOWN"}`,
    `- actual_token: ${ticketState.actual_token || "UNKNOWN"}`,
    `- actual_amount: ${ticketState.actual_amount || "UNKNOWN"}`,
    `- actual_amount_usd: ${ticketState.actual_amount_usd || "UNKNOWN"}`,
    `- actual_paid_to_wallet: ${ticketState.receiver || "UNKNOWN"}`,
    `- token_standard: ${ticketState.token_standard || "UNKNOWN"}`,
    `- explorer: ${ticketState.explorer_link || "N/A"}`,
    "",
    `Match result: ${ticketState.match_status || "UNKNOWN"}`
  ].join("\n");
}

function buildConfirmoRecoveryPayload(ticketState) {
  return {
    ticket_id: ticketState.ticket_id,
    confirmo_invoice_id: ticketState.confirmo_invoice_id,
    txid: ticketState.txid,
    reason: ticketState.match_status,
    expected_network: ticketState.expected_network,
    expected_token: ticketState.expected_token,
    expected_wallet_address: ticketState.expected_wallet_address,
    actual_network: ticketState.actual_network,
    actual_token: ticketState.actual_token,
    actual_amount: ticketState.actual_amount,
    actual_amount_usd: ticketState.actual_amount_usd,
    actual_paid_to_wallet: ticketState.receiver,
    refund_wallet: ticketState.refund_wallet,
    created_at: new Date().toISOString()
  };
}

function buildWalletFlowInternalNote(ticketState) {
  const base = [
    "Wallet flow update:",
    `- ticket_id: ${ticketState.ticket_id}`,
    `- match_status: ${ticketState.match_status}`,
    `- refund_wallet: ${ticketState.refund_wallet || "MISSING"}`,
    `- wallet_ready_for_recovery: ${ticketState.wallet_ready_for_recovery}`,
    `- confirmo_ready: ${ticketState.confirmo_ready}`
  ];

  if (ticketState.confirmo_recovery_payload) {
    base.push("", "Confirmo recovery payload (manual v1):", JSON.stringify(ticketState.confirmo_recovery_payload, null, 2));
  }

  return base.join("\n");
}

async function updateZendeskForTicket(ticketId, { tags, internalNote, publicReply }) {
  const results = {
    enabled: zendesk.enabled,
    ticket_id: ticketId,
    operations: {}
  };

  if (!zendesk.enabled) {
    results.skipped = true;
    results.reason = "zendesk_client_disabled_missing_env";
    return results;
  }

  async function runOp(name, fn) {
    try {
      const data = await fn();
      results.operations[name] = { ok: true, data };
    } catch (error) {
      const status = error && error.response ? Number(error.response.status) : null;
      const body = error && error.response ? error.response.data : null;
      results.operations[name] = {
        ok: false,
        error: {
          message: error.message,
          status_code: status,
          response: body
        }
      };
      logEvent("error", "zendesk_update_failed", {
        ticket_id: ticketId,
        operation: name,
        status_code: status,
        error_message: error.message
      });
    }
  }

  if (Array.isArray(tags) && tags.length > 0) {
    await runOp("tags", async () => zendesk.addTags(ticketId, tags));
  }

  if (internalNote) {
    await runOp("internal_note", async () => zendesk.addInternalNote(ticketId, internalNote));
  }

  if (publicReply) {
    await runOp("public_reply", async () => zendesk.addPublicReply(ticketId, publicReply));
  }

  return results;
}

function validateWalletFormat(network, wallet) {
  if (!wallet) {
    return {
      valid: false,
      reason: "missing_wallet"
    };
  }

  if (network === "Ethereum" || network === "BSC" || network === "Polygon") {
    if (wallet.startsWith("0x") && wallet.length === 42) {
      return {
        valid: true,
        reason: "valid_evm_wallet_format"
      };
    }

    return {
      valid: false,
      reason: "invalid_evm_wallet_format"
    };
  }

  if (network === "Tron") {
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(wallet)) {
      return {
        valid: true,
        reason: "valid_tron_wallet_format"
      };
    }

    return {
      valid: false,
      reason: "invalid_tron_wallet_format"
    };
  }

  if (network === "Solana") {
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      return {
        valid: true,
        reason: "valid_solana_wallet_format"
      };
    }

    return {
      valid: false,
      reason: "invalid_solana_wallet_format"
    };
  }

  return {
    valid: false,
    reason: "unsupported_network"
  };
}

function extractWalletFromMessage(network, message) {
  if (!message) {
    return null;
  }

  if (network === "Ethereum" || network === "BSC" || network === "Polygon") {
    const evmMatch = message.match(/0x[a-fA-F0-9]{40}/);
    if (evmMatch) {
      return evmMatch[0];
    }
  } else if (network === "Tron") {
    const tronMatch = message.match(/T[1-9A-HJ-NP-Za-km-z]{33}/);
    if (tronMatch) {
      return tronMatch[0];
    }
  } else if (network === "Solana") {
    const solMatches = message.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    for (const m of solMatches) {
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) {
        return m;
      }
    }
  }

  return null;
}

async function checkEvmWalletOnChain(network, wallet) {
  const urls = EVM_RPC_URLS[network] || [];
  for (const rpcUrl of urls) {
    try {
      const balance = await callJsonRpc(rpcUrl, "eth_getBalance", [wallet, "latest"]);
      if (typeof balance === "string") {
        return {
          checked: true,
          valid_on_chain: true,
          balance_wei: balance
        };
      }
    } catch (error) {
      // try next endpoint
    }
  }

  return {
    checked: true,
    valid_on_chain: false,
    reason: "evm_chain_check_failed"
  };
}

function getWalletZendeskTags(walletReadyForRecovery) {
  if (walletReadyForRecovery) {
    return [
      "crypto_wallet_valid",
      "crypto_ready_for_recovery",
      "crypto_ops_review_needed"
    ];
  }

  return ["crypto_wallet_invalid", "crypto_ask_wallet_again"];
}

function getWalletZendeskInternalNote(walletReadyForRecovery) {
  if (walletReadyForRecovery) {
    return "Refund wallet format is valid and wallet was checked on-chain. Ops review is required before sending recovery request to Confirmo.";
  }

  return "Refund wallet is invalid or could not be verified. Ask user to provide a correct wallet address.";
}

async function checkEthereumWalletOnChain(wallet) {
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance&address=${wallet}&tag=latest&apikey=${ETHERSCAN_API_KEY}`;

  const response = await http.get(url, AXIOS_HTTP_OPTIONS);

  if (response.data && response.data.status === "1") {
    return {
      checked: true,
      valid_on_chain: true,
      balance_wei: response.data.result,
      explorer_link: `https://etherscan.io/address/${wallet}`
    };
  }

  return {
    checked: true,
    valid_on_chain: false,
    reason: response.data.result || "wallet_chain_check_failed"
  };
}

async function checkTronWalletOnChain(wallet) {
  const url = `https://apilist.tronscanapi.com/api/account?address=${wallet}`;
  try {
    const response = await http.get(url, AXIOS_HTTP_OPTIONS);
    const data = response.data && typeof response.data === "object" ? response.data : null;
    const hasAddress = Boolean(data && (data.address || data.accountType || data.balance !== undefined));
    return {
      checked: true,
      valid_on_chain: hasAddress,
      explorer_link: `https://tronscan.org/#/address/${wallet}`,
      reason: hasAddress ? "ok" : "tron_wallet_not_found"
    };
  } catch (error) {
    return {
      checked: true,
      valid_on_chain: false,
      reason: "tron_chain_check_failed"
    };
  }
}

async function checkSolanaWalletOnChain(wallet) {
  for (const rpcUrl of SOLANA_RPC_URLS) {
    try {
      const balance = await callSolanaRpc(rpcUrl, "getBalance", [wallet, { commitment: "confirmed" }]);
      if (balance && typeof balance.value === "number") {
        return {
          checked: true,
          valid_on_chain: true,
          balance_lamports: balance.value,
          explorer_link: `https://solscan.io/account/${wallet}`
        };
      }
    } catch (error) {
      // try next endpoint
    }
  }

  return {
    checked: true,
    valid_on_chain: false,
    reason: "solana_chain_check_failed"
  };
}

app.get("/", (req, res) => {
  res.json({
    message: "Crypto payment resolver is running",
    version: APP_VERSION,
    stored_tickets_count: Object.keys(tickets).length
  });
});

app.get("/ui", (req, res) => {
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Realistic Zendesk-style POST endpoint (v1)
// Input: { ticket_id, txid }
app.post("/zendesk/payment-ticket", requireInternalApiKey, validatePaymentTicketBody, async (req, res) => {
  const ticketId = req.body.ticket_id;
  const txid = req.body.txid;

  if (!ticketId) {
    return res.json({ version: APP_VERSION, status: "ERROR", message: "Missing ticket_id" });
  }

  if (!txid) {
    return res.json({ version: APP_VERSION, status: "ERROR", message: "Missing txid" });
  }

  try {
    const existing = tickets[ticketId];
    if (
      existing &&
      String(existing.txid || "") === String(txid) &&
      (existing.resolver_status === "FOUND" || existing.resolver_status === "NOT_FOUND")
    ) {
      return res.json({
        version: APP_VERSION,
        status: "PAYMENT_TICKET_REPLAY",
        ticket_id: ticketId,
        saved_ticket_memory: existing,
        idempotent: true,
        next_action:
          existing.match_status === "tx_not_found" ? "ask_user_for_correct_txid" : "ops_enter_confirmo_expected"
      });
    }

    const result = await resolveTransaction(txid);
    const amountUsd = await computeAmountUsd({
      network: result.network,
      token: result.token,
      amount: result.amount
    });

    const stored = upsertTicket(ticketId);
    stored.txid = txid;
    stored.resolver_status = result.status;
    stored.actual_network = result.network;
    stored.actual_token = result.token;
    stored.actual_amount = result.amount || null;
    stored.actual_amount_usd = amountUsd;
    stored.token_standard = result.token_standard;
    stored.explorer_link = result.explorer_link;
    stored.sender = result.from;
    stored.receiver = result.to;
    stored.updated_at = new Date().toISOString();

    // No expected values yet; we only tag as tx_not_found or needs_confirmo_input
    const matchStatus = result.status === "FOUND" ? "needs_confirmo_input" : "tx_not_found";
    stored.match_status = matchStatus;
    stored.needs_wallet = false;
    saveTicketState(ticketId, stored);

    const tags =
      matchStatus === "tx_not_found"
        ? getZendeskTags("tx_not_found")
        : ["crypto_resolved_onchain", "crypto_confirmo_input_needed"];

    const internalNote = buildPaymentTicketInternalNote(stored);

    const zendesk_update = await updateZendeskForTicket(ticketId, {
      tags,
      internalNote,
      publicReply: matchStatus === "tx_not_found" ? getEmailToUser("tx_not_found") : null
    });

    return res.json({
      version: APP_VERSION,
      status: "PAYMENT_TICKET_PROCESSED",
      zendesk_enabled: zendesk.enabled,
      ticket_id: ticketId,
      saved_ticket_memory: stored,
      resolver_result: result,
      resolver_amount_usd: amountUsd,
      zendesk_update,
      next_action:
        matchStatus === "tx_not_found" ? "ask_user_for_correct_txid" : "ops_enter_confirmo_expected"
    });
  } catch (error) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: error.message,
      ticket_id: ticketId,
      zendesk_tags: ["crypto_resolver_error"],
      zendesk_internal_note:
        "Resolver API returned an error while processing Zendesk payment ticket. Manual review required.",
      next_action: "manual_review"
    });
  }
});

// Ops manual Confirmo input (v1)
// Input: { ticket_id, confirmo_invoice_id, expected_asset_network, expected_wallet_address }
app.post("/zendesk/confirmo-input", requireInternalApiKey, validateConfirmoInputBody, async (req, res) => {
  const ticketId = req.body.ticket_id;
  const confirmoInvoiceId = req.body.confirmo_invoice_id;
  let expectedNetwork = req.body.expected_network;
  let expectedToken = req.body.expected_token;
  const expectedWalletAddress = req.body.expected_wallet_address;
  const expectedAssetNetworkRaw =
    req.body.expected_asset_network ||
    req.body.expected_payment_method ||
    req.body.expected_asset ||
    null;

  if ((!expectedNetwork || !expectedToken) && expectedAssetNetworkRaw) {
    const parsed = parseExpectedAssetNetwork(expectedAssetNetworkRaw);
    expectedNetwork = expectedNetwork || parsed.network;
    expectedToken = expectedToken || parsed.token;
  }

  if (!ticketId) {
    return res.json({ version: APP_VERSION, status: "ERROR", message: "Missing ticket_id" });
  }

  const stored = upsertTicket(ticketId);

  if (!stored.txid || !stored.actual_network) {
    return res.json({
      version: APP_VERSION,
      status: "MISSING_RESOLVER_DATA",
      ticket_id: ticketId,
      stored_ticket: stored,
      zendesk_tags: ["crypto_confirmo_input_blocked"],
      zendesk_internal_note:
        "Confirmo input received, but resolver data is missing. Run /zendesk/payment-ticket first.",
      next_action: "run_resolver_first"
    });
  }

  if (!confirmoInvoiceId || !expectedNetwork || !expectedToken || !expectedWalletAddress) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message:
        "Missing confirmo_invoice_id / expected_asset_network / expected_wallet_address",
      ticket_id: ticketId
    });
  }

  stored.confirmo_invoice_id = String(confirmoInvoiceId);
  stored.expected_network = normalizeExpectedNetworkName(expectedNetwork);
  stored.expected_token = normalizeExpectedTokenName(expectedToken);
  stored.expected_wallet_address = String(expectedWalletAddress);

  const expected = { network: stored.expected_network, token: stored.expected_token };
  const actual = {
    status: stored.resolver_status,
    network: stored.actual_network,
    token: stored.actual_token
  };
  const matchResult = computeMatchDetails({
    expected,
    actual,
    expectedWallet: stored.expected_wallet_address,
    actualReceiver: stored.receiver
  });
  const matchStatus = matchResult.status;
  stored.match_status = matchStatus;
  stored.wallet_match = matchResult.wallet_match;
  stored.network_match = matchResult.network_match;
  stored.token_match = matchResult.token_match;
  stored.asset_network_match = matchResult.asset_network_match;
  stored.needs_wallet = !matchResult.wallet_match || !matchResult.asset_network_match;
  stored.updated_at = new Date().toISOString();
  saveTicketState(ticketId, stored);

  const tags = getZendeskTags(matchStatus).concat(["crypto_confirmo_expected_received"]);
  const internalNote = buildConfirmoMatchInternalNote(stored);

  const publicReply =
    matchStatus === "payment_valid"
      ? getEmailToUser("payment_valid")
      : stored.needs_wallet
        ? getEmailToUser("wrong_network")
        : matchStatus === "funds_lost_wrong_asset"
          ? getEmailToUser("funds_lost_wrong_asset")
        : matchStatus === "tx_not_found"
          ? getEmailToUser("tx_not_found")
          : null;

  const zendesk_update = await updateZendeskForTicket(ticketId, {
    tags,
    internalNote,
    publicReply
  });

  return res.json({
    version: APP_VERSION,
    status: "CONFIRMO_INPUT_PROCESSED",
    zendesk_enabled: zendesk.enabled,
    ticket_id: ticketId,
    saved_ticket_memory: stored,
    match_status: matchStatus,
    match_result: matchResult,
    zendesk_update,
    next_action: stored.needs_wallet
      ? "wait_for_wallet_reply"
      : matchStatus === "funds_lost_wrong_asset"
        ? "close_case_funds_lost"
        : "close_or_process_payment"
  });
});

// Wallet reply from user (v1)
// Input: { ticket_id, message } OR { ticket_id, refund_wallet }
app.post("/zendesk/wallet-reply", requireInternalApiKey, validateWalletReplyBody, async (req, res) => {
  const ticketId = req.body.ticket_id;
  const message = req.body.message;
  const refundWallet = req.body.refund_wallet;

  if (!ticketId) {
    return res.json({ version: APP_VERSION, status: "ERROR", message: "Missing ticket_id" });
  }

  const stored = upsertTicket(ticketId);

  if (!stored.needs_wallet) {
    return res.json({
      version: APP_VERSION,
      status: "WALLET_NOT_REQUIRED",
      ticket_id: ticketId,
      stored_ticket: stored,
      next_action: "no_wallet_action_needed"
    });
  }

  const network = stored.expected_network || stored.actual_network;
  const walletCandidate = refundWallet || extractWalletFromMessage(network, message || "");

  if (!walletCandidate) {
    const tags = ["crypto_wallet_missing"];
    const internalNote =
      "Wallet reply received, but no wallet was found. Ask user to provide the correct refund wallet address.";
    const publicReply =
      "Please reply with the wallet address where you would like the refund/recovery to be sent.";

    const zendesk_update = await updateZendeskForTicket(ticketId, {
      tags,
      internalNote,
      publicReply
    });

    return res.json({
      version: APP_VERSION,
      status: "NO_WALLET_FOUND",
      zendesk_enabled: zendesk.enabled,
      ticket_id: ticketId,
      stored_ticket: stored,
      zendesk_update,
      next_action: "ask_user_for_wallet_again"
    });
  }

  const formatCheck = validateWalletFormat(network, walletCandidate);

  let chainCheck = { checked: false, reason: "chain_check_not_run" };
  if (formatCheck.valid && network === "Ethereum") {
    chainCheck = await checkEthereumWalletOnChain(walletCandidate);
  } else if (formatCheck.valid && (network === "BSC" || network === "Polygon")) {
    chainCheck = await checkEvmWalletOnChain(network, walletCandidate);
  } else if (formatCheck.valid && network === "Tron") {
    chainCheck = await checkTronWalletOnChain(walletCandidate);
  } else if (formatCheck.valid && network === "Solana") {
    chainCheck = await checkSolanaWalletOnChain(walletCandidate);
  }

  const walletReadyForRecovery = formatCheck.valid && chainCheck.valid_on_chain === true;

  stored.refund_wallet = walletCandidate;
  stored.wallet_ready_for_recovery = walletReadyForRecovery;
  stored.ops_approved = false;
  stored.confirmo_ready = walletReadyForRecovery; // v1: if wallet ok, ready for ops to submit
  stored.confirmo_recovery_payload = walletReadyForRecovery ? buildConfirmoRecoveryPayload(stored) : null;
  stored.updated_at = new Date().toISOString();
  saveTicketState(ticketId, stored);

  const tags = walletReadyForRecovery
    ? ["crypto_wallet_valid", "crypto_confirmo_payload_ready", "crypto_ops_review_needed"]
    : ["crypto_wallet_invalid", "crypto_ask_wallet_again"];

  const internalNote = buildWalletFlowInternalNote(stored);
  const publicReply = walletReadyForRecovery
    ? "Thanks. Your refund wallet looks valid. Our team will proceed with recovery."
    : "The wallet address looks invalid for the required network. Please send the correct refund wallet.";

  const zendesk_update = await updateZendeskForTicket(ticketId, {
    tags,
    internalNote,
    publicReply
  });

  return res.json({
    version: APP_VERSION,
    status: "WALLET_REPLY_PROCESSED",
    zendesk_enabled: zendesk.enabled,
    ticket_id: ticketId,
    stored_ticket: stored,
    extracted_wallet: walletCandidate,
    format_check: formatCheck,
    chain_check: chainCheck,
    wallet_ready_for_recovery: walletReadyForRecovery,
    zendesk_update,
    next_action: walletReadyForRecovery ? "ops_submit_confirmo_recovery" : "ask_user_for_correct_wallet"
  });
});

app.get("/simulate-zendesk-ticket", blockInProduction, async (req, res) => {
  const ticketId = req.query.ticket_id;
  const txid = req.query.txid;
  const expectedNetworkQuery = req.query.expected_network;
  const expectedTokenQuery = req.query.expected_token;

  if (!ticketId) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: "Missing ticket_id"
    });
  }

  if (!txid) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: "Missing txid"
    });
  }

  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${process.env.ETHERSCAN_API_KEY}`;

    const response = await http.get(url, AXIOS_HTTP_OPTIONS);

    if (response.data && response.data.result) {
      const tx = response.data.result;
      const tokenDetection = await detectEthereumTokenSimple(txid, tx);
      const token = tokenDetection.token;

      // For testing wrong_asset, temporarily change token to "ETH".
      // For normal testing, keep token as "USDT".
      const expectedPayment = {
        network: expectedNetworkQuery ? String(expectedNetworkQuery) : "Ethereum",
        token: expectedTokenQuery ? String(expectedTokenQuery) : "USDT"
      };

      const actualPayment = {
        status: "FOUND",
        network: "Ethereum",
        token: token,
        amount: tokenDetection.amount || formatUnitsFromBase(tx.value, 18)
      };

      const matchStatus = matchPayment(expectedPayment, actualPayment);
      const tags = getZendeskTags(matchStatus);
      const internalNote = getZendeskInternalNote(matchStatus);
      const emailToUser = getEmailToUser(matchStatus);

      const nextTicket = {
        ticket_id: ticketId,
        txid: txid,
        actual_network: "Ethereum",
        actual_token: token,
        actual_amount: actualPayment.amount,
        expected_network: expectedPayment.network,
        expected_token: expectedPayment.token,
        match_status: matchStatus,
        needs_wallet:
          matchStatus === "wrong_network" ||
          matchStatus === "wrong_asset" ||
          matchStatus === "wrong_wallet_address",
        ops_approved: false,
        confirmo_ready: false,
        created_at: new Date().toISOString()
      };
      saveTicketState(ticketId, nextTicket);

      return res.json({
        version: APP_VERSION,
        status: "SIMULATED_ZENDESK_TICKET_PROCESSED",
        ticket_id: ticketId,
        saved_ticket_memory: tickets[ticketId],
        payment_result: {
          status: "FOUND",
          network: "Ethereum",
          token: token,
          amount: actualPayment.amount,
          token_standard: tokenDetection.token_standard,
          expected_network: expectedPayment.network,
          expected_token: expectedPayment.token,
          match_status: matchStatus,
          explorer_link: `https://etherscan.io/tx/${txid}`,
          sender: tx.from,
          receiver: tx.to
        },
        zendesk_tags: tags,
        zendesk_internal_note: internalNote,
        email_to_user: emailToUser,
        next_action:
          matchStatus === "payment_valid"
            ? "add_payment_valid_tag"
            : "send_wallet_request_email"
      });
    }

    const nextTicket = {
      ticket_id: ticketId,
      txid: txid,
      actual_network: "Ethereum",
      actual_token: null,
      actual_amount: null,
      expected_network: "Ethereum",
      expected_token: "USDT",
      match_status: "tx_not_found",
      needs_wallet: false,
      ops_approved: false,
      confirmo_ready: false,
      created_at: new Date().toISOString()
    };
    saveTicketState(ticketId, nextTicket);

    return res.json({
      version: APP_VERSION,
      status: "SIMULATED_ZENDESK_TICKET_PROCESSED",
      ticket_id: ticketId,
      saved_ticket_memory: tickets[ticketId],
      payment_result: {
        status: "NOT_FOUND",
        network: "Ethereum",
        match_status: "tx_not_found"
      },
      zendesk_tags: getZendeskTags("tx_not_found"),
      zendesk_internal_note: getZendeskInternalNote("tx_not_found"),
      email_to_user: getEmailToUser("tx_not_found"),
      next_action: "ask_user_for_correct_txid"
    });
  } catch (error) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: error.message,
      ticket_id: ticketId,
      zendesk_tags: ["crypto_resolver_error"],
      zendesk_internal_note:
        "Resolver API returned an error while simulating Zendesk ticket. Manual review required.",
      next_action: "manual_review"
    });
  }
});

app.get("/simulate-zendesk-wallet-reply", blockInProduction, async (req, res) => {
  const ticketId = req.query.ticket_id;
  const message = req.query.message;

  if (!ticketId) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: "Missing ticket_id"
    });
  }

  if (!message) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: "Missing message"
    });
  }

  const storedTicket = tickets[ticketId];

  if (!storedTicket) {
    return res.json({
      version: APP_VERSION,
      status: "TICKET_NOT_FOUND_IN_MEMORY",
      ticket_id: ticketId,
      user_message: message,
      zendesk_tags: ["crypto_ticket_memory_missing"],
      zendesk_internal_note:
        "No stored ticket memory found. Run /simulate-zendesk-ticket first or use a database in production.",
      next_action: "manual_review"
    });
  }

  if (!storedTicket.needs_wallet) {
    return res.json({
      version: APP_VERSION,
      status: "WALLET_NOT_REQUIRED",
      ticket_id: ticketId,
      stored_ticket: storedTicket,
      user_message: message,
      zendesk_tags: ["crypto_wallet_not_required"],
      zendesk_internal_note:
        "This ticket does not require a refund wallet based on the stored payment result.",
      next_action: "no_wallet_action_needed"
    });
  }

  try {
  const network = storedTicket.expected_network || storedTicket.actual_network;
    const extractedWallet = extractWalletFromMessage(network, message);

    if (!extractedWallet) {
      return res.json({
        version: APP_VERSION,
        status: "NO_WALLET_FOUND",
        ticket_id: ticketId,
        stored_ticket: storedTicket,
        user_message: message,
        zendesk_tags: ["crypto_wallet_missing"],
        zendesk_internal_note:
          "User replied, but no wallet address for the expected network was found in the message.",
        next_action: "ask_user_for_wallet_again"
      });
    }

    const formatCheck = validateWalletFormat(network, extractedWallet);

    let chainCheck = {
      checked: false,
      reason: "chain_check_not_run"
    };

    if (formatCheck.valid && network === "Ethereum") {
      chainCheck = await checkEthereumWalletOnChain(extractedWallet);
    } else if (formatCheck.valid && (network === "BSC" || network === "Polygon")) {
      chainCheck = await checkEvmWalletOnChain(network, extractedWallet);
    } else if (formatCheck.valid && network === "Tron") {
      chainCheck = await checkTronWalletOnChain(extractedWallet);
    } else if (formatCheck.valid && network === "Solana") {
      chainCheck = await checkSolanaWalletOnChain(extractedWallet);
    }

    const walletReadyForRecovery =
      formatCheck.valid && chainCheck.valid_on_chain === true;

    storedTicket.refund_wallet = extractedWallet;
    storedTicket.wallet_ready_for_recovery = walletReadyForRecovery;
    storedTicket.ops_approved = false;
    storedTicket.confirmo_ready = false;
    storedTicket.updated_at = new Date().toISOString();
    saveTicketState(ticketId, storedTicket);

    return res.json({
      version: APP_VERSION,
      status: "SIMULATED_ZENDESK_WALLET_REPLY_PROCESSED",
      ticket_id: ticketId,
      stored_ticket: storedTicket,
      network: network,
      user_message: message,
      extracted_wallet: extractedWallet,
      format_check: formatCheck,
      chain_check: chainCheck,
      wallet_ready_for_recovery: walletReadyForRecovery,
      next_action: walletReadyForRecovery
        ? "ops_review_before_confirmo"
        : "ask_user_for_correct_wallet",
      zendesk_tags: getWalletZendeskTags(walletReadyForRecovery),
      zendesk_internal_note: getWalletZendeskInternalNote(walletReadyForRecovery)
    });
  } catch (error) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: error.message,
      ticket_id: ticketId,
      zendesk_tags: ["crypto_wallet_reply_error"],
      zendesk_internal_note:
        "Wallet reply simulation failed. Manual review required.",
      next_action: "manual_review"
    });
  }
});

app.get("/simulate-ops-approval", blockInProduction, (req, res) => {
  const ticketId = req.query.ticket_id;
  const approvedBy = req.query.approved_by || "ops_user";

  if (!ticketId) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: "Missing ticket_id"
    });
  }

  const storedTicket = tickets[ticketId];

  if (!storedTicket) {
    return res.json({
      version: APP_VERSION,
      status: "TICKET_NOT_FOUND_IN_MEMORY",
      ticket_id: ticketId,
      zendesk_tags: ["crypto_ticket_memory_missing"],
      zendesk_internal_note:
        "Ops approval failed because no stored ticket memory was found.",
      next_action: "manual_review"
    });
  }

  if (!storedTicket.wallet_ready_for_recovery) {
    return res.json({
      version: APP_VERSION,
      status: "NOT_READY_FOR_OPS_APPROVAL",
      ticket_id: ticketId,
      stored_ticket: storedTicket,
      zendesk_tags: ["crypto_not_ready_for_recovery"],
      zendesk_internal_note:
        "Ops approval blocked because wallet is not ready for recovery.",
      next_action: "manual_review"
    });
  }

  storedTicket.ops_approved = true;
  storedTicket.confirmo_ready = true;
  storedTicket.approved_by = approvedBy;
  storedTicket.approved_at = new Date().toISOString();
  saveTicketState(ticketId, storedTicket);

  return res.json({
    version: APP_VERSION,
    status: "OPS_APPROVAL_COMPLETE",
    ticket_id: ticketId,
    stored_ticket: storedTicket,
    zendesk_tags: ["crypto_ops_approved", "crypto_confirmo_ready"],
    zendesk_internal_note:
      "Ops approved the recovery case. Case is ready to send to Confirmo.",
    next_action: "send_to_confirmo"
  });
});

app.get("/simulate-confirmo-recovery", blockInProduction, (req, res) => {
  const ticketId = req.query.ticket_id;

  if (!ticketId) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: "Missing ticket_id"
    });
  }

  const storedTicket = tickets[ticketId];

  if (!storedTicket) {
    return res.json({
      version: APP_VERSION,
      status: "TICKET_NOT_FOUND_IN_MEMORY",
      ticket_id: ticketId,
      zendesk_tags: ["crypto_ticket_memory_missing"],
      zendesk_internal_note:
        "Confirmo recovery simulation failed because no stored ticket memory was found.",
      next_action: "manual_review"
    });
  }

  if (!storedTicket.confirmo_ready) {
    return res.json({
      version: APP_VERSION,
      status: "NOT_READY_FOR_CONFIRMO",
      ticket_id: ticketId,
      stored_ticket: storedTicket,
      zendesk_tags: ["crypto_not_ready_for_confirmo"],
      zendesk_internal_note:
        "Confirmo recovery simulation blocked because ticket is not approved or wallet is not ready.",
      next_action: "manual_review"
    });
  }

  const recoveryRequest = {
    ticket_id: storedTicket.ticket_id,
    txid: storedTicket.txid,
    reason: storedTicket.match_status,
    actual_network: storedTicket.actual_network,
    actual_token: storedTicket.actual_token,
    expected_network: storedTicket.expected_network,
    expected_token: storedTicket.expected_token,
    refund_wallet: storedTicket.refund_wallet,
    approved_by: storedTicket.approved_by,
    approved_at: storedTicket.approved_at
  };

  storedTicket.confirmo_recovery_simulated = true;
  storedTicket.confirmo_recovery_request = recoveryRequest;
  storedTicket.confirmo_simulated_at = new Date().toISOString();
  saveTicketState(ticketId, storedTicket);

  return res.json({
    version: APP_VERSION,
    status: "SIMULATED_CONFIRMO_RECOVERY_SENT",
    ticket_id: ticketId,
    recovery_request: recoveryRequest,
    stored_ticket: storedTicket,
    zendesk_tags: ["crypto_confirmo_recovery_simulated"],
    zendesk_internal_note:
      "Simulated Confirmo recovery request was created. In production, this would be sent to Confirmo.",
    next_action: "wait_for_confirmo_response"
  });
});

app.get("/debug-tickets", blockInProduction, requireInternalApiKey, (req, res) => {
  res.json({
    version: APP_VERSION,
    tickets: tickets
  });
});

app.get("/healthz", (req, res) => {
  const zdSubdomain = process.env.ZD_SUBDOMAIN || process.env.ZENDESK_SUBDOMAIN;
  const zdEmail = process.env.ZD_EMAIL || process.env.ZENDESK_EMAIL;
  const zdToken = process.env.ZD_TOKEN || process.env.ZD_API_TOKEN || process.env.ZENDESK_API_TOKEN;
  const zendeskConfig = {
    subdomain: Boolean(zdSubdomain),
    email: Boolean(zdEmail),
    api_token: Boolean(zdToken)
  };
  res.json({
    status: "ok",
    version: APP_VERSION,
    env: NODE_ENV,
    zendesk_enabled: zendesk.enabled,
    zendesk_config: zendeskConfig
  });
});

function validateRequiredEnv() {
  const missing = [];
  if (!ETHERSCAN_API_KEY) {
    missing.push("ETHERSCAN_API_KEY");
  }
  if (!INTERNAL_API_KEY) {
    missing.push("INTERNAL_API_KEY");
  }
  return missing;
}

const missingEnv = validateRequiredEnv();
if (missingEnv.length > 0) {
  const msg = `[startup] Missing required env vars: ${missingEnv.join(", ")}`;
  if (IS_PRODUCTION) {
    throw new Error(`${msg}. Refusing to start in production.`);
  }
  logEvent("info", "startup_missing_env", { missing_env: missingEnv });
}

function startServer() {
  return app.listen(PORT, () => {
    logEvent("info", "server_started", {
      url: `http://localhost:${PORT}`,
      version: APP_VERSION,
      environment: NODE_ENV
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer
};
