output "api_origin" {
  description = "Public API Worker origin called directly by the browser."
  value       = "https://${cloudflare_workers_custom_domain.api.hostname}"
}

output "web_origin" {
  description = "Public Vercel web origin."
  value       = "https://${vercel_project_domain.web.domain}"
}

output "web_hostname" {
  description = "Vercel custom hostname used for DNS verification."
  value       = vercel_project_domain.web.domain
}

output "docs_origin" {
  description = "Public Vercel Scalar documentation origin."
  value       = "https://${vercel_project_domain.docs.domain}"
}

output "docs_hostname" {
  description = "Vercel custom hostname used for Scalar documentation DNS verification."
  value       = vercel_project_domain.docs.domain
}

output "provider_control_service" {
  description = "Private service-binding target; no public hostname is declared."
  value       = cloudflare_worker.provider_control.name
}

output "deletion_coordinator_service" {
  description = "Private scheduled Connection Deletion coordinator with capsule-only KMS authority."
  value       = cloudflare_worker.deletion_coordinator.name
}

output "restore_coordinator_service" {
  description = "Private scheduled deletion-marker and wall-clock expiry restore gate."
  value       = cloudflare_worker.restore_coordinator.name
}

output "oauth_kv_namespace_id" {
  description = "OAuth KV namespace identifier consumed by the API Wrangler config renderer."
  value       = cloudflare_workers_kv_namespace.oauth.id
  sensitive   = true
}

output "r2_bucket_names" {
  description = "Private R2 buckets bound only to the API Worker."
  value = {
    deletion_capsules     = cloudflare_r2_bucket.deletion_capsules.name
    deletion_markers      = cloudflare_r2_bucket.deletion_markers.name
    recipient_transitions = cloudflare_r2_bucket.recipient_transitions.name
    stored_media          = cloudflare_r2_bucket.stored_media.name
    webhook_ingress       = cloudflare_r2_bucket.webhook_ingress.name
  }
}

output "queue_names" {
  description = "Provisioning, ingestion, immutable replay, and actively consumed dead-letter Queues."
  value = {
    connection_setup_provisioning = cloudflare_queue.connection_setup_provisioning.queue_name
    dead_letter                   = cloudflare_queue.dead_letter.queue_name
    ingestion                     = cloudflare_queue.ingestion.queue_name
    replay                        = cloudflare_queue.ingestion_replay.queue_name
  }
}

output "ingestion_replay_queue_id" {
  description = "Queue identifier used only by the authenticated operator replay command."
  value       = cloudflare_queue.ingestion_replay.queue_id
  sensitive   = true
}

output "vercel_project_id" {
  description = "Vercel project identifier used by the explicit web deployment."
  value       = vercel_project.web.id
}

output "vercel_docs_project_id" {
  description = "Vercel project identifier used by the explicit static docs deployment."
  value       = vercel_project.docs.id
}

output "vercel_team_id" {
  description = "Vercel team identifier used by the explicit web deployment."
  value       = var.vercel_team_id
}
