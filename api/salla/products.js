const {
  envConfig,
  sendJson,
  debugId,
  readSession,
  writeSession,
  parseUpstreamResponse,
  tokenRequest,
} = require('../_lib/salla');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchProductsPage(config, accessToken, page, perPage) {
  const resp = await fetch(`${config.apiBase}/admin/v2/products?page=${page}&per_page=${perPage}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  return parseUpstreamResponse(resp);
}

async function fetchWithRetry(config, accessToken, page, perPage, id) {
  let attempt = 0;
  let last;
  while (attempt < 3) {
    const upstream = await fetchProductsPage(config, accessToken, page, perPage);
    console.log(`[salla:${id}] products status=${upstream.status} page=${page} attempt=${attempt + 1}`);

    if (upstream.status !== 429 && (upstream.status < 500 || upstream.status > 599)) {
      return upstream;
    }

    last = upstream;
    attempt += 1;
    if (attempt < 3) {
      await sleep(300 * attempt);
    }
  }
  return last;
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

  const page = Number(req.query && req.query.page) > 0 ? Number(req.query.page) : 1;
  const perPage = Number(req.query && req.query.per_page) > 0 ? Number(req.query.per_page) : 100;

  async function callOnce(accessToken) {
    return fetchWithRetry(config, accessToken, page, perPage, id);
  }

  try {
    let upstream = await callOnce(session.access_token);

    if ((upstream.status === 401 || upstream.status === 403) && session.refresh_token) {
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
        upstream = await callOnce(updated.access_token);
      }
    }

    return sendJson(res, upstream.status, {
      status: upstream.status,
      body: upstream.body,
      debug_id: id,
      page,
      per_page: perPage,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message, debug_id: id, page, per_page: perPage });
  }
};
