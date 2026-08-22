"use client";

import { useAuth, useReverification } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  FormOverlay,
  FormOverlayBody,
  FormOverlayClose,
  FormOverlayContent,
  FormOverlayDescription,
  FormOverlayFooter,
  FormOverlayHeader,
  FormOverlayTitle,
  FormOverlayTrigger,
} from "@/components/ui/form-overlay";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { queryKeys } from "@/lib/query/keys";
import {
  type ApiKeyRecord,
  apiKeySummaryFromCreated,
  applyApiKeyRevocation,
  createApiKey,
  fetchApiKeys,
  fetchConnections,
  revokeApiKey,
  selectableConnections,
  upsertApiKey,
} from "@/lib/query/resources";

const PERMISSIONS = [
  { id: "connections:read", label: "Connection metadata" },
  { id: "directory:read", label: "WhatsApp Directory" },
  { id: "messages:read", label: "Stored Messages" },
  { id: "messages:send", label: "Send messages" },
] as const;

interface RevealedApiKey {
  readonly connectionIds: ReadonlyArray<string>;
  readonly credential: string;
  readonly permissions: ReadonlyArray<string>;
}

const SEND_PHONE_PATTERN = /^\+[1-9][0-9]{1,14}$/u;

const displayTime = (value: string): string =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));

const toggle = (
  selected: ReadonlyArray<string>,
  value: string,
  checked: boolean,
): ReadonlyArray<string> =>
  checked ? [...selected, value] : selected.filter((item) => item !== value);

