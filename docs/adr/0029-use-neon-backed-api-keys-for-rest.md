# Use Neon-backed API Keys for the public REST API

Expose a versioned REST adapter from the existing public API Worker and authenticate it with User-created API Keys whose one-time plaintext credentials are represented in authoritative Neon by a purpose-specific HMAC digest and a revocable grant over independently selected permissions and WhatsApp Connections. Do not add Unkey or make another credential service authoritative: every request uses a narrow database bootstrap, rechecks current grant and lifecycle state, and applies the same account quotas and audit-before-release policy as MCP, while REST and MCP remain separate protocol adapters over shared application operations.

ADR 0030 extends these same API Keys to direct MCP authentication without changing their principal type or replacing OAuth for delegated MCP Clients.
