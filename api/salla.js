const {
  envConfig,
  parseUpstreamResponse,
  tokenRequest,
  readSession,
  writeSession,
  debugId,
} = require('./_lib/salla');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function sendJson(res, status, payload) {
  setCors(res);
  return res.status(status).send(JSON.stringify(payload));
}

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
    console.log(`[salla:${id}] products_page status=${upstream.status} page=${page} attempt=${attempt + 1}`);

    if (upstream.status !== 429 && (upstream.status < 500 || upstream.status > 599)) return upstream;

    last = upstream;
    attempt += 1;
    if (attempt < 3) await sleep(300 * attempt);
  }
  return last;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = debugId();
  const action = req.query && req.query.action;
  const config = envConfig();

  if (action === 'ping') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString(), debug_id: id });
  }

  if (action === 'products_page') {
    const required = ['SALLA_CLIENT_ID', 'SALLA_CLIENT_SECRET', 'SALLA_REDIRECT_URI', 'APP_SESSION_SECRET'];
    const missing = [];
    if (!config.clientId) missing.push('SALLA_CLIENT_ID');
    if (!config.clientSecret) missing.push('SALLA_CLIENT_SECRET');
    if (!config.redirectUri) missing.push('SALLA_REDIRECT_URI');
    if (!config.appSecret) missing.push('APP_SESSION_SECRET');
    if (missing.length) {
      return sendJson(res, 500, { error: 'Missing required env vars', missing, debug_id: id });
    }

    const session = readSession(req, config);
    if (!session || !session.access_token) {
      return sendJson(res, 401, { error: 'Not connected. Connect first.', debug_id: id });
    }

    const page = Number(req.query && req.query.page) > 0 ? Number(req.query.page) : 1;
    const perPage = Number(req.query && req.query.per_page) > 0 ? Number(req.query.per_page) : 100;

    async function run(token) {
      return fetchWithRetry(config, token, page, perPage, id);
    }

    try {
      let upstream = await run(session.access_token);

      if ((upstream.status === 401 || upstream.status === 403) && session.refresh_token) {
        const refreshed = await tokenRequest(config, {
          grant_type: 'refresh_token',
          refresh_token: session.refresh_token,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        });
        console.log(`[salla:${id}] products_page refresh status=${refreshed.status}`);

        if (refreshed.status < 400 && refreshed.body && refreshed.body.access_token) {
          writeSession(res, config, {
            ...session,
            access_token: refreshed.body.access_token,
            refresh_token: refreshed.body.refresh_token || session.refresh_token,
            updated_at: Date.now(),
          });
          upstream = await run(refreshed.body.access_token);
        }
      }

      const body = upstream.body || {};
      const items = Array.isArray(body.data) ? body.data : (body.data && Array.isArray(body.data.data) ? body.data.data : (Array.isArray(body.items) ? body.items : []));
      const pagination = body.pagination || body.meta || body.links || null;

      let totalPages = null;
      if (pagination && typeof pagination === 'object') {
        const candidates = [pagination.total_pages, pagination.totalPages, pagination.last_page, pagination.lastPage, pagination.pages];
        for (const c of candidates) {
          const n = Number(c);
          if (Number.isFinite(n) && n > 0) { totalPages = n; break; }
        }
      }

      const nextPage = totalPages
        ? (page < totalPages ? page + 1 : null)
        : (items.length < perPage ? null : page + 1);

      return sendJson(res, upstream.status, {
        items,
        page,
        per_page: perPage,
        next_page: nextPage,
        total_pages: totalPages,
        pagination,
        upstream_status: upstream.status,
        body,
        debug_id: id,
      });
    } catch (error) {
      return sendJson(res, 500, { error: error.message, debug_id: id, page, per_page: perPage });
    }
  }

  return sendJson(res, 400, {
    error: 'Unknown action for /api/salla. Use action=ping or action=products_page',
    debug_id: id,
  });
};
