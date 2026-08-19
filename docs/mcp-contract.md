# MCP Contract

This document defines the public launch contract for the Normal MCP server. Provider payloads, provider identifiers, and internal database identifiers never appear in this contract.

## Common Rules

`POST /mcp` accepts `Authorization: Bearer` with either an OAuth access token or an existing Normal API Key matching `normal_apk_<handle>.<secret>`. OAuth remains the delegated flow for Claude and ChatGPT. API Key-shaped credentials are authenticated before OAuth middleware and never fall back to OAuth after failure. Invalid, expired, or revoked API Keys return `401 invalid_token`; authentication infrastructure failure returns `503`. Credentials are never accepted from URLs, query parameters, JSON-RPC `_meta`, or `x-mcp-header`.

- Tool inputs and outputs are closed JSON Schema 2020-12 objects with `additionalProperties: false`.
- Success returns validated `structuredContent` and the same compact JSON in one text content block. Protected media may additionally return `resource_link` content.
- Actionable failures return `isError: true` and safe JSON with `error_code`, `message`, `retryable`, and optional `retry_after_seconds` and `resets_at` fields.
- Public entity handles are a type prefix followed by a 21-character NanoID-default-alphabet suffix matching `[A-Za-z0-9_-]{21}`: `con_`, `ctc_`, `grp_`, `cvs_`, `msg_`, `med_`, or `snd_`.
- Handles name records but grant no authority. Every call rechecks the current grant, permission or scope, selected connection, and object relationship.
- Except for `list_connections`, every tool requires an explicit `connection_id`.
- Timestamps are UTC RFC 3339 strings.
- Unknown optional values are returned as `null`, not omitted.
- No tool parameter is mirrored into an HTTP header with `x-mcp-header`.
- A WhatsApp Recipient Exclusion is enforced beneath every grant and never changes the grant itself. While one applies, the recipient is absent from `list_contacts`, `list_groups`, and `list_chats`; `read_messages` and Stored Media resources reject a retained WhatsApp Conversation handle or media URI as not found; and `send_text_message` returns `recipient_not_found` before quota reservation or provider access. No tool discloses that an exclusion is the reason, and no MCP tool can read or change one.

## Scope Map

| Scope | Tools and resources |
| --- | --- |
| `connections:read` | `list_connections` |
| `directory:read` | `list_contacts`, `list_groups` |
| `messages:read` | `list_chats`, `read_messages`, `search_messages`, Stored Media resources |
| `messages:send` | `send_text_message`, `get_send_status` |

Every tool is omitted from discovery when its scope is absent and rechecks the scope in its handler.

## Pagination

`list_contacts`, `list_groups`, and `list_chats` accept `limit` from 1 through 50 with a default of 20 and an optional opaque `cursor`. `search_messages` has its narrower limit described below. Their outputs contain:

| Field | Type | Meaning |
| --- | --- | --- |
| `has_more` | boolean | Whether another page was available when this page was produced. |
| `next_cursor` | string or null | Authorization-bound keyset cursor for the next page. |
| `as_of` | RFC 3339 string | Latest source observation represented by the projection. |
| `stale` | boolean | Whether reconciliation is overdue or the source cannot currently be confirmed. |
| `partial` | boolean | Whether initial sync, a known failure, retention, or an Ingestion Gap limits the projection. |

A cursor binds the current grant, tool, `connection_id`, normalized filters or search, limit, sort version, last sort tuple, and expiry. MCP Authorization IDs bind directly; API Keys bind as `api:<grant-id>`. MCP and REST cursor signing documents remain separate. Cursor traversal is not a frozen snapshot; concurrent changes can move entries, and callers may restart from the first page.

## `list_connections`

Requires `connections:read`. The input is an empty object. It returns only non-deleted WhatsApp Connections selected by the current grant. A Personal Account has at most three, so this tool is not paginated.

```json
{
  "connections": [
    {
      "connection_id": "con_7Yf...21-characters",
      "display_name": "Personal WhatsApp",
      "number_last_four": "1234",
      "state": "connected",
      "state_changed_at": "2026-07-30T12:00:00Z"
    }
  ]
}
```

