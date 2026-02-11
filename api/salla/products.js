const {
  envConfig,
  sendJson,
  debugId,
  readSession,
  writeSession,
  parseUpstreamResponse,
  tokenRequest,
} = require('../_lib/salla');

async function fetchProductsPage(config, accessToken, page) {
  const resp = await fetch(`${config.apiBase}/admin/v2/products?page=${page}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  return parseUpstreamResponse(resp);
}

function hasNextPage(payload, page, maxPages) {
  if (page >= maxPages) return false;
  const pagination = payload && payload.pagination;
  if (pagination && Number.isFinite(pagination.currentPage) && Number.isFinite(pagination.totalPages)) {
    return pagination.currentPage < pagination.totalPages;
  }
  const links = pagination && pagination.links;
  return Boolean(links && links.next);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const id = debugId();
  const config = envConfig();

  if (!config.appSecret) return sendJson(res, 500, { error: 'Missing APP_SESSION_SECRET', debug_id: id });

  const session = readSession(req, config);
  if (!session || !session.access_token) {
    return sendJson(res, 401, { error: 'Not connected. Connect first.', debug_id: id });
  }

  async function run(accessToken) {
    const all = [];
    let page = 1;
    let lastPayload = null;

    while (page <= 5) {
      const upstream = await fetchProductsPage(config, accessToken, page);
      console.log(`[salla:${id}] products status=${upstream.status} page=${page}`);
      if (upstream.status >= 400) {
        return { failed: true, status: upstream.status, payload: upstream.body };
      }
      if (Array.isArray(upstream.body && upstream.body.data)) {
        all.push(...upstream.body.data);
      }
      lastPayload = upstream.body;
      if (!hasNextPage(upstream.body, page, 5)) break;
      page += 1;
    }

    return {
      failed: false,
      status: 200,
      payload: {
        success: true,
        count: all.length,
        data: all,
        pagination: {
          pages_fetched: page,
          limited_to: 5,
          last: (lastPayload && lastPayload.pagination) || null,
        },
      },
    };
  }

  try {
    let result = await run(session.access_token);

    if (result.failed && (result.status === 401 || result.status === 403) && session.refresh_token) {
      const refreshed = await tokenRequest(config, {
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      console.log(`[salla:${id}] products refresh status=${refreshed.status}`);

      if (refreshed.status < 400 && refreshed.body && refreshed.body.access_token) {
        const updated = {
          ...session,
          access_token: refreshed.body.access_token,
          refresh_token: refreshed.body.refresh_token || session.refresh_token,
          updated_at: Date.now(),
        };
        writeSession(res, config, updated);
        result = await run(updated.access_token);
      }
    }

    if (result.failed) {
      return sendJson(res, result.status, {
        status: result.status,
        body: result.payload,
        debug_id: id,
      });
    }

    return sendJson(res, 200, {
      ...result.payload,
      debug_id: id,
      first_item: result.payload.data[0] || null,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message, debug_id: id });
  }
};
