function $(id) {
  return document.getElementById(id);
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toSummaryLines(res) {
  if (!res || typeof res !== "object") {
    return { html: "No response yet." };
  }

  const isFlatResolve =
    Object.prototype.hasOwnProperty.call(res, "network") &&
    Object.prototype.hasOwnProperty.call(res, "token") &&
    Object.prototype.hasOwnProperty.call(res, "txid");

  if (isFlatResolve) {
    const val = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));
    const network = val(res.network);
    const token = val(res.token);
    const paidToWallet = val(res.to_address);
    const txid = val(res.txid);
    const amount = val(res.amount);
    const foundInBlockchain = network !== "-" && token !== "-";
    const status = foundInBlockchain ? "SUCCESS" : "ERROR";
    let explorerLink = "-";
    if (foundInBlockchain && txid !== "-") {
      if (network === "Ethereum") explorerLink = `https://etherscan.io/tx/${txid}`;
      else if (network === "Polygon") explorerLink = `https://polygonscan.com/tx/${txid}`;
      else if (network === "BSC") explorerLink = `https://bscscan.com/tx/${txid}`;
      else if (network === "Tron") explorerLink = `https://tronscan.org/#/transaction/${txid}`;
      else if (network === "Solana") explorerLink = `https://solscan.io/tx/${txid}`;
      else if (network === "opBNB") explorerLink = `https://opbnbscan.com/tx/${txid}`;
    }

    const line = (label, value, valueClass = "summary-value") =>
      `<div><span class="summary-label">${escapeHtml(label)}:</span> <span class="${valueClass}">${escapeHtml(value)}</span></div>`;

    const explorerHtml =
      explorerLink === "-"
        ? line("Explorer Link", "-")
        : `<div><span class="summary-label">Explorer Link:</span> <span class="summary-value"><a class="link" href="${escapeHtml(
            explorerLink
          )}" target="_blank" rel="noreferrer">${escapeHtml(explorerLink)}</a></span></div>`;

    return {
      html: [
        line("Status", status),
        line("Ticket ID", "-"),
        line("Found In Blockchain", foundInBlockchain ? "Yes" : "No", foundInBlockchain ? "summary-yes" : "summary-no"),
        line("Actual Network", network),
        line("Actual Token", token),
        line("Amount", amount),
        line("Wallet Address Paid To", paidToWallet),
        explorerHtml,
        line("Next Action", foundInBlockchain ? "review_result" : "txn_not_exist -> ask_user_for_correct_txn_hash")
      ].join("")
    };
  }

  const memory = res.saved_ticket_memory || {};
  const val = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));
  const explorerLink = memory.explorer_link || (res.resolver_result && res.resolver_result.explorer_link);
  const actualNetwork = memory.actual_network || (res.resolver_result && res.resolver_result.network);
  const actualToken = memory.actual_token || (res.resolver_result && res.resolver_result.token);
  const paidToWallet = memory.receiver || (res.resolver_result && res.resolver_result.to);
  const resolverStatus = (memory.resolver_status || (res.resolver_result && res.resolver_result.status) || "")
    .toString()
    .toUpperCase();
  const foundInBlockchain = resolverStatus === "FOUND";
  const nextAction = foundInBlockchain
    ? val(res.next_action)
    : "txn_not_exist -> ask_user_for_correct_txn_hash";

  const line = (label, value, valueClass = "summary-value") =>
    `<div><span class="summary-label">${escapeHtml(label)}:</span> <span class="${valueClass}">${escapeHtml(value)}</span></div>`;

  const html = [
    line("Status", val(res.status)),
    line("Ticket ID", val(res.ticket_id)),
    line("Found In Blockchain", foundInBlockchain ? "Yes" : "No", foundInBlockchain ? "summary-yes" : "summary-no"),
    line("Actual Network", val(actualNetwork)),
    line("Actual Token", val(actualToken)),
    line("Wallet Address Paid To", val(paidToWallet)),
    line("Explorer Link", val(explorerLink)),
    line("Next Action", nextAction)
  ].join("");

  return { html };
}

