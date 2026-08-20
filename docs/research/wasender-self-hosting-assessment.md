# WasenderAPI Self-Hosting Assessment

- **Decision status:** Phase 0 evidence collection approved; non-production technical pilot pending legal, policy, license, and supply-chain gates; production replacement not approved
- **Research cutoff:** 2026-07-30
- **Internal repository snapshot:** `a7e2469` (rechecked 2026-07-31 after the concurrent Connection Setup provisioning merge)
- **Targets evaluated:** 100, 1,000, and 10,000 simultaneously connected WhatsApp accounts
- **Tier interpretation:** The targets are fleet-wide WhatsApp Connections, not per-Personal-Account limits. One Personal Account can retain at most three Connections and has an exact 5 GiB (`5368709120`-byte) Stored Media ceiling shared across them. [I9]
- **Scope:** Replace WasenderAPI while retaining QR-linked WhatsApp accounts, ordinary direct and group conversations, and the repository's provider-neutral behavior

## Executive Decision

Do not replace WasenderAPI in production today. Approve Phase 0 evidence collection for three potential benchmark implementations:

1. A thin gateway built directly on Baileys.
2. A thin gateway built directly on whatsmeow.
3. A source-built WAHA NOWEB-only variant that excludes GOWS and unused engines, if its legal and supply-chain gates can first be satisfied, as the packaged-server baseline.

If the pilot passes all gates, prefer the thinner of the Baileys or whatsmeow gateways. It should expose only the repository's five existing capabilities rather than becoming a general WhatsApp API platform. WAHA remains a documentary packaged-server comparison unless its conflicting license metadata is resolved in writing and a reviewed, reproducible NOWEB-only image can be built without GOWS. If those prerequisites pass, it may enter the technical benchmark, but production still requires demonstrated multi-worker ownership and durability under failure.

This recommendation is conditional for five reasons:

- WhatsApp's own unofficial-app FAQ says that using unofficial apps or linking an account to an unofficial version violates its Terms, and the ordinary WhatsApp Terms separately restrict unauthorized automated and non-personal use. That makes counsel review and explicit executive risk acceptance a prerequisite for Wasender and every parity-preserving unofficial alternative, not merely a library-license check. [L1] [L2]
- WasenderAPI now states that it manages underlying Baileys socket connections. A Baileys gateway is therefore the closest disclosed substrate, although Wasender does not disclose its version, fork, topology, storage, or recovery implementation. [W12]
- Direct WebSocket libraries avoid a Chromium process per account and are the most credible economic shape at 10,000 connected accounts. That is an architectural inference, not a measured capacity claim. Per-session RSS, CPU, database I/O, and reconnect behavior still need to be measured.
- No reviewed library or ready-made server documents or proves safe, highly available operation at 10,000 linked accounts. Multi-session support is not evidence of fenced ownership, durable event delivery, or reconnect-storm control.
- The leading WebSocket options have material legal questions. Baileys is MIT at the top level but depends on GPL-3.0 `libsignal`; whatsmeow is MPL-2.0 and depends on GPL-3.0 `go.mau.fi/libsignal`. Counsel must evaluate the actual linking, modification, hosting, container distribution, and any customer/on-prem distribution model. [B2] [B3] [X2] [X3]

Meta Cloud API should remain a separate strategic option, not a candidate for this drop-in replacement. It is first-party and Meta-hosted, but it uses registered business numbers rather than QR-linked personal sessions. Its Groups API requires an Official Business Account, creates invite-only groups with at most eight participants, and cannot access existing ordinary groups. Business App Coexistence also excludes group synchronization. [M4] [M6] [M8] [M10]

The decision tree is:

```text
Are QR-linked ordinary/Business App accounts and existing groups required?
  No  -> Evaluate a product migration to Meta Cloud API first.
  Yes -> Has counsel approved the exact unofficial linked-device use, governing
         territories, customer terms, and deployment model, and has an executive
         accepted the account-loss and continuity risk?
           No  -> Neither Wasender nor a self-hosted parity implementation is
                  approved. Change the product model or stop offering the
                  linked-device capability.
           Yes -> Has the self-host candidate passed its separate license,
                  security, supply-chain, reliability, and economics gates?
                    No  -> Continue Wasender only under separately documented
                           current-provider risk acceptance and negotiated terms.
                    Yes -> Run a bounded, opt-in migration under the
                           generation-fenced plan.
```

## What Is Known, Claimed, and Unknown

This report uses the following labels:

- **Documented fact:** stated in first-party documentation, source, package metadata, or repository code.
- **Project claim:** stated by a project or vendor but not independently demonstrated here.
- **Inference:** an engineering conclusion drawn from documented facts.
- **Pilot-required:** cannot be decided reliably from public material.
- **Legal question:** source metadata is evidence, but the legal consequence requires counsel.

Marketing statements are not treated as guarantees. In particular, Wasender's built-in queueing, automatic retry, and "zero data loss" wording is not backed by public retry schedules, ordering rules, replay behavior, durability design, or a contractual SLA. [W7] [W12]

## Legal and Policy Scope

This section identifies decision-critical source text; it is not legal advice.

### QR-Linked Ordinary Accounts

WhatsApp's official FAQ states: "Unofficial apps or websites are fake WhatsApp apps, developed by third-parties. Using these apps or linking your WhatsApp account to unofficial versions of WhatsApp violates our Terms of Service. We don't support these apps because we can't validate their security or privacy practices." It also says users may be logged out for using an unofficial app. The ordinary WhatsApp Terms reviewed separately prohibit impermissible bulk or auto-messaging, non-personal use unless authorized, unauthorized automated access, reverse engineering, and unauthorized third-party APIs that function substantially like WhatsApp; they permit account suspension or termination for violations. European Region users are directed to separate terms, so counsel must review the governing territorial versions for the actual account population. [L1] [L2]

This evidence materially increases account-loss, continuity, and legal risk for Wasender and every unofficial QR-linked candidate. It does not by itself resolve whether a particular server, linking flow, topology, or customer use falls within every clause. A candidate project's license, disclaimer, popularity, or technical ability to link an account is not authorization from WhatsApp.

### WABA-Based Business Solution

The WhatsApp Business Solution Terms are a separate instrument for the WABA-based WhatsApp Business Solution and were last modified 2026-03-06. They incorporate the WhatsApp Business Terms, govern Business Solution Data and Third Party Service Providers, and include specific AI Provider restrictions. Those provisions are material to the separate Meta Cloud API redesign, especially because this product serves AI clients, but they must not be applied to ordinary QR-linked accounts without counsel establishing that scope. [L3]

The legal gate must therefore produce two analyses rather than blending terms: one for ordinary or Business App accounts linked through Wasender/candidates, including applicable regional Terms and the unofficial-app guidance; and one for any proposed WABA/Cloud API model, including the Business Solution, messaging-policy, data-use, and AI-provider provisions.

## Required Compatibility

The current codebase has the right five-capability architectural boundary, but it does not have runtime provider selection. `@whatsapp-mcp/wasender` exposes five independent capabilities and prevents raw provider values from crossing them: [I1] [I2]

| Capability | Current `normal` replacement requirement |
| --- | --- |
| `SessionLifecycle` | Deterministic provisioning marker; create, connect, QR observation, reconciliation, duplicate quarantine, and deletion; protected per-session authority; no blind repeat of lifecycle writes. |
| `SessionDirectory` | Complete or explicitly partial contact and joined-group observations; stable protected routing locators; phone/JID/LID handling without guessing that a LID is a phone number. The current contract does not expose group participant membership. |
| `TextSending` | One bounded text-send attempt to a resolved direct or group recipient; definitive rejection vs ambiguous acceptance; stable WhatsApp message identity when evidence exists; no retry of an ambiguous send. The current request has no mention input. |
| `MediaRetrieval` | Protected source values, bounded metadata, streamed download, size and timeout enforcement, and discard/restart from byte zero after a partial failure. |
| `WebhookNormalization` | Authenticated delivery handling outside the capability; normalization of current message upsert/edit/delete and send evidence, contact/group observations, and session state; independently classified batch items; stable deduplication identities and opaque versions. The current normalized types do not expose mentions or participant-change events. |

Those are the production-replacement parity gates for this repository. The adjacent Normal POC is evidence about a possible broader product, not part of the current `normal` contract. It additionally uses outbound and inbound mentions, connected-account phone-JID/LID self-identities, and group participant add/remove/promote/demote events. Those values are absent from `TextSending`, `NormalizedMessageUpsert`, account observation, and the reviewed Wasender normalizer's supported event set. [I2] [I6] [I7] [I8]

If product owners approve that broader scope, implement it as a separately tracked bounded extension to `TextSending`, account observation within `SessionDirectory` or `SessionLifecycle`, and `WebhookNormalization`. Do not silently make optional Normal POC behavior a core replacement gate, add a sixth capability, or build a generic plugin system before that decision.

The replacement must also preserve these established policies: [I1] [I3] [I4] [I5]

- Provider credentials and mutable linked-device auth state are encrypted and never exposed in domain records, logs, URLs, or product contracts.
- Safe reads may retry within the existing bounded policy; lifecycle writes reconcile before repetition.
- A text send gets exactly one attempt. Timeout, lost connection, malformed response, `408`, or `5xx` can be ambiguous and must not trigger an automatic resend.
- Send status is a local converged read. It is never reconstructed by weak matching on recipient, text, or timestamp.
- Message Store history remains authoritative. The transport must not enable its own broad message logging or automatically mark incoming messages read.
- Webhook/event duplicates are normal and must be idempotently absorbed.

This is stricter than feature checklists in most candidate projects. A project that can "send text" is not compatible until it preserves the repository's identity, ambiguity, privacy, and reconciliation semantics.

### Concrete Repository Work

The five interfaces are a usable seam, not a completed multi-provider runtime. The present production composition is Wasender-specific: `provider-control` constructs `makeWasenderSessionLifecycle`, accepts only `WASENDER_API_CREDENTIAL` and `WASENDER_REFERENCE_SECRET`, and declares those secrets in every Wrangler environment. Its closed RPC schemas and an additional RPC output check require a `wsl_` locator. The API has one `PROVIDER_CONTROL` binding. Connection Setup provisioning now persists encrypted provider locator/authority pairs, but the records have no provider kind or generation; the deletion capsule still stores only `sessionLocator`, and the deployment catalog recognizes only `web`, `api`, and `provider-control`. [I11] [I12]

Before a production canary, implement the following bounded changes:

1. Add candidate-specific implementations of `SessionLifecycle`, `SessionDirectory`, `TextSending`, `MediaRetrieval`, and `WebhookNormalization`; keep the existing interfaces and provider-neutral failure classes. The package can retain its current name during the pilot.
2. Keep one private `PROVIDER_CONTROL` surface as the control-plane boundary, but make its composition route from durable connection transition state, not a provider selector supplied by a user or ordinary request. It must address Wasender and the candidate gateway during migration.
3. Replace the Wasender-only `wsl_` lifecycle assumption with a closed provider-neutral locator envelope. Bind `provider_kind` and monotonic `provider_generation` to every lifecycle request/result, encrypted authority, command, and event; validate that the server-selected kind and generation match the durable connection state.
4. Add the long-lived gateway as an explicit deployable with private workload authentication, manifests, secrets/bindings, health checks, and ownership. If it is managed outside Cloudflare, its deployment still belongs in the repository's deployment catalog and validation rather than remaining an undocumented external process.
5. Add durable schema for provider generation, placement, lease epoch, encrypted auth revisions, event outbox sequence, cutover watermark, and drain deadline. Wire the current API ingress and normalizer composition to generation-aware envelopes.
6. Version the deletion capsule so cleanup retains `provider_kind`, `provider_generation`, and the correct provider locator. Existing version-1 Wasender capsules are persisted cleanup evidence and need a bounded reader/migration until their deletion work is complete; cleanup must never resolve a locator against whichever provider happens to be active later.
7. Add composition, contract, manifest, migration, restore, and mixed-generation tests. A superseding ADR should authorize only the bounded transition state described below, not a general plugin marketplace.

