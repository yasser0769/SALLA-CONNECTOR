export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ============ ACTION: Exchange code for token ============
  if (action === 'token') {
    const { code, client_id, client_secret, redirect_uri } = req.body || {};
    if (!code || !client_id || !client_secret) {
      return res.status(400).json({ error: 'Missing required fields' });
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
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ============ ACTION: Refresh token ============
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
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ============ ACTION: Proxy API requests to Salla ============
  if (action === 'api') {
    const { url, method, token, body } = req.body || {};
    if (!url || !token) {
      return res.status(400).json({ error: 'Missing url or token' });
    }
    try {
      const opts = {
        method: method || 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      };
      if (body && method && method !== 'GET') {
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(url, opts);
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use: token, refresh, or api' });
}
