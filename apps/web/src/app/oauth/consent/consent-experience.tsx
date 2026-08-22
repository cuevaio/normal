"use client";

import { useAuth, useClerk, useReverification } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { queryKeys } from "@/lib/query/keys";

interface ConsentExperienceProps {
  readonly clerkJwtTemplate: string;
  readonly decisionEndpoint: string;
  readonly inspectEndpoint: string;
  readonly request: string;
}

interface Inspection {
  readonly client: { readonly name: string };
  readonly connections: ReadonlyArray<{
    readonly connection_id: string;
    readonly label: string;
    readonly number_suffix: string | null;
  }>;
  readonly presentation: string;
  readonly requested_scopes: ReadonlyArray<string>;
}

const scopeLabels: Readonly<Record<string, string>> = {
  "connections:read": "See which WhatsApp account is connected",
  "directory:read": "See your WhatsApp contacts and groups",
  "messages:read": "Read your WhatsApp messages",
  "messages:send": "Send WhatsApp messages for you",
};

export function ConsentExperience({
  clerkJwtTemplate,
  decisionEndpoint,
  inspectEndpoint,
  request,
}: ConsentExperienceProps) {
  const { getToken, isLoaded } = useAuth();
  const clerk = useClerk();
  const [connections, setConnections] = useState<ReadonlyArray<string>>([]);
  const [scopes, setScopes] = useState<ReadonlyArray<string>>([]);
  const [readConfirmed, setReadConfirmed] = useState(false);
  const [sendConfirmed, setSendConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const inspectionQuery = useQuery({
    enabled: isLoaded,
    queryFn: async () => {
      const token = await getToken({ template: clerkJwtTemplate });
      if (!token) {
        await clerk.openSignIn();
        throw new Error("signed out");
      }
      const response = await fetch(inspectEndpoint, {
        body: JSON.stringify({ request }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) throw new Error("inspection unavailable");
      const body = (await response.json()) as Inspection;
      if (
        typeof body.client?.name !== "string" ||
        typeof body.presentation !== "string" ||
        !Array.isArray(body.connections) ||
        !Array.isArray(body.requested_scopes)
      ) {
        throw new Error("invalid inspection");
      }
      return body;
    },
    queryKey: queryKeys.oauthInspection(request),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const inspection = inspectionQuery.data ?? null;
  const state = submitFailed
    ? "unavailable"
    : submitting
      ? "submitting"
      : !isLoaded || inspectionQuery.isPending
        ? "loading"
        : inspectionQuery.isError || inspection === null
          ? "unavailable"
          : "ready";

  const submitApproval = useReverification(async () => {
    const token = await getToken({ skipCache: true });
    if (!token || !inspection) throw new Error("token unavailable");
    const response = await fetch(decisionEndpoint, {
      body: JSON.stringify({
        connection_ids: connections,
        decision: "approve",
        presentation: inspection.presentation,
        read_confirmed: readConfirmed,
        request,
        scopes,
        send_confirmed: sendConfirmed,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    return response.json();
  });

  const submit = async (decision: "approve" | "deny") => {
    if (!inspection) return;
    setSubmitting(true);
    try {
      const body =
        decision === "approve"
          ? await submitApproval()
          : await (async () => {
              const token = await getToken({ template: clerkJwtTemplate });
              if (!token) throw new Error("token unavailable");
              const response = await fetch(decisionEndpoint, {
                body: JSON.stringify({
                  decision,
                  presentation: inspection.presentation,
                  request,
                }),
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                method: "POST",
              });
              if (!response.ok) throw new Error("decision unavailable");
              return response.json();
            })();
      const result = body as {
        readonly redirect_to?: unknown;
      };
      if (typeof result.redirect_to !== "string") {
        throw new Error("decision unavailable");
      }
      window.location.assign(result.redirect_to);
    } catch {
      setSubmitFailed(true);
      setSubmitting(false);
    }
  };

  const toggle = (
    selected: ReadonlyArray<string>,
    value: string,
    checked: boolean,
  ): ReadonlyArray<string> =>
    checked ? [...selected, value] : selected.filter((item) => item !== value);
  const hasRead = scopes.some((scope) => scope !== "messages:send");
  const hasSend = scopes.includes("messages:send");
  const canApprove =
    state === "ready" &&
    connections.length > 0 &&
    scopes.length > 0 &&
    (!hasRead || readConfirmed) &&
    (!hasSend || sendConfirmed);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="page-shell flex max-w-2xl flex-col gap-8">
        <p className="text-sm font-semibold text-primary">WhatsApp access</p>
        {inspection === null ? (
          state === "loading" ? (
            <div aria-live="polite" className="flex flex-col gap-3">
              <span className="sr-only">Loading authorization</span>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10 w-72" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                Authorization is temporarily unavailable.
              </AlertDescription>
            </Alert>
          )
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-balance text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                Let {inspection.client.name} use WhatsApp?
              </h1>
              <p className="text-muted-foreground">
                Choose exactly what it can access. You can remove access at any
                time.
              </p>
            </div>

            <FieldSet>
              <FieldLegend>WhatsApp account</FieldLegend>
              <FieldGroup>
                {inspection.connections.map((connection) => (
                  <FieldLabel
                    aria-label={
                      connection.number_suffix === null
                        ? connection.label
                        : `${connection.label}, ending in ${connection.number_suffix}`
                    }
                    key={connection.connection_id}
                  >
                    <Field orientation="horizontal">
                      <Checkbox
                        checked={connections.includes(connection.connection_id)}
                        onCheckedChange={(checked) =>
                          setConnections(
                            toggle(
                              connections,
                              connection.connection_id,
                              checked,
                            ),
                          )
                        }
                      />
                      <span>{connection.label}</span>
                      {connection.number_suffix === null ? null : (
                        <span className="font-mono text-sm text-muted-foreground">
                          ending in {connection.number_suffix}
                        </span>
                      )}
                    </Field>
                  </FieldLabel>
                ))}
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Allow access to</FieldLegend>
              <FieldGroup>
                {inspection.requested_scopes.map((scope) => (
                  <FieldLabel key={scope}>
                    <Field orientation="horizontal">
                      <Checkbox
                        checked={scopes.includes(scope)}
                        onCheckedChange={(checked) =>
                          setScopes(toggle(scopes, scope, checked))
                        }
                      />
                      {scopeLabels[scope] ?? scope}
                    </Field>
                  </FieldLabel>
                ))}
              </FieldGroup>
            </FieldSet>

            {hasRead || hasSend ? (
              <FieldSet>
                <FieldLegend>Before you continue</FieldLegend>
                <FieldGroup className="mt-3 gap-3">
                  {hasRead ? (
                    <FieldLabel>
                      <Field orientation="horizontal">
                        <Checkbox
                          checked={readConfirmed}
                          onCheckedChange={setReadConfirmed}
                        />
                        I’m okay with this app seeing the WhatsApp information I
                        selected
                      </Field>
                    </FieldLabel>
                  ) : null}
                  {hasSend ? (
                    <FieldLabel>
                      <Field orientation="horizontal">
                        <Checkbox
                          checked={sendConfirmed}
                          onCheckedChange={setSendConfirmed}
                        />
                        I’m okay with this app sending WhatsApp messages for me
                      </Field>
                    </FieldLabel>
                  ) : null}
                </FieldGroup>
              </FieldSet>
            ) : null}

            <div className="flex gap-3">
              <Button
                disabled={!canApprove}
                onClick={() => void submit("approve")}
                size="lg"
                type="button"
              >
                {state === "submitting" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                Allow access
              </Button>
              <Button
                disabled={state === "submitting"}
                onClick={() => void submit("deny")}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </div>
            {state === "unavailable" ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Authorization is temporarily unavailable.
                </AlertDescription>
              </Alert>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