This is real adapter and deployment work. Merely standing up WAHA or exposing a library through REST would leave production lifecycle composition, cleanup, ingress, authority, and deployment validation on the Wasender-only path.

## Current Baseline

### WasenderAPI

Wasender is a hosted linked-device service. One session represents one WhatsApp number; QR is the default onboarding method, a session receives its own API key, and the service exposes contacts, groups, messages, media decryption, and webhooks. A July 2026 first-party article says the managed service operates the underlying Baileys sockets, reconnect logic, and state management. [W2] [W3] [W4] [W12]

Public monthly pricing on the research date was: [W1]

| Plan | Connected accounts | Monthly price | Public unit rate at full utilization |
| --- | ---: | ---: | ---: |
| Basic | 1 | USD 6 | USD 6.00/account |
| Pro | 3 | USD 15 | USD 5.00/account |
| Plus | 6 | USD 30 | USD 5.00/account |
| Business | 10 | USD 45 | USD 4.50/account |
| Higher volume | More than 10 | Custom quote | Unknown |

Paid public plans advertise no provider per-message charge and no daily message cap, but that is not unlimited safe throughput. Sending is documented at 256 requests per minute per session for `send-message`, subject to a lower account-protection rate, WhatsApp enforcement, and other endpoint limits. The public material does not disclose the global concurrent-request number. The homepage advertises 15% annual savings, but no custom-tier annual total is public and that discount must not be assumed in `Q_W(S,P)`. [W1] [W6] [W8]

The material facts missing for a scaled service are more important than the feature list:

- No public enterprise price above ten sessions.
- No binding uptime, latency, recovery, or webhook-delivery SLA located.
- No public webhook retry duration, attempt schedule, ordering, replay, dead-letter, duplicate, or queue-durability contract.
- No disclosed Baileys version/fork, credential storage design, topology, session density, or disaster-recovery design.
- No public DPA, data-residency commitment, complete retention schedule, or sanctioned self-host distribution located.

ADR 0004 already makes production launch conditional on written enterprise capacity, data-processing, deletion, security, webhook-authentication, and retry terms. Replacing Wasender does not remove the underlying unofficial-client and WhatsApp-enforcement risk; it transfers all transport operations and more security responsibility in-house. [I3] [W8]

Wasender's privacy policy says it collects message content, recipient information, and usage statistics and may share information with service providers for hosting, processing, analytics, and support. Self-hosting can reduce that vendor data path, but only by making this company directly responsible for credential, contact, message, group, and media controls and their subprocessors. [W9]

### Meta Cloud API

Meta Cloud API is not self-hosted: Meta hosts and maintains the WhatsApp transport. It is a viable first-party redesign for business messaging, not a protocol-compatible Wasender replacement. [M1] [M2]

| Existing requirement | Meta Cloud API result |
| --- | --- |
| QR-link a user's personal WhatsApp account | Fails. Cloud API registers a business number. |
| Preserve a consumer Messenger account and its history | Fails. The consumer account must be deleted before registration. |
| Coexist with a WhatsApp Business App number | Conditional for supported one-to-one traffic through the partner onboarding model. |
| Access that account's existing groups | Fails. Coexistence excludes groups. |
| Create new API-native groups | Conditional on OBA approval; invite-only; at most eight participants; restricted feature set. |
| Preserve free-form messaging behavior | Fails outside the 24-hour customer-service window, where approved templates are generally required. |
| Self-host the WhatsApp transport | Fails. The transport remains Meta-hosted. |

If the linked-device and existing-group requirements are removed, Meta should be reassessed before any unofficial self-hosting project. Its message-based pricing must then be modeled using actual country, category, volume-tier, customer-service-window, and group-recipient delivery data rather than a universal per-account price. [M7] [M9] [M11]

Meta's redesign cost is message-driven, not connected-account-driven. Let `D[c,k,t]` be delivered billable one-to-one templates by country/region `c`, category `k`, and tier `t`; `R[c,k,t]` the effective rate; and `DG[c,k]` the billable deliveries of group messages to individual recipients:

```text
C_meta = sum(D[c,k,t] * R[c,k,t])
       + sum(DG[c,k] * RG[c,k])
       + C_AI_if_applicable
       + C_partner
       + C_application_and_operations
```

One billable group API send can create a charge for each recipient to whom it is delivered. Ordinary non-template service messages inside an open customer-service window are free under the standard model; delivered templates are charged according to the current rules and exceptions. The official group pages contain a conflict about marketing templates inside a group customer-service window, so a forecast should conservatively count them as billable until Meta clarifies it. Meta also publishes a separate 2026 policy for providers of general-purpose AI assistants; counsel and product owners must determine whether it applies before treating standard non-template pricing as complete. [M9] [M11] [M16]

The rate cards reviewed were effective 2026-07-01. Meta had announced market/rate changes for 2026-10-01 while saying final affected rates would be published no later than 2026-09-01, so any forecast crossing October must refresh the official matrices. [M11]

Consequently, 100, 1,000, and 10,000 registered numbers do not produce meaningful Meta totals by themselves. Each scenario needs recipient geography, message category, delivered volume, customer-service-window share, group recipient count, and possible AI-provider applicability.

## Alternatives Matrix

No entry below is production approved. "Parity" means apparent protocol capability, not verified conformance with the repository's semantics.

| Candidate | Runtime and packaging | Apparent parity | Operations evidence | License evidence | Assessment |
| --- | --- | --- | --- | --- | --- |
| Thin Baileys gateway | TypeScript library; direct WebSocket; no browser; custom service required | Closest disclosed Wasender substrate; QR/pairing, messages, mentions, groups, contacts/events, media are documented | Auth key updates and the application data store are explicitly the operator's responsibility; no HA server is supplied | MIT top level; direct GPL-3.0 `libsignal` dependency | **Benchmark finalist.** Best compatibility and TypeScript fit; highest ownership of correctness and operations. [B1] [B2] [B3] |
| Thin whatsmeow gateway | Go library; direct WebSocket; no browser; custom service required | Direct/group send/receive, group management/change events, app-state contacts, receipts, and retry receipts documented; calls not implemented | The library includes a SQL device store, but the service, leases, delivery journal, and API are ours to build | MPL-2.0 top level; direct GPL-3.0 `go.mau.fi/libsignal` dependency | **Benchmark finalist.** Likely attractive density and isolation, but requires a Go service and full contract adapter. [X1] [X2] [X3] [X4] |
| WAHA NOWEB | Self-hosted NestJS server; unified REST/webhooks over a selected WebSocket engine | Broad session, QR, directory, group, message, receipt, media, and event surface; engine payloads can differ materially | PostgreSQL/local session storage, S3 media, webhook HMAC/retries, multiple workers, and multiple sessions are documented; fencing and 10,000-session behavior are not | Repository `LICENSE` says Apache-2.0; `package.json` says `UNLICENSED`; the reviewed upstream image also embeds unlicensed/unproven GOWS | **Documentary baseline until clarified.** Benchmark only a reviewed source-built NOWEB-only image that excludes GOWS and unused engines. [A1] [A2] [A3] [A4] [A5] [A8] [A11] |
| WuzAPI | Go REST server over whatsmeow; PostgreSQL or SQLite; multi-session | Broad messages, contacts, groups, media, QR, and webhooks; HMAC, retry, dead-letter configuration, RabbitMQ, proxies, and S3 are documented | Useful implementation reference; no reviewed proof of fenced multi-owner HA or 10,000 sessions | MIT top level plus whatsmeow/libsignal chain | **Secondary packaged benchmark.** Simpler than broad platforms, but does not remove the same legal and scale work. [U1] [U2] |
| GOWA | Go REST/MCP server over whatsmeow; PostgreSQL or SQLite; multi-device since v8 | Broad message, mention, contact, group, participant, receipt, media, and `@lid` handling documented | Per-device webhooks, HMAC, persistent keys, and current v9.0.0 release; no reviewed 10,000-session ownership proof | MIT top level; direct GPL-3.0 `go.mau.fi/libsignal` dependency | **Secondary packaged benchmark.** Current and relatively focused, but the thin whatsmeow gateway avoids its unrelated API/UI surface. [G1] [G2] [G3] |
| Evolution API | Large TypeScript REST platform over Baileys and Meta, with many CRM/bot/queue integrations | Broad feature surface and LID fixes; much more than the required seam | PostgreSQL/MySQL, Redis, queues, S3, telemetry, and many integrations increase operational and attack surface | Describes Apache-2.0 plus extra logo/usage-notification conditions and possible commercial-license requirement | **Do not shortlist.** Functional breadth is not a substitute for simpler ownership semantics; custom terms need review. [E1] [E2] [E3] |
| WPPConnect Server | Node REST server over WPPConnect and Puppeteer/Chrome | Broad multi-session messaging, contacts, groups, and webhooks | Browser lifecycle and user-data directories increase density and failure costs | Server Apache-2.0; core WPPConnect package declares LGPL-3.0-or-later | **Do not shortlist for primary scale path.** Retain only as a browser-engine parity fallback. [P1] [P2] [P3] |
| whatsapp-web.js | Node library driving WhatsApp Web through Puppeteer | Very broad Web-client feature parity, including contacts, groups, mentions, media, and channels | A managed browser is required; remote session storage exists but the HA service remains ours to build | Apache-2.0 | **Do not shortlist for 10,000 accounts.** Useful differential oracle when direct-protocol libraries disagree. [J1] [J2] |
| Meta Cloud API | Meta-hosted first-party Graph API | Fails QR-linked personal accounts and existing-group parity | Stronger documented webhook security/retry behavior; transport not self-hosted | Commercial platform terms, not an OSS deployment | **Strategic product redesign only.** [M2] [M6] [M8] [M13] [M14] |

Release recency is only a maintenance signal; it does not establish reliability or scale. The cutoff snapshot was Baileys `v7.0.0-rc14` (2026-07-29), WAHA `2026.7.2` (2026-07-29), GOWA `v9.0.0` (2026-07-19), WPPConnect Server `v2.10.1` (2026-07-30), whatsapp-web.js `v1.34.7` (2026-04-24), and Evolution API `v2.3.7` (2025-12-05). whatsmeow and WuzAPI are consumed from active branch/pseudo-version snapshots rather than a comparable current stable release in this assessment. [B4] [A7] [G3] [P4] [J3] [E4] [X2] [U2]

### Why the Three Pilot Implementations

**Baileys** minimizes protocol and language distance. Its README documents direct WebSocket operation, QR and pairing-code linking, mutable auth-key persistence, contacts, message events, mentions, media, and extensive group operations. It also says the bundled multi-file auth helper is a guide rather than a production store and warns that Signal key updates must be saved whenever they change. Version `7.0.0-rc14` was current on 2026-07-29. [B1] [B2] [B4]