export function ApiKeysPanel({
  apiKeysEndpoint,
  clerkJwtTemplate,
  connectionsEndpoint,
}: {
  readonly apiKeysEndpoint: string;
  readonly clerkJwtTemplate: string;
  readonly connectionsEndpoint: string;
}) {
  const apiOrigin = new URL(apiKeysEndpoint).origin;
  const mcpEndpoint = `${apiOrigin}/mcp`;
  const { getToken, isLoaded } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<ReadonlyArray<string>>([]);
  const [selectedConnections, setSelectedConnections] = useState<
    ReadonlyArray<string>
  >([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [revealed, setRevealed] = useState<RevealedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [curlConnectionId, setCurlConnectionId] = useState("");
  const [includeApiKey, setIncludeApiKey] = useState(false);
  const [recipientPhone, setRecipientPhone] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const readAccessToken = async () => {
    if (!isLoaded) return null;
    return getToken({ template: clerkJwtTemplate });
  };

  const keysQuery = useQuery({
    enabled: isLoaded,
    queryFn: async () => {
      const token = await readAccessToken();
      if (!token) throw new Error("signed out");
      return fetchApiKeys(apiKeysEndpoint, token);
    },
    queryKey: queryKeys.apiKeys(),
  });
  const connectionsQuery = useQuery({
    enabled: isLoaded,
    queryFn: async () => {
      const token = await readAccessToken();
      if (!token) throw new Error("signed out");
      return fetchConnections(connectionsEndpoint, token);
    },
    queryKey: queryKeys.connections(),
  });

  const keys = keysQuery.data ?? [];
  const connections = selectableConnections(connectionsQuery.data ?? []);
  const creating = useMutation({
    mutationFn: async () => {
      const token = await getToken({ skipCache: true });
      if (!token) throw new Error("token unavailable");
      return createApiKey({
        body: {
          connection_ids: selectedConnections,
          ...(expiresAt === ""
            ? {}
            : { expires_at: new Date(expiresAt).toISOString() }),
          name,
          permissions,
        },
        endpoint: apiKeysEndpoint,
        token,
      });
    },
    onSuccess: (result) => {
      if (!("ok" in result) || !result.ok) return;
      queryClient.setQueryData(
        queryKeys.apiKeys(),
        (current: ReadonlyArray<ApiKeyRecord> | undefined) =>
          upsertApiKey(current, apiKeySummaryFromCreated(result.created)),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
    },
  });
  const submitCreate = useReverification(() => creating.mutateAsync());
  const revokeMutation = useMutation({
    mutationFn: async (key: ApiKeyRecord) => {
      const token = await readAccessToken();
      if (!token) throw new Error("signed out");
      return revokeApiKey({
        endpoint: apiKeysEndpoint,
        id: key.id,
        token,
      });
    },
    onSuccess: (revoked) => {
      queryClient.setQueryData(
        queryKeys.apiKeys(),
        (current: ReadonlyArray<ApiKeyRecord> | undefined) =>
          applyApiKeyRevocation(current, revoked),
      );
    },
  });

  const create = async () => {
    setCopied(false);
    setCreateError(null);
    try {
      const result = await submitCreate();
      if (!("ok" in result)) {
        setCreateError("API Key creation was cancelled or failed. Try again.");
        return;
      }
      if (!result.ok) {
        if (result.error === "duplicate_name") {
          setCreateError("An active API Key already uses this name.");
          return;
        }
        if (result.error === "limit_reached") {
          setCreateError(
            "This Personal Account already has ten active API Keys.",
          );
          return;
        }
        if (result.error === "invalid") {
          setCreateError(
            "Check the name, permissions, Connections, and expiry.",
          );
          return;
        }
        setCreateError("API Key creation was cancelled or failed. Try again.");
        return;
      }
      setRevealed({
        connectionIds: selectedConnections,
        credential: result.created.credential,
        permissions,
      });
      setCurlConnectionId(selectedConnections[0] ?? "");
      setCurlCopied(false);
      setIncludeApiKey(false);
      setRecipientPhone("");
      setName("");
      setPermissions([]);
      setSelectedConnections([]);
      setExpiresAt("");
      setCreateDialogOpen(false);
      toast.success("API Key created");
    } catch {
      setCreateError("API Key creation was cancelled or failed. Try again.");
    }
  };

  const revoke = async (key: ApiKeyRecord) => {
    try {
      await revokeMutation.mutateAsync(key);
    } catch {
      if (revealed === null && keysQuery.data === undefined) {
        return;
      }
    }
  };

  const copyCredential = async () => {
    if (revealed === null) return;
    await navigator.clipboard.writeText(revealed.credential);
    setCopied(true);
  };

  const curlCommand =
    revealed === null || curlConnectionId === ""
      ? ""
      : `curl --request POST \\
  '${apiOrigin}/v1/connections/${curlConnectionId}/send-operations' \\
  --header "Authorization: Bearer ${includeApiKey ? revealed.credential : "$NORMAL_API_KEY"}" \\
  --header 'Content-Type: application/json' \\
  --header "Idempotency-Key: $(openssl rand -base64 32 | tr -dc 'A-Za-z0-9_-' | head -c 21)" \\
  --data '${JSON.stringify(
    {
      phone: SEND_PHONE_PATTERN.test(recipientPhone)
        ? recipientPhone
        : "<RECIPIENT_PHONE>",
      text: "Hello from Normal API",
    },
    null,
    2,
  )}'`;

  const copyCurl = async () => {
    if (!SEND_PHONE_PATTERN.test(recipientPhone) || curlCommand === "") return;
    await navigator.clipboard.writeText(curlCommand);
    setCurlCopied(true);
  };

  const initialUnavailable =
    (keysQuery.isError && keysQuery.data === undefined) ||
    (connectionsQuery.isError && connectionsQuery.data === undefined);
  const ready =
    keysQuery.data !== undefined && connectionsQuery.data !== undefined;
  const canCreate =
    ready &&
    name.trim().length > 0 &&
    permissions.length > 0 &&
    selectedConnections.length > 0 &&
    !creating.isPending;

  return (
    <section aria-label="API Keys" className="flex flex-col gap-8">
      <p className="text-sm text-muted-foreground">
        Server-side credentials for REST and compatible MCP Clients. The
        plaintext is shown once; revocation ends access through both adapters.
      </p>

      <section className="flex flex-col gap-2 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <p className="text-sm font-medium">Hermes MCP configuration</p>
        <p className="text-sm text-muted-foreground">
          Store the credential as <code>NORMAL_API_KEY</code> in Hermes&apos;
          <code> ~/.hermes/.env</code>, then add this to
          <code> ~/.hermes/config.yaml</code>. Keep the server untrusted so
          every outbound tool call still requires confirmation.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs">
          <code>{`mcp_servers:
  normal:
    url: ${mcpEndpoint}
    headers:
      Authorization: "Bearer \${NORMAL_API_KEY}"
    trust: untrusted`}</code>
        </pre>
      </section>

      {!isLoaded ||
      (!ready &&
        !initialUnavailable &&
        (keysQuery.isPending || connectionsQuery.isPending)) ? (
        <p aria-live="polite">Loading API Keys…</p>
      ) : initialUnavailable ? (
        <p aria-live="polite">API Keys are temporarily unavailable.</p>
      ) : (
        <>
          {revealed !== null ? (
            <section
              aria-label="New API Key credential"
              className="flex flex-col gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
            >
              <p className="text-sm font-medium">Copy this API Key now</p>
              <p className="font-mono text-sm break-all">
                {revealed.credential}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void copyCredential()} type="button">
                  {copied ? "Copied" : "Copy API Key"}
                </Button>
                <Button
                  onClick={() => {
                    setRevealed(null);
                    setCopied(false);
                    setCurlCopied(false);
                  }}
                  type="button"
                  variant="outline"
                >
                  I have copied this API Key
                </Button>
              </div>
              {revealed.permissions.includes("messages:send") ? (
                <div className="mt-2 flex flex-col gap-4 border-t pt-5">
                  <div>
                    <p className="text-sm font-medium">
                      Send your first message
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Enter a recipient, then copy and run this command in your
                      terminal.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="curl-connection">
                        WhatsApp Connection
                      </FieldLabel>
                      <Select
                        onValueChange={(value) => {
                          setCurlConnectionId(value ?? "");
                          setCurlCopied(false);
                        }}
                        value={curlConnectionId}
                      >
                        <SelectTrigger className="w-full" id="curl-connection">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {revealed.connectionIds.map((connectionId) => {
                            const connection = connections.find(
                              (item) => item.id === connectionId,
                            );
                            return (
                              <SelectItem
                                key={connectionId}
                                value={connectionId}
                              >
                                {connection?.displayName ?? connectionId}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="curl-recipient-phone">
                        Recipient phone
                      </FieldLabel>
                      <Input
                        aria-invalid={
                          recipientPhone !== "" &&
                          !SEND_PHONE_PATTERN.test(recipientPhone)
                        }
                        id="curl-recipient-phone"
                        onChange={(event) => {
                          setRecipientPhone(event.target.value);
                          setCurlCopied(false);
                        }}
                        placeholder="+12025550199"
                        type="tel"
                        value={recipientPhone}
                      />
                    </Field>
                  </div>
                  <FieldLabel>
                    <Field orientation="horizontal">
                      <Checkbox
                        checked={includeApiKey}
                        onCheckedChange={(checked) => {
                          setIncludeApiKey(checked === true);
                          setCurlCopied(false);
                        }}
                      />
                      Include API Key in command
                    </Field>
                  </FieldLabel>
                  <section aria-label="Send message curl command">
                    <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs">
                      <code>{curlCommand}</code>
                    </pre>
                  </section>
                  <Button
                    disabled={!SEND_PHONE_PATTERN.test(recipientPhone)}
                    onClick={() => void copyCurl()}
                    type="button"
                  >
                    {curlCopied ? "Copied cURL" : "Copy cURL"}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                Your API Keys
              </h2>
              <p className="text-sm text-muted-foreground">
                Revoke a key to end access through REST and compatible MCP
                Clients.
              </p>
            </div>
            <FormOverlay
              onOpenChange={(open) => {
                setCreateDialogOpen(open);
                if (open) {
                  setCreateError(null);
                }
              }}
              open={createDialogOpen}
            >
              <FormOverlayTrigger render={<Button />}>
                Create API Key
              </FormOverlayTrigger>
              <FormOverlayContent>
                <FormOverlayHeader>
                  <FormOverlayTitle>Create an API Key</FormOverlayTitle>
                  <FormOverlayDescription>
                    Choose a unique name, permissions, and the WhatsApp
                    Connections this credential may use. The plaintext is shown
                    once.
                  </FormOverlayDescription>
                </FormOverlayHeader>
                <form
                  className="contents"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                >
                  <FormOverlayBody className="flex flex-col gap-5">
                    <Field>
                      <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
                      <Input
                        id="api-key-name"
                        maxLength={64}
                        onChange={(event) => setName(event.target.value)}
                        value={name}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="api-key-expiry">
                        Expires (optional)
                      </FieldLabel>
                      <Input
                        id="api-key-expiry"
                        onChange={(event) => setExpiresAt(event.target.value)}
                        type="datetime-local"
                        value={expiresAt}
                      />
                    </Field>
                    <FieldSet>
                      <FieldLegend>Permissions</FieldLegend>
                      <FieldGroup>
                        {PERMISSIONS.map((permission) => (
                          <FieldLabel key={permission.id}>
                            <Field orientation="horizontal">
                              <Checkbox
                                checked={permissions.includes(permission.id)}
                                onCheckedChange={(checked) =>
                                  setPermissions(
                                    toggle(
                                      permissions,
                                      permission.id,
                                      checked === true,
                                    ),
                                  )
                                }
                              />
                              {permission.label}
                            </Field>
                          </FieldLabel>
                        ))}
                      </FieldGroup>
                    </FieldSet>
                    <FieldSet>
                      <FieldLegend>WhatsApp Connections</FieldLegend>
                      <FieldGroup>
                        {connections.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            Connect a WhatsApp account before creating an API
                            Key.
                          </p>
                        ) : (
                          connections.map((connection) => (
                            <FieldLabel
                              aria-label={`${connection.displayName}, ending in ${connection.numberSuffix}`}
                              key={connection.id}
                            >
                              <Field orientation="horizontal">
                                <Checkbox
                                  checked={selectedConnections.includes(
                                    connection.id,
                                  )}
                                  onCheckedChange={(checked) =>
                                    setSelectedConnections(
                                      toggle(
                                        selectedConnections,
                                        connection.id,
                                        checked === true,
                                      ),
                                    )
                                  }
                                />
                                <span>{connection.displayName}</span>
                                <span className="font-mono text-sm text-muted-foreground">
                                  ending in {connection.numberSuffix}
                                  {connection.state === "disconnected"
                                    ? " · disconnected"
                                    : ""}
                                </span>
                              </Field>
                            </FieldLabel>
                          ))
                        )}
                      </FieldGroup>
                    </FieldSet>
                    {createError === null ? null : (
                      <p
                        aria-live="polite"
                        className="text-sm text-muted-foreground"
                      >
                        {createError}
                      </p>
                    )}
                  </FormOverlayBody>
                  <FormOverlayFooter>
                    <FormOverlayClose render={<Button variant="outline" />}>
                      Cancel
                    </FormOverlayClose>
                    <Button disabled={!canCreate} type="submit">
                      {creating.isPending ? (
                        <Spinner data-icon="inline-start" />
                      ) : null}
                      Create API Key
                    </Button>
                  </FormOverlayFooter>
                </form>
              </FormOverlayContent>
            </FormOverlay>
          </div>

          {keys.length === 0 ? (
            <p>No API Keys yet.</p>
          ) : (
            <div className="rounded-xl border bg-card">
              <Table className="min-w-6xl">
                <TableHeader className="bg-muted/40 text-xs text-muted-foreground">
                  <TableRow>
                    <TableHead className="px-4">API Key</TableHead>
                    <TableHead className="px-4">Status</TableHead>
                    <TableHead className="px-4">Created</TableHead>
                    <TableHead className="px-4">Expires</TableHead>
                    <TableHead className="px-4">Last used</TableHead>
                    <TableHead className="px-4">Permissions</TableHead>
                    <TableHead className="px-4">Connections</TableHead>
                    <TableHead className="px-4 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => {
                    const stateLabel =
                      key.state === "revoked"
                        ? "Revoked"
                        : key.state === "expired"
                          ? "Expired"
                          : "Active";
                    return (
                      <TableRow data-testid="api-key-row" key={key.id}>
                        <TableCell className="px-4 py-3 align-top">
                          <p className="font-medium">{key.name}</p>
                          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                            {key.credential_hint}
                          </p>
                        </TableCell>
                        <TableCell className="px-4 py-3 align-top">
                          <Badge data-testid="api-key-state" variant="outline">
                            {stateLabel}
                          </Badge>
                          {key.revoked_at === null ? null : (
                            <p className="mt-1 text-xs text-muted-foreground">
                              <time dateTime={key.revoked_at}>
                                {displayTime(key.revoked_at)} UTC
                              </time>
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3 align-top">
                          <time dateTime={key.created_at}>
                            {displayTime(key.created_at)} UTC
                          </time>
                        </TableCell>
                        <TableCell className="px-4 py-3 align-top">
                          {key.expires_at === null ? (
                            "No expiry"
                          ) : (
                            <time dateTime={key.expires_at}>
                              {displayTime(key.expires_at)} UTC
                            </time>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3 align-top">
                          {key.last_used_at === null ? (
                            "Never"
                          ) : (
                            <time dateTime={key.last_used_at}>
                              {displayTime(key.last_used_at)} UTC
                            </time>
                          )}
                        </TableCell>
                        <TableCell className="max-w-60 px-4 py-3 align-top whitespace-normal">
                          {key.permissions
                            .map(
                              (permission) =>
                                PERMISSIONS.find(
                                  (item) => item.id === permission,
                                )?.label ?? permission,
                            )
                            .join(", ")}
                        </TableCell>
                        <TableCell className="max-w-64 px-4 py-3 align-top font-mono text-xs whitespace-normal text-muted-foreground">
                          {key.connection_ids.join(", ")}
                        </TableCell>
                        <TableCell className="px-4 py-3 text-right align-top">
                          <Button
                            aria-label={`Revoke ${key.name}`}
                            disabled={
                              key.state !== "active" || revokeMutation.isPending
                            }
                            onClick={() => void revoke(key)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
