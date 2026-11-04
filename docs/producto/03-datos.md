# 03 · Datos

Qué datos entran al sistema, de dónde vienen, con qué frecuencia se actualizan,
qué asumimos cuando falta algo, y —tan importante como lo anterior— **qué datos
NO tenemos**, para que nadie prometa una función que no se puede construir.

## De dónde viene cada dato

### Mercado Libre (API oficial, OAuth por cuenta)

Todo lo de esta tabla se sincroniza con el botón **Sincronizar** del Resumen. El
código vive en `mcp/tools.ts`.

| Dato | Endpoint | Qué nos da | Notas |
|---|---|---|---|
| Publicaciones | `/users/{id}/items/search` + `/items/{id}` | Título, SKU, precio, stock, permalink, categoría, foto | Trae activas, pausadas y cerradas. Se pide cada publicación por separado, de a 10 en simultáneo: ML dio de baja `/items?ids=` para esta app (403 "Resource deprecated"). |
| Nombre de categoría | `/categories/{id}` | El nombre legible | `/items` solo devuelve el id. Cada categoría se resuelve una sola vez. |
| Órdenes | `/orders/search` | Ids de órdenes desde una fecha | **Paginado.** Sin paginar, una sincronización histórica se cortaba en silencio a las 50 órdenes. |
| Detalle de orden | `/orders/{id}` | Líneas, precio unitario, cantidad, comisión de ML, estado, total del comprador | |
| **Costo de envío** | `/shipments/{id}/costs` | Lo que paga el **vendedor** (campo `senders[]`) | ⚠️ Ver "La trampa del envío" abajo. Header `x-format-new: true`. |
| Publicidad (Mercado Ads) | `/marketplace/advertising/{site}/advertisers/{id}/product_ads/...` | Campañas, estado, inversión, métricas | Header `Api-Version: 2`. **Máximo 90 días por consulta**: los períodos largos se parten en ventanas. |
| Preguntas de compradores | `/questions/search?status=UNANSWERED` | Preguntas sin responder | |
| Responder una pregunta | `POST /answers` | — | Solo cuando el vendedor aprieta "Enviar". |
| Cambiar precio | `PUT /items/{id}` | — | Escritura desde la pantalla Productos. |
| Visitas a publicaciones | `/users/{id}/items_visits` | Visitas totales en un rango | Devuelve `null` si ML no tiene el dato — **no** cero. |
| Facturación de ML | `/billing/integration/monthly/periods` + `/details` | Todo lo que ML le cobró al vendedor, por concepto | Paginado con `from_id`. |
| Emitir cupón | `POST /seller-promotions/promotions` | Cupón oficial de ML | Tipo `SELLER_COUPON_CAMPAIGN`. Usado por Fidelización. |

### El vendedor (carga manual, en el panel)

| Dato | Dónde se carga | Por qué no puede venir de la API |
|---|---|---|
| **Costo de cada producto** | Pantalla Productos | Nadie lo tiene salvo el vendedor. Es el dato que hace posible todo el producto. |
| Alícuota de otros impuestos (IIBB, internos) | Configuración | Depende de la jurisdicción y la situación fiscal del vendedor. |
| Publicidad externa (Meta, Google, TikTok) | Campañas → "Cargar publicidad externa" | No hay integración por API con esas plataformas. |

### Tienda Nube (adaptador escrito, conexión pendiente)