**whatsmeow** provides an independent Go implementation. Its first-party README documents core direct/group messaging, group-change events, app-state contacts, delivery/read receipts, and retry receipts without a browser. An independent implementation reduces single-upstream risk and gives a meaningful density comparison. Its missing calls support is not a blocker for the five-capability seam. [X1]

**WAHA** is the strongest packaged documentary baseline because it already presents lifecycle, QR, storage, webhooks, messages, contacts, groups, and multiple engines through one service. Its docs say all former Plus features became part of free WAHA Core in `2026.6.1`; release `2026.7.2` was published on 2026-07-29. The same docs warn that API responses and webhook payloads can differ significantly by engine. The source currently includes Baileys, whatsapp-web.js, WPPConnect, Puppeteer, BullMQ, Redis, SQL, and storage integrations. That breadth could accelerate a pilot if the gates below pass, but is not automatically the smallest or safest production system. [A1] [A2] [A4] [A5] [A7]

WAHA's legal metadata conflict is a hard gate, not a documentation nit: its top-level `LICENSE` is Apache-2.0, its `package.json` says `UNLICENSED`, its current docs call the project free and open source, and its README still contains legacy Plus image instructions. Obtain a written license clarification covering the source, public image, included engines, commercial internal SaaS use, modifications, and any customer-distributed image before adoption. [A1] [A2] [A3]

The cutoff snapshot also shows why a release name is not a sufficient pin. Tag `2026.7.2` resolves to WAHA commit `79233e09e34831b0ce23223d89b36e49b3024fd9`. Its `package.json` names mutable Baileys branch `fork-master-2026-04-28`, while the committed `yarn.lock` resolves that dependency to `0124c8f073719727fb8db2b08d4b14b81573d82c`; the branch itself was observed at `31458e2289c14107b9526ab93eb0ce655b3855d1`. Repository examples use unversioned `devlikeapro/waha` and `devlikeapro/waha-plus` references as well as explicit `:latest` references. Rebuilding from the manifest or following those examples can therefore select different source or image bytes. [A8] [A9]

The WAHA pilot artifact must record the source commit, committed dependency lock, every Git dependency commit, base-image and final-image SHA-256 digest, build command/toolchain, NOWEB engine/configuration, generated SBOM, signature or provenance attestation, and vulnerability-scan result. Store or mirror the exact image used by the tests. A tag, branch name, image repository, or mutable `latest` tag is not an acceptable benchmark identity.

Do not admit WAHA's GOWS engine to the contract, reliability, or density benchmark. The public `devlikeapro/gows` repository calls itself a binary repository, contains no public license file at the reviewed commit, and directs readers seeking the latest source to private `gows-plus` available with WAHA PRO. More importantly, WAHA's reviewed Dockerfile fetches the configured `gows-plus` release without verifying a digest and unconditionally copies that binary into the final image; selecting NOWEB only at runtime does not remove it. Use a source-built variant that removes that stage and all GOWS output, or omit WAHA from the executable pilot. Do not download, execute, redistribute, or expose any account credential to GOWS unless the supplier provides the evaluated source, reproducible build provenance, binary digest, SBOM, license grant, commercial terms, and WhatsApp-related terms in writing. [A10] [A11]

### Why Ready-Made Servers Do Not Solve Scale by Themselves

WAHA, WuzAPI, GOWA, Evolution API, and WPPConnect Server all reduce endpoint work. None of the reviewed public material establishes all of the following at 10,000 connected accounts:

- Exactly one live socket owner per account during process pauses, network partitions, database failover, and rolling deployment.
- Fencing of stale owners before sends and mutable credential writes.
- Atomic, encrypted persistence of rapidly changing Signal/auth state.
- Durable event append before delivery, replay after failure, stable deduplication, and per-session ordering behavior.
- Cluster-wide reconnect rate control after an upstream or regional outage.
- Resource density, memory-leak behavior, noisy-neighbor isolation, and recovery time at the target workload.
- Tested backup/restore behavior that does not corrupt credentials or force widespread QR relinking.

Those are the expensive parts of self-hosting. A broad REST surface is not evidence that they are solved.

## Recommended Gateway Architecture

The transport must run as a long-lived stateful service. It should not be embedded in request-scoped Cloudflare Workers or in the product application. Keep the existing application/control plane and add a private gateway data plane.

```text
                         CONTROL PLANE

 Browser/API -> Connection Setup saga -> session registry / scheduler
                         |                         |
                         |                         +-> lease + placement store
                         v
                  durable command queue
                         |
                         v
                 private command router

                         DATA PLANE

          +----------------+  +----------------+  +----------------+
          | gateway shard  |  | gateway shard  |  | gateway shard  |
          | session actors |  | session actors |  | session actors |
          +-------+--------+  +-------+--------+  +-------+--------+
                  |                   |                   |
                  +------------- WhatsApp ---------------+
                  |
       encrypted auth-state store + KMS envelope keys
                  |
             local durable outbox
                  |
                  v
             ingestion queue -> provider normalizer -> Message Store
```

The candidate library belongs inside each gateway shard. Everything around it is product-owned and should behave identically for Baileys, whatsmeow, or a compliant WAHA NOWEB-only artifact if WAHA qualifies for execution.

The current deployment contains Cloudflare Workers, one provider-control service binding, R2 buckets, Queues and DLQ consumers, Hyperdrive/Neon access, and no long-lived gateway compute. It has no private gateway ingress, placement scheduler, gateway lease store, gateway command path, or gateway event-outbox path. Before a reliability benchmark can represent production, declare those components and their KMS, database, broker, DNS, certificate-rotation, cross-zone, and failover paths in infrastructure as code. Gateway events must enter a generation-aware version of the existing encrypted R2-plus-Queue spool, and the gateway outbox must retain an event until that ingress path durably acknowledges it; node-local disk alone is not a recovery authority. [I12] [I13]

### 1. Private Boundary

- Expose only lifecycle, directory read, one text-send attempt, guarded media retrieval, and event delivery needed by the current seam.
- Authenticate every control-plane call with workload identity or mTLS. Do not expose a candidate's generic dashboard, Swagger surface, arbitrary send routes, raw JIDs, or engine debugging endpoints to the public internet.
- Validate bounded inputs at the outer boundary. Convert every engine result into the existing provider-neutral result classes before it leaves the gateway adapter.
- Retain the account-level control split: lifecycle authority may enumerate or create sessions, while ordinary operations receive only one encrypted per-session authority.
- Render QR payloads into the required response immediately, enforce their short lifecycle, and never persist or log the raw linking payload.

### 2. Session Registry and Placement

Each session record should contain at least:

```text
session_id                       opaque internal ID
setup_marker                     deterministic provisioning marker
connection_id                    owning WhatsApp Connection
provider_kind                    controlled internal provider enum
provider_generation              monotonically increasing routing generation
generation_state                 shadow | active | draining | rollback_ready |
                                 retired | deleting
desired_state                    stopped | running | deleting
observed_state                   normalized connection state
opaque_session_locator           provider-neutral handle, never a raw ID
encrypted_provider_authority     generation-bound encrypted authority
owner_id                         current gateway process
lease_epoch                      monotonically increasing owner fence
lease_expires_at                 database-authoritative expiry
engine_version                   immutable source/image version
command_journal_sequence         last durably allocated command sequence
event_journal_sequence           last durably allocated event sequence
ingress_watermark                generation-specific cutover watermark
drain_deadline                   bounded old-generation drain deadline
```

Use explicit placement rather than letting every replica discover and open every stored session. A scheduler assigns sessions to shards based on measured memory, CPU, reconnect load, and fault-domain limits. Consistent hashing can reduce movement, but placement must still honor capacity and drain state.

Do not optimize only for the maximum sessions per process. Bound the blast radius. A process crash should disconnect a small, known cohort, not thousands of accounts.

### 3. Fenced Single Ownership

At most one owner may accept commands or mutate auth state for one connection and provider generation, and at most one generation may accept new authoritative product work. During a bounded make-before-break migration, an old generation and a shadow generation may both maintain linked-device sockets, but the shadow generation cannot accept ordinary product sends or write authoritative Message Store data. After activation, only the immutable set of old-generation ingress envelopes at or below the recorded cutover watermark may finish its pre-fence convergence; that bounded drain is not authority for a new command or delivery. Active-active authority is not the availability model.

1. A shard acquires a compare-and-swap lease and receives a monotonically increasing `lease_epoch`.
2. It decrypts auth state only after acquisition.
3. Every command dispatch, auth-state write, and event append verifies the current owner and epoch.
4. Heartbeats renew against database time, not process wall-clock time.
5. Lease loss immediately blocks new commands and closes the socket.
6. A successor waits for expiry plus a tested handoff grace period before opening a replacement socket.

Fencing protects internal writes and routing, but WhatsApp cannot inspect the epoch. A paused stale process can briefly retain an external socket. The pilot must therefore test stop-the-world pauses, partitions, delayed heartbeats, and process resurrection. The design must demonstrate that a stale owner cannot accept a send after its lease is lost.

### 4. Mutable Auth-State Persistence

Linked-device credentials are not a static login token. Baileys explicitly warns that Signal keys update as messages are sent and received and that failing to persist those updates causes delivery failures. [B1]

Required storage properties:

- Envelope encryption per connection with a KMS-managed wrapping key; encryption context binds tenant, connection, and record version.
- Transactional compare-and-swap on `lease_epoch` and auth revision so a stale owner cannot overwrite newer state.
- Atomic batches for credential and key mutations emitted together by the engine.
- No plaintext credentials in logs, traces, crash dumps, support exports, metrics, or object names.
- Point-in-time recovery and restore drills. A database backup that restores mismatched credential/key revisions is not a valid recovery plan.
- Explicit deletion workflow that removes active state, backups according to retention policy, and any media cache.

For a custom gateway, do not ship Baileys' multi-file example store or an uncoordinated local SQLite file as the production authority. A local encrypted cache may accelerate restart, but the fenced durable store remains authoritative.

### 5. Session Actor and Command Semantics

Serialize state changes and outbound commands through one actor/mailbox per session. This limits concurrency races without requiring a global queue.

For text sends:

1. Persist the Send Operation and command identity before dispatch.
2. Route only to the current owner and epoch.
3. Invoke the engine once within the existing 15-second attempt budget.
4. If the direct result carries the exact WhatsApp message key bound to the resolved recipient, return identity evidence.
5. If acceptance is uncertain, return `ambiguous` and do not retry automatically.
6. Correlate later outbound/receipt events only by the same connection and stable WhatsApp message identity.

A local idempotency key prevents duplicate command execution inside this service; it cannot make WhatsApp's send operation idempotent. Reissuing a send after a timeout can still duplicate a user-visible message.

For lifecycle writes, carry ADR 0019's reconciled saga forward: reconcile the deterministic setup marker before every create repeat, adopt exactly one existing session, quarantine duplicates, and confirm absence before releasing a number reservation. [I5]

### 6. Durable Events and Normalization

Protocol callbacks are not a durable queue. Before an event is offered to the control plane, append an immutable envelope to a local or database-backed outbox containing:

```text
connection_id
provider_generation
lease_epoch
local_event_sequence
engine_event_kind
engine_payload_ciphertext_or_protected_reference
observed_at
engine_version
```

