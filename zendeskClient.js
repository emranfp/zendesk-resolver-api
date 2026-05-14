const axios = require("axios");

function createZendeskClient() {
  const subdomain = process.env.ZENDESK_SUBDOMAIN || process.env.ZD_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL || process.env.ZD_EMAIL;
  const apiToken = process.env.ZENDESK_API_TOKEN || process.env.ZD_TOKEN;

  const enabled = Boolean(subdomain && email && apiToken);

  const baseUrl = enabled ? `https://${subdomain}.zendesk.com/api/v2` : null;
  const auth = enabled ? { username: `${email}/token`, password: apiToken } : null;

  const client = axios.create({ timeout: 20000 });
  const retryBaseDelay = Number(process.env.ZENDESK_RETRY_BASE_DELAY_MS || 300);
  const retryMaxAttempts = Number(process.env.ZENDESK_RETRY_MAX_ATTEMPTS || 3);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function shouldRetry(error) {
    const status = error && error.response ? Number(error.response.status) : 0;
    if (!status) return true;
    return status === 429 || (status >= 500 && status <= 599);
  }

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error && error.config ? error.config : null;
      if (!config) throw error;
      config.__retryCount = Number(config.__retryCount || 0);
      if (!shouldRetry(error) || config.__retryCount >= retryMaxAttempts - 1) {
        throw error;
      }
      config.__retryCount += 1;
      const delay = retryBaseDelay * Math.pow(2, config.__retryCount - 1);
      await sleep(delay);
      return client.request(config);
    }
  );

  async function request(method, path, data) {
    if (!enabled) {
      return {
        enabled: false,
        skipped: true,
        method,
        path,
        data
      };
    }

    const response = await client({
      method,
      url: `${baseUrl}${path}`,
      auth,
      data,
      timeout: 20000
    });

    return response.data;
  }

  async function addInternalNote(ticketId, noteText) {
    return await request("PUT", `/tickets/${ticketId}.json`, {
      ticket: {
        comment: {
          body: noteText,
          public: false
        }
      }
    });
  }

  async function addPublicReply(ticketId, bodyText) {
    return await request("PUT", `/tickets/${ticketId}.json`, {
      ticket: {
        comment: {
          body: bodyText,
          public: true
        }
      }
    });
  }

  async function addTags(ticketId, tags) {
    return await request("PUT", `/tickets/${ticketId}.json`, {
      ticket: {
        additional_tags: tags
      }
    });
  }

  async function setCustomFields(ticketId, customFields) {
    // customFields: [{ id: 123, value: "abc" }]
    return await request("PUT", `/tickets/${ticketId}.json`, {
      ticket: {
        custom_fields: customFields
      }
    });
  }

  return {
    enabled,
    addInternalNote,
    addPublicReply,
    addTags,
    setCustomFields
  };
}

module.exports = { createZendeskClient };