El adaptador `channels/tiendanube.ts` ya sabe traer productos y órdenes. Falta
el OAuth. Ver [07 · Roadmap](07-estado-y-roadmap.md#tienda-nube).

## Las tres trampas de los datos de Mercado Libre

Estas nos costaron encontrarlas y son la razón por la que nuestro número es
distinto al de una planilla. Si tocás el cálculo, no las rompas.

### 1. La trampa del envío
El objeto `shipping` dentro de `/orders/{id}` **solo trae un id**. No trae el
costo. Cualquier implementación que lea `order.shipping.cost` obtiene
`undefined`, lo convierte en 0, y reporta una ganancia inflada. El costo real
está en `/shipments/{id}/costs`, en el arreglo `senders[]` (lo que paga el
vendedor, distinto de lo que paga el comprador).

Además: en una orden con varios productos, el envío es **uno solo para toda la
orden**. Lo prorrateamos entre las líneas. La versión anterior copiaba el costo
completo en cada línea y multiplicaba el descuento por la cantidad de productos.

### 2. La trampa del IVA
El precio publicado en Mercado Libre **ya incluye IVA**. De cada $121 que cobra
el vendedor, $21 son débito fiscal. Contra eso descuenta el crédito fiscal del
IVA contenido en la comisión, el envío, la publicidad y el costo de la
mercadería. Lo que queda —débito menos crédito— sale de su bolsillo.

Restar ese saldo es matemáticamente idéntico a calcular toda la rentabilidad en
valores netos, pero se muestra como una línea aparte porque *"esto se te va en
IVA"* se entiende y *"todos los números divididos por 1,21"* no.

Implementado en `lib/iva.ts`, con tests.

### 3. La trampa de las canceladas
Una orden cancelada sigue existiendo en la API con todas sus líneas y sus
importes. Si se suman sin filtrar, aportan facturación y ganancia que nunca
ocurrieron. `lib/order-status.ts` define los estados que **no** cuentan
(`cancelled`, `invalid`) y todos los agregados financieros los excluyen. En la
tabla de órdenes se muestran igual, tachadas, porque el vendedor quiere verlas.

## Lo que asumimos

Asunciones vigentes. Cada una es una limitación conocida, no un descuido:

| Asunción | Por qué | Cuándo hay que revisarla |
|---|---|---|
| El vendedor es **Responsable Inscripto** con IVA al 21% | Es el caso del 100% de nuestros clientes hoy. Un campo configurable sería una perilla más para equivocarse. | El día que tengamos un cliente Monotributista o exento. Se vuelve un campo en `accounts`. |
| La mercadería se compra **con factura A** (con IVA, genera crédito fiscal) | Es lo normal en un vendedor RI que compra a proveedores formales | Si aparece un cliente que compra sin factura, su crédito fiscal es menor y le estamos sobreestimando la ganancia |
| Si un producto tiene ventas anteriores al primer costo cargado, se les aplica **ese primer costo** | La mejor estimación disponible es mejor que "sin dato" para una venta vieja | Está en `sync/profitability.ts:getCostEntryAtDate`. Es la única estimación que nos permitimos, y es explícita. |
| La publicidad diaria se reparte **por unidad vendida ese día** | No hay datos de atribución: no sabemos qué venta vino de qué anuncio | Si Mercado Ads algún día expone atribución por orden |

## Lo que NO tenemos

Escrito para que nadie prometa esto en una demo:

- **Atribución de publicidad por venta.** Sabemos cuánto se gastó por día y
  cuántas unidades se vendieron ese día. No sabemos qué venta vino de qué
  anuncio. Por eso la publicidad externa (Meta, Google, TikTok) entra en los
  indicadores a nivel cuenta pero **no se prorratea por producto**.
- **Datos del comprador.** Mercado Libre no nos da mail ni teléfono. Es
  deliberado de su parte, y es exactamente el motivo por el que el módulo de
  fidelización existe.
- **Verificación de que alguien siguió la tienda o dejó una opinión.** No hay
  endpoint para consultarlo. Hoy es sistema de honor a través de la app de
  billetera. Ver [05](05-fidelizacion-y-reviews.md#el-agujero-conocido).
- **Costos operativos del vendedor** (alquiler, sueldos, packaging). La
  "ganancia neta" es ganancia por venta, no resultado del negocio. Vale la pena
  ser explícitos con el cliente.
- **Devoluciones parciales o reembolsos que no cancelan la orden.** Hoy medimos
  devoluciones como órdenes canceladas.

## Modelo de datos

Postgres (Supabase). Todas las tablas tienen `account_id` y RLS activo.

| Tabla | Qué guarda | Clave |
|---|---|---|
| `accounts` | El cliente: nombre, mail del dueño, seller id de ML, alícuota de otros impuestos | `id` |
| `auth_tokens` | Tokens OAuth de Mercado Libre | por cuenta |
| `products` | Publicaciones sincronizadas: título, SKU, precio, stock, categoría, foto, canal | `(account_id, id)` |
| `product_costs` | Historial de costos: costo, impuesto, `valid_from` | serial |
| `orders` | Órdenes: fecha, estado, total, canal, `sync_version` | `(account_id, id)` |
| `order_items` | **El corazón del sistema.** Una fila por línea de venta con todos los descuentos ya calculados y congelados | serial |
| `ads_spend` | Inversión publicitaria por día y canal (ML, Meta, Google, TikTok) | serial |
| `question_drafts` | Preguntas de compradores y el borrador de respuesta | por pregunta |
| `billing_charges` | Lo que ML le facturó al vendedor, por concepto | por detalle |
| `invoices` | Comprobantes fiscales emitidos (ARCA) | `(account_id, order_id)` |
| `channel_connections` | Credenciales por canal de venta | `(account_id, channel)` |
| `loyalty_programs` | Configuración del programa por cuenta | `account_id` |
| `loyalty_members` | Miembros y cupón otorgado | `(account_id, member_id)` |
| `loyalty_completions` | Misiones cumplidas | `(account_id, member_id, mission)` |

### Por qué `order_items` guarda los cálculos en vez de calcularlos al vuelo

Cada fila de `order_items` guarda `ml_commission`, `shipping_cost`,
`ads_cost_allocated`, `cost_applied`, `tax_applied`, `iva_applied` y
`net_profit` **ya resueltos**.

Es a propósito: la rentabilidad de una venta de marzo tiene que seguir siendo la
misma en agosto, aunque desde entonces el vendedor haya cambiado el precio, el
costo o la alícuota de impuestos. Si se calculara al vuelo, el pasado cambiaría
solo cada vez que alguien toca una configuración. Y además: si la fórmula
cambia, los datos viejos se reparan a propósito subiendo `ORDER_SYNC_VERSION`
(ver [06 · Arquitectura](06-arquitectura.md#sincronización)), que es una
decisión explícita y no un efecto secundario.
