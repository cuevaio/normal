ALTER TABLE public.send_operations
  DROP CONSTRAINT send_operations_recipient_type_check,
  DROP CONSTRAINT send_operations_recipient_public_id_check,
  ALTER COLUMN recipient_public_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.send_operations
  ADD CONSTRAINT send_operations_recipient_type_check
    CHECK (recipient_type IN ('contact', 'group', 'phone', 'username')),
  ADD CONSTRAINT send_operations_recipient_public_id_check CHECK (
    (recipient_type = 'contact' AND recipient_public_id IS NOT NULL AND recipient_public_id ~ '^ctc_[A-Za-z0-9_-]{21}$')
    OR (recipient_type = 'group' AND recipient_public_id IS NOT NULL AND recipient_public_id ~ '^grp_[A-Za-z0-9_-]{21}$')
    OR (recipient_type IN ('phone', 'username') AND recipient_public_id IS NULL)
  );
--> statement-breakpoint
CREATE FUNCTION public.clear_direct_send_pending_content()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
BEGIN
  IF OLD.status = 'processing'
     AND NEW.status <> 'processing'
     AND NEW.recipient_type IN ('phone', 'username') THEN
    DELETE FROM public.pending_send_contents
    WHERE personal_account_id = NEW.personal_account_id
      AND send_operation_id = NEW.id;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER clear_direct_send_pending_content
AFTER UPDATE OF status ON public.send_operations
FOR EACH ROW EXECUTE FUNCTION public.clear_direct_send_pending_content();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.clear_direct_send_pending_content() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.purge_unattributed_direct_send_content_on_exclusion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
BEGIN
  IF NEW.excluded AND TG_OP = 'INSERT' THEN
    DELETE FROM public.pending_send_contents pending
    USING public.send_operations operations
    WHERE pending.personal_account_id = NEW.personal_account_id
      AND pending.whatsapp_connection_id = NEW.whatsapp_connection_id
      AND operations.personal_account_id = pending.personal_account_id
      AND operations.id = pending.send_operation_id
      AND operations.recipient_type IN ('phone', 'username');
  ELSIF NEW.excluded AND NOT OLD.excluded THEN
    DELETE FROM public.pending_send_contents pending
    USING public.send_operations operations
    WHERE pending.personal_account_id = NEW.personal_account_id
      AND pending.whatsapp_connection_id = NEW.whatsapp_connection_id
      AND operations.personal_account_id = pending.personal_account_id
      AND operations.id = pending.send_operation_id
      AND operations.recipient_type IN ('phone', 'username');
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER purge_unattributed_direct_send_content_on_exclusion
AFTER INSERT OR UPDATE OF excluded ON public.whatsapp_recipient_exclusions
FOR EACH ROW EXECUTE FUNCTION public.purge_unattributed_direct_send_content_on_exclusion();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_unattributed_direct_send_content_on_exclusion() FROM PUBLIC;
--> statement-breakpoint
-- Recovery verification pins the newest migration without duplicating its
-- security-definer body in every subsequent migration.
DO $migration$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.verify_recovery_branch(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition, '1787242636000') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch schema version is unexpected';
  END IF;
  EXECUTE pg_catalog.replace(
    function_definition,
    '1787242636000',
    '1787250000000'
  );
END
$migration$;
