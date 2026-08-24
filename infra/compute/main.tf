locals {
  environment_suffix                       = var.deployment_environment == "production" ? "" : "-${var.deployment_environment}"
  api_worker_name                          = "whatsapp-mcp-api${local.environment_suffix}"
  provider_control_worker_name             = "whatsapp-mcp-provider-control${local.environment_suffix}"
  deletion_coordinator_worker_name         = "whatsapp-mcp-deletion-coordinator${local.environment_suffix}"
  restore_coordinator_worker_name          = "whatsapp-mcp-restore-coordinator${local.environment_suffix}"
  recovery_control_worker_name             = "whatsapp-mcp-recovery-control${local.environment_suffix}"
  recovery_verifier_worker_name            = "whatsapp-mcp-recovery-verifier${local.environment_suffix}"
  recovery_game_day_worker_name            = "whatsapp-mcp-recovery-game-day${local.environment_suffix}"
  operations_control_worker_name           = "whatsapp-mcp-operations-control${local.environment_suffix}"
  recovery_workflow_name                   = "whatsapp-mcp-production-recovery${local.environment_suffix}"
  web_project_name                         = "whatsapp-mcp-web${local.environment_suffix}"
  docs_project_name                        = "whatsapp-mcp-docs${local.environment_suffix}"
  webhook_ingress_bucket_name              = "whatsapp-mcp-webhook-ingress${local.environment_suffix}"
  stored_media_bucket_name                 = "whatsapp-mcp-stored-media${local.environment_suffix}"
  deletion_capsules_bucket_name            = "whatsapp-mcp-deletion-capsules${local.environment_suffix}"
  deletion_markers_bucket_name             = "whatsapp-mcp-deletion-markers${local.environment_suffix}"
  recipient_transitions_bucket_name        = "whatsapp-mcp-recipient-transitions${local.environment_suffix}"
  oauth_kv_namespace_name                  = "whatsapp-mcp-oauth${local.environment_suffix}"
  recovery_kv_namespace_name               = "whatsapp-mcp-recovery-fixtures${local.environment_suffix}"
  operations_kv_namespace_name             = "whatsapp-mcp-operations-receipts${local.environment_suffix}"
  ingestion_queue_name                     = "whatsapp-mcp-ingestion${local.environment_suffix}"
  dead_letter_queue_name                   = "whatsapp-mcp-ingestion-dlq${local.environment_suffix}"
  replay_queue_name                        = "whatsapp-mcp-ingestion-replay${local.environment_suffix}"
  connection_setup_provisioning_queue_name = "whatsapp-mcp-connection-setup-provisioning${local.environment_suffix}"
  recovery_game_day_queue_name             = "whatsapp-mcp-recovery-game-day-replay${local.environment_suffix}"
  recovery_fixture_bucket_name             = "whatsapp-mcp-recovery-fixtures${local.environment_suffix}"
  api_bundle_path                          = abspath("${path.root}/../../apps/api/.wrangler/dist/index.js")
  provider_control_bundle_path             = abspath("${path.root}/../../apps/provider-control/dist/index.js")
  deletion_coordinator_bundle_path         = abspath("${path.root}/../../apps/deletion-coordinator/dist/index.js")
  restore_coordinator_bundle_path          = abspath("${path.root}/../../apps/restore-coordinator/dist/index.js")
  recovery_control_bundle_path             = abspath("${path.root}/../../apps/recovery-control/dist/index.js")
  recovery_verifier_bundle_path            = abspath("${path.root}/../../apps/recovery-verifier/dist/index.js")
  recovery_game_day_bundle_path            = abspath("${path.root}/../../apps/recovery-game-day/dist/index.js")
  operations_control_bundle_path           = abspath("${path.root}/../../apps/operations-control/dist/index.js")
}