Then:

- Publish at least once to the existing ingestion path and mark delivery only after downstream acknowledgement.
- Keep ordering claims narrow. Preserve append order per session, but do not claim that WhatsApp occurrence time, replay order, and receipt order are globally monotonic.
- Generate stable normalized identities from WhatsApp's message key or event semantics, not from the gateway's delivery ULID. A newly generated webhook request ID cannot deduplicate a replay of the same WhatsApp event.
- Treat every delivery as duplicate-capable. Replays after a crash must produce the same normalized identity.
- Keep raw candidate payloads inside the adapter boundary. Unsupported items remain classified rather than failing valid siblings.
- Use `provider_generation` to keep shadow, post-watermark draining, and retired-provider events out of the authoritative Message Store during migration. Only the closed pre-fence set at or below a recorded cutover watermark may finish normal convergence.

WAHA documents configurable webhook retries and an HMAC over the raw body, which is useful at its HTTP boundary. That still does not establish a durable source outbox or stable replay identity; those must be tested or added outside it. [A6]

### 7. Directory, JID, and LID Model

- Retain raw JID/LID values only in encrypted adapter storage. Continue returning connection-keyed protected routing locators to the domain.
- Never derive a phone number from a LID. Populate a phone number only from an explicit phone field, a phone-number JID, or a verified protocol mapping.
- Build contact and group projections from app-state/history events, then reconcile with explicit engine reads. Report `partial` and stale observations when completeness cannot be proven.
- Cache the group metadata required for group sends. If the optional extension is approved, include the metadata needed for mentions and participant updates; invalidate it on relevant group events.
- Test direct chats whose canonical identity changes between phone JID and LID, including outbound callback correlation after restart.

### 8. Media Path

- Download media inside the current session owner using the engine's authenticated media operation.
- Stream rather than buffering whole files, enforce the existing caller byte limit and overall timeout, and discard partial bytes on failure.
- If an object store is used, encrypt objects, use short-lived internal references, enforce retention, and never expose a protocol URL or session credential to clients.
- Keep automatic bulk media download disabled. It turns every inbound event into storage and egress cost and expands the privacy footprint.

### 9. Reconnect and Failure Control

- Classify logout/relink-required separately from transient disconnects. Do not loop forever on invalid credentials.
- Apply exponential backoff with jitter per session and a cluster-wide token bucket. After an upstream outage, ramp cohorts rather than reconnecting every account simultaneously.
- Reserve compute, database connections, and queue throughput for the reconnect path. Steady-state capacity is insufficient if every session performs auth and history work at once.
- Quarantine repeatedly crashing sessions so one malformed account state cannot restart-loop a shard.
- Drain shards explicitly during deploys: stop assignment, hand off bounded cohorts, wait for lease transfer, then terminate.
- Pin the engine and protocol version. Canary updates on test accounts and a small customer cohort before fleet rollout; retain the previous image and schema compatibility for rollback.

### 10. Observability and Security

Minimum metrics are session counts by normalized state, lease contention/loss, reconnect attempts and age, command latency/outcome, ambiguous-send rate, event-outbox lag, duplicate rate, auth revision conflicts, per-shard RSS/CPU/file descriptors, database latency, and media byte counts.

Never label phone number, JID/LID, message ID, session ID, tenant ID, message text, QR payload, credential, media URL, or raw event as a metric dimension or log field. Operators need aggregate health plus audited, narrowly authorized connection diagnostics rather than searchable message content.

## Capacity and Cost Model

### Why There Is No Defensible Dollar Total Yet

Two inputs needed for a decision are unavailable:

1. Wasender's price and contractual terms above ten accounts are a custom quote.
2. No candidate has been benchmarked under this product's session mix, message rate, group size, media rate, reconnect pattern, and durability design.

Any single monthly total before those inputs would be false precision. The model below makes the unknowns explicit and gives the exact measurements needed to fill them.

### Capacity Units: Personal Accounts and Connections

Do not use Personal Accounts and connected WhatsApp accounts interchangeably. Let:

- `S` = simultaneously connected WhatsApp accounts/sessions.
- `P` = admitted Personal Accounts.
- `K_reserved` = provider session capacity reserved by the current admission policy.
- `M_entitled` = aggregate Stored Media entitlement.

The product permits three WhatsApp Connections per Personal Account and calls its account-wide Stored Media ceiling 5 GB; the schema fixes those values at exactly three and `5368709120` bytes, or 5 GiB, shared across the account's Connections. The Personal Account bootstrap function reserves the full three-Connection entitlement for every Personal Account rather than only its current connections. Clerk owns applicant approval; exhausted provider capacity persists no applicant state and makes bootstrap transiently unavailable. [I9]

```text
S <= 3 * P
K_reserved = 3 * P
M_entitled = 5 GiB * P
```

`S` alone cannot determine `P`: admitted accounts can use one, two, three, or currently zero Connections. The gateway socket workload scales primarily with actual/peak `S`; admission commitments scale with `K_reserved`; and the account-scoped media ceiling scales with `P`. At minimum `P = ceil(S / 3)` when every modeled account uses its full connection entitlement. If every modeled account has one connected account, `P = S`; admitted zero-connection accounts increase `P` further.

| Connected accounts `S` | Full-entitlement scenario: `P`; `K_reserved`; `M_entitled` | One-connection scenario: `P`; `K_reserved`; `M_entitled` |
| ---: | --- | --- |
| 100 | 34; 102 sessions; 170 GiB | 100; 300 sessions; 500 GiB |
| 1,000 | 334; 1,002 sessions; 1,670 GiB | 1,000; 3,000 sessions; 5,000 GiB |
| 10,000 | 3,334; 10,002 sessions; 16,670 GiB | 10,000; 30,000 sessions; 50,000 GiB |

Every quote, benchmark, and launch plan must state both `S` and `P`, the expected Connections-per-Personal-Account distribution, whether infrastructure is sized for current sockets or reserved entitlement, and expected rather than merely entitled media bytes. The three target tiers in this report remain connected-account targets; the table exposes the additional account-level capacity that the present product policy can require.

### Wasender Cost

Let:

- `Q_W(S,P)` = negotiated Wasender subscription price for the connected target and any capacity commitment implied by `K_reserved = 3P`; the quote must say which unit is billed or guaranteed.
- `P_proxy_W(S)` = any Wasender-side proxy or network cost.
- `O_W(S,P)` = application integration, monitoring, support, incident, and reconciliation labor.
- `R_W(S,P)` = approved reserve or scenario value for Wasender outage, vendor exit, account restriction, and customer remediation risk.

```text
C_wasender(S,P) = Q_W(S,P) + P_proxy_W(S) + O_W(S,P) + R_W(S,P) + tax
```

For context only, extending the public ten-account unit rate of USD 4.50 produces the following arithmetic. It is not an available offer, quote, or approved account-sharding strategy:

| Connected accounts | Actual public price | Invalid linear reference at USD 4.50/account |
| ---: | --- | ---: |
| 100 | Custom quote required | USD 450/month |
| 1,000 | Custom quote required | USD 4,500/month |
| 10,000 | Custom quote required | USD 45,000/month |

ADR 0004 explicitly prohibits using unapproved account sharding to manufacture those totals. Obtain quotes at all three tiers, including support, capacity, rate limits, DPA, retention/deletion, SLA/service credits, webhook guarantees, and termination/export terms. [I3]

### Self-Hosted Infrastructure

Measure candidate density separately for idle, normal, peak, reconnecting, and history-syncing sessions. Let:

- `r95` = p95 steady-state RSS MiB per connected session at the representative workload.
- `c95` = p95 CPU cores consumed per session at that workload.
- `b_mem`, `b_cpu` = gateway process/node base memory and CPU.
- `M`, `V` = node memory MiB and vCPU.
- `u_mem`, `u_cpu` = maximum planned utilization after reserving operating-system and burst room.
- `d_limit` = separately tested maximum sessions per node/process for blast-radius and file-descriptor constraints.

```text
d_mem = floor((M * u_mem - b_mem) / r95)
d_cpu = floor((V * u_cpu - b_cpu) / c95)
d     = min(d_mem, d_cpu, d_limit)

N_active = ceil(S / d)
N_total  = max(N_active + N_zone_spares, ceil(N_active * H_ha))
```

`H_ha` is the approved capacity-headroom factor. It must cover at least one planned fault domain and the measured reconnect burst, not just an arbitrary percentage.

The following is a memory-only sensitivity table, not a candidate benchmark. It shows aggregate session RSS with 1.5x headroom and excludes process base memory, databases, queues, caches, media, and operating-system memory:

| Accounts | 20 MiB/session | 50 MiB/session | 100 MiB/session | 500 MiB/session |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 2.9 GiB | 7.3 GiB | 14.6 GiB | 73.2 GiB |
| 1,000 | 29.3 GiB | 73.2 GiB | 146.5 GiB | 732.4 GiB |
| 10,000 | 293.0 GiB | 732.4 GiB | 1,464.8 GiB | 7,324.2 GiB |

This is why browser-based engines are unlikely to be economical at 10,000 accounts and why a measured 20 MiB versus 100 MiB WebSocket implementation materially changes the decision. Neither number should be assumed before the pilot.

### Fully Loaded Self-Hosted TCO

Let:

- `C_compute` = gateway nodes, load balancers, and reserved failover capacity.
- `C_state` = HA database/auth-state authority, replicas, backups, point-in-time recovery, connection pooling, and KMS operations, including gateway-to-state traffic.
- `C_queue` = command/event queue, outbox storage, and dead-letter retention.
- `C_media` = object storage, requests, scanning, lifecycle deletion, and media processing.
- `C_egress` = WhatsApp, webhook, media, gateway-to-Cloudflare, gateway-to-Neon/auth state, KMS, broker, cross-zone, cross-cloud, and observability traffic.
- `C_proxy` = optional per-session or pooled proxy cost. Treat it as a measured operational choice, not a promised ban-avoidance mechanism.
- `C_observe` = logs, metrics, traces, alerting, and security monitoring.
- `C_license` = support, commercial license, attribution/compliance, and legal-review cost.
- `C_risk` = approved reserve or scenario value for protocol outage, forced relinking, account restriction, incident response, and customer remediation; keep the underlying risks visible even if finance declines to monetize them.
- `F_ops * L_ops` = monthly loaded operations/on-call staffing.
- `E_build / A` = initial engineering and security work amortized over `A` months.
- `E_maint` = ongoing protocol updates, dependency response, testing, and incident engineering.

```text
C_self(S,P) = C_compute(S,P)
            + C_state(S,P)
            + C_queue(S,P)
            + C_media(S,P)
            + C_egress(S,P)
            + C_proxy(S,P)
            + C_observe(S,P)
            + C_license(S,P)
            + C_risk(S,P)
            + F_ops * L_ops
            + E_build / A
            + E_maint
            + tax

fully_loaded_cost_per_connected_account = C_self(S,P) / S
```

Treat migration as a separately visible one-time cost rather than hiding it in steady-state infrastructure:

```text
C_migration = dual-provider subscription and compute
            + shadow event-journal storage
            + temporary ingress and observability
            + QR/relink customer support
            + cohort operations and rollback reserve
```

Apply the same boundary to both options. Common product API and Message Store cost may be omitted from both sides; include only incremental provider/gateway cost, or include the common cost identically in both.