`display_name` is the User-chosen WhatsApp Connection name and is always present. `number_last_four` is nullable. `state` is one of `connected`, `connecting`, `disconnected`, `reconnect_required`, or `degraded`. Deleting connections are immediately revoked and omitted.

## `list_contacts`

Requires `directory:read`.

Input fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `connection_id` | `con_` handle | yes | Explicit selected WhatsApp Connection. |
| `search` | string | no | Display-name prefix of at least three characters, or one exact E.164 number beginning with `+`. |
| `limit` | integer 1-50 | no | Page size; defaults to 20. |
| `cursor` | string | no | Cursor from a prior call with identical bound inputs. |

An exact phone search never causes the full number to be returned or logged.

```json
{
  "contacts": [
    {
      "contact_id": "ctc_k2M...21-characters",
      "conversation_id": "cvs_f9A...21-characters",
      "display_name": "Ada",
      "phone_last_four": "0199"
    }
  ],
  "has_more": false,
  "next_cursor": null,
  "as_of": "2026-07-30T12:00:00Z",
  "stale": false,
  "partial": false
}
```

`display_name`, `phone_last_four`, and `conversation_id` are nullable. `conversation_id` is present only when the current grant also has `messages:read` and the platform has retained Stored Message activity for that direct WhatsApp Conversation. A caller can pass it directly to `read_messages`; absence does not mean the contact is inactive. Results include only contacts marked active and non-deleted in the latest Directory projection, sort by normalized display name and then `contact_id`, and remain qualified by the page's `stale` and `partial` fields because the provider is authoritative.

## `list_groups`

Requires `directory:read`.

Input fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `connection_id` | `con_` handle | yes | Explicit selected WhatsApp Connection. |
| `search` | string, 3-64 characters | no | Group display-name prefix. |
| `limit` | integer 1-50 | no | Page size; defaults to 20. |
| `cursor` | string | no | Cursor from a prior call with identical bound inputs. |

```json
{
  "groups": [
    {
      "group_id": "grp_H8q...21-characters",
      "display_name": "Family"
    }
  ],
  "has_more": false,
  "next_cursor": null,
  "as_of": "2026-07-30T12:00:00Z",
  "stale": false,
  "partial": false
}
```

Results include only groups marked current and joined in the latest Directory projection and sort by normalized display name and then `group_id`. The page's `stale` and `partial` fields qualify that projected membership because the provider is authoritative. Group descriptions, profile URLs, and rosters are never returned.

`group_id` names a WhatsApp Recipient for Directory lookup and sending. It is not a WhatsApp Conversation handle and cannot be passed as `read_messages.conversation_id`. To read observed group history, call `list_chats` with `kind: "group"`, match the returned `recipient_id` to the `group_id` when needed, and pass that result's `conversation_id` to `read_messages`. A joined group may have no WhatsApp Conversation yet when the platform has not observed a Stored Message for it.

## `list_chats`

Requires `messages:read`. It lists only WhatsApp Conversations with observed Stored Message activity; Wasender has no authoritative chat-list or history endpoint.

Input fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `connection_id` | `con_` handle | yes | Explicit selected WhatsApp Connection. |
| `kind` | `all`, `direct`, or `group` | no | Conversation filter; defaults to `all`. |
| `limit` | integer 1-50 | no | Page size; defaults to 20. |
| `cursor` | string | no | Cursor from a prior call with identical bound inputs. |

```json
{
  "chats": [
    {
      "conversation_id": "cvs_f9A...21-characters",
      "kind": "direct",
      "recipient_id": "ctc_k2M...21-characters",
      "display_name": "Ada",
      "phone": "+15550190199",
      "phone_last_four": "0199",
      "last_activity_at": "2026-07-30T11:59:00Z",
      "last_activity_direction": "inbound"
    }
  ],
  "has_more": false,
  "next_cursor": null,
  "as_of": "2026-07-30T12:00:00Z",
  "stale": false,
  "partial": false
}
```

`recipient_id` is the current Directory `ctc_` handle for a direct conversation or `grp_` handle for a group. Direct-chat `display_name`, normalized E.164 `phone`, and `phone_last_four` are nullable when the provider Directory lacks that metadata; group phone fields are always `null`. Conversations are reconciled to Directory entries by their connection-scoped identity index rather than an early placeholder handle. `last_activity_direction` is `inbound` or `outbound`. Results sort by `last_activity_at` descending and then `conversation_id`. No body, snippet, unread state, provider identifier, or roster is returned.

