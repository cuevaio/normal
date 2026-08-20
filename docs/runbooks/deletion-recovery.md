# Deletion primitives and restore recovery

This runbook covers the restore-safe primitives. Connection Deletion, Personal
Account Deletion, provider cleanup scheduling, and the traffic restore gate are
separate workflows, but they must preserve this ordering and authority split.

## Personal Account Deletion entry points

The product `DELETE /v1/personal-account` and verified Clerk
`user.deleted` deliveries to `POST /v1/webhooks/clerk` enter the same terminal
operation. The API first marks the Personal Account deleting, cancels incomplete
Connection Setups, revokes MCP Authorizations and refresh families, and revokes
every API Key and clears every credential digest. It then writes the locked
Personal Account marker, starts Connection Deletion for every retained WhatsApp
Connection, and makes the account key unavailable. Active API Key rows remain
until the bounded Personal Account purge cascades them. Only the product entry
point then calls Clerk to delete the User.

Configure and rotate `CLERK_SECRET_KEY` and `CLERK_WEBHOOK_SIGNING_SECRET` as
Cloudflare secrets. Clerk webhook retries are safe for unknown and already
deleting identities and must never be replaced with an unsigned operational
request. Telemetry reports only entry-point class and outcome; it contains no
Clerk User or Personal Account identifier.

## Deleted Message Tombstones

Message-deletion webhook items are terminal Message Store evidence. Operators
must not repair a Deleted Message Tombstone by replaying an older message
upsert, edit, or media job: replay must converge to the existing content-free
row. A healthy tombstone retains ordering and its opaque message identity, has
`deleted_at` set, and has every content ciphertext field null. `read_messages`
still counts and returns that row with null text and media.

If those invariants fail after a deployment or restore, stop webhook replay,
retain only metadata-safe incident references, and use a forward migration or
projector fix. Never copy ciphertext from a Webhook Event into a tombstone.

## Active deletion ordering

1. Resolve the Personal Account and WhatsApp Connection only inside the
   restricted transaction-local Personal Account context.
2. Derive the marker object key with `DELETION_MARKER_HMAC_SECRET`. Write the
   version-1 marker with only `deletionKind`, `requestedAt`,
   `keyUnavailableAt`, and `version`, using create-if-absent. An existing
   byte-identical marker is a successful replay; different bytes at the same
   marker key are an integrity failure.
3. Before making the tenant key unavailable, copy only the opaque provider
   session locator needed for cleanup into a Deletion Capsule. Encrypt it with
   `KMS_DELETION_COORDINATOR_KEY_ARN` and the exact context `environment`,
   `purpose=deletion-capsule`, `deletionMarkerId`, and `keyVersion`. Never add a
   phone number, identity, credential, content value, provider payload, or
   tenant key to the capsule.
4. In the tenant transaction, invoke
   `app_private.make_whatsapp_connection_key_unavailable` or
   `app_private.make_personal_account_key_unavailable`. These functions are
   idempotent and leave an unavailable tombstone even if no envelope existed.
   Ordinary runtime can insert and load an initial available envelope, but
   cannot update, delete, or replace the tombstone. The same Connection
   Deletion transaction removes the WhatsApp Connection from every API Key
   before protected access can continue. A key that loses its last selected
   Connection is permanently revoked and its credential digest is cleared.
   Disconnection does not remove selection or revoke the key.
5. Start asynchronous provider reconciliation. The marker is never removed.
   The Deletion Capsule remains until the isolated deletion coordinator
   confirms provider absence and durably records that fact through its narrow
   database function.
6. The API cleanup schedule deletes encrypted Webhook Event sources and Stored
   Media objects. It acknowledges each Stored Media deletion before quota is
   released, then purges connection-owned Neon rows and releases the WhatsApp
   Number reservation. The public handle is copied to a content-free tombstone
   before the Connection row is removed, so it can never be reused.

## Personal Account purge completion

The hourly API cleanup schedule selects a deleting Personal Account only after
its locked marker is durable and every WhatsApp Connection row has completed
Connection Deletion. The restricted purge function transforms each ordinary
Activity Log into a Security Record containing only category, allowlisted
client class, outcome, counts, timing, and latency, then deletes the Personal
Account row so its Clerk identity mapping, onboarding profile, API Keys, and
all remaining tenant rows cascade away. MCP events keep their allowlisted
client class; API events use `api_key`. Security Records keep the source log's
original 90-day expiry and must not retain an API Key, User, Personal Account,
Connection, network, message, contact, provider, credential, or content
reference. The only cleanup audit retains the deletion marker digest and
completion time and expires 90 days after completion; the locked R2 marker
remains indefinitely as the restore guard.

