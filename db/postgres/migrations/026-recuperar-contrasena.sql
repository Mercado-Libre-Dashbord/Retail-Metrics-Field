-- 026 · Recuperar o cambiar la contraseña por email. Correr tal cual en el
-- SQL Editor de Supabase. Idempotente.
--
-- Hasta ahora solo un admin podía crear un link para poner contraseña
-- (política credential_invites_insert). Esta función deja que cualquiera
-- pida un link para SU email, sin sesión, con tres límites:
--   · solo si el email ya tiene acceso (contraseña cargada o una cuenta a su
--     nombre): no sirve para darse de alta solo;
--   · el link vence a los p_minutes minutos;
--   · como mucho p_max_per_hour pedidos por hora por email.
-- El link llega al email, así que solo lo usa quien tiene acceso a ese mail.
-- Devuelve true si creó el link (y entonces hay que mandar el mail).

CREATE OR REPLACE FUNCTION credential_request_reset(p_email TEXT, p_token_hash TEXT, p_minutes INTEGER, p_max_per_hour INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  v_email TEXT := lower(trim(p_email));
BEGIN
  IF v_email = '' OR p_token_hash IS NULL OR length(p_token_hash) < 32 THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM credential_users WHERE email = v_email)
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE lower(owner_email) = v_email) THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM credential_invites
       WHERE email = v_email AND created_at > now() - interval '1 hour') >= p_max_per_hour THEN
    RETURN false;
  END IF;
  INSERT INTO credential_invites (token_hash, email, expires_at)
  VALUES (p_token_hash, v_email, now() + make_interval(mins => p_minutes));
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION credential_request_reset(text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credential_request_reset(text, text, integer, integer) TO app_user;

-- Verificación: 1 fila.
SELECT proname, prosecdef FROM pg_proc WHERE proname = 'credential_request_reset';
