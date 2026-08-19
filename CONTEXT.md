# Normal

This context defines the shared language for a personal platform that exposes a connected WhatsApp account to approved AI clients.

## Language

**User**:
A person who can sign in to the platform and owns one Personal Account.
_Avoid_: Customer, member

**Personal Account**:
The tenant and data-ownership boundary for one User. A Personal Account is not shared with other Users, can retain up to three WhatsApp Connections, and can retain up to 5 GB of Stored Media across them.
_Avoid_: Organization, workspace, team

**Personal Account Deletion**:
The irreversible removal of a Personal Account after all access is revoked and every Connection Setup and WhatsApp Connection enters deletion. It can be requested in the product or triggered by deletion of the owning Clerk identity, and a later signup creates a new Personal Account.
_Avoid_: Sign out, Connection Deletion

**WhatsApp Connection**:
A provider-backed connection to one WhatsApp account, owned by one Personal Account.
_Avoid_: WhatsApp session, provider session

**Disconnected WhatsApp Connection**:
A WhatsApp Connection that cannot start new sends or maintain expected ongoing ingestion but retains historical data for authorized reads under its Message Retention Policy and can be reconnected. Items already accepted into ingestion and authenticated late evidence for retained Send Operations still converge after disconnection.
_Avoid_: Deleted connection

**Connection Deletion**:
The permanent removal of a WhatsApp Connection, including revocation of its MCP access and erasure of its provider session, keys, Stored Messages, and Stored Media. Access and key use stop immediately, active data is purged within 24 hours, encrypted backup remnants expire within 30 days, and a deleted connection cannot be reconnected.
_Avoid_: Disconnect, archive

**Deletion Continuation**:
The terminal period of Connection or Personal Account Deletion after access and key use have stopped but before provider cleanup and active-data purge are complete. Only opaque lifecycle evidence and WhatsApp Number reservation evidence remain available during this period, including after a restore; they are removed after cleanup is confirmed.
_Avoid_: Active account, recoverable deletion

**Connection Setup**:
The 15-minute flow in which a User enters a WhatsApp Number and scans its QR code to create a WhatsApp Connection. QR data is ephemeral and never retained; an incomplete Connection Setup expires and its provisional provider resources are removed.
_Avoid_: QR-only setup

**WhatsApp Number**:
The phone number of the WhatsApp account behind a WhatsApp Connection. A WhatsApp Number can back at most one Connection Setup or non-deleted WhatsApp Connection across the platform, and remains reserved through disconnection or cleanup until its provider session is confirmed removed.
_Avoid_: Session number

**Provider Account**:
An internal platform-owned account used to provision WhatsApp Connections. A User does not create, supply, or manage a Provider Account.
_Avoid_: User provider account, tenant

**Provider API Credential**:
An internal secret used to provision or operate a WhatsApp Connection. Provider API Credentials are never exposed to Users or MCP Clients.
_Avoid_: User API key

**API Key**:
A User-created, revocable credential for a server-side automation or compatible MCP Client to call Normal's public REST API or MCP endpoint on behalf of one Personal Account. An API Key used through MCP remains an API Key and never becomes an MCP Authorization. Each API Key grants an explicitly selected set of WhatsApp Connections and independently selected permissions for connection metadata, the WhatsApp Directory, Stored Messages, and outbound sends; Connections added later are not included automatically.
_Avoid_: Provider API Credential, MCP Authorization, browser token

**MCP Client**:
An external AI application that invokes the platform's WhatsApp tools on a User's behalf.
_Avoid_: Agent, integration

**MCP Authorization**:
A revocable grant allowing one MCP Client to access an explicitly selected set of WhatsApp Connections with separate permissions for connection metadata, the WhatsApp Directory, Stored Messages, and outbound sends. Connections added later are not included automatically, and send permission never implies message-read permission.
_Avoid_: Account-wide access, API key

**Client Confirmation**:
A human confirmation presented by an MCP Client before every outbound messaging tool invocation, including an idempotent replay or retry after a preflight rejection. The platform describes and, where supported, requests this interaction through tool metadata, but does not provide a separate approval step or treat Client Confirmation as an independently verified security boundary.
_Avoid_: Send Approval, web approval

**Send Operation**:
The durable record of one attempt to send an outbound WhatsApp message, which can begin only while its WhatsApp Connection is connected. A Send Operation becomes an outbound Stored Message only when trusted identity-bearing evidence establishes that the message was sent or exists in the WhatsApp chat. A Send Operation has an unknown outcome when the provider may have accepted the message but did not confirm it; an unknown Send Operation is never retried automatically. Send Operations and their replay protection remain for 90 days unless Connection or Personal Account Deletion removes them sooner.
_Avoid_: Retryable send

**Pending Send Content**:
The exact outbound text retained temporarily in active application state while a Send Operation awaits evidence that can make it a Stored Message. It can supply Stored Message content while retained, is discarded immediately after a definitive pre-send failure, and otherwise expires at the earliest of seven days after operation creation, its Message Retention Policy deadline, or Connection or Personal Account Deletion; replay protection after discard retains no readable text.
_Avoid_: Stored Message, 90-day send history

