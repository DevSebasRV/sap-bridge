require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const { getSession, sessions, agent, SAP_CONFIG } = require('./lib/sapClient');
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

  try {
    const session = await getSession(dbKey);
    const url     = SAP_CONFIG.url + req.url;

    const response = await axios({
      method:     req.method,
      url,
      data:       req.body,
      headers: {
        'Cookie':       `B1SESSION=${session.id}; ${session.route}`,
        'Content-Type': 'application/json',
      },
      httpsAgent: agent,
      params:     req.query,
    });

    res.status(response.status).json(response.data);

  } catch (err) {
    const dbKeyResolved = dbKey || SAP_CONFIG.defaultDb;
    if (err.response?.status === 401 && sessions[dbKeyResolved]) {
      sessions[dbKeyResolved].id = null;
    }
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

app.listen(3000, '127.0.0.1', () => console.log('SAP Bridge corriendo en puerto 3000'));
