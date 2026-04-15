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

// Obtiene RFC desde el payload directo o desde orderCustomizableFields
function extractRFC(cm) {
  if (cm.rfc) return cm.rfc.trim();
  const field = (cm.orderCustomizableFields || []).find(
    f => f.name?.toLowerCase().includes('rfc')
  );
  return field?.value?.trim() || null;
}

// Obtiene Régimen Fiscal desde el payload directo o desde orderCustomizableFields
function extractRegimen(cm) {
  if (cm.regimen) return String(cm.regimen).trim();
  const field = (cm.orderCustomizableFields || []).find(
    f => f.name?.toLowerCase().includes('regimen')
  );
  return field?.value ? String(field.value).trim() : null;
}

// Valida que los datos mínimos para crear un cliente estén presentes
// Devuelve array de campos faltantes
function missingCreateFields(cm) {
  const missing = [];
  if (!cm.firstName && !cm.lastName)        missing.push('firstName o lastName');
  if (!extractRFC(cm))                       missing.push('rfc');
  if (!extractRegimen(cm))                   missing.push('regimen');
  if (!sanitizePhone(cm.mobile || cm.phoneNumber) && !cm.email)
                                             missing.push('mobile (10 dígitos) o email');
  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Búsqueda de cliente — por RFC, luego por móvil
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
  const rfc      = extractRFC(cm);
  const regimen  = extractRegimen(cm);
  const cardName = [cm.firstName, cm.lastName].filter(Boolean).join(' ').trim();
  const phone    = sanitizePhone(cm.mobile || cm.phoneNumber);

  // Generar CardCode único basado en RFC
  const cardCode = 'CM-' + rfc.replace(/[^A-Z0-9]/gi, '').substring(0, 10).toUpperCase();

  const body = {
    CardCode:                cardCode,
    CardName:                cardName,
    CardType:                'cCustomer',
    FederalTaxID:            rfc,
    U_CVM_REGFISCAL:         regimen,
    U_RegimenFiscalReceptor: regimen,
    ...(cm.email && { EmailAddress: cm.email }),
    ...(phone    && { Cellular: phone }),
  };

  await sapPost('/BusinessPartners', body);
  console.log(`[cmQuotes] Cliente creado: ${cardCode} - ${cardName}`);
  return { cardCode, cardName };
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

  // Validación mínima
  if (!cm.orderNumber) {
    return res.status(400).json({
      success: false,
      message: 'El campo orderNumber es requerido.',
      logs:    [],
      data:    [],
    });
  }

  if (!cm.items || cm.items.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Se requiere al menos un item en el campo items.',
      logs:    [],
      data:    [],
    });
  }

  let step         = 'buscar cliente';
  let cardCode     = null;
  let customerName = null;

  try {

    // 1. Si viene cardCode en el payload, usarlo directo
    if (cm.cardCode) {
      cardCode = cm.cardCode;
      logs.push(`CardCode recibido en payload: ${cardCode} — se omite búsqueda.`);
    }

    // 2. Buscar por RFC
    if (!cardCode) {
      const rfc = extractRFC(cm);
      if (rfc) {
        const found = await findCustomerByRFC(rfc);
        if (found) {
          cardCode     = found.CardCode;
          customerName = found.CardName;
          logs.push(`Cliente encontrado por RFC (${rfc}): ${cardCode} - ${customerName}`);
        } else {
          logs.push(`No se encontró cliente con RFC: ${rfc}`);
        }
      } else {
        logs.push('No se envió RFC — se omite búsqueda por RFC.');
      }
    }

    // 3. Buscar por móvil
    if (!cardCode) {
      const mobile = cm.mobile || cm.phoneNumber;
      if (mobile) {
        const found = await findCustomerByMobile(mobile);
        if (found) {
          cardCode     = found.CardCode;
          customerName = found.CardName;
          logs.push(`Cliente encontrado por móvil (${mobile}): ${cardCode} - ${customerName}`);
        } else {
          logs.push(`No se encontró cliente con móvil: ${mobile}`);
        }
      } else {
        logs.push('No se envió móvil — se omite búsqueda por móvil.');
      }
    }

    // 4. Si no se encontró, intentar crear — validar campos primero
    if (!cardCode) {
      const missing = missingCreateFields(cm);
      if (missing.length > 0) {
        return res.status(400).json({
          success: false,
          message: `No se encontró el cliente y faltan datos para crearlo: ${missing.join(', ')}.`,
          logs,
          data:    [],
        });
      }

      step = 'crear cliente';
      const result = await createCustomer(cm);
      cardCode     = result.cardCode;
      customerName = result.cardName;
      logs.push(`Cliente nuevo creado en SAP: ${cardCode} - ${customerName} (RFC: ${extractRFC(cm)}, Régimen: ${extractRegimen(cm)})`);
    }

    // 5. Crear Oferta de Venta
    step = 'crear cotizacion';
    const quotation = await createQuotation(cardCode, cm);
    logs.push(`Oferta de Venta creada: DocNum ${quotation.DocNum} — Cliente: ${cardCode}`);

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
      data:    [],
    });
  }
});

module.exports = router;
