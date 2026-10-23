-- 025 · "Unidades por pack" de la ficha de cada publicación de Mercado Libre.
-- Lo usa Productos → Importar costos para saber cuántas unidades del
-- artículo trae una publicación por cantidad (pack x6, docena, etc.) aunque
-- el título no lo diga. Se llena en la próxima sincronización. Idempotente.
ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_pack INTEGER;