resource "cloudflare_r2_bucket" "webhook_ingress" {
  account_id    = var.cloudflare_account_id
  name          = local.webhook_ingress_bucket_name
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "webhook_ingress" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.webhook_ingress.name

  rules = [{
    id      = "expire-encrypted-webhook-events"
    enabled = true
    conditions = {
      prefix = ""
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
    delete_objects_transition = {
      condition = {
        max_age = 604800
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket" "stored_media" {
  account_id    = var.cloudflare_account_id
  name          = local.stored_media_bucket_name
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket" "recovery_fixtures" {
  account_id    = var.cloudflare_account_id
  name          = local.recovery_fixture_bucket_name
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "recovery_fixtures" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.recovery_fixtures.name
  rules = [{
    id         = "expire-recovery-game-day-fixtures"
    enabled    = true
    conditions = { prefix = "production-recovery/game-day/" }
    delete_objects_transition = {
      condition = { max_age = 86400, type = "Age" }
    }
  }]
}

resource "cloudflare_r2_managed_domain" "recovery_fixtures" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.recovery_fixtures.name
  enabled     = false
}

resource "cloudflare_r2_bucket" "deletion_capsules" {
  account_id    = var.cloudflare_account_id
  name          = local.deletion_capsules_bucket_name
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lifecycle" "stored_media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.stored_media.name

  rules = [{
    id      = "abort-incomplete-stored-media-uploads"
    enabled = true
    conditions = {
      prefix = ""
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket" "deletion_markers" {
  account_id    = var.cloudflare_account_id
  name          = local.deletion_markers_bucket_name
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lock" "deletion_markers" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.deletion_markers.name

  rules = [{
    id      = "retain-deletion-markers"
    enabled = true
    prefix  = ""
    condition = {
      type = "Indefinite"
    }
  }]
}

resource "cloudflare_r2_bucket" "recipient_transitions" {
  account_id    = var.cloudflare_account_id
  name          = local.recipient_transitions_bucket_name
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lock" "recipient_transitions" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.recipient_transitions.name

  rules = [{
    id      = "retain-recipient-transitions"
    enabled = true
    prefix  = ""
    condition = {
      type = "Indefinite"
    }
  }]
}

resource "cloudflare_r2_managed_domain" "recipient_transitions" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.recipient_transitions.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "webhook_ingress" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.webhook_ingress.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "stored_media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.stored_media.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "deletion_capsules" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.deletion_capsules.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "deletion_markers" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.deletion_markers.name
  enabled     = false
}

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.cloudflare_account_id
  title      = local.oauth_kv_namespace_name
}

resource "cloudflare_workers_kv_namespace" "recovery_fixtures" {
  account_id = var.cloudflare_account_id
  title      = local.recovery_kv_namespace_name
}

resource "cloudflare_workers_kv_namespace" "operations_receipts" {
  account_id = var.cloudflare_account_id
  title      = local.operations_kv_namespace_name
}

resource "cloudflare_queue" "ingestion" {
  account_id = var.cloudflare_account_id
  queue_name = local.ingestion_queue_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 86400
  }
}

resource "cloudflare_queue" "dead_letter" {
  account_id = var.cloudflare_account_id
  queue_name = local.dead_letter_queue_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 86400
  }
}

resource "cloudflare_queue" "ingestion_replay" {
  account_id = var.cloudflare_account_id
  queue_name = local.replay_queue_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 86400
  }
}

resource "cloudflare_queue" "connection_setup_provisioning" {
  account_id = var.cloudflare_account_id
  queue_name = local.connection_setup_provisioning_queue_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 86400
  }
}

resource "cloudflare_queue" "recovery_game_day" {
  account_id = var.cloudflare_account_id
  queue_name = local.recovery_game_day_queue_name
  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 86400
  }
}

resource "cloudflare_worker" "provider_control" {
  account_id = var.cloudflare_account_id
  name       = local.provider_control_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.provider_control_worker_name}",
  ]

  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_worker_version" "provider_control" {
  account_id  = var.cloudflare_account_id
  worker_id   = cloudflare_worker.provider_control.id
  main_module = "index.js"

  compatibility_date = "2026-07-30"

  modules = [
    {
      name         = "index.js"
      content_file = local.provider_control_bundle_path
      content_type = "application/javascript+module"
    }
  ]

  bindings = [
    {
      name = "DEPLOYMENT_ENVIRONMENT"
      text = var.deployment_environment
      type = "plain_text"
    },
    {
      name = "WASENDER_API_CREDENTIAL"
      type = "inherit"
    },
    {
      name = "WASENDER_REFERENCE_SECRET"
      type = "inherit"
    },
    {
      name = "WEBSHARE_API_KEY"
      type = "inherit"
    },
    {
      name        = "PROVIDER_ALLOCATION_GATE"
      class_name  = "ProviderAllocationGate"
      script_name = cloudflare_worker.provider_control.name
      type        = "durable_object_namespace"
    }
  ]
}

resource "cloudflare_workers_deployment" "provider_control" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.provider_control.name
  strategy    = "percentage"

  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.provider_control.id
    }
  ]
}