If a purge candidate approaches 24 hours, treat any remaining Connection
Deletion or object cleanup as the blocker and use marker-only diagnostics. Do
not copy tenant identifiers or content into tickets or telemetry. After a
restore, replay locked markers and complete Connection Deletion before running
the same account purge; a later Clerk signup then creates a new Personal
Account because the old Clerk identity mapping no longer exists.

The deletion coordinator receives only its Deletion Capsule KMS decrypt
authority, provider cleanup seam, Deletion Capsule binding, and the
`whatsapp_deletion_runtime` database role. It must not receive the content-root role,
content key ARN, Personal Account key envelopes, WhatsApp Connection key
envelopes, Stored Media binding, Webhook Event binding, or an ordinary
application database role. A `present` provider observation retains the
capsule for another bounded reconciliation. An `absent` observation first
records provider absence and then destroys the capsule; replay after destruction
is complete. The separate API cleanup schedule owns active R2 and Neon purge.

Alert before the 24-hour active-cleanup deadline on an overdue capsule,
provider ambiguity, denied KMS operation, marker write failure, or attempted
marker overwrite. Telemetry may include the deletion marker identity,
operation class, normalized outcome, attempt count, and duration. It must not
include the opaque entity identifier used to derive the marker, provider
session locator, KMS plaintext/ciphertext, phone number, credential, or
content.

## Stalled provider cleanup and 24-hour escalation

Page when provider absence remains unknown, a capsule reconciliation repeats a
normalized failure, or six hours remain before the 24-hour active-purge
deadline. Keep access revoked, keys unavailable, markers locked, capsules
retained, and WhatsApp Numbers reserved. Inspect only marker identity, state,
attempt count, lease age, deadline, and normalized failure through the deletion
coordinator's restricted role.

Restore KMS, provider-control, Queue, or Wasender access, then let the isolated
coordinator reconcile before repeating deletion. Never call provider deletion
blindly, release a reservation, alter the marker, age-delete a capsule, or give
the coordinator content authority. At 24 hours, escalate to privacy and
security on-call, record the missed active-purge objective honestly, preserve
the same containment, and continue bounded reconciliation until provider
absence and active purge are durable.

## Marker validation and Deletion Capsule recovery

Validate every marker's canonical `markers/v1/` key, exact version-1 fields,
canonical timestamps, create-if-absent identity, and indefinite lock. A byte-
different body at an existing key is an integrity incident. Validate a capsule
only through its marker-bound encryption context and deletion-coordinator KMS
role; it may contain only the provider locator required for cleanup.

If the coordinator is unavailable, redeploy its last known-good artifact with
fresh short-lived credentials for its existing narrow role. If KMS or the
provider is unavailable, retain the capsule unchanged until recovery. A missing
capsule before confirmed absence is not recoverable from tenant content or
logs; keep deletion terminal, preserve the marker, escalate the stranded
provider cleanup, and never recreate a guessed locator.

## Restore enumeration

No restored Neon branch may receive verification or application traffic before
the restore gate completes:

Set the restore coordinator's `NEON_BRANCH_ID` to the new branch's exact Neon
identity and `RESTORE_DATABASE_URL` to that branch's restricted
`whatsapp_restore_runtime` credential. The API, Queue consumers, and scheduled
handlers compare their configured branch identity to aggregate completion
evidence in the database; a mismatch returns unavailable before authentication,
tenant lookup, KMS use, or data-plane work. The restore coordinator has no KMS,
provider-control, OAuth, or public-route binding.

1. Keep public and internal data-plane routes disabled.
2. Enumerate every `markers/v1/` object from the locked marker bucket across all
   R2 list pages. Reject an invalid object key, missing object, malformed body,
   extra body field, unsupported version, or non-canonical timestamp.
3. Scan the restored branch's opaque Personal Account and WhatsApp Connection
   identifiers, derive each expected marker ID with the dedicated HMAC, and
   match those IDs against the enumerated marker set. Marker bodies deliberately
   contain no reversible identifier. Make every match's key unavailable first,
   then re-purge its restored rows and active object references.
