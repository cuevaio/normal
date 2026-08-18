mock_provider "cloudflare" {}
mock_provider "vercel" {}

run "development_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment        = "development"
    cloudflare_account_id         = "11111111111111111111111111111111"
    cloudflare_zone_id            = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_hyperdrive_id             = "11111111111111111111111111111111"
    webhook_hyperdrive_id         = "22222222222222222222222222222222"
    vercel_team_id                = "team_developmentvalidation"
    api_hostname                  = "api.dev.example.com"
    web_hostname                  = "app.dev.example.com"
    docs_hostname                 = "docs.dev.example.com"
    clerk_issuer                  = "https://clerk.dev.example.com"
    clerk_publishable_key         = "pk_test_Y2xlcmsuZGV2LmV4YW1wbGUuY29tJA"
    mcp_requests_per_minute       = 60
    mcp_requests_per_hour         = 600
    read_message_records_per_day  = 10000
    decrypted_media_bytes_per_day = 268435456
    sends_per_minute              = 10
    sends_per_day                 = 200
  }

  assert {
    condition     = cloudflare_worker.api.name == "whatsapp-mcp-api-development"
    error_message = "Development must have an environment-specific API Worker."
  }

  assert {
    condition     = cloudflare_worker.provider_control.name == "whatsapp-mcp-provider-control-development"
    error_message = "Development must have an environment-specific provider-control Worker."
  }

  assert {
    condition = one([
      for binding in cloudflare_worker_version.api.bindings :
      binding.service if binding.name == "PROVIDER_CONTROL"
    ]) == cloudflare_worker.provider_control.name
    error_message = "The API must bind to provider-control in the same environment."
  }

  assert {
    condition = (
      cloudflare_worker.api.subdomain.enabled == false &&
      cloudflare_worker.api.subdomain.previews_enabled == false &&
      cloudflare_worker.provider_control.subdomain.enabled == false &&
      cloudflare_worker.provider_control.subdomain.previews_enabled == false
    )
    error_message = "Workers must disable public generated hostnames before any version is deployed."
  }

  assert {
    condition     = cloudflare_workers_custom_domain.api.hostname == "api.dev.example.com"
    error_message = "The API must have a public custom-domain route."
  }

  assert {
    condition = one([
      for item in vercel_project.web.environment :
      item.value if item.key == "NEXT_PUBLIC_API_ORIGIN"
    ]) == "https://api.dev.example.com"
    error_message = "The web deployment must call the API Worker directly."
  }

  assert {
    condition = (
      vercel_project.docs.name == "whatsapp-mcp-docs-development" &&
      vercel_project.docs.framework == "astro" &&
      vercel_project.docs.root_directory == "apps/docs" &&
      vercel_project_domain.docs.domain == "docs.dev.example.com" &&
      try(length(vercel_project.docs.environment), 0) == 0
    )
    error_message = "Documentation must be a separate static Vercel project with no runtime environment values."
  }

  assert {
    condition = (
      cloudflare_r2_bucket.webhook_ingress.name == "whatsapp-mcp-webhook-ingress-development" &&
      cloudflare_r2_bucket.stored_media.name == "whatsapp-mcp-stored-media-development" &&
      cloudflare_r2_bucket.deletion_capsules.name == "whatsapp-mcp-deletion-capsules-development" &&
      cloudflare_r2_bucket.deletion_markers.name == "whatsapp-mcp-deletion-markers-development" &&
      cloudflare_r2_bucket.recipient_transitions.name == "whatsapp-mcp-recipient-transitions-development" &&
      cloudflare_workers_kv_namespace.oauth.title == "whatsapp-mcp-oauth-development" &&
      cloudflare_queue.connection_setup_provisioning.queue_name == "whatsapp-mcp-connection-setup-provisioning-development" &&
      cloudflare_queue.ingestion.queue_name == "whatsapp-mcp-ingestion-development" &&
      cloudflare_queue.dead_letter.queue_name == "whatsapp-mcp-ingestion-dlq-development" &&
      cloudflare_queue.ingestion_replay.queue_name == "whatsapp-mcp-ingestion-replay-development"
    )
    error_message = "Development state resources must use isolated environment-specific names."
  }

  assert {
    condition = toset([
      for binding in cloudflare_worker_version.api.bindings :
      "${binding.type}:${binding.name}"
      ]) == toset([
      "inherit:CLERK_JWT_KEY",
      "inherit:CLERK_SECRET_KEY",
      "inherit:CLERK_WEBHOOK_SIGNING_SECRET",
      "inherit:AWS_ACCESS_KEY_ID",
      "inherit:AWS_SECRET_ACCESS_KEY",
      "inherit:AWS_SESSION_TOKEN",
      "inherit:DELETION_MARKER_HMAC_SECRET",
      "inherit:KMS_CONTENT_ROOT_KEY_ARN",
      "inherit:KMS_DELETION_COORDINATOR_KEY_ARN",
      "inherit:API_KEY_HMAC_SECRET",
      "inherit:MCP_CURSOR_HMAC_SECRET",
      "inherit:NEON_BRANCH_ID",
      "inherit:RECIPIENT_TRANSITION_HMAC_SECRET",
      "inherit:SEND_FINGERPRINT_HMAC_SECRET",
      "inherit:SMOKE_CHECK_SECRET",
      "inherit:OAUTH_PROTOCOL_ENCRYPTION_KEY",
      "inherit:WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
      "kv_namespace:OAUTH_KV",
      "hyperdrive:HYPERDRIVE",
      "hyperdrive:WEBHOOK_HYPERDRIVE",
      "plain_text:CLERK_API_AUDIENCE",
      "plain_text:CLERK_AUTHORIZED_PARTY",
      "plain_text:CLERK_ISSUER",
      "plain_text:AWS_KMS_REGION",
      "plain_text:DEPLOYMENT_ENVIRONMENT",
      "plain_text:OAUTH_ISSUER",
      "plain_text:OAUTH_RESOURCE",
      "plain_text:MCP_REQUESTS_PER_HOUR",
      "plain_text:MCP_REQUESTS_PER_MINUTE",
      "plain_text:MESSAGE_RETENTION_DAY_OPTIONS",
      "plain_text:READ_MESSAGE_RECORDS_PER_DAY",
      "plain_text:DECRYPTED_MEDIA_BYTES_PER_DAY",
      "plain_text:SENDS_PER_DAY",
      "plain_text:SENDS_PER_MINUTE",
      "queue:CONNECTION_SETUP_PROVISIONING_QUEUE",
      "queue:INGESTION_QUEUE",
      "r2_bucket:DELETION_CAPSULES",
      "r2_bucket:DELETION_MARKERS",
      "r2_bucket:RECIPIENT_TRANSITIONS",
      "r2_bucket:STORED_MEDIA",
      "r2_bucket:WEBHOOK_INGRESS",
      "service:PROVIDER_CONTROL",
    ])
    error_message = "The API Worker must receive exactly its state, queue producer, and provider-control capabilities."
  }

  assert {
    condition = (
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "CLERK_API_AUDIENCE"
      ]) == "https://api.dev.example.com" &&
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "CLERK_AUTHORIZED_PARTY"
      ]) == "https://app.dev.example.com" &&
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "CLERK_ISSUER"
      ]) == "https://clerk.dev.example.com"
    )
    error_message = "The API must receive exact same-environment identity configuration."
  }

  assert {
    condition = (
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "OAUTH_ISSUER"
      ]) == "https://api.dev.example.com" &&
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "OAUTH_RESOURCE"
      ]) == "https://api.dev.example.com/mcp" &&
      toset(cloudflare_worker_version.api.compatibility_flags) == toset([
        "global_fetch_strictly_public",
        "nodejs_compat",
      ])
    )
    error_message = "OAuth must bind the exact API issuer/resource and strict fetch compatibility."
  }

  assert {
    condition     = cloudflare_worker_version.api.placement.region == "aws:us-east-1"
    error_message = "The API Worker must run beside the regional database so sequential MCP queries remain low latency."
  }

  assert {
    condition = one([
      for item in vercel_project.web.environment :
      item.value if item.key == "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"
    ]) == "pk_test_Y2xlcmsuZGV2LmV4YW1wbGUuY29tJA"
    error_message = "The browser must receive the environment's public Clerk key."
  }

  assert {
    condition = length([
      for item in vercel_project.web.environment :
      item.key if startswith(item.key, "NEXT_PUBLIC_POSTHOG_")
    ]) == 0
    error_message = "Browser PostHog analytics must stay disabled until both optional PostHog inputs are set."
  }

  assert {
    condition = toset([
      for binding in cloudflare_worker_version.provider_control.bindings :
      "${binding.type}:${binding.name}"
      ]) == toset([
      "inherit:WASENDER_API_CREDENTIAL",
      "inherit:WASENDER_REFERENCE_SECRET",
      "plain_text:DEPLOYMENT_ENVIRONMENT",
    ])
    error_message = "Provider-control must receive only its environment and inherited Wasender secrets."
  }

  assert {
    condition = (
      cloudflare_worker.restore_coordinator.subdomain.enabled == false &&
      cloudflare_worker.restore_coordinator.subdomain.previews_enabled == false &&
      toset([
        for binding in cloudflare_worker_version.restore_coordinator.bindings :
        "${binding.type}:${binding.name}"
        ]) == toset([
        "inherit:DELETION_MARKER_HMAC_SECRET",
        "inherit:NEON_BRANCH_ID",
        "inherit:RECIPIENT_TRANSITION_HMAC_SECRET",
        "inherit:RESTORE_DATABASE_URL",
        "plain_text:DEPLOYMENT_ENVIRONMENT",
        "r2_bucket:DELETION_MARKERS",
        "r2_bucket:RECIPIENT_TRANSITIONS",
        "r2_bucket:STORED_MEDIA",
        "r2_bucket:WEBHOOK_INGRESS",
      ])
    )
    error_message = "The restore coordinator must have only marker replay, object purge, and restore-role authority."
  }
}