Use the returned `conversation_id` with `read_messages`. Do not pass `recipient_id` from this tool or `group_id` from `list_groups` as a conversation handle.

## `read_messages`

Requires `messages:read`.

Input fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `connection_id` | `con_` handle | yes | Explicit selected WhatsApp Connection. |
| `conversation_id` | `cvs_` handle | yes | Conversation owned by that connection. |
| `limit` | integer 1-50 | no | Record count; defaults to 20. |
| `older_cursor` | string | no | Cursor returned by the immediately compatible older traversal. |

Without `older_cursor`, the tool selects the newest page. Records inside every page are ordered chronologically from oldest to newest. The cursor is short-lived, tamper-resistant, and bound to the current grant, tool, connection, conversation, limit, sort version, boundary tuple, and expiry. Tombstones count toward the daily returned-record quota.

```json
{
  "conversation_id": "cvs_f9A...21-characters",
  "kind": "direct",
  "recipient_id": "ctc_k2M...21-characters",
  "messages": [
    {
      "message_id": "msg_b7Q...21-characters",
      "sent_at": "2026-07-30T11:58:00Z",
      "direction": "inbound",
      "sender": {
        "kind": "contact",
        "display_name": "Ada",
        "phone_last_four": "0199"
      },
      "content_type": "image",
      "text": "A caption",
      "text_truncated": false,
      "text_total_utf8_bytes": 9,
      "edited_at": null,
      "deleted": false,
      "media": {
        "media_id": "med_N4s...21-characters",
        "type": "image",
        "state": "ready",
        "file_name": "photo.jpg",
        "mime_type": "image/jpeg",
        "size_bytes": 245123,
        "resource_uri": "whatsapp-media://connections/con_7Yf.../messages/msg_b7Q.../media/med_N4s...",
        "resource_unavailable_reason": null,
        "resource_size_limit_bytes": 16777216
      }
    }
  ],
  "size_limited": false,
  "has_older": true,
  "older_cursor": "opaque-signed-cursor",
  "history_starts_at": "2026-07-01T00:00:00Z",
  "history_start_reason": "retention_policy",
  "gaps": [
    {
      "starts_at": "2026-07-12T03:00:00Z",
      "ends_at": "2026-07-12T03:08:00Z",
      "cause": "connection_unavailable"
    }
  ]
}
```

Field rules:

- `conversation_id` echoes the authorized WhatsApp Conversation read by this result. `recipient_id` is its current `ctc_` or `grp_` WhatsApp Recipient handle and can be passed directly to `send_text_message`; `kind` is `direct` or `group`.
- `direction` is `inbound` or `outbound`.
- `sender.kind` is `self`, `contact`, or `group_participant`; its display name and phone suffix are nullable.
- `content_type` is `text`, `image`, `audio`, `video`, `document`, `sticker`, or `unknown`.
- `text` is the latest verified text or caption and is nullable. Prior edit ciphertext is not retained or returned.
- `text_truncated` is always present. `text_total_utf8_bytes` is the full latest plaintext byte count when text exists and is null otherwise.
- `edited_at` is nullable. `deleted: true` always has `text: null`, `media: null`, and no recoverable prior content.
- `media.type` is `image`, `audio`, `video`, `document`, or `sticker`.
- `media.state` is `pending`, `ready`, `rejected`, or `failed`. Filename may always be null; MIME type, byte size, and resource URI may be null for non-ready media.
- `ready` requires a non-null verified `size_bytes` and normalized `mime_type`. Unknown MIME normalizes to `application/octet-stream`; inability to verify actual byte size produces `failed`, never `ready`.
- `resource_size_limit_bytes` is always `16777216` (16 MiB). `resource_uri` is non-null only when media is `ready` and its verified `size_bytes` does not exceed that limit.
- `resource_unavailable_reason` is null when `resource_uri` is non-null; otherwise it is `media_pending`, `media_rejected`, `media_failed`, or `too_large_for_mcp`, consistent with `state` and size.
- Each media item with a non-null `resource_uri` also adds one MCP `resource_link` content block. Binary bytes are never embedded in the tool's JSON or text result.
- `history_start_reason` is `connection_started` or `retention_policy`.
- Gap causes are `connection_unavailable`, `webhook_configuration`, `health_check_failure`, `ingress_failure`, `processing_failure`, or `restore_loss`. `health_check_failure` records a measured lapse in the five-minute health observer, not ordinary message inactivity. `ends_at` is null for an active interval.
- Returned gaps intersect the time span represented by the page or its path to the retained history boundary. Their absence does not certify complete provider delivery.