resource "cloudflare_worker" "deletion_coordinator" {
  account_id = var.cloudflare_account_id
  name       = local.deletion_coordinator_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.deletion_coordinator_worker_name}",
  ]
  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_worker_version" "deletion_coordinator" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.deletion_coordinator.id
  main_module         = "index.js"
  compatibility_date  = "2026-07-31"
  compatibility_flags = ["nodejs_compat"]
  modules = [{
    name         = "index.js"
    content_file = local.deletion_coordinator_bundle_path
    content_type = "application/javascript+module"
  }]
  bindings = [
    { name = "ENVIRONMENT", text = var.deployment_environment, type = "plain_text" },
    { name = "AWS_KMS_REGION", text = "us-east-1", type = "plain_text" },
    { name = "AWS_ACCESS_KEY_ID", type = "inherit" },
    { name = "AWS_SECRET_ACCESS_KEY", type = "inherit" },
    { name = "AWS_SESSION_TOKEN", type = "inherit" },
    { name = "DELETION_COORDINATOR_DATABASE_URL", type = "inherit" },
    { name = "KMS_DELETION_COORDINATOR_KEY_ARN", type = "inherit" },
    { name = "DELETION_CAPSULES", bucket_name = cloudflare_r2_bucket.deletion_capsules.name, type = "r2_bucket" },
    { name = "PROVIDER_CONTROL", service = cloudflare_worker.provider_control.name, type = "service" }
  ]
  depends_on = [cloudflare_workers_deployment.provider_control]
}

resource "cloudflare_workers_deployment" "deletion_coordinator" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.deletion_coordinator.name
  strategy    = "percentage"
  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.deletion_coordinator.id
  }]
}

resource "cloudflare_workers_cron_trigger" "deletion_coordinator" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.deletion_coordinator.name
  schedules   = [{ cron = "* * * * *" }]
  depends_on  = [cloudflare_workers_deployment.deletion_coordinator]
}

resource "cloudflare_worker" "restore_coordinator" {
  account_id = var.cloudflare_account_id
  name       = local.restore_coordinator_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.restore_coordinator_worker_name}",
  ]
  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_worker_version" "restore_coordinator" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.restore_coordinator.id
  main_module         = "index.js"
  compatibility_date  = "2026-07-31"
  compatibility_flags = ["nodejs_compat"]
  modules = [{
    name         = "index.js"
    content_file = local.restore_coordinator_bundle_path
    content_type = "application/javascript+module"
  }]
  bindings = [
    { name = "DEPLOYMENT_ENVIRONMENT", text = var.deployment_environment, type = "plain_text" },
    { name = "RESTORE_DATABASE_URL", type = "inherit" },
    { name = "NEON_BRANCH_ID", type = "inherit" },
    { name = "DELETION_MARKER_HMAC_SECRET", type = "inherit" },
    { name = "RECIPIENT_TRANSITION_HMAC_SECRET", type = "inherit" },
    { name = "DELETION_MARKERS", bucket_name = cloudflare_r2_bucket.deletion_markers.name, type = "r2_bucket" },
    { name = "RECIPIENT_TRANSITIONS", bucket_name = cloudflare_r2_bucket.recipient_transitions.name, type = "r2_bucket" },
    { name = "STORED_MEDIA", bucket_name = cloudflare_r2_bucket.stored_media.name, type = "r2_bucket" },
    { name = "WEBHOOK_INGRESS", bucket_name = cloudflare_r2_bucket.webhook_ingress.name, type = "r2_bucket" }
  ]
}

resource "cloudflare_workers_deployment" "restore_coordinator" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.restore_coordinator.name
  strategy    = "percentage"
  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.restore_coordinator.id
  }]
}

resource "cloudflare_workers_cron_trigger" "restore_coordinator" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.restore_coordinator.name
  schedules   = [{ cron = "*/5 * * * *" }]
  depends_on  = [cloudflare_workers_deployment.restore_coordinator]
}

resource "cloudflare_worker" "operations_control" {
  account_id = var.cloudflare_account_id
  name       = local.operations_control_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.operations_control_worker_name}",
  ]
  subdomain = { enabled = false, previews_enabled = false }
  observability = {
    enabled = true, head_sampling_rate = 1
    logs    = { enabled = true, head_sampling_rate = 1, invocation_logs = true, persist = true }
    traces  = { enabled = true, head_sampling_rate = 1, persist = true }
  }
}

