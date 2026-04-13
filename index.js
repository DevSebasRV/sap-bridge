require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const { getSession, cachedSession, agent, SAP_CONFIG } = require('./lib/sapClient');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Proxy genérico → SAP Service Layer
// ─────────────────────────────────────────────────────────────────────────────

app.use('/s-layer', async (req, res) => {
  try {
    const session = await getSession();
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
    if (err.response?.status === 401) cachedSession.id = null;
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook ClearMechanic → Oferta de Venta SAP B1
// ─────────────────────────────────────────────────────────────────────────────

app.use('/cm-quotes', require('./routes/cmQuotes'));

// ─────────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'sap-bridge' }));

app.listen(3000, '127.0.0.1', () => console.log('SAP Bridge corriendo en puerto 3000'));
