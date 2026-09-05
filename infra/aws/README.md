# AWS encryption infrastructure

`main.tf` is the OpenTofu entry point and manages `kms.template.json` as one
CloudFormation stack per environment. Production also uses the separate
`content-credential-broker.template.json` and
`deletion-credential-broker.template.json` stacks to rotate isolated runtime
sessions, and manages the purpose-specific
`mcp-smoke-credential.template.json` and `recovery-game-day.template.json`
stacks. The KMS template
declares two non-exportable,
single-Region symmetric KMS keys and six separated IAM authorities. Deploy it
only in `us-east-1`; both OpenTofu and the template enforce that region.

- `ContentRuntimeRole` can generate and decrypt only Personal Account data keys
  carrying the exact environment/account/purpose/version encryption context.
- The same role can encrypt, but cannot decrypt, Deletion Capsules.
- `DeletionCoordinatorRole` can decrypt only Deletion Capsules and is
  explicitly denied tenant-content decryption.
- `ProviderControlRole` and `OrdinaryOperatorRole` are explicitly denied
  decryption.
- `KmsAdministratorRole` can manage lifecycle and policy but receives no
  cryptographic operation.
- `BreakGlassRole` can decrypt a Personal Account key only from an MFA-backed,
  one-hour-or-shorter session whose `personalAccountId` tag exactly equals the
  KMS encryption context. Its separate request ID tag binds CloudTrail evidence
  to the immutable database audit. No application runtime assumes this role.

The owning AWS account principal has the same non-cryptographic lifecycle
permissions as an emergency recovery path, preventing a retained key from
becoming unmanageable if the named administrator role is lost. It does not
receive Encrypt, Decrypt, GenerateDataKey, or ReEncrypt permission from either
key policy.

Every role trusts a different parameterized bootstrap principal. OpenTofu and
the CloudFormation template reject reuse of one principal across authorities.
The caller must grant each bootstrap principal `sts:AssumeRole` for only its
matching role; this configuration does not create or broaden those external
identities.

Both keys enable automatic rotation, use a 30-day pending-deletion window, and
are retained when the stack is deleted or replaced. See the deployment runbook
for remote-state requirements, validation, deployment, credential delivery,
monitoring, and rollback.

The MCP smoke stack creates one retained Secrets Manager secret and one GitHub
OIDC role restricted to that secret. The secret has no generated value: an
operator bootstraps the current refresh credential out of band so plaintext
never enters source, OpenTofu input, plans, or state.

The recovery game-day stack creates a separate rotating KMS key and a GitHub
OIDC role restricted to the `production-recovery` environment. Its only
cryptographic authority is GenerateDataKey/Decrypt with the exact
`production`/`recovery-game-day`/operation encryption context. The quarterly
workflow obtains one-hour sessions directly through GitHub OIDC and refreshes
the private game-day Worker's complete AWS binding set at most every twenty
minutes until the drill finishes. The Worker never receives OIDC authority.
