# Security operations

All changes use the exact environment's least-privilege authority and an opaque
incident or change reference. Never print a secret, token, credential hash,
provider identifier, tenant identifier, plaintext, or ciphertext. Rotate one
authority at a time, verify its consumer, then revoke the predecessor.

## Restore-damaged Personal Account envelope

Use `Recover production Personal Account envelope` only when an investigated
restore defect left exactly one active Personal Account with an unavailable
account-key envelope and at least one retained, non-deleting WhatsApp
Connection. Supply a canonical source point from before key unavailability and
an opaque `change_` reference. The workflow creates one guarded non-serving PITR
branch, verifies the exact Neon project and serving branch, requires the PITR
account-key version to match every retained Connection and Setup envelope,
restores only the unavailable account-key envelope in a serializable
transaction, verifies it before commit, and atomically records the opaque change
reference so an ambiguous commit can be safely reconciled. The operation retries
PITR cleanup through a bounded control-plane consistency window. Recovery
evidence contains an internal Personal Account reference, source point, key
version, and completion time; it is inaccessible to runtime roles, contains no
key material, and is removed with Personal Account Deletion. The workflow emits
no tenant identity, KMS identity, ciphertext, or key material. Any candidate
ambiguity, branch mismatch, unavailable source envelope, version mismatch,
concurrent change, or failed in-transaction verification aborts the write.
If the workflow result is ambiguous, dispatch it again with the exact same
source point and `change_` reference; the atomically stored evidence makes that
retry verification-only. Never invent a second reference for the same recovery.

## Routine secret rotation

Follow the inventory in [deployment configuration](../configuration.md).
Generate independent random values and update the owning vendor and deployment
secret store together. Re-run secret-name validation, production readiness,
`bun run deploy:smoke`, and safe telemetry checks.

- Rotate Cloudflare, Vercel, Neon, Clerk, Wasender, database, webhook, smoke,
  and short-lived AWS credentials through their issuers. Provider-control's
  account credential stays isolated from API and web.
- Rotate `MCP_CURSOR_HMAC_SECRET` by publishing a new API version; clients
  restart short-lived pagination. Preserve `SEND_FINGERPRINT_HMAC_SECRET` while
  any 90-day replay binding exists.
- Never directly replace `WASENDER_REFERENCE_SECRET`; stop provisioning and use
  the documented reconcile-and-rekey procedure while old locators remain
  readable. Rotate the WhatsApp Number reservation HMAC only under the stopped-
  provisioning migration described in configuration.
- Do not rotate `DELETION_MARKER_HMAC_SECRET` without a reviewed marker-rekey
  recovery design. KMS automatic key-material rotation retains the same key
  identity; never replace either KMS key as routine rotation.

## Suspected credential leak

Contain first: disable or revoke the exact credential at its issuer, stop the
affected deployment or operation class, and preserve metadata-only issuer audit.
Determine its authority boundary before rotation. If scope is uncertain, treat
all environments and consumers reachable by that credential as affected, but
do not rotate unrelated stable HMAC or KMS identities.

If the exposed value is a stable reservation, provider-reference, send-
fingerprint, or deletion-marker HMAC, stop the operations that create or depend
on new keyed identities and escalate for a reviewed dual-read/rekey design. An
ad hoc replacement would orphan reservations, provider cleanup, replay
bindings, or restore markers. If a KMS authority is exposed, revoke the caller
credentials and policy grant while preserving the KMS key identity.

Issue a replacement with no broader privilege, update only its intended secret
store, publish the consumer, verify readiness and one safe canary, then confirm
the old credential is rejected. Review immutable CloudTrail, Cloudflare, Neon,
Clerk, Vercel, and Wasender audit by time, action, normalized outcome, and opaque
incident reference. Treat any copied sensitive value in logs or tickets as a
second leak and remove access to that sink under its retention process.

## User API Key revocation

A User revokes an API Key from the signed-in dashboard. Revocation is
idempotent, clears the credential digest in the authoritative Neon transaction,
and takes effect on the next request. There is no authorization cache that can
extend a revoked or expired key. Do not recover, redisplay, or reroll the
plaintext. A lost credential requires creating a replacement key. Record only
the opaque `apk_` handle, outcome, and incident reference.

## API Key HMAC compromise

`API_KEY_HMAC_SECRET` is purpose-specific. Suspected compromise uses
intentional global invalidation rather than an unsafe fallback: revoke every
API Key, clear every digest, generate a new 32-byte hex secret, publish it as
the Worker secret, and record aggregate completion evidence. The predecessor
must not remain accepted as a verification fallback. Users create replacement
keys after recovery.

## Restore HMAC rotation

Every production database restore uses the same intentional global
invalidation before verification access reopens. The restore coordinator
revokes every restored API Key and clears every digest, recording only
aggregate counts. Operators then generate and publish a new
`API_KEY_HMAC_SECRET`. The predecessor is not accepted as a verification
fallback, and no revoked grant may authenticate inside the Neon
recovery-point window. Users create replacement keys after recovery.

## Absence of routine API Key HMAC rotation

Routine rotation that preserves active API Keys is not part of v1. It would
require a reviewed dual-generation migration. Do not replace the secret as an
ad hoc rotation while traffic is serving, and do not reuse OAuth, cursor,
content, provider-reference, webhook, reservation, or deletion HMAC material.

## Refresh-family compromise

An observed OAuth refresh `reuse` outcome means the affected family is already
revoked in authoritative Neon. Confirm revocation through safe counts, revoke
the MCP Authorization if not already revoked, deny current access and refresh
credentials, notify the User through the incident process, and investigate the
allowlisted MCP Client's storage. Do not delete KV as containment, query or
export credential hashes, or restore a family. A later grant is a new explicit
MCP Authorization with fresh consent and Clerk reverification.

## Break-glass operation

Routine operators have no content access. When content is strictly necessary
for a scoped incident, follow the [two-person break-glass
runbook](break-glass-access.md): recorded reason and exact Personal Account,
two-person approval, one capability, MFA, tagged credentials lasting no more
than one hour, per-use authorization and immutable audit, then User notification
unless a recorded legal prohibition applies. Stop at expiry and destroy local
plaintext and credentials.

## Immutable audit review

Use observability and issuer audit roles only; they receive no content keys,
database runtime role, R2 object access, provider credential, or OAuth secret.
Review append-only break-glass events, CloudTrail request and session tags,
Activity Log/Security Record aggregate outcomes, secret-store administrative
events, and deployment versions. Correlate by approved opaque incident reference
and time window. Do not enrich evidence with User, account, connection, network,
message, contact, object, provider, token, or credential values. Modifying an
audit event or deletion marker is itself a security incident.
