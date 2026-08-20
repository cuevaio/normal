# WasenderAPI Send-Text Recipient Addressing

- **Research and access date:** 2026-08-20
- **Repository basis:** `74b0101` plus the Direct Address implementation recorded in ADR 0033
- **Scope:** Official WasenderAPI documentation and the current Normal repository only. No live sends were made.

## Conclusion

WasenderAPI's current `POST /api/send-message` send-text page explicitly documents four `to` destination classes: an E.164 phone number, a WhatsApp username handle such as `@jane_doe`, a Group JID, or a Community Channel JID. [W1] The public docs do **not** publish a complete validation grammar or length limits for these values. Consequently, the strongest supportable answer is the documented classes and examples below, not a vendor-guaranteed regex.

| Destination | Send-text support established by official docs | Documented form |
| --- | --- | --- |
| Direct phone number | Yes | E.164; send-text uses `+1234567890` as its request example. [W1] |
| WhatsApp username | Yes | Leading `@`, for example `@jane_doe`; no allowed-character or length rule is published. [W1] |
| Group | Yes | The group's JID in `to`; obtain it from `GET /api/groups`. The linked official SDK documentation illustrates `1234567890-1234567890@g.us`. [W2] [W3] |
| Community Channel / newsletter | Yes | Channel JID such as `123456789@newsletter`; obtain it from a channel message's `jid`. A newsletter webhook example also shows `123456789-987654321@newsletter`, so the numeric prefix is not documented as a single fixed shape. [W4] [W5] |
| Phone-number JID (`...@s.whatsapp.net`) | Not established for basic send-text | The adjacent quoted-message page broadly permits a "WhatsApp JID," and lookup endpoints accept phone-number JIDs, but the basic send-text page does not list this form. [W1] [W6] [W7] |
| LID JID (`...@lid`) | Not established for basic send-text | WasenderAPI explicitly accepts LIDs for contact lookup/resolution endpoints, but none of the reviewed send-text, group-send, or channel-send pages explicitly says that `to` accepts a LID. Lookup acceptance is not evidence of send acceptance. [W7] [W8] |
| Normal opaque handles (`ctc_...`, `grp_...`) | No, not at the provider API | These are Normal public handles resolved internally before the provider request. [I1] [I2] |

## Formatting And Constraints

- The request is JSON to `POST https://www.wasenderapi.com/api/send-message`, authenticated with a session-specific Bearer API key. For a basic text send, `to` and `text` are required strings. [W1] [W9]
- WasenderAPI labels phone input as E.164 and its endpoint example includes `+`. However, its getting-started example sends bare digits (`212612345678`). This is an official-doc inconsistency; use the endpoint page's explicit E.164 form rather than treating bare digits as a documented contract. [W1] [W9]
- The reviewed first-party pages specify no minimum/maximum `to` length, username grammar, normative Group/Channel JID grammar, text length, Unicode normalization rule, or blank-text rule. The generic error page only demonstrates required-field errors for `to` and `text`. [W1] [W10]
- A Group JID must identify a group the connected account is in: `GET /api/groups` lists current groups and their `jid`, and the group-send page directs callers to use that returned ID. [W2] [W11]
- A Channel JID is discovered from the `jid` in a channel `message.upsert`/newsletter event and then used unchanged in `to`. [W4] [W5]
- Send-message rate limits are per endpoint per session: trial is 1 request/minute and 50/day; paid plans are 256/minute with no documented daily cap; paid account-protection mode overrides this to 1 request per 5 seconds. A separate unpublished concurrent-request cap also applies per session. [W12]

## Current Normal Semantics

Normal now exposes provider-neutral handles plus bounded Direct Addresses:

- Public MCP and REST sends accept exactly one `recipient_id`, E.164 `phone`, or bounded `@username`, scoped to an explicit `connection_id`. They still reject provider JIDs, channel identifiers, and conversation handles. [I1] [I2] [I3]
- A handle send requires an active contact or currently joined group in that connection's latest WhatsApp Directory projection. A Direct Address need not exist in the Directory. Neither form needs an already-observed WhatsApp Conversation. [I1]
- Normal text is independently constrained to 1-4,096 Unicode scalar values, must contain a value outside Unicode 17.0 `White_Space`, rejects unpaired surrogates, and is preserved without trimming or normalization. These are Normal contract rules, not constraints found in WasenderAPI's public send-text documentation. [I1] [I4]
- Internally, the current Wasender adapter accepts public E.164 phone input with 2-15 digits after `+`, legacy Directory phone locators with 7-15 digits, a phone-number JID ending `@s.whatsapp.net`, or a numeric LID ending `@lid`; group locators must end `@g.us`. It normalizes a phone number or phone-number JID to `+digits`, passes a username, LID, or Group JID through, then sends exactly `{ "to": providerRecipient, "text": text }`. [I5]
- The adapter accepts WasenderAPI's documented `@username` destination but not `@newsletter`. A username response resolved to a JID is acknowledgement-only unless exact recipient identity can be verified. Public Normal semantics continue to exclude channels. [I1] [I5]

The LID point should be treated cautiously: repository support is implementation behavior, while current official WasenderAPI docs do not promise LID send-text acceptance. A production decision that depends on direct LID sends needs vendor confirmation or a controlled non-production probe.

## Sources

All external sources are first-party WasenderAPI pages accessed on 2026-08-20. WasenderAPI itself labels the linked Node.js SDK official. [W3]

- **[W1]** [Send Text Message](https://wasenderapi.com/api-docs/messages/send-text-message)
- **[W2]** [Send Group Message](https://wasenderapi.com/api-docs/groups/send-group-message)
- **[W3]** [Official SDKs](https://wasenderapi.com/api-docs/developer-sdks/official-sdks-nodejs-python-laravel) and linked [official Node.js SDK message examples](https://github.com/AroraShreshth/wasender/blob/main/docs/messages.md)
- **[W4]** [Send Channel Message](https://wasenderapi.com/api-docs/channels-communities/send-channel-message)
- **[W5]** [Webhook: Newsletter Message Received](https://wasenderapi.com/api-docs/webhooks/webhook-newsletter-message-received)
- **[W6]** [Send Quoted Message](https://wasenderapi.com/api-docs/messages/send-quoted-message)
- **[W7]** [Check if a contact is on WhatsApp](https://wasenderapi.com/api-docs/sessions/check-if-a-contact-is-on-whatsapp)
- **[W8]** [Get LID from Phone Number](https://wasenderapi.com/api-docs/contacts/get-lid-from-phone-number) and [Get Phone Number from LID](https://wasenderapi.com/api-docs/contacts/get-phone-number-from-lid)
- **[W9]** [Getting Started with WasenderAPI](https://wasenderapi.com/api-docs/getting-started/getting-started-with-wasenderapi)
- **[W10]** [Error Responses](https://wasenderapi.com/api-docs/responses-errors/error-responses)
- **[W11]** [Get All Groups](https://wasenderapi.com/api-docs/groups/get-all-groups)
- **[W12]** [Understanding Rate Limits](https://wasenderapi.com/api-docs/rate-limits/understanding-rate-limits)
- **[I1]** [`docs/mcp-contract.md`](../mcp-contract.md#send_text_message)
- **[I2]** [`packages/contracts/src/handles.ts`](../../packages/contracts/src/handles.ts)
- **[I3]** [`packages/contracts/src/rest.ts`](../../packages/contracts/src/rest.ts)
- **[I4]** [`docs/adr/0006-do-not-retry-ambiguous-sends.md`](../adr/0006-do-not-retry-ambiguous-sends.md)
- **[I5]** [`packages/wasender/src/text-send.ts`](../../packages/wasender/src/text-send.ts)