function toConfirmoStepHtml(res) {
  if (!res || typeof res !== "object") return "No response yet.";
  const memory = res.saved_ticket_memory || {};
  const status = String(res.status || "-");
  const ticketId = String(res.ticket_id || "-");
  const match = String(res.match_status || memory.match_status || "-");
  const norm = (v) => String(v || "").trim().toLowerCase();
  const yesNo = (ok) => (ok ? "Yes" : "No");
  const yesNoClass = (ok) => (ok ? "summary-yes" : "summary-no");

  const expectedWallet = memory.expected_wallet_address;
  const actualWallet = memory.receiver;
  const expectedNetwork = memory.expected_network;
  const actualNetwork = memory.actual_network;
  const expectedToken = memory.expected_token;
  const actualToken = memory.actual_token;
  const matchResult = res.match_result || {};

  const walletKnown = Boolean(norm(expectedWallet) && norm(actualWallet));
  const networkKnown = Boolean(norm(expectedNetwork) && norm(actualNetwork));
  const tokenKnown = Boolean(norm(expectedToken) && norm(actualToken));

  const walletMatch =
    typeof matchResult.wallet_match === "boolean"
      ? matchResult.wallet_match
      : walletKnown
        ? norm(expectedWallet) === norm(actualWallet)
        : false;
  const networkMatch = networkKnown ? norm(expectedNetwork) === norm(actualNetwork) : false;
  const tokenMatch = tokenKnown ? norm(expectedToken) === norm(actualToken) : false;
  const assetNetworkMatch =
    typeof matchResult.asset_network_match === "boolean"
      ? matchResult.asset_network_match
      : networkMatch && tokenMatch;

  let caseText = "Needs review";
  if (walletKnown && networkKnown && tokenKnown) {
    if (walletMatch && assetNetworkMatch) caseText = "Wallet + asset/network all match";
    else if (!walletMatch && assetNetworkMatch) caseText = "Wallet mismatch only";
    else if (walletMatch && !assetNetworkMatch) caseText = "Asset/network mismatch only";
    else caseText = "Wallet + asset/network mismatch";
  } else {
    if (match === "payment_valid") caseText = "Payment valid";
    if (match === "wrong_wallet_address") caseText = "Wallet mismatch";
    if (match === "wrong_network") caseText = "Network mismatch";
    if (match === "wrong_asset") caseText = "Token/asset mismatch";
    if (match === "funds_lost_wrong_asset") caseText = "Funds lost due to wrong asset";
  }

  let nextActionText = String(res.next_action || "-");
  if (match === "wrong_asset" || match === "wrong_network") {
    if (walletMatch) {
      nextActionText = "Automated email sent to user; waiting for recovery wallet reply";
    } else {
      nextActionText = "Automated email sent to user: wrong wallet provided, please provide correct wallet";
    }
  } else if (match === "wrong_wallet_address") {
    nextActionText = "Automated email sent to user: wrong wallet provided, please provide correct wallet";
  }

  return [
    `<div><span class="summary-label">Status:</span> <span class="summary-value">${escapeHtml(status)}</span></div>`,
    `<div><span class="summary-label">Ticket ID:</span> <span class="summary-value">${escapeHtml(ticketId)}</span></div>`,
    `<div><span class="summary-label">Wallet Match:</span> <span class="${yesNoClass(walletMatch)}">${yesNo(walletMatch)}</span></div>`,
    `<div><span class="summary-label">Asset+Network Match:</span> <span class="${yesNoClass(assetNetworkMatch)}">${yesNo(assetNetworkMatch)}</span></div>`,
    `<div><span class="summary-label">Case:</span> <span class="summary-value">${escapeHtml(caseText)}</span></div>`,
    `<div><span class="summary-label">Match Status:</span> <span class="summary-value">${escapeHtml(match)}</span></div>`,
    `<div><span class="summary-label">Next Action:</span> <span class="summary-value">${escapeHtml(nextActionText)}</span></div>`
  ].join("");
}

function toResolveStepHtml(res) {
  if (!res || typeof res !== "object") return "No response yet.";
  return toSummaryLines(res).html;
}

