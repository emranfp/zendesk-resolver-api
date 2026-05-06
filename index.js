require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const APP_VERSION = "zendesk-post-v1";
const PORT = process.env.PORT || 3000;

const USDT_ETH_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// Temporary memory only.
// If you stop the server, this data disappears.
// Later, this will be replaced with a real database.
const tickets = {};

async function fetchErc20TransfersFromEtherscan(txid) {
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&txhash=${txid}&apikey=${process.env.ETHERSCAN_API_KEY}`;
  const response = await axios.get(url);

  if (response.data && response.data.status === "1" && Array.isArray(response.data.result)) {
    return response.data.result;
  }

  return [];
}

async function detectEthereumTokenSimple(txid, tx) {
  if (!txid || !tx) {
    return {
      token: "UNKNOWN",
      token_standard: "UNKNOWN"
    };
  }

  // Simple safe version:
  // - If Etherscan reports an ERC20 transfer in this tx, and it's USDT -> USDT (ERC20)
  // - Else if native value > 0 -> ETH (native)
  // - Else -> UNKNOWN (could be contract interaction)
  const erc20Transfers = await fetchErc20TransfersFromEtherscan(txid);
  const usdtTransfer = erc20Transfers.find((t) => {
    const contract = (t.contractAddress || "").toLowerCase();
    return contract === USDT_ETH_CONTRACT.toLowerCase();
  });

  if (usdtTransfer) {
    return {
      token: "USDT",
      token_standard: "ERC20"
    };
  }

  if (tx.value && tx.value !== "0x0" && tx.value !== "0") {
    return {
      token: "ETH",
      token_standard: "NATIVE"
    };
  }

  return {
    token: "UNKNOWN",
    token_standard: "UNKNOWN"
  };
}

function matchPayment(expected, actual) {
  if (!actual || actual.status !== "FOUND") {
    return "tx_not_found";
  }

  if (expected.network !== actual.network) {
    return "wrong_network";
  }

  if (expected.token !== actual.token) {
    return "wrong_asset";
  }

  return "payment_valid";
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

  if (matchStatus === "tx_not_found") {
    return "Transaction was not found on Ethereum. Ask user to confirm TXID or network.";
  }

  return "Payment requires manual review.";
}

function getEmailToUser(matchStatus) {
  if (matchStatus === "payment_valid") {
    return "Hi, we found your payment and it matches the expected asset and network. Your payment can now be processed.";
  }

  if (matchStatus === "wrong_network" || matchStatus === "wrong_asset") {
    return "Hi, we found your payment, but it does not match the expected payment details. Please reply with the wallet address where you would like the recovery/refund to be sent.";
  }

  if (matchStatus === "tx_not_found") {
    return "Hi, we could not find this transaction on Ethereum. Please check the transaction hash and send it again.";
  }

  return "Hi, your payment requires manual review. Our team will check it and follow up with you.";
}

function validateWalletFormat(network, wallet) {
  if (!wallet) {
    return {
      valid: false,
      reason: "missing_wallet"
    };
  }

  if (network === "Ethereum") {
    if (wallet.startsWith("0x") && wallet.length === 42) {
      return {
        valid: true,
        reason: "valid_ethereum_wallet_format"
      };
    }

    return {
      valid: false,
      reason: "invalid_ethereum_wallet_format"
    };
  }

  if (network === "Tron") {
    if (wallet.startsWith("T")) {
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

  return {
    valid: false,
    reason: "unsupported_network"
  };
}

function extractEthereumWalletFromMessage(message) {
  if (!message) {
    return null;
  }

  const match = message.match(/0x[a-fA-F0-9]{40}/);

  if (match) {
    return match[0];
  }

  return null;
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
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance&address=${wallet}&tag=latest&apikey=${process.env.ETHERSCAN_API_KEY}`;

  const response = await axios.get(url);

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

async function processPaymentTicket(ticketId, txid) {
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionByHash&txhash=${txid}&apikey=${process.env.ETHERSCAN_API_KEY}`;

  const response = await axios.get(url);

  if (response.data && response.data.result) {
    const tx = response.data.result;
    const tokenDetection = await detectEthereumTokenSimple(txid, tx);
    const token = tokenDetection.token;

    // For normal testing, keep token as "USDT".
    // For wrong_asset test, temporarily change token to "ETH".
    const expectedPayment = {
      network: "Ethereum",
      token: "USDT"
    };

    const actualPayment = {
      status: "FOUND",
      network: "Ethereum",
      token: token
    };

    const matchStatus = matchPayment(expectedPayment, actualPayment);
    const tags = getZendeskTags(matchStatus);
    const internalNote = getZendeskInternalNote(matchStatus);
    const emailToUser = getEmailToUser(matchStatus);

    tickets[ticketId] = {
      ticket_id: ticketId,
      txid: txid,
      actual_network: "Ethereum",
      actual_token: token,
      expected_network: expectedPayment.network,
      expected_token: expectedPayment.token,
      match_status: matchStatus,
      needs_wallet:
        matchStatus === "wrong_network" || matchStatus === "wrong_asset",
      ops_approved: false,
      confirmo_ready: false,
      created_at: new Date().toISOString()
    };

    return {
      version: APP_VERSION,
      status: "PAYMENT_TICKET_PROCESSED",
      ticket_id: ticketId,
      saved_ticket_memory: tickets[ticketId],
      payment_result: {
        status: "FOUND",
        network: "Ethereum",
        token: token,
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
    };
  }

  tickets[ticketId] = {
    ticket_id: ticketId,
    txid: txid,
    actual_network: "Ethereum",
    actual_token: null,
    expected_network: "Ethereum",
    expected_token: "USDT",
    match_status: "tx_not_found",
    needs_wallet: false,
    ops_approved: false,
    confirmo_ready: false,
    created_at: new Date().toISOString()
  };

  return {
    version: APP_VERSION,
    status: "PAYMENT_TICKET_PROCESSED",
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
  };
}

async function processWalletReply(ticketId, message) {
  const storedTicket = tickets[ticketId];

  if (!storedTicket) {
    return {
      version: APP_VERSION,
      status: "TICKET_NOT_FOUND_IN_MEMORY",
      ticket_id: ticketId,
      user_message: message,
      zendesk_tags: ["crypto_ticket_memory_missing"],
      zendesk_internal_note:
        "No stored ticket memory found. Run payment ticket first or use a database in production.",
      next_action: "manual_review"
    };
  }

  if (!storedTicket.needs_wallet) {
    return {
      version: APP_VERSION,
      status: "WALLET_NOT_REQUIRED",
      ticket_id: ticketId,
      stored_ticket: storedTicket,
      user_message: message,
      zendesk_tags: ["crypto_wallet_not_required"],
      zendesk_internal_note:
        "This ticket does not require a refund wallet based on the stored payment result.",
      next_action: "no_wallet_action_needed"
    };
  }

  const network = storedTicket.actual_network;
  const extractedWallet = extractEthereumWalletFromMessage(message);

  if (!extractedWallet) {
    return {
      version: APP_VERSION,
      status: "NO_WALLET_FOUND",
      ticket_id: ticketId,
      stored_ticket: storedTicket,
      user_message: message,
      zendesk_tags: ["crypto_wallet_missing"],
      zendesk_internal_note:
        "User replied, but no Ethereum wallet address was found in the message.",
      next_action: "ask_user_for_wallet_again"
    };
  }

  const formatCheck = validateWalletFormat(network, extractedWallet);

  let chainCheck = {
    checked: false,
    reason: "chain_check_not_run"
  };

  if (formatCheck.valid && network === "Ethereum") {
    chainCheck = await checkEthereumWalletOnChain(extractedWallet);
  }

  if (formatCheck.valid && network === "Tron") {
    chainCheck = {
      checked: false,
      reason: "tron_chain_check_not_added_yet"
    };
  }

  const walletReadyForRecovery =
    formatCheck.valid && chainCheck.valid_on_chain === true;

  storedTicket.refund_wallet = extractedWallet;
  storedTicket.wallet_ready_for_recovery = walletReadyForRecovery;
  storedTicket.ops_approved = false;
  storedTicket.confirmo_ready = false;
  storedTicket.updated_at = new Date().toISOString();

  return {
    version: APP_VERSION,
    status: "WALLET_REPLY_PROCESSED",
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
  };
}

app.get("/", (req, res) => {
  res.json({
    message: "Crypto payment resolver is running",
    version: APP_VERSION,
    stored_tickets_count: Object.keys(tickets).length
  });
});

// Realistic Zendesk-style POST endpoint
app.post("/zendesk/payment-ticket", async (req, res) => {
  const ticketId = req.body.ticket_id;
  const txid = req.body.txid;

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
    const result = await processPaymentTicket(ticketId, txid);
    return res.json(result);
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

// Realistic Zendesk-style POST endpoint
app.post("/zendesk/wallet-reply", async (req, res) => {
  const ticketId = req.body.ticket_id;
  const message = req.body.message;

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

  try {
    const result = await processWalletReply(ticketId, message);
    return res.json(result);
  } catch (error) {
    return res.json({
      version: APP_VERSION,
      status: "ERROR",
      message: error.message,
      ticket_id: ticketId,
      zendesk_tags: ["crypto_wallet_reply_error"],
      zendesk_internal_note:
        "Wallet reply processing failed. Manual review required.",
      next_action: "manual_review"
    });
  }
});

// Browser testing endpoint
app.get("/simulate-zendesk-ticket", async (req, res) => {
  const ticketId = req.query.ticket_id;
  const txid = req.query.txid;

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
    const result = await processPaymentTicket(ticketId, txid);
    return res.json({
      ...result,
      status: "SIMULATED_ZENDESK_TICKET_PROCESSED"
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

// Browser testing endpoint
app.get("/simulate-zendesk-wallet-reply", async (req, res) => {
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

  try {
    const result = await processWalletReply(ticketId, message);
    return res.json({
      ...result,
      status:
        result.status === "WALLET_REPLY_PROCESSED"
          ? "SIMULATED_ZENDESK_WALLET_REPLY_PROCESSED"
          : result.status
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

app.get("/simulate-ops-approval", (req, res) => {
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

app.get("/simulate-confirmo-recovery", (req, res) => {
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

app.get("/debug-tickets", (req, res) => {
  res.json({
    version: APP_VERSION,
    tickets: tickets
  });
});

app.listen(PORT, () => {
  console.log(`Resolver running on http://localhost:${PORT}`);
  console.log(`Version: ${APP_VERSION}`);
});