### Result Size

The compact success JSON targets at most 32 KiB before the required legacy text duplicate. The server returns fewer than `limit` records when necessary, sets `size_limited: true`, and derives `older_cursor` from the oldest record actually returned. It never splits one Stored Message across pages.

If one normalized record alone exceeds the target, the server returns a Unicode-safe text prefix within a 64 KiB hard JSON cap, sets `text_truncated: true`, and reports the full `text_total_utf8_bytes`. The full ciphertext remains subject to Message Retention Policy, but the MVP exposes no separate full-text resource. Quota accounting uses the number of records actually returned.

## `search_messages`

Requires `messages:read`. It searches complete normalized words in the latest retained Stored Message text and media captions within one explicitly selected WhatsApp Connection. It does not search prior edits, Deleted Message Tombstones, filenames, sender or Directory metadata, reactions, or provider payloads.

Input fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `connection_id` | `con_` handle | yes | Explicit selected WhatsApp Connection. |
| `query` | string, 1-256 Unicode scalar values | yes | Exact-word query containing 1-8 unique normalized terms. |
| `conversation_id` | `cvs_` handle | no | Restrict results to a WhatsApp Conversation owned by the selected connection. |
| `direction` | `all`, `inbound`, or `outbound` | no | Direction filter; defaults to `all`. |
| `after` | RFC 3339 string | no | Include Stored Messages with `sent_at` at or after this instant. |
| `before` | RFC 3339 string | no | Include Stored Messages with `sent_at` before this instant. |
| `limit` | integer 1-20 | no | Record count; defaults to and cannot exceed 20. |
| `cursor` | string | no | Cursor from a prior call with identical bound inputs. |

The decoded query must contain only Unicode scalar values and no more than 256 of them. Version `v1` applies NFKC, locale-independent Unicode lowercase mapping, and NFKC again, then treats maximal Letter-or-Number words continued by Letters, Marks, or Numbers as terms. Punctuation, symbols, separators, and controls are boundaries. A query that produces no terms or more than eight unique terms is invalid. Duplicate terms are removed. Every unique term must occur, but order and adjacency do not matter. Matching does not perform substring, prefix, phrase, stemming, morphology, synonym, fuzzy, or relevance search. If both time bounds are supplied, `after` must be earlier than `before`.

Results sort newest first by `sent_at DESC, message_id DESC`. The cursor is short-lived and binds the current grant, tool, selected connection, optional conversation, direction, time bounds, limit, sort version, boundary tuple, index version, and a domain-separated keyed digest of the normalized query terms. Neither query text nor search-index tokens appear in the cursor.

```json
{
  "messages": [
    {
      "message_id": "msg_b7Q...21-characters",
      "conversation_id": "cvs_f9A...21-characters",
      "sent_at": "2026-07-30T11:58:00Z",
      "direction": "inbound",
      "content_type": "image",
      "text": "Your flight confirmation is attached.",
      "text_truncated": false,
      "text_total_utf8_bytes": 37,
      "edited_at": null
    }
  ],
  "size_limited": false,
  "has_more": false,
  "next_cursor": null,
  "coverage": {
    "history_starts_at": "2026-07-01T00:00:00Z",
    "history_start_reason": "retention_policy",
    "searchable_history_starts_at": "2026-07-10T00:00:00Z",
    "index_version": "v1",
    "backfill_complete": false,
    "partial": true,
    "partial_reasons": ["index_backfill", "ingestion_gap"],
    "gaps": [
      {
        "starts_at": "2026-07-12T03:00:00Z",
        "ends_at": "2026-07-12T03:08:00Z",
        "cause": "connection_unavailable"
      }
    ]
  }
}
```

