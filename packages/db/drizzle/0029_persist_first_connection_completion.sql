ALTER TABLE public.personal_account_onboarding_profiles
  ADD COLUMN first_connection_completed_at timestamptz;
--> statement-breakpoint

UPDATE public.personal_account_onboarding_profiles AS profiles
SET first_connection_completed_at = completed.first_connected_at
FROM (
  SELECT connections.personal_account_id, min(connections.created_at) AS first_connected_at
  FROM public.whatsapp_connections AS connections
  GROUP BY connections.personal_account_id
) AS completed
WHERE completed.personal_account_id = profiles.personal_account_id;
--> statement-breakpoint

CREATE FUNCTION public.record_first_connection_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
BEGIN
  UPDATE public.personal_account_onboarding_profiles AS profiles
  SET first_connection_completed_at = coalesce(
    profiles.first_connection_completed_at,
    NEW.created_at
  )
  WHERE profiles.personal_account_id = NEW.personal_account_id;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER record_first_connection_completion
AFTER INSERT ON public.whatsapp_connections
FOR EACH ROW EXECUTE FUNCTION public.record_first_connection_completion();
--> statement-breakpoint

CREATE FUNCTION public.restore_first_connection_completion_on_profile_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
BEGIN
  NEW.first_connection_completed_at = coalesce(
    NEW.first_connection_completed_at,
    (
      SELECT min(connections.created_at)
      FROM public.whatsapp_connections AS connections
      WHERE connections.personal_account_id = NEW.personal_account_id
    )
  );
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER restore_first_connection_completion_on_profile_insert
BEFORE INSERT ON public.personal_account_onboarding_profiles
FOR EACH ROW EXECUTE FUNCTION public.restore_first_connection_completion_on_profile_insert();
--> statement-breakpoint

DROP FUNCTION public.get_onboarding_profile(text);
--> statement-breakpoint
CREATE FUNCTION public.get_onboarding_profile(
  verified_clerk_user_id text
)
RETURNS TABLE (
  account_accessible boolean,
  primary_use_case text,
  whatsapp_usage_context text,
  role text,
  intended_mcp_client text,
  research_call_interest text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz,
  security_completed_at timestamptz,
  first_connection_completed_at timestamptz
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
  SELECT
    TRUE AS account_accessible,
    profiles.primary_use_case,
    profiles.whatsapp_usage_context,
    profiles.role,
    profiles.intended_mcp_client,
    profiles.research_call_interest,
    profiles.created_at,
    profiles.updated_at,
    profiles.completed_at,
    profiles.security_completed_at,
    profiles.first_connection_completed_at
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  LEFT JOIN public.personal_account_onboarding_profiles AS profiles
    ON profiles.personal_account_id = accounts.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active';
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.record_first_connection_completion(),
  public.restore_first_connection_completion_on_profile_insert(),
  public.get_onboarding_profile(text)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_onboarding_profile(text)
  TO whatsapp_api_runtime;
--> statement-breakpoint

DO $migration$
DECLARE function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.verify_recovery_branch(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition, '1787544000000') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch schema version is unexpected';
  END IF;
  function_definition := pg_catalog.replace(
    function_definition, '1787544000000', '1787678308000');
  EXECUTE function_definition;
END
$migration$;