resource "cloudflare_worker_version" "operations_control" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.operations_control.id
  main_module         = "index.js"
  compatibility_date  = "2026-08-06"
  compatibility_flags = ["global_fetch_strictly_public"]
  modules = [{
    name         = "index.js", content_file = local.operations_control_bundle_path,
    content_type = "application/javascript+module"
  }]
  bindings = [
    { name = "API_ORIGIN", text = "https://${var.api_hostname}", type = "plain_text" },
    { name = "DEPLOYMENT_ENVIRONMENT", text = var.deployment_environment, type = "plain_text" },
    { name = "CLOUDFLARE_ANALYTICS_TOKEN", type = "inherit" },
    { name = "CLOUDFLARE_ZONE_ID", type = "inherit" },
    { name = "OBSERVABILITY_QUERY_TOKEN", type = "inherit" },
    { name = "PAGER_DESTINATION_ADDRESS", type = "inherit" },
    { name = "PAGER_RECEIPT_TOKEN", type = "inherit" },
    { name = "PAGER_WEBHOOK_TOKEN", type = "inherit" },
    { name = "SMOKE_CHECK_SECRET", type = "inherit" },
    { name = "ALERT_RECEIPTS", namespace_id = cloudflare_workers_kv_namespace.operations_receipts.id, type = "kv_namespace" },
    { name = "PAGER_EMAIL", allowed_destination_addresses = ["hi@cueva.io"], allowed_sender_addresses = ["pager@alerts.normal.fast"], type = "send_email" }
  ]
}

resource "cloudflare_workers_deployment" "operations_control" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.operations_control.name
  strategy    = "percentage"
  versions    = [{ percentage = 100, version_id = cloudflare_worker_version.operations_control.id }]
}

resource "cloudflare_workers_custom_domain" "operations_control" {
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = var.operations_hostname
  service    = cloudflare_worker.operations_control.name

  depends_on = [cloudflare_workers_deployment.operations_control]
}

resource "cloudflare_worker" "recovery_game_day" {
  account_id = var.cloudflare_account_id
  name       = local.recovery_game_day_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.recovery_game_day_worker_name}",
  ]
  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs               = { enabled = true, head_sampling_rate = 1, invocation_logs = true, persist = true }
    traces             = { enabled = true, head_sampling_rate = 1, persist = true }
  }
}

resource "cloudflare_worker_version" "recovery_game_day" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.recovery_game_day.id
  main_module         = "index.js"
  compatibility_date  = "2026-07-31"
  compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
  modules = [{
    name         = "index.js", content_file = local.recovery_game_day_bundle_path,
    content_type = "application/javascript+module"
  }]
  bindings = [
    { name = "DEPLOYMENT_ENVIRONMENT", text = var.deployment_environment, type = "plain_text" },
    { name = "AWS_KMS_REGION", text = "us-east-1", type = "plain_text" },
    { name = "AWS_ACCESS_KEY_ID", type = "inherit" },
    { name = "AWS_SECRET_ACCESS_KEY", type = "inherit" },
    { name = "AWS_SESSION_TOKEN", type = "inherit" },
    { name = "KMS_RECOVERY_GAME_DAY_KEY_ARN", type = "inherit" },
    { name = "PAGER_RECEIPT_TOKEN", type = "inherit" },
    { name = "PAGER_RECEIPT_URL", type = "inherit" },
    { name = "PAGER_WEBHOOK_TOKEN", type = "inherit" },
    { name = "PAGER_WEBHOOK_URL", type = "inherit" },
    { name = "QUARTERLY_RECEIPT_SECRET", type = "inherit" },
    { name = "RECOVERY_KV", namespace_id = cloudflare_workers_kv_namespace.recovery_fixtures.id, type = "kv_namespace" },
    { name = "RECOVERY_FIXTURES", bucket_name = cloudflare_r2_bucket.recovery_fixtures.name, type = "r2_bucket" },
    { name = "RECOVERY_REPLAY_QUEUE", queue_name = cloudflare_queue.recovery_game_day.queue_name, type = "queue" }
  ]
}

resource "cloudflare_workers_deployment" "recovery_game_day" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.recovery_game_day.name
  strategy    = "percentage"
  versions    = [{ percentage = 100, version_id = cloudflare_worker_version.recovery_game_day.id }]
}

resource "cloudflare_queue_consumer" "recovery_game_day" {
  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.recovery_game_day.queue_id
  script_name = cloudflare_worker.recovery_game_day.name
  type        = "worker"
  settings    = { batch_size = 1, max_retries = 3, max_wait_time_ms = 1000, retry_delay = 60 }
  depends_on  = [cloudflare_workers_deployment.recovery_game_day]
}