run "preview_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment        = "preview"
    cloudflare_account_id         = "22222222222222222222222222222222"
    cloudflare_zone_id            = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    api_hyperdrive_id             = "33333333333333333333333333333333"
    webhook_hyperdrive_id         = "44444444444444444444444444444444"
    vercel_team_id                = "team_previewvalidation"
    api_hostname                  = "api.preview.example.com"
    web_hostname                  = "app.preview.example.com"
    docs_hostname                 = "docs.preview.example.com"
    clerk_issuer                  = "https://clerk.preview.example.com"
    clerk_publishable_key         = "pk_test_Y2xlcmsucHJldmlldy5leGFtcGxlJA"
    mcp_requests_per_minute       = 60
    mcp_requests_per_hour         = 600
    read_message_records_per_day  = 10000
    decrypted_media_bytes_per_day = 268435456
    sends_per_minute              = 10
    sends_per_day                 = 200
  }

  assert {
    condition     = cloudflare_worker.api.name == "whatsapp-mcp-api-preview"
    error_message = "Preview must have an environment-specific API Worker."
  }

  assert {
    condition     = cloudflare_worker.provider_control.name == "whatsapp-mcp-provider-control-preview"
    error_message = "Preview must have an environment-specific provider-control Worker."
  }

  assert {
    condition     = output.api_origin == "https://api.preview.example.com"
    error_message = "Preview must expose only its own API origin."
  }
}

