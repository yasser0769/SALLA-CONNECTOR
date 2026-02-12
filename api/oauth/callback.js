const {
  envConfig,
  tokenRequest,
  readState,
  clearState,
  writeSession,
} = require('../_lib/salla');

module.exports = async function handler(req, res) {
  const config = envConfig();
  const code = req.query && req.query.code;
  const incomingState = req.query && req.query.state;

  if (!config.clientId || !config.clientSecret || !config.redirectUri || !config.accountsBase || !config.appSecret) {
    return res.redirect('/?oauth=error&reason=missing_env');
  }

  if (!code) {
    return res.redirect('/?oauth=error&reason=missing_code');
  }

  const storedState = readState(req, config);
  if (!storedState || !storedState.state || storedState.state !== incomingState) {
    clearState(res);
    return res.redirect('/?oauth=error&reason=invalid_state');
  }

  try {
    const token = await tokenRequest(config, {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    });

    if (token.status >= 400 || !token.body || !token.body.access_token) {
      clearState(res);
      const reason = encodeURIComponent(JSON.stringify(token.body || {}).slice(0, 120));
      return res.redirect(`/?oauth=error&reason=token_exchange_failed&detail=${reason}`);
    }

    writeSession(res, config, {
      access_token: token.body.access_token,
      refresh_token: token.body.refresh_token || '',
      token_type: token.body.token_type || 'Bearer',
      expires_in: token.body.expires_in || null,
      updated_at: Date.now(),
    });
    clearState(res);
    return res.redirect('/?oauth=success');
  } catch {
    clearState(res);
    return res.redirect('/?oauth=error&reason=exchange_exception');
  }
};
