require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const { getSession, sessions, agent, SAP_CONFIG, REQUEST_TIMEOUT_MS } = require('./lib/sapClient');
const setupSwagger = require('./swagger');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Swagger — debe registrarse ANTES del proxy /s-layer
// ─────────────────────────────────────────────────────────────────────────────

setupSwagger(app);

// ─────────────────────────────────────────────────────────────────────────────
// Proxy genérico → SAP Service Layer
// Excluye /s-layer/api-docs para que no lo intercepte
// ─────────────────────────────────────────────────────────────────────────────

app.use('/s-layer', async (req, res, next) => {
  // Si es la ruta de docs, pasar al siguiente middleware
  if (req.path.startsWith('/api-docs')) return next();

  // BD seleccionada por header X-SAP-DB (ej: "cp" o "fn"), default según .env
  const dbKey = req.headers['x-sap-db'] || undefined;

  // req.url YA incluye el query string — no pasar `params` aparte o los
  // parámetros OData ($top, $filter…) llegan duplicados a SAP.
  const doRequest = async () => {
    const session = await getSession(dbKey);
    return axios({
      method:     req.method,
      url:        SAP_CONFIG.url + req.url,
      data:       req.body,
      headers: {
        'Cookie':       `B1SESSION=${session.id}; ${session.route}`,
        'Content-Type': 'application/json',
      },
      httpsAgent: agent,
      timeout:    REQUEST_TIMEOUT_MS,
    });
  };

  try {
    let response;
    try {
      response = await doRequest();
    } catch (err) {
      // Sesión expirada: re-login y reintento único (antes el error 401
      // llegaba al cliente y solo la SIGUIENTE petición se recuperaba).
      if (err.response?.status !== 401) throw err;
      const key = dbKey || SAP_CONFIG.defaultDb;
      if (sessions[key]) sessions[key].id = null;
      response = await doRequest();
    }
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook ClearMechanic → Oferta de Venta SAP B1
// ─────────────────────────────────────────────────────────────────────────────

app.use('/cm-quotes',    require('./routes/cmQuotes'));
app.use('/cm-customers', require('./routes/cmCustomers'));

// ─────────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'sap-bridge' }));

// ─────────────────────────────────────────────────────────────────────────────
// 404 y errores en JSON (Express 5 propaga los rejects async hasta aquí;
// sin esto, un body malformado o un throw fuera de try devolvía HTML genérico)
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` }));

app.use((err, req, res, next) => {
  console.error('[sap-bridge] Error no manejado:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
});

app.listen(3000, '127.0.0.1', () => console.log('SAP Bridge corriendo en puerto 3000'));
