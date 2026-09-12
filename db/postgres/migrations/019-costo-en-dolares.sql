-- Guarda, junto a cada costo cargado, el tipo de cambio vigente en ese
-- momento y en qué moneda lo escribió el vendedor. Correr tal cual en el SQL
-- Editor de Supabase. Idempotente.
--
-- El costo canónico (columna `cost`, usada para calcular margen y ganancia)
-- sigue siempre en pesos, sin cambios. Lo nuevo es guardar también el TC
-- usado al cargarlo, así se puede mostrar el mismo costo convertido a
-- dólares sin que el número "salte" cada vez que cambia la cotización del
-- día: es una foto de ese momento, igual que el costo mismo.
--
-- NULL en costos cargados antes de esta migración: no hay TC guardado para
-- ellos, así que el lado en dólares se muestra vacío hasta que se vuelvan a
-- guardar.

ALTER TABLE product_costs ADD COLUMN IF NOT EXISTS exchange_rate DOUBLE PRECISION;
ALTER TABLE product_costs ADD COLUMN IF NOT EXISTS cost_currency TEXT NOT NULL DEFAULT 'ARS';

-- Verificación: 2 filas.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'product_costs' AND column_name IN ('exchange_rate', 'cost_currency');
