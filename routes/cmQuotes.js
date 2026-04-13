const express = require('express');
const router  = express.Router();
const { sapGet, sapPost } = require('../lib/sapClient');

// ─────────────────────────────────────────────────────────────────────────────
// Buscar cliente en SAP por email
// ─────────────────────────────────────────────────────────────────────────────

async function findCustomerByEmail(email) {
  try {
    const filter = `EmailAddress eq '${email}' and CardType eq 'cCustomer'`;
    const data   = await sapGet(
      `/BusinessPartners?$filter=${encodeURIComponent(filter)}&$select=CardCode,CardName&$top=1`
    );
    return data.value?.[0] || null;
  } catch (err) {
    console.error('[cmQuotes] Error buscando cliente:', err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crear cliente en SAP si no existe
// ─────────────────────────────────────────────────────────────────────────────

// Solo dígitos, exactamente 10 — si no cumple devuelve null
function sanitizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

async function createCustomer(cm) {
  // CardCode: "CM-" + primeros 8 chars del customerId de ClearMechanic
  const cardCode = 'CM-' + (cm.customerId || Date.now().toString()).substring(0, 8).toUpperCase();
  const cardName = [cm.firstName, cm.lastName].filter(Boolean).join(' ').trim() || 'Sin Nombre';

  // RFC: 1) campo directo, 2) campos personalizables, 3) genérico Público en General
  const rfcField = (cm.orderCustomizableFields || []).find(
    f => f.name?.toLowerCase().includes('rfc')
  );
  const rfc   = cm.rfc || rfcField?.value || 'XAXX010101000';
  const phone = sanitizePhone(cm.mobile || cm.phoneNumber);

  const body = {
    CardCode:                cardCode,
    CardName:                cardName,
    CardType:                'cCustomer',
    EmailAddress:            cm.email || '',
    FederalTaxID:            rfc,
    U_RegimenFiscalReceptor: '616',
    U_CVM_REGFISCAL:         '616',
    ...(phone && { Cellular: phone }),
  };

  await sapPost('/BusinessPartners', body);
  console.log(`[cmQuotes] Cliente creado en SAP: ${cardCode} - ${cardName}`);
  return cardCode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construir líneas de la Oferta de Venta (texto libre, sin ItemCode)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ITEM_CODE = process.env.SAP_DEFAULT_ITEM || '.0114';

function buildLines(items = []) {
  return items
    .filter(i => i.itemName)
    .map(i => ({
      ItemCode:        i.itemId || DEFAULT_ITEM_CODE,
      ItemDescription: i.itemName,
      Quantity:        i.quantity  || 1,
      UnitPrice:       i.unitPrice || 0,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Crear Oferta de Venta en SAP
// ─────────────────────────────────────────────────────────────────────────────

async function createQuotation(cardCode, cm) {
  const vehicleInfo = [cm.brand, cm.model, cm.year, cm.vin]
    .filter(Boolean)
    .join(' - ');

  const body = {
    CardCode:        cardCode,
    DocDate:         cm.date || new Date().toISOString().split('T')[0],
    Comments:        `Orden CM #${cm.orderNumber}${vehicleInfo ? ' | ' + vehicleInfo : ''}`,
    U_CM_OrderId:    String(cm.orderNumber || ''),
    U_Regimen_Fiscal_: '616',
    DocumentLines:   buildLines(cm.items),
  };

  return await sapPost('/Quotations', body);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /cm-quotes
// Recibe webhook de ClearMechanic y crea Oferta de Venta en SAP B1
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const cm = req.body;

  if (!cm.orderNumber) {
    return res.status(400).json({
      success: false,
      message: 'El campo orderNumber es requerido.',
      data:    [],
    });
  }

  let step     = 'buscar cliente';
  let cardCode = null;

  try {

    if (cm.email) {
      const existing = await findCustomerByEmail(cm.email);
      if (existing) {
        cardCode = existing.CardCode;
        console.log(`[cmQuotes] Cliente encontrado en SAP: ${cardCode}`);
      }
    }

    // 2. Si no existe, crear cliente
    if (!cardCode) {
      step     = 'crear cliente';
      cardCode = await createCustomer(cm);
    }

    // 3. Crear Oferta de Venta
    step = 'crear cotizacion';
    const quotation = await createQuotation(cardCode, cm);

    return res.status(201).json({
      success: true,
      message: null,
      data: {
        quoteId:     String(quotation.DocNum),
        orderNumber: String(cm.orderNumber),
        customerId:  cardCode,
        date:        cm.date || null,
      },
    });

  } catch (err) {
    const sapError = err.response?.data?.error?.message?.value || err.message;
    console.error(`[cmQuotes] Error en paso "${step}":`, err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: `Error en paso "${step}": ${sapError}`,
      data:    [],
    });
  }
});

module.exports = router;
