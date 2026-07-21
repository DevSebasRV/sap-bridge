# sap-bridge

Proxy Node/Express al **Service Layer de SAP Business One**. Maneja el login y
las sesiones por empresa para que los clientes internos no carguen credenciales
de SAP: mandan el header `X-SAP-DB` (`cp` | `fn` | `test`) y el bridge resuelve
la sesión correcta.

## Qué expone

| Ruta | Qué hace |
|---|---|
| `ALL /s-layer/*` | Proxy genérico al Service Layer (GET/POST/PATCH/…). Reenvía el path, query y body tal cual, con la cookie de sesión de la empresa del header. Reintenta una vez si la sesión expiró. |
| `POST /cm-quotes` | Webhook: crea una **Oferta de Venta** en SAP desde una orden de ClearMechanic (resuelve/crea cliente y artículos). |
| `POST /cm-customers` | Webhook: busca (por RFC → móvil) o crea un **socio de negocio** en SAP. |
| `GET /s-layer/api-docs` | Swagger UI de este servicio. |
| `GET /health` | Estado del servicio. |

## Estructura

```
index.js            # Express: proxy /s-layer, monta rutas cm*, 404/errores JSON
lib/sapClient.js    # Sesiones por empresa (login, expiración, reintento 401),
                    # timeouts, helpers sapGet/sapPost y escape OData
routes/cmQuotes.js     # Webhook ClearMechanic → Oferta de Venta
routes/cmCustomers.js  # Webhook ClearMechanic → alta de cliente
swagger.js          # Especificación OpenAPI + UI
```

## Convenciones

- **Multi-empresa**: la empresa viaja en `X-SAP-DB`; las credenciales por
  empresa viven en `.env` (nunca en código). Sin header se usa el default del
  `.env`.
- **Valores externos en filtros OData** (RFC, nombres…): escapar siempre con
  `odataEscape()` — nunca interpolar crudo.
- **Timeouts**: toda llamada a SAP lleva timeout (login 15s, resto 60s).
- Las respuestas al cliente son siempre JSON (incluye 404 y errores).
- No loguear tokens de sesión ni credenciales.

## Desarrollo

```bash
npm install
# .env con: SAP_URL, SAP_DB_DEFAULT y, por empresa (CP/FN/TEST):
#   SAP_DB_X, SAP_USER_X, SAP_PASS_X
node index.js        # escucha en 127.0.0.1:3000 — docs en /s-layer/api-docs
```

## Despliegue

Corre como proceso administrado (pm2) enlazado a `127.0.0.1:3000`, detrás del
reverse proxy. Flujo por git: commit → push → `git pull` en el servidor →
restart. El `.env` del servidor no se versiona.