4. Enumerate every `recipient-transitions/v1/` object for each restored
   recipient identity. Scan restored WhatsApp Directory contacts and groups,
   WhatsApp Conversations, and existing exclusion rows, derive each journal
   prefix with the dedicated `RECIPIENT_TRANSITION_HMAC_SECRET`, and replay the
   ordered transitions oldest first. Restore the latest acknowledged state,
   reapply every greatest purge cutoff whether or not the recipient is
   currently excluded, and drain the resulting Stored Media object deletions.
   Reject an invalid object key, missing object, malformed body, extra body
   field, unsupported version, non-canonical timestamp, an object stored under
   a name other than its own transition identity, or an exclusion recorded
   without a purge cutoff. A recipient first projected and excluded after the
   restore point has no identity in the snapshot, so its prefix cannot be
   derived here; record every journal prefix that stayed unmatched. The API
   reapplies those transitions on its hourly sweep as soon as the WhatsApp
   Directory projects the recipient again, and the recorded prefixes are
   identity-free.
5. Run the same `app_private.purge_expired_message_content` wall-clock expiry
   gate used by the hourly worker until it returns fewer than the batch limit,
   then drain `stored_media_object_deletions`, before verification access or
   serving traffic. This applies current per-connection policy as required by
   ADR 0021 without reopening content from the restored snapshot.
6. Drain `invalidate_restored_api_keys` until a batch revokes and clears
   fewer than the limit. The restore gate stays closed while any API Key is
   still active or still has a credential digest. Record only the aggregate
   revoked and digest-cleared counts.
7. Generate a new 32-byte `API_KEY_HMAC_SECRET` with `openssl rand -hex 32`
   and publish it as the API Worker secret. Do not retain the predecessor as
   a verification fallback, dual-generation secret, or restore-coordinator
   credential. Users create replacement keys after recovery.
8. Verify no marked identifier has an available key envelope or readable
   content, and that no excluded recipient has readable Stored Message content,
   readable Stored Media, or a remaining prepared transition. Record marker
   count, replayed transition count, unresolved prefix count, API Key
   invalidation counts, HMAC-rotation evidence, normalized outcomes, RPO, and
   elapsed RTO without recording tenant, recipient, credential, or provider
   identifiers. A non-zero unresolved prefix count is expected when the
   restore point predates a recipient; track it until the API sweep reports
   it resolved.
9. Enable verification access, and later traffic, only after every marker,
   recipient transition, expiry, API Key invalidation, and HMAC-rotation
   operation succeeds.

Do not sample marker or recipient transition replay, skip a malformed object,
substitute a database copy of marker or journal state, or unlock/delete either
locked bucket to recover from an error. Restore the marker, recipient
transition, or KMS authority, or forward-fix the replay code, while traffic
remains closed.

## Restore gate release criteria

Release verification access only after all marker pages were enumerated, every
restored opaque identifier was compared, marked keys are unavailable, marked
rows and active objects were re-purged, every recipient transition journal
prefix was replayed with its purge cutoff reapplied and no prepared transition
left unresolved, wall-clock expiry batches and Stored Media deletion intents
drained, and schema/RLS/quota/audit invariants pass.
Every restored API Key must already be revoked with its credential digest
cleared, and recovery must record aggregate evidence that
`API_KEY_HMAC_SECRET` was rotated to a newly generated value whose predecessor
is not accepted as a verification fallback. Users create replacement keys after
recovery; no restored grant may authenticate inside the Neon recovery-point
window.
Release application and Queue traffic only after verification records aggregate
marker count, zero failures, branch identity, achieved RPO, elapsed RTO, and
those API Key invalidation and HMAC-rotation checks.
Any malformed marker, authority failure, branch mismatch, incomplete batch, or
missing API Key invalidation evidence keeps the gate closed; there is no bypass
or sampled success mode.
The public API release gate additionally requires those restore checks on the
current weekly drill evidence before the public REST surface may be released.

## Rollback and authority recovery

Never delete, unlock, rename, or replace the marker bucket, the recipient
transition bucket, either indefinite lock, the dedicated marker or recipient
transition HMAC secret, or either KMS key during application rollback.
Do not age-delete Deletion Capsules: unexplained capsule loss can strand a
provider session after tenant keys are unavailable. Restore a failed
coordinator from the last known-good production artifact with its separate
short-lived role credentials, reconcile absence, and then let the normal
primitive destroy the capsule.
