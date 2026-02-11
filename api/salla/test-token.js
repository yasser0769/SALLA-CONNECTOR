const {
  envConfig,
  sendJson,
  debugId,
  readSession,
  writeSession,
  parseUpstreamResponse,
  tokenRequest,
} = require('../_lib/salla');

function buildStoreInfoUrl(apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  if (base.endsWith('/admin/v2')) return `${base}/store/info`;
  return `${base}/admin/v2/store/info`;
}

async function callStore(config, accessToken) {
  const storeUrl = buildStoreInfoUrl(config.apiBase);
  const resp = await fetch(storeUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  return parseUpstreamResponse(resp);
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

  try {
    let upstream = await callStore(config, session.access_token);
    console.log(`[salla:${id}] test-token status=${upstream.status} path=${buildStoreInfoUrl(config.apiBase)}`);

    if ((upstream.status === 401 || upstream.status === 403) && session.refresh_token) {
      const refreshed = await tokenRequest(config, {
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      console.log(`[salla:${id}] refresh attempt status=${refreshed.status}`);

      if (refreshed.status < 400 && refreshed.body && refreshed.body.access_token) {
        writeSession(res, config, {
          ...session,
          access_token: refreshed.body.access_token,
          refresh_token: refreshed.body.refresh_token || session.refresh_token,
          updated_at: Date.now(),
        });
        upstream = await callStore(config, refreshed.body.access_token);
        console.log(`[salla:${id}] test-token retry status=${upstream.status} path=${buildStoreInfoUrl(config.apiBase)}`);
      }
    }

    return sendJson(res, upstream.status, {
      status: upstream.status,
      body: upstream.body,
      debug_id: id,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message, debug_id: id });
  }
};
