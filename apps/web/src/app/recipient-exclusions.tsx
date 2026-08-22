"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { queryKeys } from "@/lib/query/keys";
import {
  applyRecipientExclusion,
  fetchRecipientPage,
  flattenRecipientPages,
  type Recipient,
  type RecipientKind,
  type RecipientPage,
  setRecipientExclusion,
} from "@/lib/query/resources";

export interface RecipientConnection {
  readonly displayName: string | null;
  readonly id: string;
  readonly numberSuffix: string;
}

const recipientLabel = (recipient: Recipient) =>
  recipient.displayName ??
  (recipient.kind === "contact" ? "Unnamed contact" : "Unnamed group");

export function RecipientExclusions({
  connections,
  connectionsEndpoint,
  getToken,
}: {
  readonly connections: ReadonlyArray<RecipientConnection>;
  readonly connectionsEndpoint: string;
  readonly getToken: () => Promise<string | null>;
}) {
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [kind, setKind] = useState<RecipientKind>("contact");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const selectedConnectionId = connectionId ?? connections[0]?.id ?? null;
  const recipientsQuery = useInfiniteQuery({
    enabled: selectedConnectionId !== null,
    getNextPageParam: (page: RecipientPage) => page.nextCursor,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      return fetchRecipientPage({
        connectionId: selectedConnectionId as string,
        cursor: pageParam,
        endpoint: connectionsEndpoint,
        kind,
        search,
        token,
      });
    },
    queryKey: queryKeys.recipients(
      selectedConnectionId ?? "",
      kind,
      search.trim(),
    ),
  });
  const exclusionMutation = useMutation({
    mutationFn: async ({
      excluded,
      recipient,
    }: {
      readonly excluded: boolean;
      readonly recipient: Recipient;
    }) => {
      if (selectedConnectionId === null) throw new Error("no connection");
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      return setRecipientExclusion({
        connectionId: selectedConnectionId,
        endpoint: connectionsEndpoint,
        excluded,
        expectedExcluded: recipient.excluded,
        recipientId: recipient.id,
        token,
      });
    },
    onSuccess: (saved, { recipient }) => {
      queryClient.setQueryData(
        queryKeys.recipients(selectedConnectionId ?? "", kind, search.trim()),
        (current: { pages: RecipientPage[] } | undefined) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: applyRecipientExclusion(
                  current.pages,
                  recipient.id,
                  saved,
                ),
              },
      );
    },
  });

  const page = flattenRecipientPages(recipientsQuery.data?.pages);
  const listUnavailable =
    recipientsQuery.isError && recipientsQuery.data === undefined;
  const listLoading = recipientsQuery.isFetching;

  const setExcluded = async (recipient: Recipient, excluded: boolean) => {
    if (selectedConnectionId === null || exclusionMutation.isPending) return;
    setStatus(
      excluded
        ? `Saving. Normal will stop tracking ${recipientLabel(recipient)}.`
        : `Saving. Normal may track ${recipientLabel(recipient)} again.`,
    );
    try {
      const saved = await exclusionMutation.mutateAsync({
        excluded,
        recipient,
      });
      setStatus(
        saved
          ? `Normal no longer tracks ${recipientLabel(recipient)}.`
          : `Normal may track ${recipientLabel(recipient)} again.`,
      );
    } catch {
      setStatus(
        `Could not save ${recipientLabel(recipient)}. Other settings still work.`,
      );
    }
  };

  if (connections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect WhatsApp to choose which recipients Normal may track.
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field className="sm:w-64">
          <FieldLabel htmlFor="recipient-connection">
            WhatsApp Connection
          </FieldLabel>
          <Select
            items={connections.map((connection) => ({
              label:
                connection.displayName ??
                `WhatsApp Connection ending ${connection.numberSuffix}`,
              value: connection.id,
            }))}
            onValueChange={(value) => {
              setConnectionId(String(value));
            }}
            value={selectedConnectionId ?? ""}
          >
            <SelectTrigger id="recipient-connection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.displayName ??
                      `WhatsApp Connection ending ${connection.numberSuffix}`}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="sm:w-40">
          <FieldLabel htmlFor="recipient-kind">Recipient kind</FieldLabel>
          <Select
            items={[
              { label: "Contacts", value: "contact" },
              { label: "Groups", value: "group" },
            ]}
            onValueChange={(value) => {
              setKind(value === "group" ? "group" : "contact");
            }}
            value={kind}
          >
            <SelectTrigger id="recipient-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="contact">Contacts</SelectItem>
                <SelectItem value="group">Groups</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="sm:flex-1">
          <FieldLabel htmlFor="recipient-search">Search by name</FieldLabel>
          <Input
            id="recipient-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Start of a display name"
            type="search"
            value={search}
          />
          <FieldDescription>
            Enter at least three characters of a display name.
          </FieldDescription>
        </Field>
      </div>

      {page === null ? null : (
        <p className="text-xs text-muted-foreground">
          {page.directory.stale
            ? "This WhatsApp Directory projection may be out of date. "
            : ""}
          {page.directory.partial
            ? "Some recipients may be missing from this projection. "
            : ""}
          Directory as of {page.directory.asOf}.
        </p>
      )}

      {listUnavailable ? (
        <p className="text-sm text-muted-foreground">
          Your WhatsApp Directory is temporarily unavailable.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2" data-testid="recipient-exclusions">
        {(page?.recipients ?? []).map((recipient) => (
          <li
            className="flex items-center justify-between gap-3 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10"
            data-testid="recipient-exclusion"
            key={recipient.id}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-medium">
                  {recipientLabel(recipient)}
                </p>
                <Badge variant="outline">
                  {recipient.kind === "contact" ? "Contact" : "Group"}
                </Badge>
              </div>
              {recipient.phoneLastFour === null ? null : (
                <p className="text-xs text-muted-foreground">
                  Ends in {recipient.phoneLastFour}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-sm">
              {exclusionMutation.isPending &&
              exclusionMutation.variables?.recipient.id === recipient.id ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              <Checkbox
                checked={recipient.excluded}
                disabled={exclusionMutation.isPending}
                id={`exclude-${recipient.id}`}
                onCheckedChange={(checked) =>
                  void setExcluded(recipient, checked === true)
                }
              />
              <Label htmlFor={`exclude-${recipient.id}`}>
                Do not track
                <span className="sr-only"> {recipientLabel(recipient)}</span>
              </Label>
            </div>
          </li>
        ))}
      </ul>

      {listLoading && page === null ? (
        <p className="text-sm text-muted-foreground">Loading recipients.</p>
      ) : null}

      {page?.nextCursor == null ? null : (
        <Button
          onClick={() => void recipientsQuery.fetchNextPage()}
          type="button"
          variant="outline"
        >
          Show more recipients
        </Button>
      )}

      <p aria-live="polite" data-testid="recipient-exclusion-status">
        {status}
      </p>
    </div>
  );
}
