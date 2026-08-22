"use client";

import { useAuth, useReverification } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

const PERMISSIONS = [
  { id: "connections:read", label: "Connection metadata" },
  { id: "directory:read", label: "WhatsApp Directory" },
  { id: "messages:read", label: "Stored Messages" },
  { id: "messages:send", label: "Send messages" },
] as const;

type ApiKeyPermission = (typeof PERMISSIONS)[number]["id"];

interface ApiKeySummary {
  readonly connection_ids: ReadonlyArray<string>;
  readonly created_at: string;
  readonly credential_hint: string;
  readonly expires_at: string | null;
  readonly id: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly permissions: ReadonlyArray<ApiKeyPermission>;
  readonly revoked_at: string | null;
  readonly state: "active" | "expired" | "revoked";
}

interface SelectableConnection {
  readonly displayName: string;
  readonly id: string;
  readonly numberSuffix: string;
  readonly state: string;
}

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

const decodeKeys = (value: unknown): ReadonlyArray<ApiKeySummary> | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { api_keys?: unknown }).api_keys)
  ) {
    return null;
  }
  const keys: ApiKeySummary[] = [];
  for (const key of (value as { api_keys: ReadonlyArray<unknown> }).api_keys) {
    if (
      typeof key !== "object" ||
      key === null ||
      typeof (key as ApiKeySummary).id !== "string" ||
      !/^apk_[A-Za-z0-9_-]{21}$/u.test((key as ApiKeySummary).id) ||
      typeof (key as ApiKeySummary).name !== "string" ||
      typeof (key as ApiKeySummary).credential_hint !== "string" ||
      typeof (key as ApiKeySummary).created_at !== "string" ||
      ((key as ApiKeySummary).state !== "active" &&
        (key as ApiKeySummary).state !== "expired" &&
        (key as ApiKeySummary).state !== "revoked") ||
      !Array.isArray((key as ApiKeySummary).permissions) ||
      !Array.isArray((key as ApiKeySummary).connection_ids)
    ) {
      return null;
    }
    keys.push(key as ApiKeySummary);
  }
  return keys;
};