`searchable_history_starts_at` is the start of the contiguous retained interval currently covered by `index_version`, or `null` when no interval is searchable. `backfill_complete` is true only when that boundary has reached `history_starts_at`. `partial_reasons` contains `index_backfill` while retained history remains unindexed and `ingestion_gap` when a known Ingestion Gap intersects the searched time range; `partial` is true when either applies. Gap fields and causes follow `read_messages`. Coverage describes observed retained history and never certifies that the provider delivered every message.

Each returned candidate is decrypted and verified against plaintext before release. Search results contain no Stored Media metadata, `resource_uri`, `resource_link`, provider URL, public URL, or binary content. Use `read_messages` with the returned Conversation context to access eligible Stored Media. The compact and hard JSON size rules from `read_messages` apply, and quota accounting uses records actually returned. `search_messages` shares `READ_MESSAGE_RECORDS_PER_DAY` with `read_messages`; request-frequency quotas are unchanged.

## Stored Media Resources

Requires `messages:read`. Ready Stored Media no larger than 16 MiB (`16,777,216` bytes) uses this custom URI template:

```text
whatsapp-media://connections/{connection_id}/messages/{message_id}/media/{media_id}
```

`read_messages` returns each eligible concrete URI both in its structured media object and as an MCP `resource_link`. Ready media above the limit remains `ready` and retains its metadata, but returns `resource_uri: null`, `resource_unavailable_reason: "too_large_for_mcp"`, and `resource_size_limit_bytes: 16777216`. The MVP does not expose chunks, ranges, or an alternate download URL. `resources/list` returns an empty list rather than a bulk media inventory. `resources/templates/list` exposes only the template above and only to an authorization with `messages:read`.

For every `resources/read`, the server:

- Strictly parses the complete URI and rejects extra path, query, fragment, or encoded traversal syntax.
- Rechecks `messages:read`, the selected connection, and the connection-message-media ownership chain against current Neon state.
- Creates an Activity Log and reserves the media's full size from its integrity-protected, queryable verified plaintext-byte field before decrypting content or encrypted metadata.
- Returns only `ready` media no larger than `16777216` bytes with its normalized MIME type, sanitized filename metadata when one exists, binary `blob`, `cacheScope: private`, zero cache TTL, and HTTP `Cache-Control: no-store`.
- Uses the same resource-not-found response for unknown, unauthorized, deleted, non-ready, over-limit, or cross-linked handles.
- Never returns a provider URL, public R2 URL, presigned URL, or directly fetchable HTTPS resource.

## `send_text_message`

Requires `messages:send`. The destination is a required `recipient_id` containing either a `ctc_` or `grp_` handle owned by the explicit `connection_id`. A WhatsApp Recipient does not need an already-observed WhatsApp Conversation. The tool does not accept `conversation_id`, a raw phone number, or a provider identifier.

For an unbound new-send request, the handle must be marked as an active non-deleted contact or currently joined group in the latest Directory projection. Unknown, removed, unjoined, and connection-mismatched handles then return the same `isError: true` result with `error_code: "recipient_not_found"` and `retryable: false` before quota reservation or operation creation. Passing this projected check does not guarantee provider routability, and the tool makes no live recipient preflight call.

Input fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `connection_id` | `con_` handle | yes | Explicit selected WhatsApp Connection. |
| `recipient_id` | `ctc_` or `grp_` handle | yes | Contact or group owned by that connection. |
| `text` | string, 1-4,096 Unicode scalar values | yes | Exact outbound text containing at least one value outside Unicode 17.0 `White_Space`. |
| `idempotency_key` | string matching `^[A-Za-z0-9_-]{21}$` | yes | Caller-generated NanoID-default-alphabet retry identity governed by ADR 0006. |

Text validation occurs before quota reservation or Send Operation creation. The decoded string must be a sequence of Unicode scalar values, so unpaired UTF-16 surrogates are rejected. Length counts that scalar sequence, and the nonblank check uses Unicode 17.0's `White_Space` property. The server does not trim, normalize, or truncate valid text; leading and trailing whitespace, line breaks, and Unicode normalization form are preserved. Pending Send Content and the request fingerprint use the exact UTF-8 encoding of that validated sequence.

