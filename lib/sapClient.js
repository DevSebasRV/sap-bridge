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

// Logins en vuelo — evita el "login stampede" (ver login()).
const loginEnCurso = {};

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
// Clasificación de errores del Service Layer
// ─────────────────────────────────────────────────────────────────────────────

function _errorTexto(err) {
  const data = err.response?.data;
  return String(data?.error?.message?.value || data?.error?.message || '');
}

function _errorCodigo(err) {
  const c = err.response?.data?.error?.code;
  return c === undefined || c === null ? null : String(c);
}

/** Sesión vencida o inválida → hay que re-loguear. (401, o código 301.) */
function esSesionInvalida(err) {
  if (err.response?.status === 401) return true;
  if (_errorCodigo(err) === '301') return true;
  return /invalid session|session.*(expired|invalid)/i.test(_errorTexto(err));
}

/** "Switch company error: -1102" (código 305): el Service Layer aloja las 3
 * empresas y no pudo cambiar el contexto para ESTA petición (contención).
 * La sesión sigue siendo válida — se reintenta con pausas, igual que hace el
 * portal desde hace meses. Ocurre ANTES de ejecutar la operación, así que
 * reintentar es seguro (no duplica documentos). */
function esSwitchCompany(err) {
  if (_errorCodigo(err) === '305') return true;
  return /switch company|-1102/i.test(_errorTexto(err));
}

function invalidarSesion(key) {
  if (sessions[key]) sessions[key].id = null;
}

/**
 * Ejecuta `hacer(session)` con auto-recuperación:
 *  - -1102 / 305 (switch company): reintenta con la MISMA sesión y pausas
 *    (300 y 700 ms); si persiste, prueba una vez con sesión nueva.
 *  - 401 / 301 (sesión inválida): re-login y un reintento.
 *  - Errores de negocio (p.ej. -1028, cliente inactivo): NO se reintentan.
 * Máximo 4 llamadas a SAP por petición.
 */
async function conRecuperacion(dbKey, hacer) {
  const { key } = resolveDbKey(dbKey);
  const esperas = [300, 700];
  let intentoSwitch = 0;
  let reloginHecho  = false;

  for (;;) {
    const session = await getSession(key);
    try {
      return await hacer(session);
    } catch (err) {
      if (esSesionInvalida(err) && !reloginHecho) {
        console.warn(`[SAP] Sesión inválida (DB: ${key}). Re-login y reintento.`);
        invalidarSesion(key);
        reloginHecho = true;
        continue;
      }
      if (esSwitchCompany(err)) {
        if (intentoSwitch < esperas.length) {
          const ms = esperas[intentoSwitch++];
          console.warn(`[SAP] Switch company -1102 (DB: ${key}). Reintento en ${ms}ms.`);
          await new Promise(r => setTimeout(r, ms));
          continue;
        }
        if (!reloginHecho) {
          // Último recurso: por si la sesión quedó huérfana en el Service Layer.
          console.warn(`[SAP] -1102 persistente (DB: ${key}). Sesión nueva y último intento.`);
          invalidarSesion(key);
          reloginHecho = true;
          continue;
        }
      }
      // Que la siguiente petición no herede una sesión sospechosa.
      if (esSesionInvalida(err)) invalidarSesion(key);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesión
// ─────────────────────────────────────────────────────────────────────────────

// Si llegan N peticiones juntas sin sesión, antes todas llamaban a login() a la
// vez (N sesiones en SAP, la última pisaba a las demás). Ahora la primera hace
// el login y las demás esperan esa misma promesa.
async function login(dbKey) {
  const { key, config } = resolveDbKey(dbKey);

  if (loginEnCurso[key]) return loginEnCurso[key];

  loginEnCurso[key] = (async () => {
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
  })();

  try {
    return await loginEnCurso[key];
  } finally {
    delete loginEnCurso[key];
  }
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
// Helpers HTTP (con auto-recuperación de sesión y de -1102)
// ─────────────────────────────────────────────────────────────────────────────

async function sapGet(path, params = {}, dbKey) {
  return conRecuperacion(dbKey, async (session) => {
    const res = await axios.get(`${SAP_CONFIG.url}${path}`, {
      headers:    { Cookie: cookieHeader(session), 'Content-Type': 'application/json' },
      params,
      httpsAgent: agent,
      timeout:    REQUEST_TIMEOUT_MS,
    });
    return res.data;
  });
}

async function sapPost(path, body, dbKey) {
  return conRecuperacion(dbKey, async (session) => {
    const res = await axios.post(`${SAP_CONFIG.url}${path}`, body, {
      headers:    { Cookie: cookieHeader(session), 'Content-Type': 'application/json' },
      httpsAgent: agent,
      timeout:    REQUEST_TIMEOUT_MS,
    });
    return res.data;
  });
}

module.exports = {
  sapGet,
  sapPost,
  getSession,
  sessions,
  agent,
  SAP_CONFIG,
  odataEscape,
  REQUEST_TIMEOUT_MS,
  conRecuperacion,
  cookieHeader,
};
