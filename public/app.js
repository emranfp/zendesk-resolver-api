function $(id) {
  return document.getElementById(id);
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

async function pingServer() {
  const pill = $("serverPill");
  try {
    const res = await fetch("/debug-tickets");
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
  $("reqOut").textContent = req ? pretty(req) : "-";
  $("resOut").textContent = res ? pretty(res) : "-";
}

async function runResolve(ticketId, txid) {
  const url = `/zendesk/payment-ticket`;
  const body = { ticket_id: ticketId, txid };

  setOutputs({ method: "POST", url, body }, null);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  setOutputs({ method: "POST", url, body }, data);
}

async function runWallet(ticketId, message) {
  const url = `/zendesk/wallet-reply`;
  const body = { ticket_id: ticketId, message };

  setOutputs({ method: "POST", url, body }, null);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  setOutputs({ method: "POST", url, body }, data);
}

async function runConfirmoInput(ticketId, invoiceId, expectedAssetNetwork, expectedWalletAddress) {
  const url = `/zendesk/confirmo-input`;
  const body = {
    ticket_id: ticketId,
    confirmo_invoice_id: invoiceId,
    expected_asset_network: expectedAssetNetwork,
    expected_wallet_address: expectedWalletAddress
  };

  setOutputs({ method: "POST", url, body }, null);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  setOutputs({ method: "POST", url, body }, data);
}

window.addEventListener("DOMContentLoaded", () => {
  pingServer();

  $("btnResolve").addEventListener("click", async () => {
    const ticketId = $("ticketId").value.trim();
    const txid = $("txid").value.trim();
    $("ticketId2").value = ticketId;
    $("ticketIdConfirmo").value = ticketId;

    if (!ticketId || !txid) {
      return setOutputs(
        { error: "Missing input" },
        { message: "Please enter ticket id + txid." }
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
