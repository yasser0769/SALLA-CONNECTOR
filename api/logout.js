const { sendJson, clearSession, clearState } = require('./_lib/salla');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  clearSession(res);
  clearState(res);
  return sendJson(res, 200, { ok: true });
};