Validation and execution precedence is fixed:

1. Validate the closed input schema and Unicode rules.
2. Check the current grant, `messages:send` permission or scope, and requested connection grant.
3. Resolve the same-authorization idempotency binding. Return an exact replay or `idempotency_conflict` before current health, Directory, or quota checks.
4. Only for an unbound key, require `connected` state, projected recipient eligibility, and available quota, then atomically create the attempt.

Only a WhatsApp Connection currently in `connected` state may create a Send Operation. `connecting`, `disconnected`, `reconnect_required`, and `degraded` return `isError: true` with `error_code: "connection_unavailable"` and `retryable: true` before quota reservation or operation creation.

The tool advertises:

```json
{
  "annotations": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "_meta": {
    "anthropic/requiresUserInteraction": true
  }
}
```

The Anthropic extension requests mandatory person-facing confirmation in supporting Claude clients; other approved MCP Clients are responsible for equivalent Client Confirmation. Every invocation requires Client Confirmation, including an exact idempotent replay and a retry after an unbound preflight rejection. `retryable: true` describes whether a later invocation could succeed and never authorizes an automatic outbound tool invocation. Standard annotations remain untrusted hints, and neither mechanism is a server-verifiable security boundary. The tool has no `confirmed` input and performs no server-side elicitation.

`send_text_message` and `get_send_status` use the same normalized `status` enum:

| Status | Meaning |
| --- | --- |
| `processing` | The platform has durably claimed this one attempt and its single provider call has not reached a known outcome. |
| `accepted` | The provider acknowledged or queued the message; recipient delivery is not established. |
| `sent` | The provider reports the message sent onward but not yet delivered. |
| `delivered` | The provider reports delivery to the recipient device. |
| `read` | The provider reports that the recipient opened the message. |
| `failed` | Available evidence currently establishes a definitive failure. |
| `unknown` | The provider may have accepted the attempt, but the platform cannot establish whether it did. |

Provider status strings and numeric codes are never returned. Send Status converges by evidence strength rather than event arrival order: positive progression may skip stages and never regresses; `failed` may replace `processing`, `accepted`, or `sent` but not `delivered` or `read`; later exactly correlated positive evidence may correct `failed`; and `unknown` may reconcile to exactly correlated `accepted`, `sent`, `delivered`, `read`, or `failed`, never back to `processing`. Stale or weaker evidence is ignored. An `unknown` operation is never retried automatically.

For a new send, one Neon transaction creates the Activity Log, Send Operation, idempotency binding, and quota reservation and sets `status: "processing"`, `attempt_claimed_at`, and `lease_expires_at` 30 seconds later. That commit is the durable provider-attempt boundary. Before commit, failure rolls back the operation, binding, and quota and returns `isError`; after commit, quota remains consumed and every observable outcome is an operation receipt. The Worker returns the committed `processing` receipt without waiting for provider latency and attaches one 15-second provider call to its execution context. That deferred attempt remains alive after the MCP response and uses an isolated database connection once the request connection scope closes. Its complete direct response is causally bound and may advance the operation without a provider message identifier; later or independently delivered webhook evidence may advance it only through ADR 0017's exact same-connection/shared-stable-identifier correlation. Lease expiry atomically changes `processing` to `unknown`; no caller can take over or redispatch it, and a concurrent exact replay returns the current receipt immediately.

After a Send Operation crosses the atomic durable provider-attempt boundary, every status is returned as a successful structured operation receipt. This includes `failed` and `unknown`; presenting either as `isError` could encourage a second real-world send. `isError` is reserved for requests rejected before that commit, such as invalid input, failed authorization, an unavailable connection, or exhausted quota.

`send_text_message` returns:

```json
{
  "send_id": "snd_P3v...21-characters",
  "status": "accepted",
  "created_at": "2026-07-30T12:00:00Z",
  "status_changed_at": "2026-07-30T12:00:01Z",
  "idempotent_replay": false
}
```

`idempotent_replay` is `true` when the same grant repeats the same `idempotency_key`, `connection_id`, `recipient_id`, and exact text and receives the existing Send Operation. For an API Key, the grant identity is the same across REST and MCP. A replay never consumes send quota or invokes the provider again. The receipt does not echo text, recipient or connection handles, the idempotency key, provider identifiers, or a Stored Message handle.

