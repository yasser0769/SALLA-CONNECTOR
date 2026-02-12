const crypto = require('crypto');

const SESSION_COOKIE = 'salla_session';
const STATE_COOKIE = 'salla_oauth_state';

function envConfig() {
  return {
    clientId: process.env.SALLA_CLIENT_ID || '',
    clientSecret: process.env.SALLA_CLIENT_SECRET || '',
    redirectUri: process.env.SALLA_REDIRECT_URI || '',
    apiBase: process.env.SALLA_API_BASE || 'https://api.salla.dev',
    accountsBase: process.env.SALLA_ACCOUNTS_BASE || 'https://accounts.salla.sa',
    appSecret: process.env.APP_SESSION_SECRET || '',
  };
}

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

function parseCookieHeader(req) {
  const raw = (req.headers && req.headers.cookie) || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function signValue(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function encodeSignedPayload(secret, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = signValue(secret, payload);
  return `${payload}.${sig}`;
}

function decodeSignedPayload(secret, signedValue) {
  if (!signedValue || typeof signedValue !== 'string') return null;
  const [payload, sig] = signedValue.split('.');
  if (!payload || !sig) return null;
  const expected = signValue(secret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function cookieParts(name, value, maxAgeSeconds = 3600 * 24 * 30) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearCookie(name) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function setCookie(res, cookie) {
  const prev = res.getHeader ? res.getHeader('Set-Cookie') : undefined;
  if (!prev) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', [...prev, cookie]);
    return;
  }
  res.setHeader('Set-Cookie', [prev, cookie]);
}

async function parseUpstreamResponse(resp) {
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: { error: 'Non-JSON', raw: text.slice(0, 1000) } };
  }
}

async function tokenRequest(config, formFields) {
  const body = new URLSearchParams(formFields).toString();
  const resp = await fetch(`${config.accountsBase}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  return parseUpstreamResponse(resp);
}

function debugId() {
  return crypto.randomBytes(4).toString('hex');
}

function readSession(req, config) {
  const cookies = parseCookieHeader(req);
  return decodeSignedPayload(config.appSecret, cookies[SESSION_COOKIE]);
}

function writeSession(res, config, session) {
  const signed = encodeSignedPayload(config.appSecret, session);
  setCookie(res, cookieParts(SESSION_COOKIE, signed));
}

function clearSession(res) {
  setCookie(res, clearCookie(SESSION_COOKIE));
}

function readState(req, config) {
  const cookies = parseCookieHeader(req);
  return decodeSignedPayload(config.appSecret, cookies[STATE_COOKIE]);
}

function writeState(res, config, state) {
  const signed = encodeSignedPayload(config.appSecret, { state, at: Date.now() });
  setCookie(res, cookieParts(STATE_COOKIE, signed, 600));
}

function clearState(res) {
  setCookie(res, clearCookie(STATE_COOKIE));
}

module.exports = {
  SESSION_COOKIE,
  STATE_COOKIE,
  envConfig,
  setCors,
  sendJson,
  parseCookieHeader,
  cookieParts,
  clearCookie,
  setCookie,
  parseUpstreamResponse,
  tokenRequest,
  debugId,
  readSession,
  writeSession,
  clearSession,
  readState,
  writeState,
  clearState,
};
