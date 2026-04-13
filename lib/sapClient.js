require('dotenv').config();
const axios = require('axios');
const https = require('https');

const SAP_CONFIG = {
  url:  process.env.SAP_URL,
  user: process.env.SAP_USER,
  pass: process.env.SAP_PASS,
  db:   process.env.SAP_DB,
};

const agent = new https.Agent({ rejectUnauthorized: false });

let cachedSession = { id: null, route: null, expiry: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// Sesión
// ─────────────────────────────────────────────────────────────────────────────

async function login() {
  const res = await axios.post(
    `${SAP_CONFIG.url}/Login`,
    { UserName: SAP_CONFIG.user, Password: SAP_CONFIG.pass, CompanyDB: SAP_CONFIG.db },
    { httpsAgent: agent }
  );
  const cookies = res.headers['set-cookie'] || [];
  cachedSession.id     = res.data.SessionId;
  cachedSession.route  = cookies.find(c => c.includes('ROUTEID'))?.split(';')[0] || '';
  cachedSession.expiry = Date.now() + (res.data.SessionTimeout * 60000);
  console.log('[SAP] Login OK - Session:', cachedSession.id);
  return cachedSession;
}

async function getSession() {
  if (!cachedSession.id || Date.now() > (cachedSession.expiry - 60000)) {
    await login();
  }
  return cachedSession;
}

function cookieHeader(session) {
  return `B1SESSION=${session.id}; ${session.route}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers HTTP
// ─────────────────────────────────────────────────────────────────────────────

async function sapGet(path, params = {}) {
  const session = await getSession();
  const res = await axios.get(`${SAP_CONFIG.url}${path}`, {
    headers:    { Cookie: cookieHeader(session), 'Content-Type': 'application/json' },
    params,
    httpsAgent: agent,
  });
  return res.data;
}

async function sapPost(path, body) {
  const session = await getSession();
  try {
    const res = await axios.post(`${SAP_CONFIG.url}${path}`, body, {
      headers:    { Cookie: cookieHeader(session), 'Content-Type': 'application/json' },
      httpsAgent: agent,
    });
    return res.data;
  } catch (err) {
    // Si la sesión expiró, reintentar una vez
    if (err.response?.status === 401) {
      cachedSession.id = null;
      const fresh = await getSession();
      const res = await axios.post(`${SAP_CONFIG.url}${path}`, body, {
        headers:    { Cookie: cookieHeader(fresh), 'Content-Type': 'application/json' },
        httpsAgent: agent,
      });
      return res.data;
    }
    throw err;
  }
}

module.exports = { sapGet, sapPost, getSession, cachedSession, agent, SAP_CONFIG };