After schema validation and current grant, permission or scope, and connection-grant checks, the server resolves a retained idempotency binding before checking health, projected recipient eligibility, or quota for a new send. An exact replay therefore returns its current receipt even if the connection later disconnected or the recipient projection changed. For schema-valid input on a currently granted connection, reusing a bound key with different `connection_id`, `recipient_id`, or exact text returns `isError: true`, `error_code: "idempotency_conflict"`, and `retryable: false`, without resolving the replacement recipient. Malformed input fails schema first, and an ungranted requested connection fails authorization before binding lookup. Only an unbound key proceeds through current new-send preflight and quota reservation.

The Send Operation and its idempotency binding have a storage and replay-protection maximum of 90 days after `created_at`, independently of Message Retention Policy. Status and replay additionally require the originating grant to remain active; MCP Authorization revocation or absolute session expiry and API Key revocation or expiry end access immediately. A later authorization or replacement API Key does not inherit earlier operations. Connection or Personal Account Deletion removes them sooner. After ordinary operation expiry, `send_id` is not found and the old key is unbound; submitting that key again creates a new Send Operation. Clients must generate one fresh key per send intent and use replay only while both the binding and originating grant remain active. Every MCP invocation still receives a separate Client Confirmation.

Exact outbound text is retained in active application state as encrypted Pending Send Content only until the earliest of Stored Message creation, definitive pre-send failure, seven days after `created_at`, the Message Retention Policy deadline, or Connection or Personal Account Deletion. For a finite policy duration `D`, `pending_expires_at = min(created_at + 7 days, created_at + D)`; retain-until-deletion contributes no earlier policy deadline, so the seven-day cap still applies. Stored Message creation consumes the pending content, and pre-send failure removes it immediately. After content expires, the 90-day binding retains only a keyed, non-reversible fingerprint of the authorization, connection, recipient, and exact UTF-8 text for idempotency comparison; `accepted` and `unknown` statuses may outlive readable content. Encrypted remnants may remain only inside Neon's managed seven-day PITR history, and restore expiry gates prevent them from becoming application-readable again.

A direct provider response can update its causally bound Send Operation without a provider message identifier, but it can create an outbound Stored Message only when it carries trusted stable message identity plus content or still-retained Pending Send Content. Independently delivered evidence can associate with an operation only through the same connection and an exact stable provider message identifier that the adapter has verified is shared by both payload types. The encrypted identifier and its connection- and namespace-scoped keyed equality index remain with the operation; recipient, text, timestamp proximity, status order, and apparent candidate uniqueness are never sufficient.

An authenticated outbound upsert creates or updates a Stored Message only when it carries its own trusted stable provider message identifier. Without shared identity it remains independent of any Send Operation. A stronger content-bearing upsert or edit overrides Pending Send Content. If identity-only `sent`, `delivered`, or `read` evidence arrives after pending content was removed, including after a corrected `failed`, it updates only the Send Operation; no readable Stored Message is created until a content-bearing identity-bearing upsert arrives before the Message Retention Policy deadline. Text is never reconstructed from the request fingerprint. `processing`, `accepted`, unresolved `unknown`, and failures before qualifying evidence remain operation-only, while a later failure does not remove a message already established by stronger evidence. Disconnection prevents new sends but does not block convergence of items already queued for ingestion or authenticated, exactly correlated late evidence for retained operations.

## `get_send_status`

Requires `messages:send`. It reads the latest locally converged state of a Send Operation created by the same still-active grant and does not call the provider.

Input fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `connection_id` | `con_` handle | yes | Explicit selected WhatsApp Connection. |
| `send_id` | `snd_` handle | yes | Send Operation created by this grant for that connection. |

It returns:

```json
{
  "send_id": "snd_P3v...21-characters",
  "status": "delivered",
  "created_at": "2026-07-30T12:00:00Z",
  "status_changed_at": "2026-07-30T12:01:14Z"
}
```

`status_changed_at` reports when the currently returned state was established, not when the lookup occurred. Unknown, unauthorized, differently authorized, deleted, and connection-mismatched send handles share one not-found boundary.
