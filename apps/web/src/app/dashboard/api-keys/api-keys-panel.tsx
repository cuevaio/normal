"use client";

import { useAuth, useReverification } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";

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
  const [revealed, setRevealed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      if (!isLoaded) return;
      const token = await getToken({ template: clerkJwtTemplate });
      if (!token) {
        setState("unavailable");
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
        setState("unavailable");
        return;
      }
      setKeys(decodedKeys);
      setConnections(decodedConnections);
      setState("ready");
    } catch {
      setState("unavailable");
    }
  }, [
    apiKeysEndpoint,
    clerkJwtTemplate,
    connectionsEndpoint,
    getToken,
    isLoaded,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = useReverification(async () => {
    const token = await getToken({
      skipCache: true,
      template: clerkJwtTemplate,
    });
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
    try {
      const body = (await submitCreate()) as {
        readonly credential?: unknown;
        readonly error?: unknown;
      };
      if (typeof body.credential !== "string") {
        setState("unavailable");
        return;
      }
      setRevealed(body.credential);
      setName("");
      setPermissions([]);
      setSelectedConnections([]);
      setExpiresAt("");
      await load();
    } catch {
      setState("unavailable");
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
      setState("unavailable");
      return;
    }
    await load();
  };

  const copyCredential = async () => {
    if (revealed === null) return;
    await navigator.clipboard.writeText(revealed);
    setCopied(true);
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
        Server-side credentials for your Personal Account. The plaintext is
        shown once.
      </p>

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
              <p className="font-mono text-sm break-all">{revealed}</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void copyCredential()} type="button">
                  {copied ? "Copied" : "Copy API Key"}
                </Button>
                <Button
                  onClick={() => {
                    setRevealed(null);
                    setCopied(false);
                  }}
                  type="button"
                  variant="outline"
                >
                  I have copied this API Key
                </Button>
              </div>
            </section>
          ) : null}

          <form
            className="flex flex-col gap-5 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <FieldSet>
              <FieldLegend>Create an API Key</FieldLegend>
              <FieldGroup>
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
              </FieldGroup>
            </FieldSet>
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
                    Connect a WhatsApp account before creating an API Key.
                  </p>
                ) : (
                  connections.map((connection) => (
                    <FieldLabel
                      aria-label={`${connection.displayName}, ending in ${connection.numberSuffix}`}
                      key={connection.id}
                    >
                      <Field orientation="horizontal">
                        <Checkbox
                          checked={selectedConnections.includes(connection.id)}
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
            <Button disabled={!canCreate} type="submit">
              Create API Key
            </Button>
          </form>

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
                      disabled={key.state === "revoked"}
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
