# 04 · El panel del cliente

Pantalla por pantalla: qué ve el cliente, de dónde sale cada número y con qué
fórmula exacta. Este documento es la referencia cuando un cliente pregunta *"¿de
dónde sacaste este número?"* — y también el contrato que no hay que romper
cuando se toca el cálculo.

**Convención transversal:** el selector de período (la barra de botones que
aparece arriba en Resumen, Campañas y Tendencias) define el rango de todo lo que
está debajo. Opciones: **hoy · esta semana · este mes · este trimestre · este
semestre · este año · histórico**, más un rango personalizado. "Esta semana" es
semana calendario (lunes → hoy), no los últimos 7 días. La lógica vive en
`lib/period.ts` y es la única fuente de rangos de toda la app.

---

## Navegación

| Sección | Para qué entra el cliente |
|---|---|
| **Resumen** | Su tablero diario: cuánto vendió, cuánto ganó, con qué |
| **Productos** | Cargar costos y ver el margen de cada publicación |
| **Consultas** | Responder preguntas de compradores sin salir del panel |
| **Campañas** | Ver y pausar campañas de Mercado Ads, cargar publicidad externa |
| **Tendencias** | Qué productos están acelerando y cuáles se apagan |
| **Fidelización** | Configurar el programa de puntos y el cupón |
| **Configuración** | Alícuota de otros impuestos |
| **Cuentas** *(solo admin)* | Alta de clientes y cambio de cuenta activa |

---

## Resumen

### El botón Sincronizar

Un solo botón hace todo: trae publicaciones, órdenes nuevas, **repara órdenes
viejas** cuando cambió la fórmula, trae publicidad y trae la facturación de ML.
Va mostrando *"N de M órdenes…"* mientras avanza porque un proceso largo sin
señal de vida parece colgado. Detalle técnico en
[06 · Arquitectura](06-arquitectura.md#sincronización).

### Las ocho tarjetas de "Tienda"

Cada una tiene un ícono **ⓘ** que despliega esta misma explicación dentro de la
app. Si cambiás una fórmula, cambiá también el texto del ⓘ en `app/page.tsx`.

| Tarjeta | Fórmula | Detalle |
|---|---|---|
| **Facturación** *(tarjeta principal, en negro)* | `Σ (precio unitario × cantidad)` | Antes de descontar nada. Excluye canceladas. |
| **Órdenes** | `COUNT(DISTINCT orden)` | Órdenes con al menos una venta en el período. Excluye canceladas. |
| **Devoluciones** | `Σ` importe de órdenes **canceladas** | No resta de la facturación (la venta nunca ocurrió), se muestra aparte. Debajo: cantidad de órdenes y % sobre las ventas. |
| **Ticket promedio** | `Facturación ÷ Órdenes` | |
| **Ganancia neta** | ver fórmula completa abajo | Las líneas sin costo cargado quedan **afuera**. |
| **Margen neto** | `Ganancia neta ÷ Facturación` | De cada $100 facturados, cuánto queda. |
| **Facturación neta** | `Facturación − comisión ML − envío` | No descuenta costo ni impuestos. Es el "cuánto me depositan". |
| **Visitas** | `/users/{id}/items_visits` | Muestra **"Sin dato"** si ML no devuelve nada, nunca cero. Debajo: tasa de conversión = órdenes ÷ visitas. |

Las tarjetas de Facturación, Órdenes y Ganancia neta muestran además una
**píldora de variación** contra el período anterior equivalente (este mes vs. el
mes pasado, este año vs. el año pasado).

### La fórmula de la ganancia neta

Se calcula **por línea de venta** y se congela en `order_items.net_profit`.
Vive en `sync/profitability.ts:calculateNetProfit`.

```
ganancia neta de la línea =
      precio unitario × cantidad
    − comisión de Mercado Libre
    − costo de envío (prorrateado si la orden tiene varias líneas)
    − publicidad asignada
    − costo del producto × cantidad
    − otros impuestos × cantidad        (alícuota de la cuenta: IIBB, internos)
    − IVA a pagar                       (débito fiscal − crédito fiscal)
```

Con dos reglas que no son negociables:

- **Si falta el costo del producto, el resultado es `null`**, no cero. Esa línea
  no entra en ningún agregado de ganancia, y el panel avisa abajo de las
  tarjetas: *"N línea(s) de venta sin costo cargado, excluidas de Ganancia
  neta"*.
- **Publicidad asignada** = `(gasto del día ÷ unidades vendidas ese día) ×
  unidades de esta línea`. Es un reparto, no una atribución: no sabemos qué
  venta vino de qué anuncio.

### "En qué se fue tu facturación" (torta)

Descompone la facturación del período en: comisión ML, envío, publicidad, costo
de producto, IVA, otros impuestos y **ganancia neta** (la única porción en
verde). Responde de un vistazo la pregunta *"¿a dónde se fue mi plata?"*.

### "Productos más vendidos" (top 5)

Con foto, unidades vendidas y ganancia. Deliberadamente **al lado** del top por
ganancia: *más vendido* y *más rentable* casi nunca son el mismo producto, y ver
las dos listas juntas es donde el cliente toma decisiones.

### "Rendimiento de ventas" (línea)

Facturación y ganancia neta por día dentro del período. Facturación en negro
(serie protagonista), ganancia en gris (contexto).

### "Lo que Mercado Libre te facturó"

Los cargos **reales** de la factura de ML, traídos de su API de facturación, con
una columna al lado que muestra **lo que nosotros calculamos** para comisión y
envío. Es una herramienta de auditoría: si las dos columnas no cierran, nuestro
cálculo tiene un problema.

Algunas facturas de ML no llegan por la API de facturación (vienen por otro
canal). Para esas, el cliente puede **cargarlas a mano** con "Agregar una
factura de ML a mano": fecha, concepto (comisión, envío, impuestos, publicidad,
Full u otros), importe (negativo para una nota de crédito) y un detalle
opcional. Se guardan en `billing_charges` junto a las sincronizadas (con
`detail_type = 'MANUAL'`, así el sync nunca las pisa), suman en esta tabla y en
los costos de Full, y se pueden borrar. No requiere migración.