resource "cloudflare_workers_cron_trigger" "recovery_game_day" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.recovery_game_day.name
  schedules   = [{ cron = "11 2 * * *" }]

  depends_on = [cloudflare_workers_deployment.recovery_game_day]
}

resource "cloudflare_worker" "recovery_verifier" {
  account_id = var.cloudflare_account_id
  name       = local.recovery_verifier_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.recovery_verifier_worker_name}",
  ]
  subdomain = { enabled = false, previews_enabled = false }
  observability = {
    enabled = true, head_sampling_rate = 1
    logs    = { enabled = true, head_sampling_rate = 1, invocation_logs = true, persist = true }
    traces  = { enabled = true, head_sampling_rate = 1, persist = true }
  }
}

resource "cloudflare_worker_version" "recovery_verifier" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.recovery_verifier.id
  main_module         = "index.js"
  compatibility_date  = "2026-07-31"
  compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
  modules = [{
    name         = "index.js", content_file = local.recovery_verifier_bundle_path,
    content_type = "application/javascript+module"
  }]
  bindings = [
    { name = "DEPLOYMENT_ENVIRONMENT", text = var.deployment_environment, type = "plain_text" },
    { name = "RECOVERY_BRANCH_PREFIX", text = "recovery/${var.deployment_environment}-", type = "plain_text" },
    { name = "RECOVERY_DATABASE_NAME", text = "whatsapp_mcp", type = "plain_text" },
    { name = "NEON_PARENT_BRANCH_ID", type = "inherit" },
    { name = "NEON_PROJECT_ID", type = "inherit" },
    { name = "NEON_RECOVERY_API_KEY", type = "inherit" },
    { name = "OBSERVABILITY_QUERY_TOKEN", type = "inherit" },
    { name = "OBSERVABILITY_QUERY_URL", type = "inherit" },
    { name = "RECOVERY_EVIDENCE_TOKEN", type = "inherit" },
    { name = "RECOVERY_VERIFIER_DATABASE_PASSWORD", type = "inherit" },
    { name = "RECOVERY_GAME_DAY", service = cloudflare_worker.recovery_game_day.name, type = "service" }
  ]
  depends_on = [cloudflare_workers_deployment.recovery_game_day]
}

resource "cloudflare_workers_deployment" "recovery_verifier" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.recovery_verifier.name
  strategy    = "percentage"
  versions    = [{ percentage = 100, version_id = cloudflare_worker_version.recovery_verifier.id }]
}

resource "cloudflare_worker" "recovery_control" {
  account_id = var.cloudflare_account_id
  name       = local.recovery_control_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.recovery_control_worker_name}",
  ]
  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_workflow" "production_recovery" {
  account_id    = var.cloudflare_account_id
  workflow_name = local.recovery_workflow_name
  script_name   = cloudflare_worker.recovery_control.name
  class_name    = "ProductionRecoveryWorkflow"
  limits = {
    steps = 100
  }

  depends_on = [cloudflare_workers_deployment.recovery_control]
}

# Wrangler owns the Durable Object migration history. OpenTofu reconciles the
# deployed Worker version without replaying an already applied migration tag.
resource "cloudflare_worker_version" "recovery_control" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.recovery_control.id
  main_module         = "index.js"
  compatibility_date  = "2026-07-31"
  compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
  modules = [{
    name         = "index.js"
    content_file = local.recovery_control_bundle_path
    content_type = "application/javascript+module"
  }]
  bindings = [
    { name = "DEPLOYMENT_ENVIRONMENT", text = var.deployment_environment, type = "plain_text" },
    { name = "RECOVERY_BRANCH_PREFIX", text = "recovery/${var.deployment_environment}-", type = "plain_text" },
    { name = "RECOVERY_DATABASE_NAME", text = "whatsapp_mcp", type = "plain_text" },
    { name = "DELETION_MARKER_HMAC_SECRET", type = "inherit" },
    { name = "NEON_RECOVERY_API_KEY", type = "inherit" },
    { name = "NEON_PARENT_BRANCH_ID", type = "inherit" },
    { name = "NEON_PROJECT_ID", type = "inherit" },
    { name = "RECIPIENT_TRANSITION_HMAC_SECRET", type = "inherit" },
    { name = "RECOVERY_CONTROL_TOKEN", type = "inherit" },
    { name = "RECOVERY_EVIDENCE_TOKEN", type = "inherit" },
    { name = "RECOVERY_VERIFIER_DATABASE_PASSWORD", type = "inherit" },
    { name = "DELETION_MARKERS", bucket_name = cloudflare_r2_bucket.deletion_markers.name, type = "r2_bucket" },
    { name = "RECIPIENT_TRANSITIONS", bucket_name = cloudflare_r2_bucket.recipient_transitions.name, type = "r2_bucket" },
    { name = "RECOVERY_GATE", class_name = "RecoveryGate", script_name = cloudflare_worker.recovery_control.name, type = "durable_object_namespace" },
    { name = "RECOVERY_WORKFLOW", class_name = "ProductionRecoveryWorkflow", workflow_name = local.recovery_workflow_name, type = "workflow" },
    { name = "RECOVERY_VERIFIER", service = cloudflare_worker.recovery_verifier.name, type = "service" }
  ]
  depends_on = [cloudflare_workers_deployment.recovery_verifier]
}

