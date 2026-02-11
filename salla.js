export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // Health check
  if (action === 'ping') {
    return res.status(200).json({ ok: true, time: new Date().toISOString() });
  }

  // Exchange code for token
  if (action === 'token') {
    const { code, client_id, client_secret, redirect_uri } = req.body || {};
    if (!code || !client_id || !client_secret) {
      return res.status(400).json({ error: 'Missing required fields: code, client_id, client_secret' });
    }
    try {
      const resp = await fetch('https://accounts.salla.sa/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id,
          client_secret,
          code,
          redirect_uri: redirect_uri || '',
        }),
      });
      const text = await resp.text();
      try { return res.status(resp.status).json(JSON.parse(text)); }
      catch { return res.status(resp.status).json({ error: 'Non-JSON from Salla', raw: text.slice(0, 500) }); }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Refresh token
  if (action === 'refresh') {
    const { refresh_token, client_id, client_secret } = req.body || {};
    if (!refresh_token || !client_id || !client_secret) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
      const resp = await fetch('https://accounts.salla.sa/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id,
          client_secret,
          refresh_token,
        }),
      });
      const text = await resp.text();
      try { return res.status(resp.status).json(JSON.parse(text)); }
      catch { return res.status(resp.status).json({ error: 'Non-JSON', raw: text.slice(0, 500) }); }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Proxy API requests to Salla
  if (action === 'api') {
    const { url, method, token, body } = req.body || {};
    if (!url || !token) {
      return res.status(400).json({ error: 'Missing url or token' });
    }
    try {
      const opts = {
        method: method || 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      };
      if (body && method && method !== 'GET') {
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(url, opts);
      const text = await resp.text();
      try { return res.status(resp.status).json(JSON.parse(text)); }
      catch { return res.status(resp.status).json({ error: 'Non-JSON from Salla API', raw: text.slice(0, 500) }); }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use: ping, token, refresh, api' });
}