Do not omit labor because a server image is free. At 100 accounts, even a fraction of an on-call engineer can dominate the public-plan unit-rate reference. At 10,000 accounts, fixed engineering amortizes more effectively, but protocol incidents and reconnect storms also have a much larger blast radius.

### Storage and Egress Inputs

For each data class `k`, measure retained bytes per applicable unit per day `B_k`, retention days `D_k`, monthly growth, request rate, and replication factor `R_k`. Let `N_k` be the correct driver: connected accounts `S` for connection-scoped auth/event data, Personal Accounts `P` for account-scoped limits, or measured messages/media objects where activity is the actual driver:

```text
stored_bytes_k = N_k * B_k * D_k * R_k
```

Model at least encrypted auth revisions, event outbox, Message Store payloads, directory projections, backups, media cache/object storage, logs, and dead letters separately. Media must use the actual inbound size distribution and retention policy; average text-message size is not a useful proxy. Keep expected retained media below the exact `5 GiB * P` entitlement ceiling, and do not multiply that ceiling by `S`.

### Economic Decision Rule

Compare like behavior and include a risk margin:

```text
annual_self_host_advantage
  = 12 * (C_wasender(S,P) - C_self(S,P))

payback_months
  = (initial_incremental_build_cost + C_migration)
    / max(C_wasender(S,P) - recurring_self_host_cost(S,P), 0)
```

Require the conservative self-host forecast to remain at least 30% below the negotiated Wasender total after operations labor, development amortization, HA spare capacity, and support/legal cost. The 30% is a proposed decision margin, not a market fact; without material margin, the added protocol, credential, and on-call risk is not economically justified.

| Tier | Likely decision pressure | Evidence required before deciding |
| ---: | --- | --- |
| 100 | Fixed build and operations labor dominate. Staying hosted is likely cheaper unless enterprise terms or risk are unacceptable. | Wasender quote; measured candidate density; actual fractional on-call load; pilot build estimate. |
| 1,000 | Self-hosting may become economically plausible if direct-WebSocket density is good and operations remain simple. | Target-concurrency soak, HA database/queue quote, reconnect test, staffing and maintenance history. |
| 10,000 | Unit infrastructure can amortize well, but no reviewed project proves this scale. Reliability, legal, abuse, and account-loss risk dominate. | Target-concurrency staged launch, fault-domain model, real reconnect storm, 24x7 ownership, legal approval, and written risk acceptance. |

Cash break-even is meaningful only after functional parity. Meta cannot be assigned a low cost for a requirement it does not satisfy, and a browser engine cannot be assigned a WebSocket density without measurement.

## Pilot Plan

The pilot is an evidence-gathering project, not the first production migration phase.

### Phase 0: Commercial, Legal, and Policy Gate

Complete before building more than a throwaway harness:

1. Request Wasender quotes and terms for 100, 1,000, and 10,000 connected accounts.
2. Ask Wasender for written SLA, support, capacity, rate-limit, DPA/subprocessor, residency, retention/deletion, webhook retry/durability, incident-notification, export, and termination terms.
3. Obtain counsel's written analysis of WhatsApp/Meta terms and the proposed linked-device automation use case.
4. Obtain an SBOM and counsel review for each finalist, including Baileys plus `libsignal`, whatsmeow plus `go.mau.fi/libsignal`, and every dependency in the selected WAHA NOWEB container.
5. Get written WAHA license clarification if WAHA remains in the pilot. Exclude GOWS unless the supplier provides source, provenance, a binary digest and SBOM, license grant, and commercial terms in writing.
6. Decide whether the company will ever distribute a gateway/container to customers or offer on-prem deployment. Do not assume an internal SaaS analysis covers image distribution.
7. Define consent, anti-spam, abuse response, account suspension, data deletion, and customer disclosure policies.
8. Create an immutable artifact manifest for each build: source commit, dependency lock and Git commits, image SHA-256 digest, base images, build toolchain, SBOM, signature/provenance, and engine/configuration. Reject floating branches and image tags.

If counsel rejects the underlying unofficial linked-device use or executive risk acceptance is withheld, stop both the Wasender and self-hosted parity paths. A failure limited to a candidate's license, supply chain, security, or operating model may instead leave Wasender in place, but only under separately recorded current-provider risk acceptance and negotiated terms. The first-party alternative is to change the product to a WABA/Cloud API model and evaluate it under the separate WhatsApp Business Solution Terms. [L1] [L2] [L3]

### Phase 1: Contract Harness

Do not begin by recreating every candidate endpoint. Build a harness around the five existing capabilities:

- Run all current Wasender adapter fixtures through each candidate-specific adapter and preserve the existing five-capability classifications and policies.
- Add required engine-native fixtures for QR rotations, reconnect-required/logout states, direct and group messages, outbound echoes, receipt transitions, contacts, joined groups, JID/LID mappings, malformed siblings, duplicate deliveries, and media.
- If the broader Normal POC extension is separately approved, add a distinct fixture suite for mentions, connected-account JID/LID self-identities, group membership, and participant add/remove/promote/demote events. Its result must not change the pass/fail status of current replacement parity until that contract exists.
- Assert that raw JIDs, engine status strings, URLs, credentials, and free-form errors do not cross the seam.
- Assert that one direct engine response and its later outbound callback derive the same stable message identity.
- Inject network loss before request write, after request write, after upstream acceptance, and before response delivery. Verify ambiguous sends are never automatically repeated.
- Re-run the suite against immutable Baileys and whatsmeow artifacts in CI, recording the artifact manifest with every result. Add WAHA NOWEB only after its legal/provenance gates pass and a GOWS-free image is produced.

Keep the current interface in place during the pilot. Renaming packages or designing a general plugin framework does not answer the transport question.

### Pilot Test Boundary

Collect gate evidence at the highest available production boundary rather than replacing repositories, RPC, queues, or gateway transport with in-memory implementations. [I14]

- Exercise provider-control through the actual Cloudflare Worker RPC service binding and validate provider-neutral decoding, generation dispatch, stale-generation rejection, and content-free failure conversion.
- Apply versioned production migrations to isolated Postgres/PGlite and retain production RLS roles and tenant context while testing provider-generation state, journals, watermarks, quotas, and deletion.
- Build and run the actual candidate gateway image. Invoke its private network protocol and real auth-state/outbox implementation rather than calling the candidate library directly.
- Exercise the encrypted ingress spool, Queue acknowledgement, DLQ, replay, and generation filter through their Worker boundaries.
- Drive QR setup and reconnect-required behavior through the production-built web application and API Worker for at least one canary journey.
- Inject process death, stale leases, network partitions, broker failure, database failover, and response loss at the process or network boundary that would fail in production. A mocked `SessionLifecycle`, callback invocation, or library microbenchmark cannot satisfy a gateway reliability gate.
- Prove production bundles contain no test provider selector, fault header, alternate origin, fake Layer, or test-only credential path.

The suite must prove that a command created under generation `n` cannot execute under generation `n+1`; a stale owner cannot dispatch after lease loss; a shadow or post-watermark old generation cannot write authoritative Message Store state; only the immutable old-generation set at or below the cutover watermark can finish pre-fence convergence; exact stable identities deduplicate the bounded evidence allowed across a cutover; rollback always creates a new monotonic fence; and Connection Deletion cleans every retained generation before releasing the WhatsApp Number. [I15]

### Phase 2: Live Functional Canaries

Use dedicated, consented test accounts and ordinary app behavior. Do not test spam, evasion, or unapproved sharding.

Run the same scenarios against Wasender and each finalist:

| Area | Required live scenarios |
| --- | --- |
| Provisioning | Create intent, QR rotation/expiry, successful scan, process restart, disconnect, reconnect, logout, relink, delete, ambiguous create/delete reconciliation, duplicate marker quarantine. |
| Identity | Direct phone JID, direct LID, verified JID/LID mapping, group JID, group-message sender phone/LID variants, and identity stability across gateway restart. Connected-account self-identity is tested only under an approved extension. |
| Directory | Initial sync, pagination/large directory, joined-group rename/join/leave, partial sync, stale observation, and no phone guess from LID. Test group membership only under an approved extension. |
| Sending | Direct text, group text, definitive recipient rejection, throttling, timeout ambiguity, and callback correlation. Test visible/ghost/provider mentions only under an approved extension. |
| Events | Inbound/outbound, duplicate/replay, delivered/read/played, group update, session state, and a malformed item beside a valid item. Test participant add/remove/promote/demote only under an approved extension. |
| Media | Each required media type, large allowed object, object over caller limit, expired media, mid-stream disconnect, retry from byte zero, deletion/retention. |
| Product behavior | No automatic incoming read receipts, phone notifications preserved as configured, Message Store remains authoritative. |

Use whatsapp-web.js only as a differential diagnostic if both direct-protocol finalists disagree on a Web-client behavior. Do not add it as a fourth scale candidate.

### Phase 3: Reliability and Density Benchmark

Benchmark complete gateway builds, including encrypted auth persistence and durable outbox. Library-only memory numbers are not deployment numbers.

Workload inputs must come from production telemetry or an approved forecast:

- Connected-but-idle distribution.
- Direct/group messages sent and received per account per minute at p50, p95, and peak.
- Group sizes and participant-event rate.
- Directory size and reconciliation frequency.
- Media frequency, type, and byte distribution.
- Receipt fan-out and Message Store event rate.
- Normal disconnect and reconnect frequency.

Measure at steady state and during each fault:

- Cold start and gradual session ramp.
- Gateway process kill, container eviction, and node loss.
- Long runtime pause, clock skew, lease-store timeout, and network partition.
- Primary database failover and temporary queue outage.
- Event consumer outage followed by replay.
- Neon point-in-time restore from the verified history window, with deletion-marker replay and wall-clock expiry before verification access.
- 10%, 25%, and 100% transient disconnect/reconnect waves.
- Upstream protocol/version incompatibility and rollback to the previous image.
- Corrupt or stale auth revision for one account.
- Large history/app-state synchronization.

Record p50/p95/p99 RSS and CPU per session, file descriptors, sockets, garbage collection, event-loop or goroutine delay, database transactions and bytes, reconnect CPU/I/O, queue lag, send latency, event latency, disconnect duration, and memory slope over time. Report first-party availability, WhatsApp/candidate dependency availability, and per-session connected time as separate measurements.

Scale in authorized stages. A synthetic HTTP load test cannot replace real linked sessions because it omits sockets, cryptographic key mutation, app-state synchronization, and upstream reconnect behavior. Do not extrapolate a 100-session result directly to 10,000.

### Phase 4: Production Canary

Start only after the acceptance gates below pass:

1. Migrate internal/test accounts.
2. Migrate a small opt-in customer cohort with direct operational support.
3. Hold at each cohort until the full soak window and error budget pass.
4. Increase one fault domain at a time; never combine a new engine version, new scheduler, and larger cohort in one change.
5. Stop expansion automatically on acceptance-gate regression.

## Acceptance Gates

The following are recommended minimums. Product and SRE owners should ratify exact SLO numbers before Phase 2 so results cannot be reinterpreted after the test.