const decodeConnections = (
  value: unknown,
): ReadonlyArray<SelectableConnection> | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(
      (value as { whatsapp_connections?: unknown }).whatsapp_connections,
    )
  ) {
    return null;
  }
  const connections: SelectableConnection[] = [];
  for (const connection of (
    value as {
      whatsapp_connections: ReadonlyArray<Record<string, unknown>>;
    }
  ).whatsapp_connections) {
    if (
      typeof connection.display_name !== "string" ||
      typeof connection.id !== "string" ||
      !/^con_[A-Za-z0-9_-]{21}$/u.test(connection.id) ||
      typeof connection.number_suffix !== "string" ||
      connection.state === "deleting"
    ) {
      continue;
    }
    connections.push({
      displayName: connection.display_name,
      id: connection.id,
      numberSuffix: connection.number_suffix,
      state: String(connection.state),
    });
  }
  return connections;
};

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
  const [keys, setKeys] = useState<ReadonlyArray<ApiKeySummary>>([]);
  const [connections, setConnections] = useState<
    ReadonlyArray<SelectableConnection>
  >([]);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<ReadonlyArray<string>>([]);
  const [selectedConnections, setSelectedConnections] = useState<
    ReadonlyArray<string>
  >([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [revealed, setRevealed] = useState<RevealedApiKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [curlConnectionId, setCurlConnectionId] = useState("");
  const [includeApiKey, setIncludeApiKey] = useState(false);
  const [recipientPhone, setRecipientPhone] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const load = useCallback(
    async (options?: { readonly preserveReveal?: boolean }) => {
      const failClosed = () => {
        if (options?.preserveReveal !== true) {
          setState("unavailable");
        }
      };
      try {
        if (!isLoaded) return;
        const token = await getToken({ template: clerkJwtTemplate });
        if (!token) {
          failClosed();
          return;
        }
        const [keysResponse, connectionsResponse] = await Promise.all([
          fetch(apiKeysEndpoint, {
            headers: { authorization: `Bearer ${token}` },
          }),
          fetch(connectionsEndpoint, {
            headers: { authorization: `Bearer ${token}` },
          }),
        ]);
        const [keysBody, connectionsBody] = await Promise.all([
          keysResponse.json(),
          connectionsResponse.json(),
        ]);
        const decodedKeys = decodeKeys(keysBody);
        const decodedConnections = decodeConnections(connectionsBody);
        if (
          !keysResponse.ok ||
          decodedKeys === null ||
          !connectionsResponse.ok ||
          decodedConnections === null
        ) {
          failClosed();
          return;
        }
        setKeys(decodedKeys);
        setConnections(decodedConnections);
        setState("ready");
      } catch {
        failClosed();
      }
    },
    [
      apiKeysEndpoint,
      clerkJwtTemplate,
      connectionsEndpoint,
      getToken,
      isLoaded,
    ],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = useReverification(async () => {
    const token = await getToken({ skipCache: true });
    if (!token) throw new Error("token unavailable");
    const response = await fetch(apiKeysEndpoint, {
      body: JSON.stringify({
        connection_ids: selectedConnections,
        ...(expiresAt === ""
          ? {}
          : { expires_at: new Date(expiresAt).toISOString() }),
        name,
        permissions,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    return response.json();
  });

  const create = async () => {
    setCreating(true);
    setCopied(false);
    setCreateError(null);
    try {
      const body = (await submitCreate()) as {
        readonly credential?: unknown;
        readonly error?: unknown;
      };
      if (typeof body.credential !== "string") {
        if (body.error === "duplicate_name") {
          setCreateError("An active API Key already uses this name.");
          return;
        }
        if (body.error === "limit_reached") {
          setCreateError(
            "This Personal Account already has ten active API Keys.",
          );
          return;
        }
        if (body.error === "invalid") {
          setCreateError(
            "Check the name, permissions, Connections, and expiry.",
          );
          return;
        }
        setState("unavailable");
        return;
      }
      setRevealed({
        connectionIds: selectedConnections,
        credential: body.credential,
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
      setState("ready");
      await load({ preserveReveal: true });
    } catch {
      setCreateError("API Key creation was cancelled or failed. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: ApiKeySummary) => {
    const token = await getToken({ template: clerkJwtTemplate });
    if (!token) return;
    const response = await fetch(
      `${apiKeysEndpoint}/${encodeURIComponent(key.id)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        method: "DELETE",
      },
    );
    if (!response.ok) {
      if (revealed === null) {
        setState("unavailable");
      }
      return;
    }
    await load({ preserveReveal: true });
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

  const canCreate =
    state === "ready" &&
    name.trim().length > 0 &&
    permissions.length > 0 &&
    selectedConnections.length > 0 &&
    !creating;

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

      {state === "loading" ? (
        <p aria-live="polite">Loading API Keys…</p>
      ) : state === "unavailable" ? (
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
            <Dialog
              onOpenChange={(open) => {
                setCreateDialogOpen(open);
                if (open) {
                  setCreateError(null);
                }
              }}
              open={createDialogOpen}
            >
              <DialogTrigger render={<Button />}>Create API Key</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create an API Key</DialogTitle>
                  <DialogDescription>
                    Choose a unique name, permissions, and the WhatsApp
                    Connections this credential may use. The plaintext is shown
                    once.
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="contents"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                >
                  <DialogBody className="flex flex-col gap-5">
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
                  </DialogBody>
                  <DialogFooter>
                    <DialogClose render={<Button variant="outline" />}>
                      Cancel
                    </DialogClose>
                    <Button disabled={!canCreate} type="submit">
                      {creating ? <Spinner data-icon="inline-start" /> : null}
                      Create API Key
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {keys.length === 0 ? (
            <p>No API Keys yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {keys.map((key) => {
                const stateLabel =
                  key.state === "revoked"
                    ? "Revoked"
                    : key.state === "expired"
                      ? "Expired"
                      : "Active";
                return (
                  <li
                    className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
                    key={key.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium">{key.name}</h3>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {key.credential_hint}
                        </p>
                      </div>
                      <Badge data-testid="api-key-state" variant="outline">
                        {stateLabel}
                      </Badge>
                    </div>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">Created</dt>
                        <dd>
                          <time dateTime={key.created_at}>
                            {displayTime(key.created_at)} UTC
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Expires</dt>
                        <dd>
                          {key.expires_at === null ? (
                            "No expiry"
                          ) : (
                            <time dateTime={key.expires_at}>
                              {displayTime(key.expires_at)} UTC
                            </time>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Last used</dt>
                        <dd>
                          {key.last_used_at === null
                            ? "Never"
                            : displayTime(key.last_used_at)}
                        </dd>
                      </div>
                      {key.revoked_at === null ? null : (
                        <div>
                          <dt className="text-muted-foreground">Revoked</dt>
                          <dd>
                            <time dateTime={key.revoked_at}>
                              {displayTime(key.revoked_at)} UTC
                            </time>
                          </dd>
                        </div>
                      )}
                    </dl>
                    <p className="text-sm">
                      {key.permissions
                        .map(
                          (permission) =>
                            PERMISSIONS.find((item) => item.id === permission)
                              ?.label ?? permission,
                        )
                        .join(", ")}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {key.connection_ids.join(", ")}
                    </p>
                    <Button
                      disabled={key.state !== "active"}
                      onClick={() => void revoke(key)}
                      type="button"
                      variant="outline"
                    >
                      Revoke {key.name}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
