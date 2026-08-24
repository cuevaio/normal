# Provider-neutral WhatsApp seam

`@whatsapp-mcp/wasender` is the internal replacement seam around the sole
private-beta provider. It exports no catch-all barrel and has seven independent
Effect capabilities:

- `SessionLifecycle` is account-authority lifecycle control.
- `SessionDirectory` is read-only, per-session Directory authority.
- `TextSending` performs one per-session text-send attempt.
- `PdfSending` uploads one verified PDF and performs at most one document-send attempt.
- `ImageSending` uploads one verified JPEG or PNG and performs at most one image-send attempt.
- `MediaRetrieval` reads per-session metadata and guarded Effect streams.
- `WebhookNormalization` turns one authenticated delivery into independently
  processable provider-neutral items.

Production implementations are supplied by capability-specific modules. The
text, PDF, and image send implementations fix the provider endpoints and
platform transport in production. The real Directory
implementation is exported as
`makeWasenderSessionDirectory` from `@whatsapp-mcp/wasender/session`. The other
production implementations are exposed through their capability-specific
modules. The seam does not add runtime provider selection or a selectable fake.
The lifecycle implementation closes over the account-level Provider API
Credential, a stable locator HMAC key, and a Webshare proxy selector in
provider-control; none is a capability input or output, and no runtime setting
can select a fake or alternate provider origin. The selector accepts only the
complete Colombian Backbone inventory and returns a redacted SOCKS5 URL for one
unused static ISP proxy.
Provider-control publishes that capability only as closed Cloudflare RPC
methods on its service-binding entrypoint. Each input is validated before the
credential-backed Layer is loaded, adapter failures cross as content-free
provider-control results, and lifecycle methods are not HTTP routes. Create,
proxy-aware reconcile, repair, and reconnect validation run through the one
named Durable Object representing the deployment's proxy pool so their
read-then-write allocation cannot race across Worker isolates. The gate stores
only an opaque setup marker and settlement deadline while a proxy-changing write
is unresolved; it stores no assignment or credential data. Disconnect, deletion, QR reads, and number
verification remain direct provider-control RPC methods. The
account-level credential never crosses the binding. Because Effect `Redacted`
instances intentionally do not serialize their hidden values, provider-control
unwraps only the newly issued per-session authority into the RPC value; the API
must immediately restore the redaction boundary and envelope-encrypt that value
before persistence.
The WhatsApp Number required for creation crosses the seam only as a `Redacted`
value. Newly provisioned or adopted per-session authority is returned only as a
log-safe `Redacted` value so the owning Worker can envelope-encrypt it before a
per-session Layer uses it.

The lifecycle adapter calls the documented account endpoints at the fixed
`https://www.wasenderapi.com` origin. Creation uses the deterministic Connection
Setup marker as the provider name, always disables provider message logging
and automatic incoming-message reads, and explicitly keeps group webhook
delivery enabled. The five-minute reconciliation may repair only this complete
safe webhook configuration through the lifecycle-write policy. It verifies the
repair with a fresh provider read before reporting the configuration healthy.
Provider numeric identifiers become
domain-separated HMAC locators; resolving a locator therefore performs a
bounded account list instead of exposing or embedding the raw identifier. A QR
payload is rendered immediately to SVG bytes and the payload is not retained.
List and detail reads enforce the safe-read retry and response limits, while
create, connect, disconnect, and delete perform one write attempt. Disconnect
uses the provider's distinct lifecycle endpoint and retains the provider
session; it never delegates to delete. The owning lifecycle workflow reconciles
the deterministic Connection Setup marker before every connect or disconnect
write and reconciles again after an ambiguous result. Delete reconciles both
before and after a write and returns `present` until a later reconciled attempt
observes absence.

## Boundary values

Provider payloads enter only the webhook normalizer as bytes. Raw provider
payloads, event names, status strings, identifiers, URLs, credentials, and
transport failures are not contract values. Adapter-produced locators,
identities, and versions are opaque tokens; a concrete adapter must generate a
protected equality or routing value rather than returning a raw provider
value. Session authority and media sources cross the seam only as Effect
`Redacted` values. The owning Worker immediately envelope-encrypts them before
persistence and supplies plaintext only to the applicable adapter Layer.
Failures use the closed `ProviderNeutralFailure` classification and contain no
free-form message, cause, URL, response body, or provider identifier. Its retry
decision is operation-specific rather than a generic retryable flag. Guarded
media stream failures use that same typed error channel, so a late transport
failure cannot escape through an untyped native stream error.

