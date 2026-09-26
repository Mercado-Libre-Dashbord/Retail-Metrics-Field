-- Margen estimado por producto, con los cargos reales de Mercado Libre.
-- Correr tal cual en el SQL Editor de Supabase. Idempotente.
--
-- Antes el "Margen" de Productos era solo (precio − costo) / precio: un
-- producto de $87.000 con costo $22.620 mostraba 74% aunque Mercado Libre se
-- quedara con la comisión, el cargo fijo y el envío gratis. Para mostrar el
-- margen de verdad de un producto que todavía no vendió (o no vendió en el
-- período elegido), el sync guarda por publicación lo que Mercado Libre
-- cobraría hoy por venderla a su precio:
--
--   listing_type_id     Tipo de publicación (gold_special = Clásica, gold_pro = Premium).
--   free_shipping       Si la publicación ofrece envío gratis (lo paga el vendedor).
--   est_price           Precio con el que se calculó la estimación.
--   est_sale_fee        Cargo por vender una unidad a ese precio (comisión + cargo fijo),
--                       según /sites/MLA/listing_prices.
--   est_fixed_fee       La parte fija de ese cargo (para recalcular si cambia el precio).
--   est_shipping_cost   Lo que le cuesta al vendedor el envío gratis de una unidad.
--   est_updated_at      Cuándo se calculó; se renueva cada pocos días o si cambia el precio.

ALTER TABLE products ADD COLUMN IF NOT EXISTS listing_type_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS est_price DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS est_sale_fee DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS est_fixed_fee DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS est_shipping_cost DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS est_updated_at TIMESTAMPTZ;

-- Verificación: 7 filas.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'products'
  AND column_name IN ('listing_type_id', 'free_shipping', 'est_price', 'est_sale_fee', 'est_fixed_fee', 'est_shipping_cost', 'est_updated_at');
