"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
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
      const nextStatus = saved
        ? `Normal no longer tracks ${recipientLabel(recipient)}.`
        : `Normal may track ${recipientLabel(recipient)} again.`;
      setStatus(nextStatus);
      toast.success(nextStatus);
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
    <div className="flex w-full flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_10rem_minmax(16rem,1fr)] sm:items-start">
        <label
          className="grid gap-1.5 text-sm font-medium"
          htmlFor="recipient-connection"
        >
          WhatsApp Connection
          <select
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm shadow-xs outline-none transition-[border-color,box-shadow] duration-150 ease-[var(--ease-out)] focus:border-ring focus:ring-3 focus:ring-ring/20"
            id="recipient-connection"
            onChange={(event) => setConnectionId(event.target.value)}
            value={selectedConnectionId ?? ""}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName ??
                  `WhatsApp Connection ending ${connection.numberSuffix}`}
              </option>
            ))}
          </select>
        </label>
        <label
          className="grid gap-1.5 text-sm font-medium"
          htmlFor="recipient-kind"
        >
          Recipient kind
          <select
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm shadow-xs outline-none transition-[border-color,box-shadow] duration-150 ease-[var(--ease-out)] focus:border-ring focus:ring-3 focus:ring-ring/20"
            id="recipient-kind"
            onChange={(event) =>
              setKind(event.target.value === "group" ? "group" : "contact")
            }
            value={kind}
          >
            <option value="contact">Contacts</option>
            <option value="group">Groups</option>
          </select>
        </label>
        <label
          className="grid gap-1.5 text-sm font-medium"
          htmlFor="recipient-search"
        >
          Search by name
          <input
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm shadow-xs outline-none transition-[border-color,box-shadow] duration-150 ease-[var(--ease-out)] placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/20"
            id="recipient-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Start of a display name"
            type="search"
            value={search}
          />
          <span className="text-xs font-normal text-muted-foreground">
            Enter at least three characters.
          </span>
        </label>
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
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                  <thead className="bg-muted/45 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-medium" scope="col">
                        Name
                      </th>
                      <th className="px-4 py-2.5 font-medium" scope="col">
                        Kind
                      </th>
                      <th className="px-4 py-2.5 font-medium" scope="col">
                        Phone
                      </th>
                      <th
                        className="px-4 py-2.5 text-right font-medium"
                        scope="col"
                      >
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {table.recipients.length === 0 ? (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-muted-foreground"
                          colSpan={4}
                        >
                          {table.empty}
                        </td>
                      </tr>
                    ) : (
                      table.recipients.map((recipient) => {
                        const saving =
                          exclusionMutation.isPending &&
                          exclusionMutation.variables?.recipient.id ===
                            recipient.id;
                        return (
                          <tr
                            data-testid="recipient-exclusion"
                            key={recipient.id}
                          >
                            <th className="px-4 py-3 font-medium" scope="row">
                              {recipientLabel(recipient)}
                            </th>
                            <td className="px-4 py-3 text-muted-foreground">
                              {recipient.kind === "contact"
                                ? "Contact"
                                : "Group"}
                            </td>
                            <td className="px-4 py-3 tabular-nums text-muted-foreground">
                              {recipient.phoneLastFour === null
                                ? "Not available"
                                : `Ending ${recipient.phoneLastFour}`}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                aria-label={`${recipient.excluded ? "Track again" : "Stop tracking"} ${recipientLabel(recipient)}`}
                                className="rounded-md px-2.5 py-1.5 font-medium text-foreground outline-none transition-[background-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={exclusionMutation.isPending}
                                onClick={() =>
                                  void setExcluded(
                                    recipient,
                                    !recipient.excluded,
                                  )
                                }
                                type="button"
                              >
                                {saving
                                  ? "Saving..."
                                  : recipient.excluded
                                    ? "Track again"
                                    : "Stop tracking"}
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {listLoading && page === null ? (
        <p className="text-sm text-muted-foreground">Loading recipients.</p>
      ) : null}

      {page?.nextCursor == null ? null : (
        <button
          className="w-fit rounded-lg border bg-background px-3 py-2 text-sm font-medium shadow-xs outline-none transition-[background-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.97]"
          onClick={() => void recipientsQuery.fetchNextPage()}
          type="button"
        >
          Show more recipients
        </button>
      )}

      <p
        aria-live="polite"
        className="min-h-5 text-sm text-muted-foreground"
        data-testid="recipient-exclusion-status"
      >
        {status}
      </p>
    </div>
  );
}
