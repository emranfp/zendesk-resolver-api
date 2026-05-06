const axios = require("axios");

function createZendeskClient() {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const apiToken = process.env.ZENDESK_API_TOKEN;

  const enabled = Boolean(subdomain && email && apiToken);

  const baseUrl = enabled ? `https://${subdomain}.zendesk.com/api/v2` : null;
  const auth = enabled ? { username: `${email}/token`, password: apiToken } : null;

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

    const response = await axios({
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