> ⚠️ Estos cargos **no entran** en la ganancia neta. La comisión y el envío ya se
> descuentan por orden; sumarlos otra vez los contaría dos veces. Están
> pendientes de que el cliente valide que los números cierran antes de decidir
> si reemplazan la estimación por orden. Es un ítem abierto del
> [roadmap](07-estado-y-roadmap.md).

### "Top productos por ganancia" y "Últimas órdenes"

Top por ganancia: con foto, para poder reconocer el producto sin leer el título.
Últimas órdenes: la tabla del período, con estados traducidos y con color, y las
canceladas tachadas mostrando "—" en la ganancia.

---

## Productos

La tabla operativa del vendedor. Columnas: **Producto** (con foto y SKU) ·
Precio · Stock · Costo · Margen · Vendidas · Rentabilidad · Actualizar costo ·
enlace a ML.

Tres cosas que hace esta pantalla y que conviene entender:

1. **Cargar el costo es lo que enciende el producto.** Sin costo, ese producto
   no aporta a la ganancia neta en ningún lado. Es el único trabajo manual
   inevitable del cliente.
2. **El costo tiene historial** (`product_costs.valid_from`). Cargar un costo
   nuevo hoy no reescribe el margen de las ventas de marzo.
3. **El precio se edita acá y se escribe en Mercado Libre** (`PUT /items/{id}`).
   El vendedor no tiene que ir y volver.

**Margen** = `(precio × (1 − alícuota de otros impuestos) − costo) ÷ precio`.

> Los "otros impuestos" **no** se cargan por producto: se configuran una sola vez
> a nivel cuenta en Configuración. Antes eran una columna por producto y era una
> fuente de error y de trabajo repetido.

La tabla está pensada para **entrar sin scroll horizontal** en pantallas de
1000px para arriba, con encabezado fijo al hacer scroll vertical.

---

## Consultas

Las preguntas sin responder de Mercado Libre, con la foto del producto, y un
**borrador de respuesta sugerido**.

El borrador sale de reglas simples sobre palabras clave (stock, envío, precio,
garantía, mayorista, retiro…), no de un modelo de lenguaje: sin costo, sin
latencia y sin dependencia nueva. Si no reconoce el patrón, deja el campo vacío
para que lo escriba el vendedor.

**Nada se envía a Mercado Libre sin que el vendedor apriete "Enviar".** Puede
guardar el borrador y seguir después.

---

## Campañas

- **Campañas de Mercado Ads**: nombre, estado, inversión, y la acción de
  pausar/reanudar.
- **Anuncios**: el detalle por publicación.
- **Cargar publicidad externa**: Meta, Google Ads y TikTok se cargan a mano. Ese
  gasto entra en los indicadores a nivel cuenta, pero **no se prorratea por
  producto** porque no tenemos atribución.

> Nota técnica que explica un bug histórico: la API de Mercado Ads acepta
> **como máximo 90 días por consulta**. Pedir "este año" devolvía un error. Los
> períodos largos se parten en ventanas de 90 días y se suman.

---

## Tendencias

Dos listas: **"Están despegando"** y **"Se están apagando"**.

Compara la **segunda mitad del período contra la primera**, midiendo
**unidades por semana** y no el total acumulado. La distinción importa: un
producto que vendió 100 unidades el mes pasado y 60 este mes está cayendo, pero
si lo mirás por total acumulado del trimestre sigue siendo tu producto estrella.
La velocidad avisa antes.

---

## Fidelización

Ver [05 · Fidelización y reviews](05-fidelizacion-y-reviews.md). En resumen: la
tabla de misiones con sus puntos, la configuración del premio (puntos
necesarios, monto del cupón, compra mínima, presupuesto tope) y el interruptor
de activación.

---

## Configuración

Un solo campo: **otros impuestos, como % de la facturación** (Ingresos Brutos,
internos). Se aplica igual a todos los productos.

El IVA **no** va acá: se calcula solo al 21%. Cargarlo acá sería contarlo dos
veces. La pantalla lo dice explícitamente, porque es el error que un cliente
haría naturalmente.

---

## Estados vacíos y de error

Tratados como parte del producto, no como un detalle:

- Sin cuenta de ML conectada → invitación a conectar, no una pantalla en cero.
- Sin ventas en el período → *"Probá con un período más largo"*, sugiriendo cuál.
- Falta una migración en la base → **banner solo para el admin** con el SQL
  exacto a correr. El cliente nunca ve esto.
- Dato ausente → *"Sin dato"*, nunca `0`.