| Gate | Pass condition | Automatic no-go condition |
| --- | --- | --- |
| Functional contract | 100% of the five existing capability contracts, required fixtures, and required live scenarios pass on an immutable build. Optional Normal POC extensions are reported separately unless approved into scope before Phase 1. | Missing lifecycle reconciliation, contact/joined-group Directory behavior, one-attempt direct or group text sending, guarded media retrieval, supported webhook normalization, JID/LID safety, exact outbound identity, or malformed-sibling isolation. |
| Send correctness | Every successful direct result and authoritative outbound event correlates by exact stable identity; all injected ambiguous outcomes remain single-attempt. | Any automatic resend of an ambiguous operation, weak text/time correlation, or unexplained duplicate user-visible send. |
| Event durability | No loss of an event durably accepted by the gateway under tested process, node, queue, and consumer failures; replay deduplicates to one domain item. | Lost accepted event, unstable replay identity, unbounded outbox, or one malformed item drops valid siblings. |
| Session ownership | At most one command-accepting owner per session in all pause/partition/failover tests; stale epochs cannot write auth state or dispatch sends. | Split-brain send, stale credential overwrite, or owner handoff that requires unplanned relinking. |
| Auth durability | Restore and failover retain valid, revision-consistent encrypted auth state; deletion is auditable. | Plaintext exposure, inconsistent key restore, cross-tenant access, or recurring QR relinks after routine restart. |
| First-party availability | Over a minimum seven-day canary, the product, API, ingestion path, gateway control/data plane, auth-state authority, and Message Store meet the existing 99.5% rolling seven-day first-party availability SLO. No first-party failure is excluded because WhatsApp or another dependency was also impaired. | Seven-day first-party error budget exceeded, or gateway/control failures are relabeled as provider failures to preserve the metric. [I10] |
| Provider dependency | Wasender, each candidate transport, and observable WhatsApp dependency availability are measured separately. A separately ratified 99.9% candidate connected-time objective may be used as a pilot comparison metric, but it does not replace the first-party SLO or imply end-to-end availability. | Candidate materially underperforms the Wasender baseline, attribution cannot distinguish first-party from external failure, or the denominator excludes ordinary candidate reconnect failures. [I10] |
| Recovery and data protection | Demonstrate RTO no greater than four hours; committed Neon-state RPO no greater than five minutes through the managed backup/PITR path; a verified seven-day Neon history; a representative restore with deletion-marker replay and current wall-clock expiry before verification access; and zero-loss treatment of immutable deletion markers. The five-minute objective covers committed Neon state only; any separate candidate auth-state authority needs its own ratified restore objective and revision-consistency drill. Continue the weekly restore and quarterly game-day cadence required by ADR 0032. | RTO or committed-state RPO missed, scope is misstated, restore serves expired/deleted data, deletion markers are unavailable, or auth-state restore produces inconsistent revisions or fleet relinks. [I10] |
| Stored Media recovery | State explicitly that Stored Media has no backup RPO because R2 is its sole retained copy; loss of the primary object surfaces as `failed`, not available. | The design or customer copy implies recoverability of a lost R2 object without a separately approved backup design. [I10] |
| Ingestion continuity | Record only evidence-based, connection-scoped Ingestion Gaps from disconnection/configuration evidence, failed durable enqueue or normalization reaching DLQ, measured ingress/Queue outage or purge, restore loss, or a cutover failure with concrete evidence. Provider events never delivered are outside storage RPO. | A known failure interval is hidden, a gap is inferred from message inactivity, or absence of a known gap is described as complete provider history. [I10] [I13] |
| Capacity | Target launch tier runs with at least one full fault domain unavailable and approved headroom; p99 limits and seven-day memory slope stay within bounds. | Capacity is extrapolated only from library microbenchmarks or HTTP mocks. |
| Security and supply chain | Every artifact is built from an immutable reviewed source commit with locked transitive resolutions; base images and included binaries are digest-pinned; the resulting image digest is tied to reviewed source/build inputs through reproducible provenance or attestations; an SBOM covers the complete image; signatures, vulnerability review, secret scanning, least privilege, KMS boundaries, backup protection, and incident runbooks are approved. | Mutable branch/tag dependency, unlocked resolution, unverified downloaded binary, image digest with no source/build provenance, missing SBOM, generic admin UI exposed publicly, raw credentials/content in telemetry, or a critical unmitigated finding. |
| Legal/policy | Counsel approves exact use and deployment model; WAHA ambiguity resolved if applicable; customer terms and abuse controls approved. | Unresolved GPL/LGPL/custom-term impact, prohibited product use, or reliance on an unofficial project disclaimer as permission from WhatsApp. |
| Operations | Named 24x7 owner, dashboards, paging, capacity model, upgrade/canary/rollback automation, restore drill, and protocol-break runbook exist. | "Community will fix it" is the incident plan or only one engineer can recover the fleet. |
| Economics | Conservative fully loaded TCO is at least 30% below the negotiated equivalent Wasender cost and payback fits the approved horizon. | Savings exist only after excluding labor, HA, development, support/legal, storage/egress, or risk reserve. |

For a 10,000-account decision, repeat the capacity and reconnect gate at staged real concurrency close enough to expose database, scheduler, socket, and upstream behavior. A one-node demonstration or vendor claim is not acceptable evidence.

## Migration Plan

### Architectural Preparation

Gradual migration needs a bounded per-connection provider transition even though ADR 0011 correctly rejected a speculative runtime plugin system. Add a superseding migration ADR that permits only:

```text
wasender -> candidate -> candidate_stable
                  \
                   -> rollback_to_wasender
```

Record `provider_kind` and monotonically increasing `provider_generation` on the connection, command, event envelope, and encrypted provider authority. This is migration control, not arbitrary provider selection by a user or request.

Keep both adapters behind the same five capabilities. Keep account-level Wasender PATs in provider-control and candidate fleet authority in an equally narrow private control service. Do not move either credential into the product API.

### Credential and QR Reality

Wasender does not provide exportable Baileys auth state, and candidate credentials should not be assumed compatible even if both use Baileys. Every migrated account must link the new gateway as a fresh companion through QR or another explicitly supported user flow.

Do not attempt to scrape, copy, or transform Wasender session credentials. Besides being unavailable, that would bypass the encrypted ownership and consent model.

The preferred make-before-break flow also requires an available linked-device slot and WhatsApp acceptance of both companions during the rollback window. Validate this per account. If no slot is available or parallel linking is rejected, the migration becomes break-before-make and both cutover support and rollback may require another user QR.

### Per-Cohort Cutover

1. **Prepare generation:** Keep generation `n` active and create candidate generation `n+1` in `shadow`. Persist separate encrypted authority, ingress identity, command journal, event journal, and cleanup authority for `n+1`. Verify that no unresolved provisioning, deletion, or ambiguous send requires operator action.
2. **Link:** Link the candidate as a fresh companion. Append every candidate callback to its encrypted generation-specific journal, but do not offer shadow data to the authoritative Message Store. Disable avoidable history synchronization and classify required history separately.
3. **Validate:** Confirm connected-account identity, direct and joined-group Directory behavior, JID/LID handling, an inbound test event, one controlled migration-validation send, exact stable message identity, receipt convergence, and guarded media retrieval. Optional-extension behavior is evaluated separately.
4. **Quiesce commands:** Stop creation of new outbound commands for the connection. Drain generation `n` commands already durably claimed. Classify every result and never replay an ambiguous send through either provider.
5. **Record watermarks:** In one durable transaction, record the highest old-generation ingress sequence already accepted into the encrypted spool and the highest old-generation command sequence eligible for dispatch. Close generation `n` to new authoritative commands and to new authoritative ingress above that watermark. Continue authenticating and journaling late old-provider deliveries under generation `n`; they cannot write directly to domain state.
6. **Fence and activate:** Atomically mark `n` as `draining`, mark `n+1` as `active`, and advance the connection's active generation. Every new command and event envelope records `provider_kind` and `provider_generation`; the runtime rejects any command whose recorded generation is no longer active before credential use or dispatch.
7. **Bounded old-generation drain:** Reconcile the immutable old-generation command set and process the ingress set at or below the recorded watermarks to terminal journal states under pre-fence convergence authority. Never dispatch an old-generation command after activation. Keep a ratified drain deadline and capacity bound. Missing the deadline stops cohort expansion and triggers recovery or rollback; it never authorizes discarding a durably accepted item. Items arriving above the old ingress watermark remain non-authoritative and are retained only for exact late-evidence reconciliation and diagnosis.
8. **Reconcile exact identities:** Compare evidence across generations only when both adapters prove the same stable WhatsApp message identity for the same connection and identifier namespace. Never match recipient, text, timestamp, status order, or apparent uniqueness. If the adapters use different namespaces or cannot establish equality, the items converge independently; a shadow or late old-generation item never enters the Message Store merely because no duplicate was found. [I15]
9. **Observe and retire:** Resume ordinary commands on the candidate and monitor it through the cohort soak. After the rollback window and old-generation drain complete, delete the Wasender session through its reconciled saga, confirm absence, revoke its authority, close its ingress, and mark the generation retired. Only then remove rollback capacity and billing reservation.

An ingress watermark orders only deliveries the platform has accepted; it does not prove that Wasender or WhatsApp has no delayed or omitted event. If concrete evidence shows failed durable enqueue, exhausted DLQ, restore loss, configuration drift, or an unprovable cutover interval, record a connection-scoped Ingestion Gap from the last confirmed healthy point until confirmed recovery. Do not infer a gap from message inactivity, and do not describe the absence of a known gap as complete history. [I13]

Connection Deletion during a dual-provider window must fence every generation and reconcile cleanup for every non-absent provider session. Version the Deletion Capsule to carry a bounded encrypted list of generation-specific cleanup authorities containing provider kind, provider generation, and opaque locator. Do not release the WhatsApp Number reservation until every retained provider generation is confirmed absent. [I5] [I12]

### Rollback

Rollback remains possible only while the Wasender session is connected or can be reconnected. Preserve it for a defined, costed rollback window and tell users that a new QR may be required if WhatsApp or the user removes the old linked device.

Rollback triggers include:

- First-party availability/RTO breach or separately ratified candidate connected-time breach.
- Stable-message-identity mismatch or unexplained outbound duplicate.
- Event loss, unbounded outbox lag, or persistent directory divergence.
- Auth-state corruption, split ownership, or cross-tenant/security finding.
- Material increase in account restrictions, forced relinks, or support incidents.
- Emergency protocol incompatibility without a validated candidate rollback image.

Rollback procedure:

1. Stop new command creation for the cohort and fence candidate generation `n` before any Wasender dispatch.
2. Record candidate command and ingress watermarks, then drain or classify every generation-`n` command. Do not resend an ambiguous candidate operation through Wasender. Continue authenticated journaling of candidate callbacks under the draining generation.
3. Reconcile the retained Wasender session and authority. If healthy, create a new monotonically increasing generation `n+1` with `provider_kind = wasender`; never reactivate an earlier numeric generation or reuse its command/event fence.
4. Atomically activate generation `n+1`, assign new command and ingress watermarks, and leave candidate generation `n` draining or quarantined. Only candidate ingress already at or below the recorded cutoff may finish pre-fence convergence; callbacks above it cannot write authoritative state.
5. Replay only durably journaled inbound envelopes allowed by the generation and watermark rules. Preserve original deduplication identities and never synthesize sends.
6. Record an evidence-based Ingestion Gap for any measured failed enqueue, exhausted DLQ item, restore loss, or failed cutover interval. Do not infer one from inactivity. [I13]
7. Preserve candidate auth state and bounded diagnostics for root-cause analysis, subject to retention policy; do not delete evidence during the incident.
8. If Wasender is no longer linked, move the connection to reconnect-required and request a user QR rather than fabricating a successful rollback.