Webhook normalization returns one result per logical item. Unsupported and
malformed items are classified in place, allowing valid siblings from the same
delivery to continue independently. Every supported item carries an opaque
stable or semantic-fallback identity for downstream deduplication. Provider
version tokens remain opaque; ingestion asks the normalization capability to
compare them instead of learning provider version syntax or ordering rules.
Message upserts without readable text or one of the supported media shapes are
unsupported provider items: they are quarantined by the ordinary ingestion path
and never create a Stored Message or WhatsApp Conversation.

## Webhook normalization

`importWebhookIdentityKey` accepts at least 32 bytes and imports a non-extractable
HMAC-SHA-256 key. The API composition that owns a WhatsApp Connection must
generate this key from a cryptographically secure random source, envelope-encrypt
it with that connection's data, and use
`makeWasenderWebhookNormalizationLayer` only after decrypting it. A key is scoped
to one WhatsApp Connection. It is not a global environment variable, Wasender
credential, or OpenTofu input, and it must never be logged.

The normalizer implements the reviewed Wasender shapes for `messages.upsert`,
the incoming-message variants, `message.sent`, `messages.update`,
`messages.delete`, `message-receipt.update`, `contacts.upsert`,
`contacts.update`, `groups.upsert`, `groups.update`, and `session.status`.
Documented object and array forms are accepted where Wasender has emitted both.
Each element keeps its provider position as `itemIndex`; one malformed element
does not change the indices or results of its valid siblings. Unsupported event
families become `unsupported` items instead of entering the Message Store.

Provider message, recipient, contact, group, and item identities are converted
to connection-keyed HMAC tokens before they cross the adapter boundary. Media
download/decryption material crosses only as an Effect `Redacted` value.
Occurrence evidence is normalized to UTC, authenticated inside an opaque
adapter version token, and compared only through `compareVersions`. The same
logical item therefore receives the same identity when Wasender retries it,
duplicates it in one batch, or regroups it with different siblings. The
normalizer does not correlate sends by recipient, content, timestamp, or
candidate uniqueness.

Wasender status codes map as follows: error to `failed`, pending to `accepted`,
sent to `sent`, delivered to `delivered`, and read or played to `read`. Session
states map to the domain's connected, connecting, disconnected,
reconnect-required, and degraded states. A contact LID is never guessed to be a
phone number; only an explicit number or a phone-number JID can populate the
internal Directory phone value.

Safe telemetry may report only the operation class, normalized item kind or
classification, item count, byte count, duration, and outcome. Never log the
payload, normalized content, provider event name, opaque identities, protected
versions, phone numbers, or redacted media source. A `response_too_large`
failure is permanent; cryptographic/runtime failures defer to the bounded
ingestion retry policy.

The test fixtures record the Wasender documentation reviewed for each supported
shape. When the vendor changes a schema, add a reviewed fixture and preserve
the existing item classifications until the change is deliberately supported;
do not edit encrypted source during operator replay.

## Operation policies

Lifecycle list, QR, and reconciliation plus Directory synchronization use the
safe-read policy. Lifecycle create, connect, and delete use the lifecycle-write
policy. The other capabilities use their named policy directly.

| Class | Attempts and timeout | Ambiguity and reconciliation | Response bound |
| --- | --- | --- | --- |
| Safe JSON read | At most three jittered 10-second attempts within 25 seconds | Safe to repeat; retries network failures, 408, 429, and 5xx | 1 MiB |
| Text send | One 15-second attempt | Acceptance may be unknown; reconcile only through exact identity-bearing evidence | 1 MiB |
| PDF send | One bounded upload, then at most one 15-second document-send attempt | Upload failure before send is definitive; send acceptance may be unknown and is never retried | 1 MiB per JSON response |
| Image send | One upload with an exact maximum of 5,000,000 verified bytes, then at most one 15-second image-send attempt | Upload failure before send is definitive; send acceptance may be unknown and is never retried | 1 MiB per JSON response |
| Lifecycle write | One 15-second attempt before reconciliation | Reconcile provider state before any repeat | 1 MiB |
| Media metadata | One 30-second attempt | Safe to repeat, but no implicit retry schedule | 1 MiB |
| Guarded media download | One 60-second attempt | Discard partial bytes; a later attempt restarts at byte zero | Caller bound, at most 100,000,000 bytes |

Safe reads honor `Retry-After` only up to five seconds and only while the
three-attempt, 25-second wall-clock budget remains. Other operation classes do
not gain retries from `Retry-After`. A media caller supplies a validated
positive integer byte limit no greater than the largest ADR 0008 ingestion
limit; the implementation counts streamed bytes rather than trusting
`Content-Length`.

The seam deliberately provides no message-information polling capability:
`get_send_status` is a local domain read and never invokes the provider.

