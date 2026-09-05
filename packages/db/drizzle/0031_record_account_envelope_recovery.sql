CREATE TABLE public.personal_account_envelope_recovery_operations (
  change_reference text PRIMARY KEY
    CHECK (change_reference ~ '^change_[a-f0-9]{32}$'),
  personal_account_id uuid NOT NULL UNIQUE
    REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
  source_point_at timestamptz NOT NULL,
  recovered_key_version integer NOT NULL CHECK (recovered_key_version > 0),
  completed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (source_point_at <= completed_at)
);
--> statement-breakpoint

REVOKE ALL
ON TABLE public.personal_account_envelope_recovery_operations
FROM PUBLIC;
--> statement-breakpoint

DO $migration$
DECLARE function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.verify_recovery_branch(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition, '1787689711458') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch schema version is unexpected';
  END IF;
  EXECUTE pg_catalog.replace(
    function_definition, '1787689711458', '1787707546000');
END
$migration$;