run "production_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment        = "production"
    cloudflare_account_id         = "33333333333333333333333333333333"
    cloudflare_zone_id            = "cccccccccccccccccccccccccccccccc"
    api_hyperdrive_id             = "55555555555555555555555555555555"
    webhook_hyperdrive_id         = "66666666666666666666666666666666"
    vercel_team_id                = "team_productionvalidation"
    api_hostname                  = "api.example.com"
    web_hostname                  = "app.example.com"
    docs_hostname                 = "docs.example.com"
    clerk_issuer                  = "https://clerk.example.com"
    clerk_publishable_key         = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"
    mcp_requests_per_minute       = 60
    mcp_requests_per_hour         = 600
    read_message_records_per_day  = 10000
    decrypted_media_bytes_per_day = 268435456
    sends_per_minute              = 10
    sends_per_day                 = 200
  }

  assert {
    condition     = cloudflare_worker.api.name == "whatsapp-mcp-api"
    error_message = "Production must retain the canonical API Worker name."
  }

  assert {
    condition     = cloudflare_worker.provider_control.name == "whatsapp-mcp-provider-control"
    error_message = "Production must retain the canonical provider-control Worker name."
  }

  assert {
    condition     = output.provider_control_service == "whatsapp-mcp-provider-control"
    error_message = "Provider-control must be exported only as a service-binding target."
  }

  assert {
    condition = (
      cloudflare_r2_managed_domain.webhook_ingress.enabled == false &&
      cloudflare_r2_managed_domain.stored_media.enabled == false &&
      cloudflare_r2_managed_domain.deletion_capsules.enabled == false &&
      cloudflare_r2_managed_domain.deletion_markers.enabled == false &&
      cloudflare_r2_managed_domain.recipient_transitions.enabled == false
    )
    error_message = "Every R2 bucket must explicitly disable its public r2.dev domain."
  }

  assert {
    condition = one([
      for rule in cloudflare_r2_bucket_lifecycle.webhook_ingress.rules :
      rule.delete_objects_transition.condition.max_age
      if rule.id == "expire-encrypted-webhook-events"
    ]) == 604800
    error_message = "Encrypted Webhook Events must expire after seven days."
  }

  assert {
    condition = one([
      for rule in cloudflare_r2_bucket_lock.deletion_markers.rules :
      rule.condition.type
      if rule.id == "retain-deletion-markers"
    ]) == "Indefinite"
    error_message = "Deletion markers must be protected by an indefinite bucket lock."
  }

  assert {
    condition = one([
      for rule in cloudflare_r2_bucket_lock.recipient_transitions.rules :
      rule.condition.type
      if rule.id == "retain-recipient-transitions"
    ]) == "Indefinite"
    error_message = "WhatsApp Recipient Exclusion transitions must be protected by an indefinite bucket lock."
  }

  assert {
    condition = (
      cloudflare_queue.connection_setup_provisioning.settings.message_retention_period == 86400 &&
      cloudflare_queue_consumer.connection_setup_provisioning.script_name == cloudflare_worker.api.name &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.batch_size == 1 &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.max_retries == 10 &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.retry_delay == 30 &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.visibility_timeout_ms == null &&
      cloudflare_queue_consumer.ingestion.dead_letter_queue == cloudflare_queue.dead_letter.queue_name &&
      cloudflare_queue_consumer.ingestion.settings.max_retries == 7 &&
      cloudflare_queue_consumer.ingestion.settings.retry_delay == 10800 &&
      cloudflare_queue_consumer.dead_letter.settings.max_retries == 100 &&
      cloudflare_queue_consumer.dead_letter.settings.retry_delay == 300 &&
      cloudflare_queue.ingestion.settings.message_retention_period == 86400 &&
      cloudflare_queue.dead_letter.settings.message_retention_period == 86400 &&
      cloudflare_queue.ingestion_replay.settings.message_retention_period == 86400 &&
      cloudflare_queue_consumer.ingestion_replay.settings.max_retries == 100 &&
      cloudflare_queue_consumer.ingestion_replay.settings.retry_delay == 300
    )
    error_message = "Provisioning, ingestion, replay, and dead-letter Queues must retain their bounded production delivery policies."
  }

  assert {
    condition = (
      cloudflare_queue_consumer.ingestion.script_name == cloudflare_worker.api.name &&
      cloudflare_queue_consumer.dead_letter.script_name == cloudflare_worker.api.name &&
      cloudflare_queue_consumer.ingestion_replay.script_name == cloudflare_worker.api.name
    )
    error_message = "The API Worker must actively consume ingestion, replay, and dead-letter queues."
  }

  assert {
    condition = toset([
      for schedule in cloudflare_workers_cron_trigger.api.schedules : schedule.cron
    ]) == toset(["* * * * *", "*/5 * * * *", "0 * * * *"])
    error_message = "The API Worker must schedule maintenance, five-minute health reconciliation, and hourly retention work."
  }
}

