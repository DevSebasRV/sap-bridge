const swaggerUi   = require('swagger-ui-express');

const spec = {
  openapi: '3.0.0',
  info: {
    title:       'SAP Bridge — ClearMechanic Integration',
    version:     '1.0.0',
    description: 'API intermediaria entre ClearMechanic y SAP Business One Service Layer.',
  },
  servers: [
    { url: 'https://proxy-sap.ferbel.com.mx', description: 'Producción (Lightsail)' },
    { url: 'http://localhost:3000',            description: 'Local' },
  ],
  tags: [
    { name: 'Health',     description: 'Estado del servicio' },
    { name: 'CM Quotes',  description: 'Crear Ofertas de Venta en SAP desde ClearMechanic' },
    { name: 'SAP Proxy',  description: 'Proxy directo al SAP Service Layer' },
  ],
  paths: {

    // ── Health ──────────────────────────────────────────────────────────────
    '/health': {
      get: {
        tags:    ['Health'],
        summary: 'Verifica que el servicio está corriendo',
        responses: {
          200: {
            description: 'Servicio activo',
            content: { 'application/json': {
              example: { status: 'ok', service: 'sap-bridge' }
            }},
          },
        },
      },
    },

    // ── CM Quotes ────────────────────────────────────────────────────────────
    '/cm-quotes': {
      post: {
        tags:    ['CM Quotes'],
        summary: 'Crear Oferta de Venta en SAP B1 desde una orden de ClearMechanic',
        description: `
**Flujo:**
1. Busca cliente en SAP por RFC → por móvil → si no existe lo crea
2. Por cada item: busca en SAP → si no existe lo crea
3. Crea la Oferta de Venta con las líneas resueltas

**Cliente:**
- Si se envía \`cardCode\` se usa directo sin buscar
- Si se envía \`rfc\` busca por RFC en SAP
- Si se envía \`mobile\` busca por teléfono móvil en SAP
- Si no se encuentra, intenta crear el cliente (requiere: firstName/lastName, rfc, regimen, mobile o email)

**Items:**
- Si \`itemId\` existe en SAP → se usa sin modificar descripción
- Si \`itemId\` NO existe en SAP → se crea el artículo (requiere: itemId, itemName)
- Si no viene \`itemId\` → se ignora con log

**RFC y Régimen Fiscal** también pueden venir en \`orderCustomizableFields\` con nombres que contengan "rfc" y "regimen".
        `,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CMQuoteRequest' },
              examples: {
                'Cliente nuevo + Item nuevo': {
                  summary: 'Crea cliente nuevo y artículo nuevo en SAP',
                  value: {
                    orderNumber: 'TEST-001',
                    date:        '2026-04-14',
                    firstName:   'Juan',
                    lastName:    'Pérez TEST',
                    email:       'juan.test@test.com',
                    mobile:      '5500000099',
                    rfc:         'PEPJ800101000',
                    regimen:     '601',
                    brand:       'Honda',
                    model:       'CBR',
                    year:        2024,
                    vin:         'TEST00000000000099',
                    items: [
                      { itemId: 'ITEM-NUEVO-001', itemName: 'Balata Delantera Test', quantity: 1, unitPrice: 350.00 },
                      { itemId: 'ITEM-NUEVO-002', itemName: 'Aceite Motor Test',     quantity: 2, unitPrice: 120.00 },
                    ],
                  },
                },
                'Cliente existente por RFC': {
                  summary: 'Busca cliente por RFC — no crea uno nuevo',
                  value: {
                    orderNumber: 'TEST-002',
                    date:        '2026-04-14',
                    rfc:         'TST2010101000',
                    brand:       'KTM',
                    model:       'DUKE',
                    year:        2023,
                    items: [
                      { itemId: '.0114', itemName: 'Item existente', quantity: 1, unitPrice: 0 },
                    ],
                  },
                },
                'Cliente existente por móvil': {
                  summary: 'Busca cliente por número móvil',
                  value: {
                    orderNumber: 'TEST-003',
                    date:        '2026-04-14',
                    mobile:      '5500000002',
                    brand:       'Yamaha',
                    model:       'R3',
                    year:        2022,
                    items: [
                      { itemId: '.0114', itemName: 'Item existente', quantity: 1, unitPrice: 0 },
                    ],
                  },
                },
                'CardCode directo': {
                  summary: 'Usa CardCode SAP directamente sin buscar',
                  value: {
                    orderNumber: 'TEST-004',
                    date:        '2026-04-14',
                    cardCode:    '/42713',
                    brand:       'Suzuki',
                    model:       'GSXR',
                    year:        2021,
                    items: [
                      { itemId: '.0114', itemName: 'Faro',         quantity: 1, unitPrice: 0 },
                      { itemId: '.0114', itemName: 'Direccionales', quantity: 1, unitPrice: 0 },
                    ],
                  },
                },
                'Con orderCustomizableFields (formato ClearMechanic)': {
                  summary: 'RFC y Régimen en campos personalizables de CM',
                  value: {
                    orderNumber: 'TEST-005',
                    date:        '2026-04-14',
                    firstName:   'Pedro',
                    lastName:    'Monraz',
                    email:       'pedro@test.com',
                    mobile:      '3364971852',
                    brand:       'VW',
                    model:       'Vento',
                    year:        2022,
                    vin:         'QWERTY123456ABCDE',
                    items: [
                      { itemId: 'XYZ987', itemName: 'Balata delantera derecha', quantity: 1, unitPrice: 800 },
                      { itemId: 'ABC029', itemName: 'Cremallera',               quantity: 2, unitPrice: 14.59 },
                      { itemId: null,     itemName: 'Revisión de cremallera',   quantity: null, unitPrice: null },
                    ],
                    orderCustomizableFields: [
                      { type: 'FreeText', name: 'RFC',            value: 'MOMP800101000' },
                      { type: 'FreeText', name: 'Regimen Fiscal', value: '616' },
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Oferta de Venta creada correctamente',
            content: { 'application/json': {
              schema:  { $ref: '#/components/schemas/CMQuoteResponse' },
              example: {
                success: true,
                message: null,
                logs: [
                  'Cliente encontrado por RFC (TST2010101000): CM-TST2010101 - Carlos TEST2',
                  'Artículo nuevo creado en SAP: ITEM-NUEVO-001 - Balata Delantera Test (Grupo: 125 - TALLER SERVICIO, IVA: I1)',
                  'Artículo encontrado en SAP: .0114 - INTERCOMUNICADOR TCOM SC FREEDCONN',
                  'Oferta de Venta creada: DocNum 90370 — Cliente: CM-TST2010101 — 2 línea(s)',
                ],
                data: {
                  quoteId:      '90370',
                  orderNumber:  'TEST-001',
                  customerId:   'CM-TST2010101',
                  customerName: 'Carlos TEST2',
                  date:         '2026-04-14',
                },
              },
            }},
          },
          400: {
            description: 'Datos incompletos o inválidos',
            content: { 'application/json': {
              example: {
                success: false,
                message: 'No se encontró el cliente y faltan datos para crearlo: rfc, regimen.',
                logs:    ['No se envió RFC — se omite búsqueda por RFC.', 'No se envió móvil — se omite búsqueda por móvil.'],
                data:    [],
              },
            }},
          },
          500: {
            description: 'Error interno o de SAP',
            content: { 'application/json': {
              example: {
                success: false,
                message: 'Error en paso "crear cliente": RFC must be 12 or 13 characters long',
                logs:    ['No se encontró cliente con RFC: INVALIDO'],
                data:    [],
              },
            }},
          },
        },
      },
    },

    // ── SAP Proxy ────────────────────────────────────────────────────────────
    '/s-layer/{path}': {
      get: {
        tags:    ['SAP Proxy'],
        summary: 'GET directo al SAP Service Layer',
        description: 'Ejemplo: `/s-layer/BusinessPartners?$top=3` o `/s-layer/Items(\'.0114\')`',
        parameters: [
          { name: 'path', in: 'path', required: true, schema: { type: 'string' },
            example: 'BusinessPartners?$top=3&$select=CardCode,CardName' },
        ],
        responses: { 200: { description: 'Respuesta del SAP Service Layer' } },
      },
      post: {
        tags:    ['SAP Proxy'],
        summary: 'POST directo al SAP Service Layer',
        description: 'Envía cualquier body directamente al Service Layer. Ejemplo: `/s-layer/Quotations`',
        parameters: [
          { name: 'path', in: 'path', required: true, schema: { type: 'string' }, example: 'Quotations' },
        ],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { 200: { description: 'Respuesta del SAP Service Layer' } },
      },
    },

  },

  // ── Schemas ────────────────────────────────────────────────────────────────
  components: {
    schemas: {

      CMQuoteRequest: {
        type: 'object',
        required: ['orderNumber', 'items'],
        properties: {
          orderNumber:  { type: 'string',  description: 'Número de orden de ClearMechanic', example: 'TEST-001' },
          date:         { type: 'string',  format: 'date', description: 'Fecha de la orden', example: '2026-04-14' },
          cardCode:     { type: 'string',  description: 'CardCode SAP directo — bypasea búsqueda de cliente', example: '/42713' },
          firstName:    { type: 'string',  description: 'Nombre del cliente', example: 'Juan' },
          lastName:     { type: 'string',  description: 'Apellido del cliente', example: 'Pérez' },
          email:        { type: 'string',  description: 'Correo electrónico', example: 'juan@test.com' },
          mobile:       { type: 'string',  description: 'Teléfono móvil (10 dígitos) — usado para búsqueda y creación', example: '5500000001' },
          phoneNumber:  { type: 'string',  description: 'Teléfono fijo (alternativo a mobile)', example: '5512345678' },
          rfc:          { type: 'string',  description: 'RFC del cliente (12-13 chars) — usado para búsqueda y creación', example: 'PEPJ800101000' },
          regimen:      { type: 'string',  description: 'Régimen Fiscal SAP México (ej. 601, 616)', example: '601' },
          brand:        { type: 'string',  description: 'Marca del vehículo', example: 'KTM' },
          model:        { type: 'string',  description: 'Modelo del vehículo', example: 'DUKE' },
          year:         { type: 'integer', description: 'Año del vehículo', example: 2023 },
          vin:          { type: 'string',  description: 'Número de serie del vehículo', example: 'PA5TU9406PL851120' },
          items: {
            type: 'array',
            description: 'Lista de artículos/servicios de la cotización',
            items: { $ref: '#/components/schemas/CMQuoteItem' },
          },
          orderCustomizableFields: {
            type: 'array',
            description: 'Campos personalizables de ClearMechanic — se busca RFC y Regimen Fiscal aquí si no vienen en campos directos',
            items: { $ref: '#/components/schemas/CustomizableField' },
          },
        },
      },

      CMQuoteItem: {
        type: 'object',
        properties: {
          itemId:    { type: 'string',  description: 'Código del artículo (ItemCode en SAP) — si no existe se crea', example: 'ITEM-001' },
          itemName:  { type: 'string',  description: 'Nombre/descripción del artículo — requerido para crear si no existe', example: 'Balata Delantera' },
          quantity:  { type: 'number',  description: 'Cantidad', example: 1 },
          unitPrice: { type: 'number',  description: 'Precio unitario', example: 350.00 },
        },
      },

      CustomizableField: {
        type: 'object',
        properties: {
          type:  { type: 'string', example: 'FreeText' },
          name:  { type: 'string', example: 'RFC' },
          value: { description: 'Valor del campo (string, number, object o array según el tipo)' },
        },
      },

      CMQuoteResponse: {
        type: 'object',
        properties: {
          success:  { type: 'boolean' },
          message:  { type: 'string', nullable: true },
          logs:     { type: 'array', items: { type: 'string' } },
          data: {
            type: 'object',
            properties: {
              quoteId:      { type: 'string', description: 'DocNum de la Oferta de Venta en SAP' },
              orderNumber:  { type: 'string', description: 'Número de orden de ClearMechanic' },
              customerId:   { type: 'string', description: 'CardCode del cliente en SAP' },
              customerName: { type: 'string', description: 'Nombre del cliente en SAP' },
              date:         { type: 'string', format: 'date' },
            },
          },
        },
      },

    },
  },
};

module.exports = (app) => {
  const path = '/s-layer/api-docs';
  app.use(path, swaggerUi.serve, swaggerUi.setup(spec, {
    customSiteTitle: 'SAP Bridge API',
    customCss: `
      body { background: #fafafa; }
      .swagger-ui .topbar { display: none }
      .swagger-ui { font-family: sans-serif; }
      .swagger-ui .info .title { color: #3b4151; }
      .swagger-ui .scheme-container { background: #fff; box-shadow: 0 1px 2px 0 rgba(0,0,0,.15); padding: 10px 0; }
    `,
    swaggerOptions: { defaultModelsExpandDepth: -1 },
  }));
  console.log(`[SAP Bridge] Swagger disponible en ${path}`);
};