**Send Status**:
The platform's best known state of a Send Operation: processing locally, accepted by the provider, sent onward but not known delivered, delivered, read, failed according to current evidence, or unknown because provider acceptance is ambiguous. Send Status converges by evidence strength rather than event arrival order; accepted and sent do not mean delivered, and provider-specific status names are not Send Statuses.
_Avoid_: Provider status, guaranteed delivery

**Activity Log**:
The User-visible audit history of protected operations made through MCP Authorizations and API Keys and their outcomes. It identifies the access channel and responsible MCP Client or API Key, contains operational metadata and opaque references rather than copied message content, media, credentials, full phone numbers, or provider payloads, and is retained for 90 days.
_Avoid_: Tool Call Log, approval queue

**Security Record**:
An unlinkable record derived from a security-relevant authorization or protected-operation event during Personal Account Deletion. It retains only event category, allowlisted client class, outcome, counts, timing, and latency until the source event's original 90-day expiry, with no User, account, connection, authorization, network, message, contact, or provider reference.
_Avoid_: Activity Log, account history

**WhatsApp Conversation**:
A direct chat or group chat within one WhatsApp Connection.
_Avoid_: Thread

**WhatsApp Recipient**:
A contact or joined group marked active in the latest WhatsApp Directory projection for one WhatsApp Connection and therefore eligible for an outbound attempt. A WhatsApp Recipient can exist before the platform observes a WhatsApp Conversation and is addressed by its Directory identity rather than a raw phone number or provider identifier; projection staleness means provider routability is not guaranteed.
_Avoid_: Conversation, raw destination

**WhatsApp Recipient Exclusion**:
A User-owned rule, scoped to one WhatsApp Connection and one WhatsApp Recipient, that stops Normal from tracking that recipient. While it applies, the recipient is absent from every MCP Directory, chat, message, and Stored Media result, a new Send Operation to it is rejected as recipient not found, and no provider observation for it creates a WhatsApp Conversation, Stored Message, Stored Media, or readable Pending Send Content. Setting one purges the recipient's existing Message Store history and records a permanent purge cutoff that survives a database restore; removing one permits only future observations and future sends and never restores purged history. The WhatsApp Directory projection for the recipient is retained so the User can still recognize and manage it.
_Avoid_: Block, mute, hidden contact, display filter

**Conversation Activity**:
The latest inbound or outbound Stored Message in a WhatsApp Conversation. Directory changes, receipts, reactions, and other provider events do not count as Conversation Activity.
_Avoid_: Unread activity, provider chat update

**WhatsApp Directory**:
The connection-scoped projection of WhatsApp contacts and groups used by MCP tools. The provider remains the source of truth; Directory results disclose when the projection is partial or stale.
_Avoid_: Address book, source of truth

**Message Store**:
The persisted history of all supported inbound and outbound chat messages observed after a WhatsApp Connection becomes active. Statuses, newsletters, calls, and unrelated system events are outside the Message Store.
_Avoid_: Provider message log

**Message History Window**:
The period for which a WhatsApp Connection has available Stored Messages, beginning no earlier than Connection Setup and bounded by Message Retention Policy. It does not imply that earlier WhatsApp history never existed.

**Ingestion Gap**:
An evidence-based interval in a Message History Window during which one or more provider deliveries may be missing. Reads disclose intersecting Ingestion Gaps and describe history as observed rather than provider-certified complete; the absence of a known gap does not prove that the provider delivered every message.

**Stored Message**:
An inbound or outbound WhatsApp chat message in the Message Store that belongs to one WhatsApp Conversation. An outbound send attempt is not a Stored Message until trusted identity-bearing sent-or-stronger evidence with retained content, or an authenticated identity-bearing outbound upsert, establishes that it exists in the chat; Stored Messages retain only the latest verified content after an edit.
_Avoid_: Webhook Event

**Deleted Message Tombstone**:
The non-content record left after WhatsApp reports a message deletion. It can exist before the original message is observed, preserves conversation ordering and deduplication, and permanently prevents a late provider delivery from restoring message body or Stored Media.
_Avoid_: Stored Message content

**Stored Media**:
An image, audio file, video, document, or sticker securely retained for one Stored Message and made available only to authorized readers of that message when the delivery channel can safely carry it. Stored Media is pending while processing, ready only with a verified byte size and normalized MIME type after structural checks, rejected when it violates policy, or failed when processing cannot establish required metadata; readiness does not guarantee MCP readability, malware safety, or recovery after loss of the primary object.
_Avoid_: Public media URL, provider media URL

**Webhook Event**:
The original provider delivery received for one WhatsApp Connection. A Webhook Event can contain one or many Webhook Items and is retained temporarily for audit and normalization, then removed while its non-reversible deduplication fingerprints remain.
_Avoid_: Stored Message

**Webhook Item**:
One logical provider change carried by a Webhook Event, such as one message, deletion, Directory update, or connection-state change. Each Webhook Item is handled independently when a provider delivery contains several changes.
_Avoid_: Webhook Event, batch

**Message Retention Policy**:
The User's rule for how long Stored Messages, Stored Media, and Pending Send Content remain available in active application state. The default is 30 days; a User can choose a shorter period or explicitly retain messages until deletion, while Pending Send Content uses operation creation as its deadline anchor and always has a separate seven-day maximum.
_Avoid_: Permanent retention by default
