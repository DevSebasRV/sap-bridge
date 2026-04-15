const express = require('express');
const router  = express.Router();
const { sapGet, sapPost } = require('../lib/sapClient');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Solo dígitos, exactamente 10 — si no cumple devuelve null
function sanitizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

// Devuelve el Régimen Fiscal correcto:
// 1) Lo que viene en cm.regimen
// 2) Si RFC es XAXX010101000 → 616 (Público en General)
// 3) Default → 601 (General de Ley Personas Morales)
function resolveRegimen(cm) {
  if (cm.regimen) return String(cm.regimen);
  const rfc = (cm.rfc || '').toUpperCase().trim();
  if (rfc === 'XAXX010101000') return '616';
  return '601';
}

// ─────────────────────────────────────────────────────────────────────────────
// Búsqueda de cliente — primero por RFC, luego por móvil
// ─────────────────────────────────────────────────────────────────────────────

async function findCustomerByRFC(rfc) {
  if (!rfc) return null;
  try {
    const filter = `FederalTaxID eq '${rfc}' and CardType eq 'cCustomer'`;
    const data   = await sapGet(
      `/BusinessPartners?$filter=${encodeURIComponent(filter)}&$select=CardCode,CardName&$top=1`
    );
    return data.value?.[0] || null;
  } catch (err) {
    console.error('[cmQuotes] Error buscando por RFC:', err.response?.data || err.message);
    return null;
  }
}

async function findCustomerByMobile(mobile) {
  const phone = sanitizePhone(mobile);
  if (!phone) return null;
  try {
    const filter = `Cellular eq '${phone}' and CardType eq 'cCustomer'`;
    const data   = await sapGet(
      `/BusinessPartners?$filter=${encodeURIComponent(filter)}&$select=CardCode,CardName&$top=1`
    );
    return data.value?.[0] || null;
  } catch (err) {
    console.error('[cmQuotes] Error buscando por móvil:', err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crear cliente en SAP
// ─────────────────────────────────────────────────────────────────────────────

async function createCustomer(cm) {
  const cardCode = 'CM-' + (cm.customerId || Date.now().toString()).substring(0, 8).toUpperCase();
  const cardName = [cm.firstName, cm.lastName].filter(Boolean).join(' ').trim() || 'Sin Nombre';
  const rfc      = cm.rfc || 'XAXX010101000';
  const regimen  = resolveRegimen(cm);
  const phone    = sanitizePhone(cm.mobile || cm.phoneNumber);

  const body = {
    CardCode:                cardCode,
    CardName:                cardName,
    CardType:                'cCustomer',
    EmailAddress:            cm.email        || '',
    FederalTaxID:            rfc,
    U_CVM_REGFISCAL:         regimen,
    U_RegimenFiscalReceptor: regimen,
    ...(phone && { Cellular: phone }),
  };

  await sapPost('/BusinessPartners', body);
  console.log(`[cmQuotes] Cliente creado: ${cardCode} - ${cardName} (RFC: ${rfc}, Régimen: ${regimen})`);
  return { cardCode, cardName, created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Líneas de la Oferta de Venta
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ITEM_CODE = process.env.SAP_DEFAULT_ITEM || '.0114';

function buildLines(items = []) {
  return items
    .filter(i => i.itemName)
    .map(i => ({
      ItemCode:  i.itemId || DEFAULT_ITEM_CODE,
      Quantity:  i.quantity  || 1,
      UnitPrice: i.unitPrice || 0,
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
    CardCode:      cardCode,
    DocDate:       cm.date || new Date().toISOString().split('T')[0],
    Comments:      `Orden CM #${cm.orderNumber}${vehicleInfo ? ' | ' + vehicleInfo : ''}`,
    U_CM_OrderId:  String(cm.orderNumber || ''),
    DocumentLines: buildLines(cm.items),
  };

  return await sapPost('/Quotations', body);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /cm-quotes
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const cm   = req.body;
  const logs = [];

  if (!cm.orderNumber) {
    return res.status(400).json({
      success: false,
      message: 'El campo orderNumber es requerido.',
      data:    [],
      logs:    [],
    });
  }

  let step         = 'buscar cliente';
  let cardCode     = null;
  let customerName = null;

  try {

    // 1. Si viene cardCode en el payload, usarlo directo
    if (cm.cardCode) {
      cardCode = cm.cardCode;
      logs.push(`CardCode recibido en payload: ${cardCode}`);
    }

    // 2. Buscar por RFC
    if (!cardCode && cm.rfc) {
      const found = await findCustomerByRFC(cm.rfc);
      if (found) {
        cardCode     = found.CardCode;
        customerName = found.CardName;
        logs.push(`Cliente encontrado por RFC (${cm.rfc}): ${cardCode} - ${customerName}`);
      }
    }

    // 3. Buscar por móvil
    if (!cardCode && (cm.mobile || cm.phoneNumber)) {
      const found = await findCustomerByMobile(cm.mobile || cm.phoneNumber);
      if (found) {
        cardCode     = found.CardCode;
        customerName = found.CardName;
        logs.push(`Cliente encontrado por móvil: ${cardCode} - ${customerName}`);
      }
    }

    // 4. Crear cliente si no existe
    if (!cardCode) {
      step = 'crear cliente';
      const result = await createCustomer(cm);
      cardCode     = result.cardCode;
      customerName = [cm.firstName, cm.lastName].filter(Boolean).join(' ').trim();
      logs.push(`Cliente nuevo creado en SAP: ${cardCode} - ${customerName} (RFC: ${cm.rfc || 'XAXX010101000'}, Régimen: ${resolveRegimen(cm)})`);
    }

    // 5. Crear Oferta de Venta
    step = 'crear cotizacion';
    const quotation = await createQuotation(cardCode, cm);
    logs.push(`Oferta de Venta creada: DocNum ${quotation.DocNum} para cliente ${cardCode}`);

    return res.status(201).json({
      success: true,
      message: null,
      logs,
      data: {
        quoteId:      String(quotation.DocNum),
        orderNumber:  String(cm.orderNumber),
        customerId:   cardCode,
        customerName: customerName || '',
        date:         cm.date || null,
      },
    });

  } catch (err) {
    const sapError = err.response?.data?.error?.message?.value || err.message;
    console.error(`[cmQuotes] Error en paso "${step}":`, err.response?.data || err.message);
    logs.push(`Error en paso "${step}": ${sapError}`);
    return res.status(500).json({
      success: false,
      message: `Error en paso "${step}": ${sapError}`,
      logs,
      data: [],
    });
  }
});

module.exports = router;
