const express = require('express');
const router  = express.Router();
const { sapGet, sapPost } = require('../lib/sapClient');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers generales
// ─────────────────────────────────────────────────────────────────────────────

function sanitizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

function extractRFC(cm) {
  if (cm.rfc) return cm.rfc.trim();
  const field = (cm.orderCustomizableFields || []).find(
    f => f.name?.toLowerCase().includes('rfc')
  );
  return field?.value?.trim() || null;
}

function extractRegimen(cm) {
  if (cm.regimen) return String(cm.regimen).trim();
  const field = (cm.orderCustomizableFields || []).find(
    f => f.name?.toLowerCase().includes('regimen')
  );
  return field?.value ? String(field.value).trim() : null;
}

function missingCustomerFields(cm) {
  const missing = [];
  if (!cm.firstName && !cm.lastName) missing.push('firstName o lastName');
  if (!extractRFC(cm))               missing.push('rfc');
  if (!extractRegimen(cm))           missing.push('regimen');
  if (!sanitizePhone(cm.mobile || cm.phoneNumber) && !cm.email)
                                     missing.push('mobile (10 dígitos) o email');
  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clientes — búsqueda y creación
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
    console.error('[cmQuotes] Error buscando cliente por RFC:', err.response?.data || err.message);
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
    console.error('[cmQuotes] Error buscando cliente por móvil:', err.response?.data || err.message);
    return null;
  }
}

async function createCustomer(cm) {
  const rfc      = extractRFC(cm);
  const regimen  = extractRegimen(cm);
  const cardName = [cm.firstName, cm.lastName].filter(Boolean).join(' ').trim();
  const phone    = sanitizePhone(cm.mobile || cm.phoneNumber);
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
  return { cardCode, cardName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Artículos — búsqueda y creación
// ─────────────────────────────────────────────────────────────────────────────

async function itemExists(itemCode) {
  try {
    const data = await sapGet(
      `/Items('${encodeURIComponent(itemCode)}')?$select=ItemCode,ItemName`
    );
    return data?.ItemCode ? data : null;
  } catch (err) {
    // 404 = no existe
    if (err.response?.status === 404) return null;
    console.error('[cmQuotes] Error buscando artículo:', err.response?.data || err.message);
    return null;
  }
}

async function createItem(item) {
  const body = {
    ItemCode:      item.itemId,
    ItemName:      item.itemName,
    ItemType:      'itItems',
    InventoryItem: 'tYES',
    SalesItem:     'tYES',
    PurchaseItem:  'tYES',
    ItemsGroupCode: 125,
    TaxCodeAR:     'I1',
    ...(item.unitPrice != null && { SalesPrice: item.unitPrice }),
  };

  await sapPost('/Items', body);
  return item.itemId;
}

function missingItemFields(item) {
  const missing = [];
  if (!item.itemId)   missing.push('itemId');
  if (!item.itemName) missing.push('itemName');
  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Líneas de la Oferta de Venta
// Verifica/crea artículos y construye las líneas
// ─────────────────────────────────────────────────────────────────────────────

async function resolveLines(items = [], logs = []) {
  const lines = [];

  for (const item of items) {
    if (!item.itemName) {
      logs.push(`Item ignorado — falta itemName.`);
      continue;
    }

    // Si no viene itemId — error descriptivo
    if (!item.itemId) {
      logs.push(`Item "${item.itemName}" ignorado — falta itemId.`);
      continue;
    }

    // Verificar si el artículo ya existe en SAP
    const existing = await itemExists(item.itemId);

    if (existing) {
      // Artículo existe — NO mandamos descripción, SAP usa la original
      logs.push(`Artículo encontrado en SAP: ${item.itemId} - ${existing.ItemName}`);
      lines.push({
        ItemCode:  item.itemId,
        Quantity:  item.quantity  || 1,
        UnitPrice: item.unitPrice || 0,
      });
    } else {
      // Artículo no existe — validar campos mínimos para crearlo
      const missing = missingItemFields(item);
      if (missing.length > 0) {
        logs.push(`Artículo "${item.itemId}" no existe en SAP y faltan datos para crearlo: ${missing.join(', ')} — ignorado.`);
        continue;
      }

      // Crear artículo
      await createItem(item);
      logs.push(`Artículo nuevo creado en SAP: ${item.itemId} - ${item.itemName} (Grupo: 125 - TALLER SERVICIO, IVA: I1)`);
      lines.push({
        ItemCode:  item.itemId,
        Quantity:  item.quantity  || 1,
        UnitPrice: item.unitPrice || 0,
      });
    }
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Crear Oferta de Venta en SAP
// ─────────────────────────────────────────────────────────────────────────────

async function createQuotation(cardCode, cm, lines) {
  const vehicleInfo = [cm.brand, cm.model, cm.year, cm.vin]
    .filter(Boolean)
    .join(' - ');

  const body = {
    CardCode:      cardCode,
    DocDate:       cm.date || new Date().toISOString().split('T')[0],
    Comments:      `Orden CM #${cm.orderNumber}${vehicleInfo ? ' | ' + vehicleInfo : ''}`,
    U_CM_OrderId:  String(cm.orderNumber || ''),
    DocumentLines: lines,
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
      logs: [], data: [],
    });
  }

  if (!cm.items || cm.items.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Se requiere al menos un item en el campo items.',
      logs: [], data: [],
    });
  }

  let step         = 'buscar cliente';
  let cardCode     = null;
  let customerName = null;

  try {

    // ── CLIENTE ──────────────────────────────────────────────────────────────

    // 1. cardCode directo en payload
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

    // 4. Crear cliente si no existe
    if (!cardCode) {
      const missing = missingCustomerFields(cm);
      if (missing.length > 0) {
        return res.status(400).json({
          success: false,
          message: `No se encontró el cliente y faltan datos para crearlo: ${missing.join(', ')}.`,
          logs, data: [],
        });
      }
      step = 'crear cliente';
      const result = await createCustomer(cm);
      cardCode     = result.cardCode;
      customerName = result.cardName;
      logs.push(`Cliente nuevo creado en SAP: ${cardCode} - ${customerName} (RFC: ${extractRFC(cm)}, Régimen: ${extractRegimen(cm)})`);
    }

    // ── ARTÍCULOS ─────────────────────────────────────────────────────────────

    step = 'resolver articulos';
    const lines = await resolveLines(cm.items, logs);

    if (lines.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No se pudo resolver ningún artículo válido para la cotización.',
        logs, data: [],
      });
    }

    // ── COTIZACIÓN ────────────────────────────────────────────────────────────

    step = 'crear cotizacion';
    const quotation = await createQuotation(cardCode, cm, lines);
    logs.push(`Oferta de Venta creada: DocNum ${quotation.DocNum} — Cliente: ${cardCode} — ${lines.length} línea(s)`);

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
      logs, data: [],
    });
  }
});

module.exports = router;