Rollback is cohort-scoped. A defect in one engine version or shard must not require flipping every account simultaneously.

## Risk Register

| Risk | Impact | Evidence/assessment | Mitigation and gate |
| --- | --- | --- | --- |
| WhatsApp terms/enforcement | Account restriction or ban; product interruption | WhatsApp says unofficial apps or linking to unofficial versions violates its Terms; the risk is shared by Wasender and every parity-preserving candidate. | Counsel and executive risk acceptance; consent/anti-abuse controls; staged cohorts; restriction telemetry; first-party Meta path if product can change. [L1] [L2] [W8] |
| Protocol churn | Fleet disconnect or feature break | Libraries reverse engineer/effectively track WhatsApp Web; recent releases contain frequent compatibility fixes. | Pin versions, protocol canaries, upstream monitoring, differential tests, previous-image rollback, funded maintenance owner. |
| Auth-state loss or theft | Forced relink or account takeover | Auth and Signal keys are mutable and sufficient to operate a linked device. | Per-connection envelope encryption, fenced revisions, least privilege, KMS audit, PITR, restore tests, secure deletion. |
| Split-brain owner | Duplicate sends and auth corruption | External WhatsApp socket cannot honor an internal fencing token. | Database-time lease, epoch checks, immediate close on loss, grace period, actor routing, partition/pause chaos gate. |
| Ambiguous send retry | Duplicate user-visible message | Network timeout does not prove rejection. | Preserve one-attempt ADR policy; exact stable-ID evidence only; no generic retry wrapper. [I1] [I4] |
| Event loss/duplication | Incorrect workflows and Message Store | WebSocket callbacks and webhook retries are at-least-once/volatile without a journal. | Durable outbox, stable semantic IDs, dedupe, bounded replay, lag alarms, failure injection. |
| Generation cutover | Dropped late evidence, duplicate sends, or two providers mutating authoritative state | Provider streams have no shared completeness watermark and may encode identities differently. | Immutable command generation, authenticated per-generation journals, ingress/command watermarks, bounded drain, exact-identity-only reconciliation, and evidence-based Ingestion Gaps. [I13] [I15] |
| Reconnect storm | Cascading CPU/DB/network failure | Thousands of sessions can disconnect together after an outage or rollout. | Cluster token bucket, jitter, cohort ramp, reserved reconnect capacity, 100% wave test. |
| Resource estimate error | Unexpected bill or capacity failure | No candidate has product-specific per-session measurements. | Full-gateway benchmark, p95/p99 sizing, fault-domain spare, tier-specific soak, cost sensitivity. |
| Copyleft/custom license | Source/commercial obligations or blocked distribution | MIT/MPL/Apache labels do not describe all transitive dependencies; WAHA and Evolution metadata add ambiguity. | SBOM and counsel review for exact binary/container/use; written clarification; no customer image before approval. |
| Opaque or drifting artifact | Unreviewed code executes with account credentials or benchmark results cannot be reproduced | WAHA examples float images/dependencies, and its reviewed image fetches unverified private GOWS. | Immutable source/dependency/image pins, provenance and SBOM; remove GOWS; omit WAHA if a compliant artifact cannot be built. [A8] [A9] [A10] [A11] |
| Ready-server attack surface | Remote compromise or data exposure | Broad admin, dashboard, integrations, arbitrary webhooks/media, and debug endpoints exceed the seam. | Private wrapper, disable unused modules/UI, network policy, least privilege, image scanning, focused thin gateway preference. |
| Privacy/data residency | Regulatory and contractual breach | Self-hosting moves message, contact, group, auth, and media processing into company systems. | Data map/DPIA as applicable, retention/deletion, regional design, encrypted stores/backups, access audit, subprocessor review. |
| Upstream maintainer concentration | Slow emergency fix or abandonment | Community projects provide no contractual emergency response by default. | Support contract where available, internal protocol expertise, fork policy, upstream contribution budget, second-engine exit option. |
| Migration relink burden | Customer churn and support load | Auth state is not portable; each account needs a fresh link. | Explicit UX, scheduled cohorts, validation before cutover, defined rollback window, support staffing. |

## Licensing Findings

This section is issue-spotting, not legal advice.

- Baileys declares MIT, while its current `package.json` directly depends on WhiskeySockets `libsignal`; that repository is GPL-3.0. [B2] [B3]
- whatsmeow declares MPL-2.0 and directly depends on `go.mau.fi/libsignal`; version `v0.2.2` resolves to `tulir/libsignal-protocol-go`, whose license is GPL-3.0. [X2] [X3]
- WuzAPI and GOWA declare MIT but compile against whatsmeow and the GPL-3.0 Signal implementation. A top-level MIT file does not answer the obligations for a combined binary or distributed container. [U2] [G2] [G3]
- WPPConnect Server declares Apache-2.0 but its core `@wppconnect-team/wppconnect` dependency declares LGPL-3.0-or-later. [P2] [P3]
- Evolution API calls itself Apache-2.0 but its license adds logo/copyright and usage-notification conditions and says failure can require a commercial license. Treat it as custom terms, not unmodified Apache-2.0. [E3]
- WAHA's repository license, package metadata, documentation, historical Plus text, multi-engine dependency set, and default inclusion of unlicensed/unproven GOWS are not internally consistent enough for an executable commercial pilot artifact without written clarification and a rebuilt NOWEB-only image. [A1] [A2] [A3] [A10] [A11]

GPL-3.0 distinguishes running software privately from conveying copies, but the consequence depends on how components are linked, modified, hosted, and distributed. Internal SaaS use, managed customer infrastructure, downloadable agents, and on-prem images can produce different analyses. Get written counsel; do not encode an assumed interpretation in architecture.

## Final Recommendation

Approve Phase 0 evidence collection only. Begin a time-boxed technical pilot after counsel approves the exact linked-device use, executives accept the shared account-loss risk, and each executable artifact passes its license and supply-chain gate.

The preferred potential end state is a small private WebSocket gateway built on the winning Baileys or whatsmeow implementation, surrounded by product-owned encrypted auth persistence, fenced leases, session actors, reconnect control, and a durable event outbox. Preserve the current five-capability adapter and its exact ambiguity/reconciliation semantics. Do not adopt a candidate's full public API as the domain contract.

Use WAHA only as a documentary packaged-server comparison until its license and build-provenance gates pass. If they pass, benchmark a source-built NOWEB-only image that excludes GOWS and unused engines. Do not screen or benchmark GOWS under the current evidence. If a compliant WAHA artifact cannot be produced, run the executable pilot with direct Baileys and direct whatsmeow only.

At each target tier:

- **100 accounts:** if the underlying linked-device use is approved, default to Wasender unless the current quote/terms are unacceptable or the pilot demonstrates a strategic control benefit. Cost savings alone are unlikely to absorb build and on-call labor.
- **1,000 accounts:** make the build-vs-buy decision from measured direct-WebSocket TCO and a real Wasender quote. This is the first tier where self-hosting may plausibly amortize.
- **10,000 accounts:** treat self-hosting as a dedicated messaging platform with 24x7 ownership, not a deployed open-source container. Do not launch based on linear extrapolation from a small test.

If linked accounts and existing groups cease to be hard requirements, stop this project and reassess Meta Cloud API. A first-party product model is operationally and policy-wise preferable when it can satisfy the actual use case.

Immediate actions:

1. Obtain the three Wasender enterprise quotes and written operational/data terms.
2. Send the finalist dependency/license matrix and exact deployment model to counsel.
3. Define and ratify the pilot workload, SLOs, economic margin, and rollback window.
4. Build the contract harness before any general REST gateway work.
5. Benchmark immutable Baileys and whatsmeow builds with encrypted state and the outbox included; add a source-built WAHA NOWEB-only image only if its license/provenance gates pass and the image excludes GOWS.
6. Rotate the live-looking Wasender credential in `/Users/cuevaio/projects/normal-poc/.env`. The file is ignored, untracked, absent from that repository's Git history, and the credential was not used during this research, but rotation is still the correct response.

## Sources

All external sources were accessed on 2026-07-30 unless a publication date is stated. Repository versions and mutable documentation should be rechecked when the pilot starts.

### Internal Repository

- **[I1]** Provider-neutral seam: [`docs/wasender-seam.md`](../wasender-seam.md)
- **[I2]** Capability types and policies: [`packages/wasender/src/control.ts`](../../packages/wasender/src/control.ts), [`packages/wasender/src/session.ts`](../../packages/wasender/src/session.ts), and [`packages/wasender/src/webhook.ts`](../../packages/wasender/src/webhook.ts)
- **[I3]** ADR 0004, platform-managed sessions: [`docs/adr/0004-platform-manage-wasender-sessions.md`](../adr/0004-platform-manage-wasender-sessions.md)
- **[I4]** ADR 0011, thin provider interface: [`docs/adr/0011-isolate-wasender-behind-a-thin-provider-interface.md`](../adr/0011-isolate-wasender-behind-a-thin-provider-interface.md)
- **[I5]** ADR 0019, reconciled provisioning saga: [`docs/adr/0019-provision-provider-sessions-with-a-reconciled-saga.md`](../adr/0019-provision-provider-sessions-with-a-reconciled-saga.md)
- **[I6]** Normal POC Wasender use: `/Users/cuevaio/projects/normal-poc/src/lib/wasender-api.ts`
- **[I7]** Normal POC webhook parsing: `/Users/cuevaio/projects/normal-poc/src/lib/whatsapp-webhook.ts`
- **[I8]** Normal POC message persistence: `/Users/cuevaio/projects/normal-poc/src/lib/message-store.ts`
- **[I9]** Personal Account connection/media limits and provider-capacity reservation: [`CONTEXT.md`](../../CONTEXT.md), [`packages/db/drizzle/0000_baseline.sql`](../../packages/db/drizzle/0000_baseline.sql), and [`packages/db/drizzle/0002_delegate_waitlist_to_clerk.sql`](../../packages/db/drizzle/0002_delegate_waitlist_to_clerk.sql)
- **[I10]** Private-beta availability, RTO, RPO, restore, deletion-marker, Stored Media, and provider-measurement objectives: [`docs/adr/0021-set-private-beta-recovery-objectives.md`](../adr/0021-set-private-beta-recovery-objectives.md) and [`infra/production/main.tf`](../../infra/production/main.tf)
- **[I11]** Current provider-control contract and Wasender-only production composition: [`packages/contracts/src/provider-control.ts`](../../packages/contracts/src/provider-control.ts), [`apps/provider-control/src/index.ts`](../../apps/provider-control/src/index.ts), [`apps/provider-control/src/rpc.ts`](../../apps/provider-control/src/rpc.ts), [`apps/provider-control/src/production.ts`](../../apps/provider-control/src/production.ts), and [`apps/provider-control/wrangler.jsonc`](../../apps/provider-control/wrangler.jsonc)
- **[I12]** Current schema, provisioning, deletion cleanup, and deployment topology: [`packages/db/migrations/0001_tenant_isolation.sql`](../../packages/db/migrations/0001_tenant_isolation.sql), [`packages/db/migrations/0008_connection_setup_provisioning.sql`](../../packages/db/migrations/0008_connection_setup_provisioning.sql), [`apps/api/src/connection-setup-provisioning.ts`](../../apps/api/src/connection-setup-provisioning.ts), [`apps/api/src/deletion/capsule.ts`](../../apps/api/src/deletion/capsule.ts), [`apps/api/src/production.ts`](../../apps/api/src/production.ts), [`apps/api/wrangler.jsonc`](../../apps/api/wrangler.jsonc), [`packages/domain/src/deployment.ts`](../../packages/domain/src/deployment.ts), and [`infra/compute/main.tf`](../../infra/compute/main.tf)
- **[I13]** Evidence-based Ingestion Gaps and durable encrypted ingress: [`docs/adr/0022-record-only-evidence-based-ingestion-gaps.md`](../adr/0022-record-only-evidence-based-ingestion-gaps.md) and [`docs/adr/0005-durably-enqueue-encrypted-webhooks.md`](../adr/0005-durably-enqueue-encrypted-webhooks.md)
- **[I14]** Highest-available-boundary test policy: [`docs/testing.md`](../testing.md)
- **[I15]** Exact stable-identity convergence: [`docs/adr/0017-converge-provider-events-by-type.md`](../adr/0017-converge-provider-events-by-type.md)
- Supporting first-party Wasender/Meta notes: [`.wasender-meta-primary-sources.md`](.wasender-meta-primary-sources.md)

