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

function newDebugId() {
  return Math.random().toString(36).slice(2, 8);
}

function logDebug(debugId, message, extra) {
  console.log(`[salla:${debugId}] ${message}`, extra || '');
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

async function requestTokenByGrant(config, payload) {
  const formBody = toFormUrlEncoded(payload);
  const resp = await fetch('https://accounts.salla.sa/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formBody,
  });
  return parseUpstreamResponse(resp);
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

  const debugId = newDebugId();

  try {
    const action = req.query && req.query.action;
    const body = parseBody(req);
    const config = envConfig();

    if (action === 'ping') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString(), debug_id: debugId });
    }

    if (action === 'config') {
      return sendJson(res, 200, {
        ok: true,
        client_id: config.clientId || null,
        redirect_uri: config.redirectUri || null,
        debug_id: debugId,
      });
    }

    if (action === 'token') {
      const code = body.code;
      if (!code) {
        return sendJson(res, 400, { error: 'Missing required field: code', debug_id: debugId });
      }
      if (!config.clientId || !config.clientSecret || !config.redirectUri) {
        return sendJson(res, 500, {
          error: 'Missing SALLA_CLIENT_ID/SALLA_CLIENT_SECRET/SALLA_REDIRECT_URI in env',
          debug_id: debugId,
        });
      }

      const parsed = await requestTokenByGrant(config, {
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        scope: 'offline_access',
      });

      logDebug(debugId, 'oauth token exchange', { status: parsed.status });
      return sendJson(res, parsed.status, Object.assign({}, parsed.data, { debug_id: debugId }));
    }

    if (action === 'refresh') {
      const refreshToken = body.refresh_token;
      if (!refreshToken) {
        return sendJson(res, 400, { error: 'Missing required field: refresh_token', debug_id: debugId });
      }
      if (!config.clientId || !config.clientSecret || !config.redirectUri) {
        return sendJson(res, 500, {
          error: 'Missing SALLA_CLIENT_ID/SALLA_CLIENT_SECRET/SALLA_REDIRECT_URI in env',
          debug_id: debugId,
        });
      }

      const parsed = await requestTokenByGrant(config, {
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        redirect_uri: config.redirectUri,
        scope: 'offline_access',
      });

      logDebug(debugId, 'oauth refresh exchange', { status: parsed.status });
      return sendJson(res, parsed.status, Object.assign({}, parsed.data, { debug_id: debugId }));
    }

    if (action === 'api') {
      const url = body.url;
      const method = (body.method || 'GET').toUpperCase();
      const token = body.token;
      const requestBody = body.body;
      const paginate = body.paginate !== false;
      const refreshToken = body.refresh_token;

      if (!url || !token) {
        return sendJson(res, 400, { error: 'Missing url or token', debug_id: debugId });
      }

      async function executeWithToken(currentToken) {
        if (method === 'GET' && paginate) {
          let currentUrl = url;
          let pageCount = 0;
          const maxPages = 50;
          const combinedData = [];
          let lastPayload = null;
          let lastStatus = 200;

          while (currentUrl && pageCount < maxPages) {
            logDebug(debugId, 'proxy request', { url: currentUrl, method });
            const resp = await proxySallaRequest({
              url: currentUrl,
              method,
              token: currentToken,
              requestBody,
            });
            const parsed = await parseUpstreamResponse(resp);
            logDebug(debugId, 'proxy response', { status: parsed.status, url: currentUrl });
            lastStatus = parsed.status;
            lastPayload = parsed.data;

            if (parsed.status >= 400) {
              return { failed: true, status: parsed.status, payload: parsed.data };
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

          return {
            failed: false,
            status: lastStatus,
            payload: {
              success: true,
              data: combinedData,
              pagination,
            },
          };
        }

        logDebug(debugId, 'proxy request', { url, method });
        const resp = await proxySallaRequest({
          url,
          method,
          token: currentToken,
          requestBody,
        });
        const parsed = await parseUpstreamResponse(resp);
        logDebug(debugId, 'proxy response', { status: parsed.status, url });
        if (parsed.status >= 400) {
          return { failed: true, status: parsed.status, payload: parsed.data };
        }

        return { failed: false, status: parsed.status, payload: parsed.data };
      }

      const firstTry = await executeWithToken(token);
      if (!firstTry.failed) {
        return sendJson(res, firstTry.status, Object.assign({}, firstTry.payload, { debug_id: debugId }));
      }

      if (firstTry.status === 401 && refreshToken && config.clientId && config.clientSecret && config.redirectUri) {
        const refreshParsed = await requestTokenByGrant(config, {
          grant_type: 'refresh_token',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
          redirect_uri: config.redirectUri,
          scope: 'offline_access',
        });
        logDebug(debugId, 'proxy auto-refresh attempt', { status: refreshParsed.status });

        if (refreshParsed.status < 400 && refreshParsed.data && refreshParsed.data.access_token) {
          const retry = await executeWithToken(refreshParsed.data.access_token);
          if (!retry.failed) {
            return sendJson(res, retry.status, Object.assign({}, retry.payload, {
              debug_id: debugId,
              refreshed_access_token: refreshParsed.data.access_token,
              refreshed_refresh_token: refreshParsed.data.refresh_token || null,
            }));
          }
          return sendJson(res, retry.status, Object.assign({}, retry.payload, {
            debug_id: debugId,
            refresh_attempted: true,
          }));
        }

        return sendJson(res, firstTry.status, Object.assign({}, firstTry.payload, {
          debug_id: debugId,
          refresh_attempted: true,
          refresh_error: refreshParsed.data,
        }));
      }

      return sendJson(res, firstTry.status, Object.assign({}, firstTry.payload, { debug_id: debugId }));
    }

    return sendJson(res, 400, {
      error: 'Unknown action. Use: ping, config, token, refresh, api',
      debug_id: debugId,
    });
  } catch (error) {
    logDebug(debugId, 'handler crash', { message: error.message });
    return sendJson(res, 500, { error: error.message || 'Unexpected server error', debug_id: debugId });
  }
};
