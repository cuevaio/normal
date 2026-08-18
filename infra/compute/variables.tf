variable "deployment_environment" {
  description = "The isolated authority and deployment environment represented by this state."
  type        = string

  validation {
    condition     = contains(["development", "preview", "production"], var.deployment_environment)
    error_message = "deployment_environment must be development, preview, or production."
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account dedicated to this environment's authority scope."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone containing api_hostname."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "api_hyperdrive_id" {
  description = "Same-environment Hyperdrive configuration used by the API runtime role."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.api_hyperdrive_id))
    error_message = "api_hyperdrive_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "webhook_hyperdrive_id" {
  description = "Same-environment Hyperdrive configuration used by the restricted webhook runtime role."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.webhook_hyperdrive_id)) && var.webhook_hyperdrive_id != var.api_hyperdrive_id
    error_message = "webhook_hyperdrive_id must be a distinct 32-character lowercase hexadecimal ID."
  }
}

variable "vercel_team_id" {
  description = "Vercel team dedicated to this environment's authority scope."
  type        = string

  validation {
    condition     = can(regex("^team_[A-Za-z0-9]+$", var.vercel_team_id))
    error_message = "vercel_team_id must use Vercel's team_<id> form."
  }
}

variable "api_hostname" {
  description = "Public custom hostname routed directly to the API Worker."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.api_hostname)) &&
      !endswith(var.api_hostname, ".workers.dev")
    )
    error_message = "api_hostname must be a lowercase custom DNS hostname outside workers.dev."
  }
}

variable "web_hostname" {
  description = "Public custom hostname assigned to the Vercel web project."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.web_hostname))
    error_message = "web_hostname must be a lowercase DNS hostname."
  }
}

variable "docs_hostname" {
  description = "Public custom hostname assigned to the static Vercel Scalar documentation project."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.docs_hostname))
    error_message = "docs_hostname must be a lowercase DNS hostname."
  }
}

variable "clerk_issuer" {
  description = "Exact HTTPS Clerk issuer for this isolated environment."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.clerk_issuer))
    error_message = "clerk_issuer must be an exact HTTPS origin."
  }
}

variable "clerk_publishable_key" {
  description = "Public Clerk browser key for this isolated environment."
  type        = string

  validation {
    condition     = can(regex("^pk_(test|live)_[A-Za-z0-9_-]{20,}\\$?$", var.clerk_publishable_key))
    error_message = "clerk_publishable_key must use Clerk's public key format."
  }
}

variable "mcp_requests_per_minute" {
  description = "Approved authoritative MCP request reservations allowed in an exact rolling minute."
  type        = number

  validation {
    condition     = var.mcp_requests_per_minute >= 1 && floor(var.mcp_requests_per_minute) == var.mcp_requests_per_minute
    error_message = "mcp_requests_per_minute must be a positive integer."
  }
}

variable "mcp_requests_per_hour" {
  description = "Approved authoritative MCP request reservations allowed in an exact rolling hour."
  type        = number

  validation {
    condition = (
      var.mcp_requests_per_hour >= var.mcp_requests_per_minute &&
      floor(var.mcp_requests_per_hour) == var.mcp_requests_per_hour
    )
    error_message = "mcp_requests_per_hour must be an integer at least as large as mcp_requests_per_minute."
  }
}

variable "read_message_records_per_day" {
  description = "Authoritative UTC-day Stored Message returned-record quota."
  type        = number
  validation {
    condition     = var.read_message_records_per_day > 0 && floor(var.read_message_records_per_day) == var.read_message_records_per_day
    error_message = "read_message_records_per_day must be a positive integer."
  }
}

variable "decrypted_media_bytes_per_day" {
  description = "Authoritative UTC-day decrypted Stored Media byte quota."
  type        = number
  validation {
    condition     = var.decrypted_media_bytes_per_day > 0 && floor(var.decrypted_media_bytes_per_day) == var.decrypted_media_bytes_per_day
    error_message = "decrypted_media_bytes_per_day must be a positive integer."
  }
}

variable "sends_per_minute" {
  description = "Approved per-authorization exact rolling-minute outbound send reservations."
  type        = number
  validation {
    condition     = var.sends_per_minute >= 1 && floor(var.sends_per_minute) == var.sends_per_minute
    error_message = "sends_per_minute must be a positive integer."
  }
}

variable "sends_per_day" {
  description = "Approved per-Personal-Account UTC-day outbound send reservations."
  type        = number
  validation {
    condition     = var.sends_per_day >= 1 && floor(var.sends_per_day) == var.sends_per_day
    error_message = "sends_per_day must be a positive integer."
  }
}

variable "posthog_project_key" {
  description = "Optional public PostHog project key for browser analytics. Empty disables collection. Must be set together with posthog_host."
  type        = string
  default     = ""

  validation {
    condition     = var.posthog_project_key == "" || can(regex("^phc_[A-Za-z0-9_-]+$", var.posthog_project_key))
    error_message = "posthog_project_key must be empty or a public PostHog project key."
  }
}

variable "posthog_host" {
  description = "Optional bare HTTPS PostHog ingest origin. Empty disables collection. Must be set together with posthog_project_key."
  type        = string
  default     = ""

  validation {
    condition = (
      var.posthog_host == "" ||
      can(regex("^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.posthog_host))
    )
    error_message = "posthog_host must be empty or an exact HTTPS origin."
  }
}

variable "posthog_privacy_controls_approved" {
  description = "Confirms that the environment's PostHog retention, IP handling, privacy disclosure, CSP, and subprocessor review are complete."
  type        = bool
  default     = false
}