### WasenderAPI

- **[W1]** Home and live pricing: https://wasenderapi.com/
- **[W2]** API documentation index: https://wasenderapi.com/api-docs
- **[W3]** Getting started and linked-device QR flow: https://wasenderapi.com/api-docs/getting-started/getting-started-with-wasenderapi
- **[W4]** Authentication: https://wasenderapi.com/api-docs/authentication/how-to-authenticate-api-requests-using-personal-access-token and https://wasenderapi.com/api-docs/authentication/how-to-authenticate-api-requests-using-bearer-tokens
- **[W6]** Rate limits: https://wasenderapi.com/api-docs/rate-limits/understanding-rate-limits
- **[W7]** Webhook setup: https://wasenderapi.com/api-docs/webhooks/webhook-setup
- **[W8]** Terms of Service: https://wasenderapi.com/terms
- **[W9]** Privacy Policy: https://wasenderapi.com/privacy
- **[W12]** Wasender architecture article stating managed Baileys sockets, queueing, reconnect, and webhook claims, published 2026-07-17: https://wasenderapi.com/blog/evolution-api-in-production-architecture-guide-for-scaling-multi-tenant-saas

### Meta / WhatsApp

- **[M1]** Platform overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform
- **[M2]** Cloud API hosting/support: https://developers.facebook.com/documentation/business-messaging/whatsapp/support
- **[M4]** Business phone numbers: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers
- **[M6]** Business App Coexistence: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- **[M7]** Messages and customer-service window: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- **[M8]** Groups API: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups
- **[M9]** Groups pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/pricing
- **[M10]** Official Business Accounts: https://developers.facebook.com/documentation/business-messaging/whatsapp/official-business-accounts
- **[M11]** Platform pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- **[M13]** Webhooks overview and delivery behavior: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
- **[M14]** Webhook endpoint, authentication, and retry behavior: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
- **[M16]** 2026 AI Provider pricing policy: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers

### WhatsApp Legal and Policy

- **[L1]** Unofficial-app FAQ: https://faq.whatsapp.com/1217634902127718
- **[L2]** Ordinary WhatsApp Terms of Service, page displayed `Effective Date: January 4, 2021` and linked separate European Region terms: https://www.whatsapp.com/legal/terms-of-service
- **[L3]** WhatsApp Business Solution Terms, page displayed `Last Modified: March 6, 2026`: https://www.whatsapp.com/legal/business-solution-terms

### Baileys and whatsmeow

- **[B1]** Baileys `v7.0.0-rc14` README and production auth-state warnings at commit `7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a`: https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/README.md
- **[B2]** Baileys `package.json` and MIT license at the same commit: https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/package.json and https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/LICENSE
- **[B3]** npm `libsignal@6.0.0` metadata resolving to WhiskeySockets `libsignal-node` commit `bcea72df9ec34d9d9140ab30619cf479c7c144c7`, and its GPL-3.0 license: https://registry.npmjs.org/libsignal/6.0.0 and https://github.com/WhiskeySockets/libsignal-node/blob/bcea72df9ec34d9d9140ab30619cf479c7c144c7/LICENSE
- **[B4]** Baileys `v7.0.0-rc14` release, published 2026-07-29: https://github.com/WhiskeySockets/Baileys/releases/tag/v7.0.0-rc14
- **[X1]** whatsmeow README/features at observed commit `662ad1dc6900ffe1b1a2a6bc0fca01cba488d747`: https://github.com/tulir/whatsmeow/blob/662ad1dc6900ffe1b1a2a6bc0fca01cba488d747/README.md
- **[X2]** whatsmeow module and MPL-2.0 license at the same commit: https://github.com/tulir/whatsmeow/blob/662ad1dc6900ffe1b1a2a6bc0fca01cba488d747/go.mod and https://github.com/tulir/whatsmeow/blob/662ad1dc6900ffe1b1a2a6bc0fca01cba488d747/LICENSE
- **[X3]** `go.mau.fi/libsignal` source resolution and GPL-3.0 license: https://proxy.golang.org/go.mau.fi/libsignal/@v/v0.2.2.info and https://github.com/tulir/libsignal-protocol-go/blob/v0.2.2/LICENSE
- **[X4]** whatsmeow SQL device store at the same commit: https://github.com/tulir/whatsmeow/tree/662ad1dc6900ffe1b1a2a6bc0fca01cba488d747/store/sqlstore

### Packaged Servers and Browser Options

- **[A1]** WAHA `2026.7.2` README at commit `79233e09e34831b0ce23223d89b36e49b3024fd9`: https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/README.md
- **[A2]** WAHA package metadata and dependencies at the same commit: https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/package.json
- **[A3]** WAHA Apache-2.0 `LICENSE` at the same commit: https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/LICENSE
- **[A4]** WAHA current free/Core and former Plus documentation: https://waha.devlike.pro/docs/how-to/waha-plus/
- **[A5]** WAHA engines, sessions, and storage docs: https://waha.devlike.pro/docs/engines/, https://waha.devlike.pro/docs/how-to/sessions/, and https://waha.devlike.pro/docs/how-to/storages/
- **[A6]** WAHA events, HMAC, and webhook retry docs: https://waha.devlike.pro/docs/how-to/events/
- **[A7]** WAHA `2026.7.2` release, published 2026-07-29: https://github.com/devlikeapro/waha/releases/tag/2026.7.2
- **[A8]** WAHA tag commit, locked Baileys dependency, exact locked commit, and observed mutable-branch head: https://github.com/devlikeapro/waha/commit/79233e09e34831b0ce23223d89b36e49b3024fd9, https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/yarn.lock, https://github.com/devlikeapro/Baileys/commit/0124c8f073719727fb8db2b08d4b14b81573d82c, and https://github.com/devlikeapro/Baileys/commit/31458e2289c14107b9526ab93eb0ce655b3855d1
- **[A9]** WAHA floating image examples at the pinned commit: https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/README.md, https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/docker-compose.yaml, and https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/docker-compose/docker-compose.workers.yaml
- **[A10]** Public GOWS repository snapshot `ceed2a32285ae3c0c4e553decc4425451e203754`, which labels itself a binary repository, points source users to private `gows-plus`, and contains no public license file: https://github.com/devlikeapro/gows/tree/ceed2a32285ae3c0c4e553decc4425451e203754 and https://github.com/devlikeapro/gows/blob/ceed2a32285ae3c0c4e553decc4425451e203754/README.md
- **[A11]** WAHA Dockerfile and GOWS configuration at the pinned commit: https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/Dockerfile and https://github.com/devlikeapro/waha/blob/79233e09e34831b0ce23223d89b36e49b3024fd9/waha.config.json
- **[U1]** WuzAPI README/features/operations at observed commit `6b5bd4a2e1dfae610f4a75e8651c64c63ea10c46`: https://github.com/asternic/wuzapi/blob/6b5bd4a2e1dfae610f4a75e8651c64c63ea10c46/README.md
- **[U2]** WuzAPI module and MIT license at the same commit: https://github.com/asternic/wuzapi/blob/6b5bd4a2e1dfae610f4a75e8651c64c63ea10c46/go.mod and https://github.com/asternic/wuzapi/blob/6b5bd4a2e1dfae610f4a75e8651c64c63ea10c46/LICENSE
- **[G1]** GOWA `v9.0.0` README and API/event surface at commit `727e08a02cfa806907267c791397fbb9d522426a`: https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/727e08a02cfa806907267c791397fbb9d522426a/readme.md
- **[G2]** GOWA module and MIT license at the same commit: https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/727e08a02cfa806907267c791397fbb9d522426a/src/go.mod and https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/727e08a02cfa806907267c791397fbb9d522426a/LICENCE.txt
- **[G3]** GOWA `v9.0.0` release, published 2026-07-19: https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/tag/v9.0.0
- **[E1]** Evolution API README at observed commit `fa09d37892cdbb1d65a250155d293d92230c5b30`: https://github.com/EvolutionAPI/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/README.md
- **[E2]** Evolution API package metadata at the same commit: https://github.com/EvolutionAPI/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/package.json
- **[E3]** Evolution API custom license text at the same commit: https://github.com/EvolutionAPI/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/LICENSE
- **[E4]** Evolution API `v2.3.7` release, published 2025-12-05: https://github.com/evolution-foundation/evolution-api/releases/tag/2.3.7
- **[P1]** WPPConnect Server `v2.10.1` README at commit `997164f0307501f32ebfa68619788f9e1827b29c`: https://github.com/wppconnect-team/wppconnect-server/blob/997164f0307501f32ebfa68619788f9e1827b29c/README.md
- **[P2]** WPPConnect Server package and Apache-2.0 license at the same commit: https://github.com/wppconnect-team/wppconnect-server/blob/997164f0307501f32ebfa68619788f9e1827b29c/package.json and https://github.com/wppconnect-team/wppconnect-server/blob/997164f0307501f32ebfa68619788f9e1827b29c/LICENSE
- **[P3]** WPPConnect core package declaring LGPL-3.0-or-later at observed commit `e1d55b6ad973d2c114145388802c31a58e19f6d0`: https://github.com/wppconnect-team/wppconnect/blob/e1d55b6ad973d2c114145388802c31a58e19f6d0/package.json
- **[P4]** WPPConnect Server `v2.10.1` release, published 2026-07-30: https://github.com/wppconnect-team/wppconnect-server/releases/tag/v2.10.1
- **[J1]** whatsapp-web.js `v1.34.7` README, features, runtime, warning, and license at commit `f935b500117e264c2b3abc25b63a280bd98182a7`: https://github.com/wwebjs/whatsapp-web.js/blob/f935b500117e264c2b3abc25b63a280bd98182a7/README.md
- **[J2]** whatsapp-web.js package metadata at the same commit: https://github.com/wwebjs/whatsapp-web.js/blob/f935b500117e264c2b3abc25b63a280bd98182a7/package.json
- **[J3]** whatsapp-web.js `v1.34.7` release, published 2026-04-24: https://github.com/wwebjs/whatsapp-web.js/releases/tag/v1.34.7
