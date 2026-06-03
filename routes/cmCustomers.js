const express = require('express');
const router  = express.Router();
const { sapGet, sapPost } = require('../lib/sapClient');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sanitizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

async function findByRFC(rfc, dbKey) {
  if (!rfc) return null;
  try {
    const filter = `FederalTaxID eq '${rfc}' and CardType eq 'cCustomer'`;
    const data   = await sapGet(
      `/BusinessPartners?$filter=${encodeURIComponent(filter)}&$select=CardCode,CardName&$top=1`,
      {}, dbKey
    );
    return data.value?.[0] || null;
  } catch {
    return null;
  }
}

async function findByMobile(mobile, dbKey) {
  const phone = sanitizePhone(mobile);
  if (!phone) return null;
  try {
    const filter = `Cellular eq '${phone}' and CardType eq 'cCustomer'`;
    const data   = await sapGet(
      `/BusinessPartners?$filter=${encodeURIComponent(filter)}&$select=CardCode,CardName&$top=1`,
      {}, dbKey
    );
    return data.value?.[0] || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /cm-customers
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const cm    = req.body;
  const dbKey = req.headers['x-sap-db'] || undefined;

  const { firstName, lastName, email, mobile, taxId, landline, businessName, regimen } = cm;

  // Nombre del cliente: businessName tiene prioridad, luego firstName + lastName
  const cardName = businessName?.trim()
    || [firstName, lastName].filter(Boolean).join(' ').trim()
    || null;

  if (!cardName) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos requeridos: firstName o lastName (o businessName).',
      data: [],
    });
  }

  if (!taxId && !sanitizePhone(mobile)) {
    return res.status(400).json({
      success: false,
      message: 'Se requiere taxId (RFC) o mobile (10 dígitos) para identificar o crear el cliente.',
      data: [],
    });
  }

  try {
    // 1. Buscar por RFC
    if (taxId) {
      const found = await findByRFC(taxId, dbKey);
      if (found) {
        return res.status(200).json({
          success:  true,
          message:  'Cliente ya existe en SAP.',
          data: {
            customerId:   found.CardCode,
            firstName,
            lastName,
            email:        email    || null,
            mobile:       mobile   || null,
            taxId:        taxId    || null,
            landline:     landline || null,
            businessName: businessName || null,
          },
        });
      }
    }

    // 2. Buscar por móvil
    if (mobile) {
      const found = await findByMobile(mobile, dbKey);
      if (found) {
        return res.status(200).json({
          success:  true,
          message:  'Cliente ya existe en SAP.',
          data: {
            customerId:   found.CardCode,
            firstName,
            lastName,
            email:        email    || null,
            mobile:       mobile   || null,
            taxId:        taxId    || null,
            landline:     landline || null,
            businessName: businessName || null,
          },
        });
      }
    }

    // 3. Crear cliente en SAP
    const rfc      = taxId?.trim() || null;
    const phone    = sanitizePhone(mobile);
    const cardCode = rfc
      ? 'CM-' + rfc.replace(/[^A-Z0-9]/gi, '').substring(0, 10).toUpperCase()
      : 'CM-' + phone;

    const body = {
      CardCode: cardCode,
      CardName: cardName,
      CardType: 'cCustomer',
      ...(rfc      && { FederalTaxID: rfc }),
      ...(regimen  && { U_CVM_REGFISCAL: regimen, U_RegimenFiscalReceptor: regimen }),
      ...(email    && { EmailAddress: email }),
      ...(phone    && { Cellular: phone }),
      ...(landline && { Phone1: sanitizePhone(landline) || landline }),
    };

    await sapPost('/BusinessPartners', body, dbKey);

    return res.status(201).json({
      success: true,
      message: 'Final customer created successfully.',
      data: {
        customerId:   cardCode,
        firstName:    firstName    || null,
        lastName:     lastName     || null,
        email:        email        || null,
        mobile:       mobile       || null,
        taxId:        taxId        || null,
        landline:     landline     || null,
        businessName: businessName || null,
      },
    });

  } catch (err) {
    const sapError = err.response?.data?.error?.message?.value || err.message;
    console.error('[cmCustomers] Error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: sapError,
      data: [],
    });
  }
});

module.exports = router;