The text-send adapter posts the domain-resolved provider identity and exact
validated text to Wasender once. The documented `in_progress` direct response
is only provider acknowledgement: its numeric `msgId` is not the stable
WhatsApp message identity shared with webhook evidence. Identity-bearing
evidence requires an outbound `key.id` bound to the exact resolved recipient;
the adapter returns only a connection-keyed HMAC of that identifier. A
timeout, lost connection, `408`, `5xx`, oversized or malformed response, or
unverifiable identity is ambiguous and is never retried. Complete
authentication, recipient, provider, and throttling rejections are definitive.
For a Direct Address username, a response that resolves the alias to a phone or
LID JID is acknowledgement-only because the provider does not document that
alias mapping as stable identity. It may advance the causally bound operation to
`accepted`, but cannot materialize Pending Send Content as a Stored Message.

The PDF- and image-send adapters receive only already verified, snapshotted
bytes and the domain-resolved provider identity. Each performs one bounded
upload and keeps the returned provider URL inside the adapter for at most one
send request; that URL is never a capability result or persisted value. The
image adapter also receives the signature-derived `image/jpeg` or `image/png`
MIME and an optional exact validated caption. Its send result follows the same
stable-identity and ambiguity classifications as text sending. Identity-only
evidence may advance the causally bound Send Operation, but downstream
projection must materialize an image caption only together with the retained
image or stronger media-bearing evidence.

Adapter telemetry may contain only the operation class, normalized outcome,
upload and send attempt counts, duration, and bounded byte counts. It never
contains capability inputs or outputs, message text or captions, image MIME,
full phone numbers, opaque references, encrypted adapter values, raw response
data, URLs, or credentials.

## Production media retrieval

The real `MediaRetrieval` Layer uses the per-session authority only for the
30-second `POST https://www.wasenderapi.com/api/decrypt-media` metadata call.
The encrypted provider message and the returned one-hour download URL remain
inside versioned Effect `Redacted` adapter values. The download request never
forwards the session authority.

`www.wasenderapi.com` is the only approved metadata and download hostname and
is deliberately not configurable. Before every request, including every
same-host redirect, the adapter resolves both address families through bounded
DNS-over-HTTPS requests and rejects empty answers or any non-global, private,
loopback, link-local, transition, benchmarking, documentation, multicast, or
reserved address. Fetch redirect handling is manual and limited to three
same-host redirects.

Metadata responses are read and counted up to 1 MiB. Downloads are streamed,
count actual bytes independently of `Content-Length`, cancel the response at
the caller's validated hard limit, and use a typed stream failure so partial
bytes are discarded and any later attempt starts at byte zero. The 60-second
budget covers DNS resolution, redirects, response setup, and complete stream
consumption. Production construction validates a non-empty printable session
authority and exposes no runtime fake or host override.

## Wasender Directory implementation

The production Directory adapter calls Wasender's documented paginated
`GET /api/contacts` and `GET /api/groups` endpoints at the fixed
`https://www.wasenderapi.com` origin. It closes over exactly one redacted
session API key and sends that value only as the Bearer credential for those
per-session requests. No account-level PAT is accepted by the constructor or
read methods.

Each HTTP body and the aggregate normalized observation are limited to the
safe-read 1 MiB bound. The adapter validates the documented success envelope,
item shapes, and pagination evidence before normalizing names, available phone
numbers, and current membership. Provider JIDs, profile URLs, statuses, and
other provider-only fields are discarded. Recipient locators are stable,
authenticated sealed values derived within the per-session adapter; the raw
JID is not the locator runtime value and does not cross the seam.

An observation is `complete` and fresh only after every provider-declared page
fits within the three-attempt, 25-second operation budget and passes validation.
If at least one page is valid but a later page fails, exceeds the aggregate
bound, or cannot fit in that budget, the available entries are returned as a
`partial`, stale observation. A failure before any trustworthy page, or an
authentication or integrity failure on any page, fails the Effect with the
closed provider-neutral classification. This uses only evidence Wasender
actually supplies and does not claim provider-certified completeness.

The reviewed fixtures reflect Wasender's contacts and groups documentation as
observed on 2026-07-30: paginated responses use `data.items` plus
`data.pagination` with `total`, `page`, `limit`, and `totalPages`. Because the
vendor does not publish a Directory snapshot timestamp, `observedAt` records
the local receipt time of the latest validated page. A later reconciliation
persists and compares that observation under the domain's projection rules.
No infrastructure binding or platform-wide provider secret is added: ordinary
Directory egress stays in the public API Worker and per-session authority stays
in the existing connection-key envelope boundary required by ADRs 0002, 0004,
and 0007.
