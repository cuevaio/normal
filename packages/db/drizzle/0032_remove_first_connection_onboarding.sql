DROP TRIGGER record_first_connection_completion
  ON public.whatsapp_connections;
--> statement-breakpoint

DROP TRIGGER restore_first_connection_completion_on_profile_insert
  ON public.personal_account_onboarding_profiles;
--> statement-breakpoint

DROP FUNCTION public.record_first_connection_completion();
--> statement-breakpoint

DROP FUNCTION public.restore_first_connection_completion_on_profile_insert();
--> statement-breakpoint

DROP FUNCTION public.get_onboarding_profile(text);
--> statement-breakpoint

DROP FUNCTION public.upsert_onboarding_profile(
  text, text, text, text, text, text, timestamptz
);
--> statement-breakpoint

DROP FUNCTION public.complete_onboarding_security(text, timestamptz);
--> statement-breakpoint

DROP FUNCTION public.first_connection_setup_eligible(text);
--> statement-breakpoint

DROP POLICY personal_account_onboarding_profiles_tenant
  ON public.personal_account_onboarding_profiles;
--> statement-breakpoint

DROP INDEX public.personal_account_onboarding_profiles_completed_at;
--> statement-breakpoint

DROP TABLE public.personal_account_onboarding_profiles;
--> statement-breakpoint

DO $migration$
DECLARE function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.verify_recovery_branch(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition, '1787707546000') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch schema version is unexpected';
  END IF;
  EXECUTE pg_catalog.replace(
    function_definition, '1787707546000', '1788570000000');
END
$migration$;
