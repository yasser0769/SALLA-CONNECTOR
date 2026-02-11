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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function envConfig() {
  return {
    clientId: process.env.SALLA_CLIENT_ID || '',
    clientSecret: process.env.SALLA_CLIENT_SECRET || '',
    redirectUri: process.env.SALLA_REDIRECT_URI || '',
  };
}

function toFormUrlEncoded(payload) {
  return new URLSearchParams(payload).toString();
}

async function parseUpstreamResponse(resp) {
  const raw = await resp.text();
  try {
    return { status: resp.status, data: JSON.parse(raw) };
  } catch {
    return {
      status: resp.status,
      data: {
        error: 'Non-JSON',
        raw: raw.slice(0, 500),
      },
    };
  }
}

function getNextUrlFromResponse(url, data) {
  const links = data && data.pagination && data.pagination.links;
  if (links && typeof links.next === 'string' && links.next.trim()) {
    return links.next;
  }

  const pagination = data && data.pagination;
  if (pagination && Number.isFinite(pagination.currentPage) && Number.isFinite(pagination.totalPages)) {
    if (pagination.currentPage < pagination.totalPages) {
      const next = new URL(url);
      next.searchParams.set('page', String(pagination.currentPage + 1));
      return next.toString();
    }
  }

  return null;
}

async function proxySallaRequest({ url, method, token, requestBody }) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  };

  if (method !== 'GET' && method !== 'HEAD' && requestBody !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(requestBody);
  }

  return fetch(url, options);
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const action = req.query && req.query.action;
    const body = parseBody(req);
    const config = envConfig();

    if (action === 'ping') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (action === 'config') {
      return sendJson(res, 200, {
        ok: true,
        client_id: config.clientId || null,
        redirect_uri: config.redirectUri || null,
      });
    }

    if (action === 'token') {
      const code = body.code;
      if (!code) {
        return sendJson(res, 400, { error: 'Missing required field: code' });
      }
      if (!config.clientId || !config.clientSecret || !config.redirectUri) {
        return sendJson(res, 500, { error: 'Missing SALLA_CLIENT_ID/SALLA_CLIENT_SECRET/SALLA_REDIRECT_URI in env' });
      }

      const formBody = toFormUrlEncoded({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        scope: 'offline_access',
      });

      const resp = await fetch('https://accounts.salla.sa/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: formBody,
      });

      const parsed = await parseUpstreamResponse(resp);
      return sendJson(res, parsed.status, parsed.data);
    }

    if (action === 'refresh') {
      const refreshToken = body.refresh_token;
      if (!refreshToken) {
        return sendJson(res, 400, { error: 'Missing required field: refresh_token' });
      }
      if (!config.clientId || !config.clientSecret || !config.redirectUri) {
        return sendJson(res, 500, { error: 'Missing SALLA_CLIENT_ID/SALLA_CLIENT_SECRET/SALLA_REDIRECT_URI in env' });
      }

      const formBody = toFormUrlEncoded({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        redirect_uri: config.redirectUri,
        scope: 'offline_access',
      });

      const resp = await fetch('https://accounts.salla.sa/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: formBody,
      });

      const parsed = await parseUpstreamResponse(resp);
      return sendJson(res, parsed.status, parsed.data);
    }

    if (action === 'api') {
      const url = body.url;
      const method = (body.method || 'GET').toUpperCase();
      const token = body.token;
      const requestBody = body.body;
      const paginate = body.paginate !== false;

      if (!url || !token) {
        return sendJson(res, 400, { error: 'Missing url or token' });
      }

      if (method === 'GET' && paginate) {
        let currentUrl = url;
        let pageCount = 0;
        const maxPages = 50;
        const combinedData = [];
        let lastPayload = null;
        let lastStatus = 200;

        while (currentUrl && pageCount < maxPages) {
          const resp = await proxySallaRequest({
            url: currentUrl,
            method,
            token,
            requestBody,
          });
          const parsed = await parseUpstreamResponse(resp);
          lastStatus = parsed.status;
          lastPayload = parsed.data;

          if (parsed.status >= 400) {
            return sendJson(res, parsed.status, parsed.data);
          }

          if (Array.isArray(parsed.data && parsed.data.data)) {
            combinedData.push(...parsed.data.data);
          }

          pageCount += 1;
          currentUrl = getNextUrlFromResponse(currentUrl, parsed.data);
        }

        const pagination = Object.assign({}, (lastPayload && lastPayload.pagination) || {}, {
          combinedCount: combinedData.length,
          pagesFetched: pageCount,
          hasMore: Boolean(currentUrl),
        });

        return sendJson(res, lastStatus, {
          success: true,
          data: combinedData,
          pagination,
        });
      }

      const resp = await proxySallaRequest({
        url,
        method,
        token,
        requestBody,
      });
      const parsed = await parseUpstreamResponse(resp);
      return sendJson(res, parsed.status, parsed.data);
    }

    return sendJson(res, 400, { error: 'Unknown action. Use: ping, config, token, refresh, api' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unexpected server error' });
  }
};
