# MetricsField Retail

App multi-cuenta (Next.js) que sincroniza productos, órdenes, envíos y
publicidad desde Mercado Libre, y calcula la rentabilidad **real** de cada
cuenta: descuenta comisión, envío, publicidad, costo de mercadería, IVA y otros
impuestos. Encima de esa base corre un módulo de fidelización que convierte
compradores en seguidores y opiniones dentro de Mercado Libre.

> 📘 **¿Buscás entender el producto y no cómo instalarlo?**
> La documentación de producto está en **[`docs/producto/`](docs/producto/)**:
> qué construimos y por qué, modelo de negocio, qué datos obtenemos, el panel
> pantalla por pantalla, fidelización y reviews, arquitectura, y el estado del
> roadmap. Empezá por [el índice](docs/producto/README.md).
>
> Este README cubre solo el **setup técnico**.

Cada cliente entra con su cuenta de Google y ve solo su propia cuenta de
Mercado Libre; el/los email(s) en `ADMIN_EMAILS` pueden ver y crear cualquier
cuenta (switcher en la barra de navegación + pantalla `/admin`).

La base es Postgres en Supabase, con **Row Level Security (RLS)** activado en
todas las tablas: aunque el código de la app tuviera un bug y se olvidara de
filtrar por cuenta en alguna query, Postgres igual bloquea ver datos de otra
cuenta (ver "Seguridad" más abajo).

## Setup

1. `npm install`
2. Seguí **"Base de datos (Supabase)"** más abajo para crear el proyecto y
   correr `db/postgres/schema.sql`.
3. Copiá `.env.example` a `.env` y completá:
   - `ML_CLIENT_ID` / `ML_CLIENT_SECRET`: de tu app en developers.mercadolibre.com
     (una sola app sirve para todas las cuentas/clientes).
   - `ML_REDIRECT_URI`: debe coincidir exactamente con el configurado en la app
     de ML (por defecto `http://localhost:3000/api/ml/callback`).
   - `DATABASE_URL`: la connection string del rol `app_user` (no la de
     `postgres` ni la `service_role` — ver más abajo).
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: credenciales OAuth de Google
     Cloud Console (tipo "Web application"), con `http://localhost:3000/api/auth/callback/google`
     como redirect URI autorizado.
   - `NEXTAUTH_SECRET`: cualquier string random largo (`openssl rand -base64 32`).
   - `ADMIN_EMAILS`: tu email de Google, separado por coma si hay más de un admin.
     `ADMIN_EMAILS_EXTRA` suma más admins sin tocar la anterior.
   - `ANTHROPIC_API_KEY` (opcional): activa las respuestas a consultas con IA
     (Consultas). Sin ella se usan los borradores por palabras clave.
     `ANSWERS_MODEL` cambia el modelo (por defecto `claude-opus-5-5`).
4. `npm run dev`
5. Entrá a `http://localhost:3000`, iniciá sesión con Google.
6. Si sos admin: andá a `/admin` y creá una cuenta por cada cliente (nombre +
   email de Google con el que va a entrar).
7. Cada cliente entra con su Google, ve el banner "Conectar Mercado Libre" en
   Resumen y autoriza su propia cuenta de ML.
8. Entrá a "Productos" y cargá el costo de cada uno, después apretá
   "Sincronizar" en Resumen.

## Base de datos (Supabase)

1. Creá un proyecto en [supabase.com](https://supabase.com) (el plan free
   alcanza para arrancar).
2. Abrí **SQL Editor** en el panel de Supabase, pegá el contenido completo de
   `db/postgres/schema.sql` y ejecutalo. Es idempotente — correrlo de nuevo
   no rompe nada. Esto crea las tablas, activa RLS con sus políticas, y crea
   un rol de base de datos `app_user` con una contraseña placeholder.
3. Cambiale la contraseña a `app_user` (SQL Editor):
   ```sql
   ALTER ROLE app_user WITH PASSWORD 'una-contraseña-larga-y-random';
   ```
4. Corré las migraciones de `db/postgres/migrations/` en orden (`001` … `009`),
   una por una. **Importante:** el SQL Editor de Supabase corre todo lo pegado
   como una sola transacción, así que si una sentencia falla se revierte todo
   en silencio — por eso van de a una. Cada archivo termina con un `SELECT` de
   verificación que dice cuántas filas tiene que devolver.
5. En **Project Settings → Database → Connection string**, copiá la del
   **Transaction pooler** (puerto 6543) y reemplazá el usuario/contraseña por
   los de `app_user`:
   ```
   postgres://app_user:TU_PASSWORD@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
6. Usá esa URL como `DATABASE_URL` (local y en Vercel).

### ¿Por qué un rol `app_user` en vez de conectarse directo?

Supabase te da por defecto el usuario `postgres` (superusuario) y una
`service_role` key — **ambos ignoran RLS por diseño**. Si la app se conectara
con cualquiera de los dos, las políticas de seguridad que activa
`schema.sql` no harían nada; sería seguridad de utilería, no real. `app_user`
es un rol común, sin privilegios especiales, así que cada query que la app
corre pasa sí o sí por las políticas de RLS.

### Seguridad: qué protege RLS acá

Cada tabla de datos (`products`, `orders`, `order_items`, `ads_spend`,
`product_costs`, `auth_tokens`) tiene una política que solo deja ver/escribir
filas de la cuenta activa en esa request (`account_id = app_current_account_id()`).
La tabla `accounts` tiene su propia política: un admin ve todas, un cliente
solo la suya (por email).

Esto es una segunda capa además del filtrado que ya hace el código de la
app (`WHERE account_id = ...` en cada ruta) — no lo reemplaza, lo respalda:
si mañana una ruta nueva se olvida ese filtro, Postgres igual no devuelve
filas de otra cuenta. Está probado en `db/rls-isolation.test.ts` con datos
reales de dos cuentas distintas, incluyendo una query deliberadamente sin
`WHERE account_id`.

## Tests

`npm test` — corre contra una base Postgres real (no mocks para la capa de
datos). Necesita una base local: ver `db/postgres/schema.sql` y crear un rol
`app_user` con la contraseña `app_user_local_test_pw` en una base
`ml_dashboard_test`, o exportar `TEST_DATABASE_URL` apuntando a la tuya.

## Notas

- Los tokens de Mercado Libre y los datos de cada cuenta viven únicamente en
  Postgres, nunca se commitean.
- Si `getAdsSpend` (en `mcp/tools.ts`) no coincide con la respuesta real de la API de
  Mercado Ads en una cuenta, ajustá el mapeo de campos ahí — es el único punto marcado
  como "a validar" en el plan de implementación.

## Publicidad externa (Meta / Google / TikTok)

El gasto de Mercado Ads se sincroniza solo con el botón "Sincronizar". El gasto
de Meta, Google Ads y TikTok se carga a mano desde la sección "Cargar publicidad
externa" en **Campañas** (no hay integración por API con esas plataformas — ver
la adenda del spec para el porqué). Ese gasto entra en Ad Spend/MER/ROAS/CPA a
nivel cuenta, pero no se prorratea por producto porque no tenemos forma de saber
qué venta vino de qué canal sin datos de atribución.