run "reject_same_web_and_api_origin" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment        = "production"
    cloudflare_account_id         = "33333333333333333333333333333333"
    cloudflare_zone_id            = "cccccccccccccccccccccccccccccccc"
    api_hyperdrive_id             = "55555555555555555555555555555555"
    webhook_hyperdrive_id         = "66666666666666666666666666666666"
    vercel_team_id                = "team_productionvalidation"
    api_hostname                  = "app.example.com"
    web_hostname                  = "app.example.com"
    docs_hostname                 = "docs.example.com"
    clerk_issuer                  = "https://clerk.example.com"
    clerk_publishable_key         = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"
    mcp_requests_per_minute       = 60
    mcp_requests_per_hour         = 600
    read_message_records_per_day  = 10000
    decrypted_media_bytes_per_day = 268435456
    sends_per_minute              = 10
    sends_per_day                 = 200
  }

  expect_failures = [vercel_project.web]
}

run "development_topology_with_posthog" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment            = "development"
    cloudflare_account_id             = "11111111111111111111111111111111"
    cloudflare_zone_id                = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_hyperdrive_id                 = "11111111111111111111111111111111"
    webhook_hyperdrive_id             = "22222222222222222222222222222222"
    vercel_team_id                    = "team_developmentvalidation"
    api_hostname                      = "api.dev.example.com"
    web_hostname                      = "app.dev.example.com"
    docs_hostname                     = "docs.dev.example.com"
    clerk_issuer                      = "https://clerk.dev.example.com"
    clerk_publishable_key             = "pk_test_Y2xlcmsuZGV2LmV4YW1wbGUuY29tJA"
    mcp_requests_per_minute           = 60
    mcp_requests_per_hour             = 600
    read_message_records_per_day      = 10000
    decrypted_media_bytes_per_day     = 268435456
    sends_per_minute                  = 10
    sends_per_day                     = 200
    posthog_project_key               = "phc_developmentvalidationkey"
    posthog_host                      = "https://us.i.posthog.com"
    posthog_privacy_controls_approved = true
  }

  assert {
    condition = (
      one([
        for item in vercel_project.web.environment :
        item.value if item.key == "NEXT_PUBLIC_POSTHOG_KEY"
      ]) == "phc_developmentvalidationkey" &&
      one([
        for item in vercel_project.web.environment :
        item.value if item.key == "NEXT_PUBLIC_POSTHOG_HOST"
      ]) == "https://us.i.posthog.com"
    )
    error_message = "When both PostHog inputs are set, the browser must receive the public project key and ingest origin."
  }
}

run "reject_partial_posthog_configuration" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment        = "development"
    cloudflare_account_id         = "11111111111111111111111111111111"
    cloudflare_zone_id            = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    api_hyperdrive_id             = "11111111111111111111111111111111"
    webhook_hyperdrive_id         = "22222222222222222222222222222222"
    vercel_team_id                = "team_developmentvalidation"
    api_hostname                  = "api.dev.example.com"
    web_hostname                  = "app.dev.example.com"
    docs_hostname                 = "docs.dev.example.com"
    clerk_issuer                  = "https://clerk.dev.example.com"
    clerk_publishable_key         = "pk_test_Y2xlcmsuZGV2LmV4YW1wbGUuY29tJA"
    mcp_requests_per_minute       = 60
    mcp_requests_per_hour         = 600
    read_message_records_per_day  = 10000
    decrypted_media_bytes_per_day = 268435456
    sends_per_minute              = 10
    sends_per_day                 = 200
    posthog_project_key           = "phc_developmentvalidationkey"
    posthog_host                  = ""
  }

  expect_failures = [vercel_project.web]
}