resource "cloudflare_workers_deployment" "recovery_control" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.recovery_control.name
  strategy    = "percentage"
  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.recovery_control.id
  }]
}

resource "cloudflare_workers_custom_domain" "recovery_control" {
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = var.recovery_hostname
  service    = cloudflare_worker.recovery_control.name

  depends_on = [cloudflare_workers_deployment.recovery_control]
}

resource "cloudflare_worker" "api" {
  account_id = var.cloudflare_account_id
  name       = local.api_worker_name
  tags = [
    "cf:environment=${var.deployment_environment}",
    "cf:service=${local.api_worker_name}",
  ]

  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_worker_version" "api" {
  account_id  = var.cloudflare_account_id
  worker_id   = cloudflare_worker.api.id
  main_module = "index.js"

  compatibility_date  = "2026-07-30"
  compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
  placement = {
    region = "aws:us-east-1"
  }

  modules = [
    {
      name         = "index.js"
      content_file = local.api_bundle_path
      content_type = "application/javascript+module"
    }
  ]

  bindings = [
    {
      name = "DEPLOYMENT_ENVIRONMENT"
      text = var.deployment_environment
      type = "plain_text"
    },
    {
      name = "NEON_BRANCH_ID"
      type = "inherit"
    },
    {
      name = "CLERK_API_AUDIENCE"
      text = "https://${var.api_hostname}"
      type = "plain_text"
    },
    {
      name = "CLERK_AUTHORIZED_PARTY"
      text = "https://${var.web_hostname}"
      type = "plain_text"
    },
    {
      name = "CLERK_ISSUER"
      text = var.clerk_issuer
      type = "plain_text"
    },
    {
      name = "CLERK_JWT_KEY"
      type = "inherit"
    },
    {
      name = "CLERK_SECRET_KEY"
      type = "inherit"
    },
    {
      name = "CLERK_WEBHOOK_SIGNING_SECRET"
      type = "inherit"
    },
    {
      name = "AWS_ACCESS_KEY_ID"
      type = "inherit"
    },
    {
      name = "AWS_SECRET_ACCESS_KEY"
      type = "inherit"
    },
    {
      name = "AWS_SESSION_TOKEN"
      type = "inherit"
    },
    {
      name = "AWS_KMS_REGION"
      text = "us-east-1"
      type = "plain_text"
    },
    {
      name = "KMS_CONTENT_ROOT_KEY_ARN"
      type = "inherit"
    },
    {
      name = "KMS_DELETION_COORDINATOR_KEY_ARN"
      type = "inherit"
    },
    {
      name = "DELETION_MARKER_HMAC_SECRET"
      type = "inherit"
    },
    {
      name = "RECIPIENT_TRANSITION_HMAC_SECRET"
      type = "inherit"
    },
    {
      name = "API_KEY_HMAC_SECRET"
      type = "inherit"
    },
    {
      name = "MCP_CURSOR_HMAC_SECRET"
      type = "inherit"
    },
    {
      name = "SEND_FINGERPRINT_HMAC_SECRET"
      type = "inherit"
    },
    {
      name = "SMOKE_CHECK_SECRET"
      type = "inherit"
    },
    {
      name = "OAUTH_ISSUER"
      text = "https://${var.api_hostname}"
      type = "plain_text"
    },
    {
      name = "OAUTH_PROTOCOL_ENCRYPTION_KEY"
      type = "inherit"
    },
    {
      name = "OAUTH_RESOURCE"
      text = "https://${var.api_hostname}/mcp"
      type = "plain_text"
    },
    {
      name = "MCP_REQUESTS_PER_MINUTE"
      text = tostring(var.mcp_requests_per_minute)
      type = "plain_text"
    },
    {
      name = "MESSAGE_RETENTION_DAY_OPTIONS"
      text = "7,30,90"
      type = "plain_text"
    },
    {
      name = "MCP_REQUESTS_PER_HOUR"
      text = tostring(var.mcp_requests_per_hour)
      type = "plain_text"
    },
    {
      name = "READ_MESSAGE_RECORDS_PER_DAY"
      text = tostring(var.read_message_records_per_day)
      type = "plain_text"
    },
    {
      name = "DECRYPTED_MEDIA_BYTES_PER_DAY"
      text = tostring(var.decrypted_media_bytes_per_day)
      type = "plain_text"
    },
    {
      name = "SENDS_PER_MINUTE"
      text = tostring(var.sends_per_minute)
      type = "plain_text"
    },
    {
      name = "SENDS_PER_DAY"
      text = tostring(var.sends_per_day)
      type = "plain_text"
    },
    {
      name = "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET"
      type = "inherit"
    },
    {
      id   = var.api_hyperdrive_id
      name = "HYPERDRIVE"
      type = "hyperdrive"
    },
    {
      id   = var.webhook_hyperdrive_id
      name = "WEBHOOK_HYPERDRIVE"
      type = "hyperdrive"
    },
    {
      name         = "OAUTH_KV"
      namespace_id = cloudflare_workers_kv_namespace.oauth.id
      type         = "kv_namespace"
    },
    {
      bucket_name = cloudflare_r2_bucket.webhook_ingress.name
      name        = "WEBHOOK_INGRESS"
      type        = "r2_bucket"
    },
    {
      bucket_name = cloudflare_r2_bucket.stored_media.name
      name        = "STORED_MEDIA"
      type        = "r2_bucket"
    },
    {
      bucket_name = cloudflare_r2_bucket.deletion_capsules.name
      name        = "DELETION_CAPSULES"
      type        = "r2_bucket"
    },
    {
      bucket_name = cloudflare_r2_bucket.deletion_markers.name
      name        = "DELETION_MARKERS"
      type        = "r2_bucket"
    },
    {
      bucket_name = cloudflare_r2_bucket.recipient_transitions.name
      name        = "RECIPIENT_TRANSITIONS"
      type        = "r2_bucket"
    },
    {
      name       = "CONNECTION_SETUP_PROVISIONING_QUEUE"
      queue_name = cloudflare_queue.connection_setup_provisioning.queue_name
      type       = "queue"
    },
    {
      name       = "INGESTION_QUEUE"
      queue_name = cloudflare_queue.ingestion.queue_name
      type       = "queue"
    },
    {
      name    = "PROVIDER_CONTROL"
      service = cloudflare_worker.provider_control.name
      type    = "service"
    }
  ]

  depends_on = [cloudflare_workers_deployment.provider_control]
}

