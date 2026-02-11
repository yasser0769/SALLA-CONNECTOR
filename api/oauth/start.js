const crypto = require('crypto');
const { envConfig, writeState } = require('../_lib/salla');

module.exports = async function handler(req, res) {
  const config = envConfig();

  if (!config.clientId || !config.redirectUri || !config.accountsBase || !config.appSecret) {
    return res.status(500).json({
      error: 'Missing required env vars: SALLA_CLIENT_ID, SALLA_REDIRECT_URI, APP_SESSION_SECRET',
    });
  }

  const state = crypto.randomBytes(16).toString('hex');
  writeState(res, config, state);

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: 'offline_access',
    state,
  });

  const redirectTo = `${config.accountsBase}/oauth2/auth?${params.toString()}`;
  return res.redirect(302, redirectTo);
};
