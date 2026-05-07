function matchPayment(expected, actual) {
  if (!actual || actual.status !== "FOUND") {
    return "tx_not_found";
  }

  if (actual.token === "BNB" || actual.network === "opBNB") {
    return "funds_lost_wrong_asset";
  }

  if (expected.network !== actual.network) {
    return "wrong_network";
  }

  if (expected.token !== actual.token) {
    return "wrong_asset";
  }

  return "payment_valid";
}

function normalizeWalletForCompare(wallet) {
  if (!wallet) {
    return "";
  }
  return String(wallet).trim().toLowerCase();
}

function computeMatchStatusWithWallet({ expected, actual, expectedWallet, actualReceiver }) {
  return computeMatchDetails({ expected, actual, expectedWallet, actualReceiver }).status;
}

function computeMatchDetails({ expected, actual, expectedWallet, actualReceiver }) {
  const walletMatches =
    normalizeWalletForCompare(expectedWallet) === normalizeWalletForCompare(actualReceiver);

  // Keep existing product behavior for "not found" and "funds lost" cases.
  const baseStatus = matchPayment(expected, actual);
  if (baseStatus === "tx_not_found" || baseStatus === "funds_lost_wrong_asset") {
    return {
      status: baseStatus,
      wallet_match: walletMatches,
      network_match: false,
      token_match: false,
      asset_network_match: false
    };
  }

  const networkMatches = expected && actual && expected.network === actual.network;
  const tokenMatches = expected && actual && expected.token === actual.token;
  const assetNetworkMatch = Boolean(networkMatches && tokenMatches);

  // Evaluate all dimensions and use deterministic precedence.
  let status = "payment_valid";
  if (!networkMatches) {
    status = "wrong_network";
  } else if (!tokenMatches) {
    status = "wrong_asset";
  } else if (!walletMatches) {
    status = "wrong_wallet_address";
  }

  return {
    status,
    wallet_match: walletMatches,
    network_match: Boolean(networkMatches),
    token_match: Boolean(tokenMatches),
    asset_network_match: assetNetworkMatch
  };
}

module.exports = {
  matchPayment,
  normalizeWalletForCompare,
  computeMatchStatusWithWallet,
  computeMatchDetails
};
