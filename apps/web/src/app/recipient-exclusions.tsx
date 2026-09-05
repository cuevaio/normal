"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const recipientLabel = (recipient: Recipient) => recipient.displayName ?? "";

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
  const [status, setStatus] = useState({ announce: false, message: "" });
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
  const knownRecipients = (page?.recipients ?? []).filter((recipient) =>
    Boolean(recipient.displayName?.trim()),
  );
  const trackedRecipients = knownRecipients.filter(
    (recipient) => !recipient.excluded,
  );
  const excludedRecipients = knownRecipients.filter(
    (recipient) => recipient.excluded,
  );
  const listUnavailable =
    recipientsQuery.isError && recipientsQuery.data === undefined;
  const listLoading = recipientsQuery.isFetching;

  const setExcluded = async (recipient: Recipient, excluded: boolean) => {
    if (selectedConnectionId === null || exclusionMutation.isPending) return;
    setStatus({
      announce: true,
      message: excluded
        ? `Saving. Normal will stop tracking ${recipientLabel(recipient)}.`
        : `Saving. Normal may track ${recipientLabel(recipient)} again.`,
    });
    try {
      const saved = await exclusionMutation.mutateAsync({
        excluded,
        recipient,
      });
      const nextStatus = saved
        ? `Normal no longer tracks ${recipientLabel(recipient)}.`
        : `Normal may track ${recipientLabel(recipient)} again.`;
      setStatus({ announce: false, message: nextStatus });
      toast.success(nextStatus);
    } catch {
      setStatus({
        announce: true,
        message: `Could not save ${recipientLabel(recipient)}. Other settings still work.`,
      });
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
    <div className="flex w-full flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_10rem_minmax(16rem,1fr)] sm:items-start">
        <Field>
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
            onValueChange={(value) => setConnectionId(value)}
            value={selectedConnectionId ?? ""}
          >
            <SelectTrigger className="w-full" id="recipient-connection">
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
        <Field>
          <FieldLabel htmlFor="recipient-kind">Recipient kind</FieldLabel>
          <Select
            items={[
              { label: "Contacts", value: "contact" },
              { label: "Groups", value: "group" },
            ]}
            onValueChange={(value) =>
              setKind(value === "group" ? "group" : "contact")
            }
            value={kind}
          >
            <SelectTrigger className="w-full" id="recipient-kind">
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
        <Field>
          <FieldLabel htmlFor="recipient-search">Search by name</FieldLabel>
          <Input
            id="recipient-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Start of a display name"
            type="search"
            value={search}
          />
          <FieldDescription>Enter at least three characters.</FieldDescription>
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

      {page === null || listUnavailable ? null : (
        <div className="grid gap-8" data-testid="recipient-exclusions">
          {[
            {
              empty: `No known ${kind === "contact" ? "contacts" : "groups"} are currently tracked.`,
              heading: `Tracked ${kind === "contact" ? "contacts" : "groups"}`,
              recipients: trackedRecipients,
            },
            {
              empty: `No known ${kind === "contact" ? "contacts" : "groups"} are excluded.`,
              heading: `${kind === "contact" ? "Contacts" : "Groups"} not tracked`,
              recipients: excludedRecipients,
            },
          ].map((table) => (
            <section className="grid gap-2" key={table.heading}>
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-sm font-semibold">{table.heading}</h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {table.recipients.length}
                </span>
              </div>
              <div className="overflow-hidden rounded-xl border">
                <Table className="min-w-[34rem] border-collapse text-left">
                  <TableHeader className="bg-muted/45 text-xs text-muted-foreground">
                    <TableRow>
                      <TableHead className="px-4 py-2.5" scope="col">
                        Name
                      </TableHead>
                      <TableHead className="px-4 py-2.5" scope="col">
                        Kind
                      </TableHead>
                      <TableHead className="px-4 py-2.5" scope="col">
                        Phone
                      </TableHead>
                      <TableHead
                        className="px-4 py-2.5 text-right font-medium"
                        scope="col"
                      >
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y">
                    {table.recipients.length === 0 ? (
                      <TableRow>
                        <TableCell
                          className="px-4 py-8 text-center text-muted-foreground"
                          colSpan={4}
                        >
                          {table.empty}
                        </TableCell>
                      </TableRow>
                    ) : (
                      table.recipients.map((recipient) => {
                        const saving =
                          exclusionMutation.isPending &&
                          exclusionMutation.variables?.recipient.id ===
                            recipient.id;
                        return (
                          <TableRow
                            data-testid="recipient-exclusion"
                            key={recipient.id}
                          >
                            <TableHead className="h-auto px-4 py-3" scope="row">
                              {recipientLabel(recipient)}
                            </TableHead>
                            <TableCell className="px-4 py-3 text-muted-foreground">
                              {recipient.kind === "contact"
                                ? "Contact"
                                : "Group"}
                            </TableCell>
                            <TableCell className="px-4 py-3 tabular-nums text-muted-foreground">
                              {recipient.phoneLastFour === null
                                ? "Not available"
                                : `Ending ${recipient.phoneLastFour}`}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-right">
                              <Button
                                aria-label={`${recipient.excluded ? "Track again" : "Stop tracking"} ${recipientLabel(recipient)}`}
                                disabled={exclusionMutation.isPending}
                                onClick={() =>
                                  void setExcluded(
                                    recipient,
                                    !recipient.excluded,
                                  )
                                }
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                {saving
                                  ? "Saving..."
                                  : recipient.excluded
                                    ? "Track again"
                                    : "Stop tracking"}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
          ))}
        </div>
      )}

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

      <p
        aria-live="polite"
        className="sr-only"
        data-testid="recipient-exclusion-announcement"
      >
        {status.announce ? status.message : ""}
      </p>
      <p
        className="min-h-5 text-sm text-muted-foreground"
        data-testid="recipient-exclusion-status"
      >
        {status.message}
      </p>
    </div>
  );
}