function toWalletStepHtml(res) {
  if (!res || typeof res !== "object") return "No response yet.";
  const val = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));
  const boolText = (v) => (typeof v === "boolean" ? (v ? "Yes" : "No") : "-");
  const boolClass = (v) => (typeof v === "boolean" ? (v ? "summary-yes" : "summary-no") : "summary-value");
  const line = (label, value, cls = "summary-value") =>
    `<div><span class="summary-label">${escapeHtml(label)}:</span> <span class="${cls}">${escapeHtml(value)}</span></div>`;

  const formatValid =
    (res.format_check && res.format_check.valid) ??
    (typeof res.valid_on_chain === "boolean" ? res.valid_on_chain : undefined);
  const chainChecked =
    (res.chain_check && res.chain_check.checked) ??
    (typeof res.valid_on_chain === "boolean" ? true : undefined);
  const chainValid =
    (res.chain_check && res.chain_check.valid_on_chain) ??
    (typeof res.valid_on_chain === "boolean" ? res.valid_on_chain : undefined);
  const ready =
    res.wallet_ready_for_recovery ??
    (typeof res.wallet_ready === "boolean" ? res.wallet_ready : undefined);

  return [
    line("Status", val(res.status)),
    line("Ticket ID", val(res.ticket_id)),
    line("Extracted Wallet", val(res.extracted_wallet || (res.stored_ticket && res.stored_ticket.refund_wallet))),
    line("Checked: Wallet format", boolText(formatValid), boolClass(formatValid)),
    line("Checked: On-chain wallet check run", boolText(chainChecked), boolClass(chainChecked)),
    line("Checked: Wallet exists on-chain", boolText(chainValid), boolClass(chainValid)),
    line("Wallet Ready For Recovery", boolText(ready), boolClass(ready)),
    line("Next Action", val(res.next_action))
  ].join("");
}

const API_KEY_STORAGE_KEY = "resolver_ui_api_key";
let latestResolved = {
  network: null,
  token: null,
  to_address: null,
  amount: null,
  txid: null
};

function getApiKey() {
  return $("apiKey").value.trim();
}

