const { envConfig, sendJson, readSession } = require('./_lib/salla');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const config = envConfig();
  const session = config.appSecret ? readSession(req, config) : null;
  const expiresIn = Number(session && session.expires_in);
  const updatedAt = Number(session && session.updated_at);
  const expiresAt =
    Number.isFinite(expiresIn) && Number.isFinite(updatedAt)
      ? (updatedAt + expiresIn * 1000)
      : null;

  return sendJson(res, 200, {
    connected: Boolean(session && session.access_token),
    expires_at: expiresAt,
    has_credentials: Boolean(config.clientId && config.clientSecret),
    redirect_uri: config.redirectUri || null,
  });
};