resource "cloudflare_workers_deployment" "api" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.api.name
  strategy    = "percentage"

  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.api.id
    }
  ]
}

resource "cloudflare_queue_consumer" "ingestion" {
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.ingestion.queue_id
  script_name       = cloudflare_worker.api.name
  type              = "worker"
  dead_letter_queue = cloudflare_queue.dead_letter.queue_name

  settings = {
    batch_size       = 10
    max_retries      = 7
    max_wait_time_ms = 5000
    retry_delay      = 10800
  }

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_queue_consumer" "connection_setup_provisioning" {
  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.connection_setup_provisioning.queue_id
  script_name = cloudflare_worker.api.name
  type        = "worker"

  settings = {
    batch_size       = 1
    max_retries      = 10
    max_wait_time_ms = 1000
    retry_delay      = 30
  }

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_queue_consumer" "dead_letter" {
  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.dead_letter.queue_id
  script_name = cloudflare_worker.api.name
  type        = "worker"

  settings = {
    batch_size       = 10
    max_retries      = 100
    max_wait_time_ms = 5000
    retry_delay      = 300
  }

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_queue_consumer" "ingestion_replay" {
  account_id  = var.cloudflare_account_id
  queue_id    = cloudflare_queue.ingestion_replay.queue_id
  script_name = cloudflare_worker.api.name
  type        = "worker"

  settings = {
    batch_size       = 10
    max_retries      = 100
    max_wait_time_ms = 5000
    retry_delay      = 300
  }

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_workers_cron_trigger" "api" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.api.name

  schedules = [
    { cron = "* * * * *" },
    { cron = "*/5 * * * *" },
    { cron = "0 * * * *" },
  ]

  depends_on = [cloudflare_workers_deployment.api]
}

