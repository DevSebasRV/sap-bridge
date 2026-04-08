require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const https   = require('https');

const app = express();
app.use(express.json());

const SAP_CONFIG = {
  url:  process.env.SAP_URL,
  user: process.env.SAP_USER,
  pass: process.env.SAP_PASS,
  db:   process.env.SAP_DB
};

const agent = new https.Agent({ rejectUnauthorized: false });

let cachedSession = { id: null, route: null, expiry: 0 };

async function loginToSAP() {
  try {
    const res = await axios.post(
      `${SAP_CONFIG.url}/Login`,
      { UserName: SAP_CONFIG.user, Password: SAP_CONFIG.pass, CompanyDB: SAP_CONFIG.db },
      { httpsAgent: agent }
    );
    const cookies = res.headers['set-cookie'] || [];
    cachedSession.id     = res.data.SessionId;
    cachedSession.route  = cookies.find(c => c.includes('ROUTEID'))?.split(';')[0] || '';
    cachedSession.expiry = Date.now() + (res.data.SessionTimeout * 60000);
    console.log('SAP login OK - Session:', cachedSession.id);
    return true;
  } catch (err) {
    console.error('SAP login FAILED:', err.message);
    return false;
  }
}

app.use('/s-layer', async (req, res) => {
  if (!cachedSession.id || Date.now() > (cachedSession.expiry - 60000)) {
    const ok = await loginToSAP();
    if (!ok) return res.status(500).json({ error: 'SAP Connection Error' });
  }
  const url = SAP_CONFIG.url + req.url;
  try {
    const response = await axios({
      method:      req.method,
      url:         url,
      data:        req.body,
      headers: {
        'Cookie':       `B1SESSION=${cachedSession.id}; ${cachedSession.route}`,
        'Content-Type': 'application/json'
      },
      httpsAgent: agent,
      params:     req.query
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    if (err.response?.status === 401) cachedSession.id = null;
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'sap-proxy' }));

app.listen(3000, '127.0.0.1', () => console.log('SAP Proxy corriendo en puerto 3000'));