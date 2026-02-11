module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query && req.query.action;
  if (action === 'ping') {
    return res.status(200).send(JSON.stringify({ ok: true, time: new Date().toISOString() }));
  }

  return res.status(400).send(JSON.stringify({
    error: 'Unknown action for /api/salla. Use /api/salla?action=ping or new routes: /api/oauth/* and /api/salla/*',
  }));
};
