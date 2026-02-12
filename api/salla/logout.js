const { sendJson, clearSession, clearState } = require('../_lib/salla');

module.exports = async function handler(req, res) {
  clearSession(res);
  clearState(res);
  return sendJson(res, 200, { ok: true });
};