function saveApiKey() {
  const key = getApiKey();
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

function loadApiKey() {
  const saved = localStorage.getItem(API_KEY_STORAGE_KEY) || "";
  $("apiKey").value = saved;
}

function clearApiKey() {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  $("apiKey").value = "";
}

function getAuthHeaders() {
  const key = getApiKey();
  return key ? { "x-api-key": key } : {};
}

async function pingServer() {
  const pill = $("serverPill");
  try {
    const res = await fetch("/healthz");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    await res.json();
    pill.textContent = "Server OK";
    pill.classList.remove("bad");
    pill.classList.add("ok");
  } catch (e) {
    pill.textContent = "Server not reachable";
    pill.classList.remove("ok");
    pill.classList.add("bad");
  }
}

function setOutputs(req, res) {
  const reqOut = $("reqOut");
  const resSummary = $("resSummary");
  const resOut = $("resOut");
  if (reqOut) reqOut.textContent = req ? pretty(req) : "-";
  if (resSummary) resSummary.innerHTML = res ? toSummaryLines(res).html : "-";
  if (resOut) resOut.textContent = res ? pretty(res) : "-";
}

function setConfirmoStepOutput(res) {
  const box = $("confirmoStepOut");
  if (!box) return;
  box.innerHTML = toConfirmoStepHtml(res);
}

function setResolveStepOutput(res) {
  const box = $("resolveStepOut");
  if (!box) return;
  box.innerHTML = toResolveStepHtml(res);
}

function setWalletStepOutput(res) {
  const box = $("walletStepOut");
  if (!box) return;
  box.innerHTML = toWalletStepHtml(res);
}

async function runResolve(ticketId, txid) {
  const useZendeskFlow = Boolean(ticketId && ticketId.trim());
  const url = useZendeskFlow ? `/zendesk/payment-ticket` : `/api/resolve-transaction`;
  const body = { txid };
  if (useZendeskFlow) {
    body.ticket_id = ticketId.trim();
  }

  setOutputs({ method: "POST", url, body }, null);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  latestResolved = {
    network: data.network || null,
    token: data.token || null,
    to_address: data.to_address || null,
    amount: data.amount || null,
    txid: data.txid || txid || null
  };
  setOutputs({ method: "POST", url, body }, data);
  setResolveStepOutput(data);
}

async function runWallet(ticketId, message) {
  const url = `/zendesk/wallet-reply`;
  const body = { message, user_message: message };
  if (ticketId) {
    body.ticket_id = ticketId;
  }
  if (latestResolved.network) body.actual_network = latestResolved.network;
  if (latestResolved.to_address) body.actual_wallet = latestResolved.to_address;

  setOutputs({ method: "POST", url, body }, null);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  setOutputs({ method: "POST", url, body }, data);
  setWalletStepOutput(data);
}

async function runConfirmoInput(ticketId, invoiceId, expectedAssetNetwork, expectedWalletAddress) {
  const url = `/zendesk/confirmo-input`;
  const expected = String(expectedAssetNetwork || "").trim();
  const paren = expected.match(/^(.+?)\s*\((.+)\)$/);
  const expectedAsset = paren ? paren[1].trim() : "";
  const expectedNetwork = paren ? paren[2].trim() : "";
  const body = {
    expected_asset_network: expectedAssetNetwork,
    expected_asset: expectedAsset || expected,
    expected_network: expectedNetwork,
    expected_wallet: expectedWalletAddress,
    expected_wallet_address: expectedWalletAddress,
    actual_network: latestResolved.network,
    actual_token: latestResolved.token,
    actual_wallet: latestResolved.to_address
  };
  if (ticketId) body.ticket_id = ticketId;
  if (invoiceId) body.confirmo_invoice_id = invoiceId;

  setOutputs({ method: "POST", url, body }, null);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  setOutputs({ method: "POST", url, body }, data);
  setConfirmoStepOutput(data);
}

window.addEventListener("DOMContentLoaded", () => {
  loadApiKey();
  pingServer();

  $("btnSaveApiKey").addEventListener("click", () => {
    saveApiKey();
    setOutputs(
      { action: "save_api_key" },
      { ok: true, message: "API key saved in browser local storage." }
    );
  });

  $("btnClearApiKey").addEventListener("click", () => {
    clearApiKey();
    setOutputs({ action: "clear_api_key" }, { ok: true, message: "API key cleared." });
  });

  $("btnResolve").addEventListener("click", async () => {
    const ticketId = $("ticketId").value.trim();
    const txid = $("txid").value.trim();
    $("ticketId2").value = ticketId;
    $("ticketIdConfirmo").value = ticketId;

    if (!txid) {
      return setOutputs(
        { error: "Missing input" },
        { message: "Please enter txid." }
      );
    }

    try {
      await runResolve(ticketId, txid);
    } catch (e) {
      setOutputs({ error: "Request failed" }, { message: String(e) });
    }
  });

  $("btnResolveSample").addEventListener("click", async () => {
    $("ticketId").value = "demo";
    $("txid").value =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    $("ticketId2").value = "demo";
    $("ticketIdConfirmo").value = "demo";
    try {
      await runResolve($("ticketId").value, $("txid").value);
    } catch (e) {
      setOutputs({ error: "Request failed" }, { message: String(e) });
    }
  });

  $("btnConfirmo").addEventListener("click", async () => {
    const ticketId = $("ticketIdConfirmo").value.trim();
    const invoiceId = $("invoiceId").value.trim();
    const expectedAssetNetwork = $("expectedAssetNetwork").value.trim();
    const expectedWalletAddress = $("expectedWalletAddress").value.trim();

    if (!ticketId || !invoiceId || !expectedAssetNetwork || !expectedWalletAddress) {
      return setOutputs(
        { error: "Missing input" },
        {
          message:
            "Please enter ticket id + invoice id + expected network and asset + expected wallet address."
        }
      );
    }

    try {
      await runConfirmoInput(ticketId, invoiceId, expectedAssetNetwork, expectedWalletAddress);
    } catch (e) {
      setOutputs({ error: "Request failed" }, { message: String(e) });
    }
  });

  $("btnWallet").addEventListener("click", async () => {
    const ticketId = $("ticketId2").value.trim();
    const message = $("message").value.trim();

    if (!ticketId || !message) {
      return setOutputs(
        { error: "Missing input" },
        { message: "Please enter ticket id + message." }
      );
    }

    try {
      await runWallet(ticketId, message);
    } catch (e) {
      setOutputs({ error: "Request failed" }, { message: String(e) });
    }
  });

  $("btnWalletSample").addEventListener("click", () => {
    $("message").value =
      "this is my wallet address TQXW8f7N2QwM4hK3p7xY7m4kq2r9uV4D8m please recover and send it to me";
  });
});
