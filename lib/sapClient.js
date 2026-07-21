require('dotenv').config();
const axios = require('axios');
const https = require('https');

const SAP_CONFIG = {
  url:       process.env.SAP_URL,
  defaultDb: process.env.SAP_DB_DEFAULT || 'cp',
  databases: {
    cp: {
      db:   process.env.SAP_DB_CP,
      user: process.env.SAP_USER_CP,
      pass: process.env.SAP_PASS_CP,
    },
    fn: {
      db:   process.env.SAP_DB_FN,
      user: process.env.SAP_USER_FN,
      pass: process.env.SAP_PASS_FN,
    },
    test: {
      db:   process.env.SAP_DB_TEST,
      user: process.env.SAP_USER_TEST,
      pass: process.env.SAP_PASS_TEST,
    },
  },
};

const agent = new https.Agent({ rejectUnauthorized: false });

// Timeouts: sin ellos, una petición colgada a SAP bloquea indefinidamente.
const LOGIN_TIMEOUT_MS   = 15000;
const REQUEST_TIMEOUT_MS = 60000;

// Pool de sesiones — una por BD
const sessions = {};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────────────────────

function resolveDbKey(dbKey) {
  const key    = dbKey || SAP_CONFIG.defaultDb;
  const config = SAP_CONFIG.databases[key];

  if (!config) {
    const available = Object.keys(SAP_CONFIG.databases);
    throw new Error(`Base de datos desconocida: "${key}". Disponibles: ${available.join(', ')}`);
  }
  if (!config.db || !config.user || !config.pass) {
    throw new Error(`La base de datos "${key}" no está configurada en el .env (faltan SAP_DB_${key.toUpperCase()}, SAP_USER_${key.toUpperCase()} o SAP_PASS_${key.toUpperCase()}).`);
  }

  return { key, config };
}

function cookieHeader(session) {
  return `B1SESSION=${session.id}; ${session.route}`;
}

// En OData las comillas simples se escapan duplicándolas. Usar SIEMPRE que un
// valor externo (RFC, nombre, etc.) se interpole dentro de un $filter.
function odataEscape(value) {
  return String(value).replace(/'/g, "''");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesión
// ─────────────────────────────────────────────────────────────────────────────

async function login(dbKey) {
  const { key, config } = resolveDbKey(dbKey);
  const res = await axios.post(
    `${SAP_CONFIG.url}/Login`,
    { UserName: config.user, Password: config.pass, CompanyDB: config.db },
    { httpsAgent: agent, timeout: LOGIN_TIMEOUT_MS }
  );
  const cookies = res.headers['set-cookie'] || [];
  sessions[key] = {
    id:     res.data.SessionId,
    route:  cookies.find(c => c.includes('ROUTEID'))?.split(';')[0] || '',
    expiry: Date.now() + (res.data.SessionTimeout * 60000),
  };
  // No loguear el SessionId: es un token de sesión (riesgo si los logs se filtran).
  console.log(`[SAP] Login OK — DB: ${key} (${config.db})`);
  return sessions[key];
}

async function getSession(dbKey) {
  const { key } = resolveDbKey(dbKey);
  const session = sessions[key];
  if (!session?.id || Date.now() > (session.expiry - 60000)) {
    await login(key);
  }
  return sessions[key];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers HTTP
// ─────────────────────────────────────────────────────────────────────────────

async function sapGet(path, params = {}, dbKey) {
  const { key } = resolveDbKey(dbKey);
  const session = await getSession(key);
  const opts = (s) => ({
    headers:    { Cookie: cookieHeader(s), 'Content-Type': 'application/json' },
    params,
    httpsAgent: agent,
    timeout:    REQUEST_TIMEOUT_MS,
  });
  try {
    const res = await axios.get(`${SAP_CONFIG.url}${path}`, opts(session));
    return res.data;
  } catch (err) {
    // Sesión expirada: re-login y reintento único. Sin esto, los buscadores que
    // atrapan errores devolvían null y se creaban clientes DUPLICADOS.
    if (err.response?.status === 401) {
      sessions[key].id = null;
      const fresh = await getSession(key);
      const res = await axios.get(`${SAP_CONFIG.url}${path}`, opts(fresh));
      return res.data;
    }
    throw err;
  }
}

async function sapPost(path, body, dbKey) {
  const { key } = resolveDbKey(dbKey);
  const session = await getSession(key);
  try {
    const res = await axios.post(`${SAP_CONFIG.url}${path}`, body, {
      headers:    { Cookie: cookieHeader(session), 'Content-Type': 'application/json' },
      httpsAgent: agent,
      timeout:    REQUEST_TIMEOUT_MS,
    });
    return res.data;
  } catch (err) {
    // Si la sesión expiró, reintentar una vez
    if (err.response?.status === 401) {
      sessions[key].id = null;
      const fresh = await getSession(key);
      const res = await axios.post(`${SAP_CONFIG.url}${path}`, body, {
        headers:    { Cookie: cookieHeader(fresh), 'Content-Type': 'application/json' },
        httpsAgent: agent,
        timeout:    REQUEST_TIMEOUT_MS,
      });
      return res.data;
    }
    throw err;
  }
}

module.exports = { sapGet, sapPost, getSession, sessions, agent, SAP_CONFIG, odataEscape, REQUEST_TIMEOUT_MS };