resource "cloudflare_workers_custom_domain" "api" {
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = var.api_hostname
  service    = cloudflare_worker.api.name

  depends_on = [cloudflare_workers_deployment.api]
}

resource "vercel_project" "web" {
  name      = local.web_project_name
  framework = "nextjs"
  team_id   = var.vercel_team_id

  root_directory  = "apps/web"
  build_command   = "cd ../.. && bun x turbo run build --filter=@whatsapp-mcp/web --cache-dir=.turbo/cache"
  install_command = "cd ../.. && bun install --frozen-lockfile"
  git_repository = var.deployment_environment == "production" ? {
    type              = "github"
    repo              = "cuevaio/normal"
    production_branch = "main"
  } : null
  skew_protection = var.deployment_environment == "production" ? "12 hours" : null

  auto_assign_custom_domains                        = true
  automatically_expose_system_environment_variables = false
  customer_success_code_visibility                  = false
  directory_listing                                 = false
  git_fork_protection                               = true
  protected_sourcemaps                              = true

  resource_config = {
    fluid                    = true
    function_default_regions = ["iad1"]
  }

  environment = concat(
    [
      {
        key       = "DEPLOYMENT_ENVIRONMENT"
        value     = var.deployment_environment
        target    = ["production"]
        sensitive = false
      },
      {
        key       = "NEXT_PUBLIC_API_ORIGIN"
        value     = "https://${var.api_hostname}"
        target    = ["production"]
        sensitive = false
      },
      {
        key       = "NEXT_PUBLIC_WEB_ORIGIN"
        value     = "https://${var.web_hostname}"
        target    = ["production"]
        sensitive = false
      },
      {
        key       = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"
        value     = var.clerk_publishable_key
        target    = ["production"]
        sensitive = false
      }
    ],
    var.posthog_project_key != "" && var.posthog_host != "" ? [
      {
        key       = "NEXT_PUBLIC_POSTHOG_KEY"
        value     = var.posthog_project_key
        target    = ["production"]
        sensitive = false
      },
      {
        key       = "NEXT_PUBLIC_POSTHOG_HOST"
        value     = var.posthog_host
        target    = ["production"]
        sensitive = false
      }
    ] : []
  )

  lifecycle {
    precondition {
      condition     = var.api_hostname != var.web_hostname && var.api_hostname != var.docs_hostname && var.web_hostname != var.docs_hostname
      error_message = "The web, docs, and API origins must be distinct so Vercel cannot become a data-plane proxy."
    }
    precondition {
      condition     = (var.posthog_project_key == "") == (var.posthog_host == "")
      error_message = "PostHog key and host must both be set or both empty so analytics cannot be partially enabled."
    }
    precondition {
      condition     = var.posthog_project_key == "" || var.posthog_privacy_controls_approved
      error_message = "PostHog cannot be enabled until retention, IP handling, privacy disclosure, CSP, and subprocessor controls are approved for this environment."
    }
  }
}

resource "vercel_project_domain" "web" {
  project_id = vercel_project.web.id
  domain     = var.web_hostname
  team_id    = var.vercel_team_id
}

resource "vercel_project" "docs" {
  name      = local.docs_project_name
  framework = "astro"
  team_id   = var.vercel_team_id

  root_directory   = "apps/docs"
  output_directory = "dist"
  build_command    = "cd ../.. && bun x turbo run build --filter=@whatsapp-mcp/docs --cache-dir=.turbo/cache"
  install_command  = "cd ../.. && bun install --frozen-lockfile"

  auto_assign_custom_domains                        = true
  automatically_expose_system_environment_variables = false
  customer_success_code_visibility                  = false
  directory_listing                                 = false
  git_fork_protection                               = true
  protected_sourcemaps                              = true

  lifecycle {
    precondition {
      condition     = var.api_hostname != var.docs_hostname && var.web_hostname != var.docs_hostname
      error_message = "The docs origin must stay distinct from the web and API origins so documentation cannot become a data-plane proxy."
    }
  }
}

resource "vercel_project_domain" "docs" {
  project_id = vercel_project.docs.id
  domain     = var.docs_hostname
  team_id    = var.vercel_team_id
}
