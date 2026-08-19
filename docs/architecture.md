# Architecture

This diagram shows the production boundaries and primary data flows. It is a
map of responsibilities, not a substitute for the detailed contracts, ADRs,
and runbooks.

```mermaid
flowchart LR
    user[User]
    mcp[MCP Client]
    apiCaller[Server-side API caller]
    clerk[Clerk]
    whatsapp[WhatsApp]
    wasender[Wasender]

    subgraph vercel[Vercel]
        web[Next.js product UI]
        docs[Static Scalar reference]
    end

    subgraph cloudflare[Cloudflare]
        api[API Worker<br/>Public data plane]
        provider[provider control Worker<br/>Private provider boundary]
        deletion[deletion coordinator Worker]
        restore[restore coordinator Worker]
        recovery[recovery control Worker<br/>Authenticated non-serving drills]
        oauth[(OAuth KV<br/>Protocol state only)]
        queues[(Queues<br/>Provisioning and ingestion)]
        webhook[(Private R2<br/>Encrypted Webhook Events)]
        media[(Private R2<br/>Encrypted Stored Media)]
        lifecycle[(Private R2<br/>Deletion Capsules and markers)]
        transitions[(Private R2<br/>Recipient Exclusion transitions)]
        hyperdrive[Hyperdrive]
    end

    subgraph data[Authoritative data and keys]
        neon[(Neon Postgres<br/>Authoritative application state)]
        kms[AWS KMS<br/>Purpose specific root keys]
        neonControl[Neon control plane<br/>Project-scoped recovery only]
    end

    user -->|sign in and manage| web
    user -->|read public API reference| docs
    web -->|Clerk JWT over HTTPS| api
    mcp -->|OAuth or API Key, then MCP over HTTPS| api
    apiCaller -->|API Key over HTTPS| api
    web --> clerk
    api -->|OAuth protocol artifacts| oauth

    api -->|tenant scoped access| hyperdrive
    hyperdrive -->|restricted runtime roles and RLS| neon
    api -->|durable work| queues
    queues -->|consume and reconcile| api
    wasender -->|authenticated webhooks| api
    api -->|encrypted ingress| webhook
    api -->|encrypted media| media
    api -->|envelope key operations| kms

    api -->|private service binding| provider
    deletion -->|private service binding| provider
    provider -->|provision and control| wasender
    wasender -->|linked account traffic| whatsapp

    api -->|durable deletion evidence| lifecycle
    deletion -->|read capsules and write markers| lifecycle
    deletion -->|capsule key operations| kms
    restore -->|verify deletion markers| lifecycle
    api -->|append only transition journal| transitions
    restore -->|replay recipient transitions| transitions
    restore -->|reapply terminal deletion state| neon
    recovery -->|guarded PITR child lifecycle| neonControl
    recovery -->|restricted replay on disposable child| neon
    recovery -->|read locked evidence| lifecycle
    recovery -->|read locked evidence| transitions
```

## Boundary notes

* The API Worker is the only public data plane. Browser requests go directly to
  its configured origin. Server-side automations call the same Worker with a
  User-created API Key; they do not go through Vercel or a second public Worker.
  The static Scalar app at `docs.normal.fast` is a separate Vercel project. It
  renders the generated OpenAPI document and cannot execute authenticated
  requests, persist an API Key, or proxy browser data requests to the API
  Worker. Development and preview use isolated docs projects and hostnames.
* `provider-control` is private. Provider API Credentials and provider specific
  behavior do not cross its boundary or the `packages/wasender` seam.
* `recovery-control` is public only on its dedicated custom domain for the
  protected GitHub recovery environment. A constant-time bearer check precedes
  its closed start/status contract, a Durable Object serializes runs, and a
  Workflow reconciles an exact annotated non-serving Neon PITR child. It can
  read locked markers and Recipient Exclusion transitions, but it has no Stored
  Media or Webhook Ingress binding and therefore simulates and acknowledges
  child-branch deletion intents without deleting shared production objects.
  Completion requires a separate authenticated evidence authority; missing
  verifier or observability inputs fail the drill closed.
* Neon is authoritative for identity mappings, tenant data, authorization,
  quota reservations, audit records, and lifecycle state. KV, R2, and Queues do
  not become alternate authorities.
* Stored Messages and Stored Media use application layer envelope encryption.
  KMS keys are purpose specific, and the deletion coordinator cannot decrypt
  tenant content.
* Connection Deletion revokes access and key use immediately, including API
  Key selection for that WhatsApp Connection and automatic revocation of a key
  that loses its last selected Connection. The deletion and restore
  coordinators preserve that terminal state through provider cleanup and
  database restore. Disconnection keeps retained-history API Key access.
* A WhatsApp Recipient Exclusion is a User-owned rule enforced beneath every
  MCP Authorization and API Key. Neon holds current state; a locked,
  restore-external R2 journal holds the append-only transitions and permanent
  purge cutoffs the restore coordinator replays before traffic reopens.
* API Keys authenticate REST and compatible MCP Clients through a
  purpose-specific HMAC digest and a narrow Neon bootstrap. API Key-shaped MCP
  credentials route before OAuth and never fall back to OAuth after failure.
  Personal Account Deletion revokes every API Key and clears
  every digest in the same prepare transaction as MCP revocation; active rows
  later cascade during the bounded Personal Account purge. MCP and REST remain
  separate protocol adapters over shared protected WhatsApp operations, quotas,
  and Activity Logs. Activity Log channel is independent from principal type.
  Send Operations admit a protocol-neutral grant identity so MCP Authorization
  and API Key stay distinct principals across both adapters. REST pages complete
  retained Stored Messages at
  `GET /v1/connections/{connection_id}/conversations/{conversation_id}/messages`
  and creates or exactly replays a text Send Operation at
  `POST /v1/connections/{connection_id}/send-operations`. Local Send Status is
  available only to the originating still-active API Key at
  `GET /v1/connections/{connection_id}/send-operations/{send_operation_id}`.

For exact behavior, read [`CONTEXT.md`](../CONTEXT.md), the
[MCP contract](mcp-contract.md), the [configuration reference](configuration.md),
the [Wasender seam](wasender-seam.md), and the [ADRs](adr).
