-- Cierra todo lo que no sea app_user. Correr tal cual en el SQL Editor de
-- Supabase. Idempotente.
--
-- La app habla con Postgres solo como app_user, desde el servidor. Pero
-- Supabase además publica el esquema public por su Data API (REST) a los
-- roles anon y authenticated, y Postgres deja ejecutar cualquier función a
-- PUBLIC por defecto. RLS ya les esconde todas las filas; esto saca además
-- los permisos, para que no dependa de una sola capa:
--
-- 1. Las funciones del contador de intentos de login (SECURITY DEFINER)
--    solo las puede ejecutar app_user. Con EXECUTE para PUBLIC, cualquiera
--    con acceso a la Data API podía bloquear el login de otro o resetear su
--    contador de intentos.
-- 2. anon y authenticated pierden todo permiso sobre tablas, secuencias y
--    funciones de public, y también sobre las que se creen en el futuro.

REVOKE EXECUTE ON FUNCTION credential_record_failed_login(text, integer, integer), credential_record_successful_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credential_record_failed_login(text, integer, integer), credential_record_successful_login(text) TO app_user;

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- Verificación: 0 filas en las dos consultas.
SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0));
