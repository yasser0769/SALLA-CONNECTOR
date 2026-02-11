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

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query && req.query.action;
  const body = parseBody(req);

  if (action === 'ping') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  if (action === 'token') {
    const code = body.code;
    const clientId = body.client_id || process.env.SALLA_CLIENT_ID || '';
    const clientSecret = body.client_secret || process.env.SALLA_CLIENT_SECRET || '';
    const redirectUri = body.redirect_uri || process.env.SALLA_REDIRECT_URI || '';

    if (!code || !clientId || !clientSecret) {
      return sendJson(res, 400, {
        error: 'Missing required fields: code, client_id, client_secret',
      });
    }

    try {
      const resp = await fetch('https://accounts.salla.sa/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });

      const parsed = await parseUpstreamResponse(resp);
      return sendJson(res, parsed.status, parsed.data);
    } catch (error) {
      return sendJson(res, 500, { error: error.message || 'Token request failed' });
    }
  }

  if (action === 'refresh') {
    const refreshToken = body.refresh_token;
    const clientId = body.client_id || process.env.SALLA_CLIENT_ID || '';
    const clientSecret = body.client_secret || process.env.SALLA_CLIENT_SECRET || '';

    if (!refreshToken || !clientId || !clientSecret) {
      return sendJson(res, 400, {
        error: 'Missing required fields: refresh_token, client_id, client_secret',
      });
    }

    try {
      const resp = await fetch('https://accounts.salla.sa/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      const parsed = await parseUpstreamResponse(resp);
      return sendJson(res, parsed.status, parsed.data);
    } catch (error) {
      return sendJson(res, 500, { error: error.message || 'Refresh request failed' });
    }
  }

  if (action === 'api') {
    const url = body.url;
    const method = (body.method || 'GET').toUpperCase();
    const token = body.token;
    const requestBody = body.body;

    if (!url || !token) {
      return sendJson(res, 400, { error: 'Missing url or token' });
    }

    try {
      const options = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      };

      if (method !== 'GET' && method !== 'HEAD' && requestBody !== undefined) {
        options.body = JSON.stringify(requestBody);
      }

      const resp = await fetch(url, options);
      const parsed = await parseUpstreamResponse(resp);
      return sendJson(res, parsed.status, parsed.data);
    } catch (error) {
      return sendJson(res, 500, { error: error.message || 'Proxy request failed' });
    }
  }

  return sendJson(res, 400, { error: 'Unknown action. Use: ping, token, refresh, api' });
};
