"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { makeIdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import {
  ArrowUpDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
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
  type ActivityLog,
  applyAuthorizationRevocation,
  decodeSafeWhatsAppConnection,
  fetchAccountInsights,
  fetchActivityLogPage,
  fetchConnectionsWithPolicies,
  fetchMcpAuthorizations,
  flattenActivityLogs,
  type McpAuthorization,
  removeConnection,
  replaceConnection,
  revokeMcpAuthorization,
  type SafeWhatsAppConnection,
} from "@/lib/query/resources";
import { captureProductAnalyticsEvent } from "../effect/product-analytics";
import { AccountOverview } from "./account-overview";
import {
  nextConnectionSetupPollDelayMs,
  observationMetricDurationMs,
} from "./connection-setup-observation";
import {
  type ConnectionSetupCleanupState,
  ConnectionSetupForm,
  type ConnectionSetupState,
  decodeOnboardingProfileResponse,
  FirstConnectionOnboarding,
  type OnboardingProfile,
} from "./first-connection-onboarding";
import { McpConnectionGuides } from "./mcp-connection-guides";
import { RecipientExclusions } from "./recipient-exclusions";

interface PublicBoundaryJourneyProps {
  readonly autoInitialize?: boolean;
  readonly clerkJwtTemplate: string;
  readonly connectionsEndpoint: string;
  readonly connectionSetupEndpoint: string;
  readonly mcpAuthorizationsEndpoint: string;
  readonly mcpServerUrl: string;
  readonly onboardingProfileEndpoint: string;
  readonly personalAccountEndpoint: string;
  readonly personalAccountDeletionEndpoint: string;
  readonly activityLogsEndpoint: string;
  readonly accountInsightsEndpoint: string;
  readonly view?: PersonalAccountView;
}

export type PersonalAccountView =
  | "overview"
  | "connections"
  | "authorizations"
  | "activity"
  | "settings";

type JourneyState = "idle" | "loading" | "signed_out" | "unavailable" | "ok";

type SetupState = ConnectionSetupState;

type AuthorizationState = "idle" | "loading" | "ok" | "unavailable";

type ActivityLogSort =
  | "capability"
  | "startedAt"
  | "results"
  | "latencyMs"
  | "outcome";

type SortDirection = "ascending" | "descending";

const activityLogOutcomes: ReadonlyArray<ActivityLog["outcome"]> = [
  "started",
  "success",
  "execution_error",
  "rate_limited",
  "authorization_denied",
];

const compareOptionalNumbers = (
  left: number | null,
  right: number | null,
): number => {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
};

const scopeLabels: Record<McpAuthorization["scopes"][number], string> = {
  "connections:read": "Connection metadata",
  "directory:read": "WhatsApp Directory",
  "messages:read": "Stored Messages",
  "messages:send": "Send messages",
};

const displayTime = (value: string): string =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));

type SetupCleanupState = ConnectionSetupCleanupState;

export function PublicBoundaryJourney({
  autoInitialize = false,
  clerkJwtTemplate,
  connectionsEndpoint,
  connectionSetupEndpoint,
  mcpAuthorizationsEndpoint,
  mcpServerUrl,
  onboardingProfileEndpoint,
  personalAccountEndpoint,
  personalAccountDeletionEndpoint,
  activityLogsEndpoint,
  accountInsightsEndpoint,
  view = "overview",
}: PublicBoundaryJourneyProps) {
  const { getToken: getClerkToken, isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const queryClient = useQueryClient();
  const getToken = () => getClerkToken({ template: clerkJwtTemplate });
  const [identityUnavailable, setIdentityUnavailable] = useState(false);
  const identityState = identityUnavailable
    ? "unavailable"
    : !isLoaded
      ? "loading"
      : isSignedIn
        ? "signed_in"
        : "signed_out";
  const [state, setState] = useState<JourneyState>("idle");
  const [setupState, setSetupState] = useState<SetupState>("idle");
  const [activityLogSearch, setActivityLogSearch] = useState("");
  const [activityLogOutcome, setActivityLogOutcome] = useState<
    "all" | ActivityLog["outcome"]
  >("all");
  const [activityLogSort, setActivityLogSort] =
    useState<ActivityLogSort>("startedAt");
  const [activityLogSortDirection, setActivityLogSortDirection] =
    useState<SortDirection>("descending");
  const [activityLogPage, setActivityLogPage] = useState(0);
  const [activityLogPageSize, setActivityLogPageSize] = useState(10);
  const [revokingAuthorization, setRevokingAuthorization] = useState<
    string | null
  >(null);
  const [setupCleanupState, setSetupCleanupState] =
    useState<SetupCleanupState | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [configurationConnectionId, setConfigurationConnectionId] = useState<
    string | null
  >(null);
  const [reconnectConnectionId, setReconnectConnectionId] = useState<
    string | null
  >(null);
  const [connectionLifecycleAction, setConnectionLifecycleAction] = useState<
    string | null
  >(null);
  const [connectionLifecycleStatus, setConnectionLifecycleStatus] = useState<
    Readonly<Record<string, string>>
  >({});
  const [retentionDrafts, setRetentionDrafts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [retentionAcknowledgements, setRetentionAcknowledgements] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [retentionStatus, setRetentionStatus] = useState<
    Readonly<Record<string, string>>
  >({});
  const [connectionName, setConnectionName] = useState("");
  const [nameDrafts, setNameDrafts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [nameStatus, setNameStatus] = useState<
    Readonly<Record<string, string>>
  >({});
  const [savingNames, setSavingNames] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [showFirstConnectionOnboarding, setShowFirstConnectionOnboarding] =
    useState(false);
  const [onboardingProfile, setOnboardingProfile] =
    useState<OnboardingProfile | null>(null);
  const [reconnectQr, setReconnectQr] = useState<{
    readonly connectionId: string;
    readonly url: string;
  } | null>(null);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const setupStateRef = useRef<ConnectionSetupState>("idle");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [deletionState, setDeletionState] = useState<
    "idle" | "deleting" | "unavailable"
  >("idle");
  const [deletingConnectionId, setDeletingConnectionId] = useState<
    string | null
  >(null);
  const [connectionDeletionStatus, setConnectionDeletionStatus] = useState("");
  const setupIntent = useRef<{
    readonly idempotencyKey: string;
    readonly name: string;
    readonly whatsappNumber: string;
  } | null>(null);
  const activeQrImageUrl = useRef<string | null>(null);
  const activeReconnectQrUrl = useRef<string | null>(null);
  const lifecycleGeneration = useRef(0);
  const lifecycleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observationGeneration = useRef(0);
  const observationAttempt = useRef(0);
  const setupObservationMetrics = useRef<{
    readonly qrObservedAtMs: number | null;
    readonly setupStartedAtMs: number | null;
    readonly startToQrCaptured: boolean;
    readonly qrToActiveCaptured: boolean;
  }>({
    qrObservedAtMs: null,
    setupStartedAtMs: null,
    startToQrCaptured: false,
    qrToActiveCaptured: false,
  });
  const observationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const automaticallyInitialized = useRef(false);
  const sawInitialConnections = useRef(false);

  const connectionsQuery = useQuery({
    enabled: state === "ok" && isLoaded && isSignedIn === true,
    queryFn: async () => {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      return fetchConnectionsWithPolicies(connectionsEndpoint, token);
    },
    queryKey: queryKeys.connectionWorkspace(),
  });
  const authorizationsQuery = useQuery({
    enabled: state === "ok" && isLoaded && isSignedIn === true,
    queryFn: async () => {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      return fetchMcpAuthorizations(mcpAuthorizationsEndpoint, token);
    },
    queryKey: queryKeys.authorizations(),
  });
  const insightsQuery = useQuery({
    enabled: state === "ok" && isLoaded && isSignedIn === true,
    queryFn: async () => {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      return fetchAccountInsights(accountInsightsEndpoint, token);
    },
    queryKey: queryKeys.accountInsights(),
  });
  const activityLogsQuery = useInfiniteQuery({
    enabled: state === "ok" && isLoaded && isSignedIn === true,
    getNextPageParam: (page: { readonly nextCursor: string | null }) =>
      page.nextCursor,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      return fetchActivityLogPage({
        cursor: pageParam,
        endpoint: activityLogsEndpoint,
        token,
      });
    },
    queryKey: queryKeys.activityLogs(),
  });
  const onboardingQuery = useQuery({
    enabled:
      state === "ok" &&
      connectionsQuery.isSuccess &&
      connectionsQuery.data.length === 0,
    queryFn: async () => {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const response = await fetch(onboardingProfileEndpoint, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("onboarding unavailable");
      const profile = decodeOnboardingProfileResponse(await response.json());
      if (profile === undefined) throw new Error("onboarding unavailable");
      return profile;
    },
    queryKey: queryKeys.onboardingProfile(),
  });
  const revokeAuthorizationMutation = useMutation({
    mutationFn: async (authorization: McpAuthorization) => {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      return revokeMcpAuthorization({
        authorization,
        endpoint: mcpAuthorizationsEndpoint,
        token,
      });
    },
    onSuccess: (revoked) => {
      queryClient.setQueryData(
        queryKeys.authorizations(),
        (current: ReadonlyArray<McpAuthorization> | undefined) =>
          applyAuthorizationRevocation(current, revoked),
      );
    },
  });

  const connections = connectionsQuery.data ?? [];
  const authorizations = authorizationsQuery.data ?? [];
  const insights = insightsQuery.data ?? null;
  const activityLogs = flattenActivityLogs(activityLogsQuery.data?.pages);
  const activityLogCursor =
    activityLogsQuery.data?.pages.at(-1)?.nextCursor ?? null;
  const authorizationState: AuthorizationState = authorizationsQuery.isPending
    ? "loading"
    : authorizationsQuery.isError && authorizationsQuery.data === undefined
      ? "unavailable"
      : "ok";
  const activityLogState: AuthorizationState = activityLogsQuery.isPending
    ? "loading"
    : activityLogsQuery.isError && activityLogsQuery.data === undefined
      ? "unavailable"
      : "ok";
  const insightsState: AuthorizationState = insightsQuery.isPending
    ? "loading"
    : insightsQuery.isError && insightsQuery.data === undefined
      ? "unavailable"
      : "ok";
  const activityLogPageState = activityLogsQuery.isFetchingNextPage
    ? "loading"
    : activityLogsQuery.isFetchNextPageError
      ? "unavailable"
      : "idle";
  const dashboardUnavailable =
    state === "unavailable" ||
    (state === "ok" &&
      connectionsQuery.isError &&
      connectionsQuery.data === undefined) ||
    (state === "ok" &&
      connectionsQuery.isSuccess &&
      connectionsQuery.data.length === 0 &&
      onboardingQuery.isError &&
      onboardingQuery.data === undefined);
  const dashboardLoading =
    state === "idle" ||
    state === "loading" ||
    (state === "ok" &&
      connectionsQuery.data === undefined &&
      !connectionsQuery.isError) ||
    (state === "ok" &&
      connectionsQuery.isSuccess &&
      connectionsQuery.data.length === 0 &&
      !sawInitialConnections.current &&
      !showFirstConnectionOnboarding &&
      !onboardingQuery.isError);
  const dashboardReady =
    state === "ok" && !dashboardLoading && !dashboardUnavailable;

  useEffect(() => {
    if (!connectionsQuery.isSuccess) return;
    setRetentionDrafts((current) => {
      const next = { ...current };
      for (const connection of connectionsQuery.data) {
        if (next[connection.id] === undefined) {
          next[connection.id] =
            connection.retentionDays === null
              ? "until-deletion"
              : String(connection.retentionDays);
        }
      }
      return next;
    });
    setNameDrafts((current) => {
      const next = { ...current };
      for (const connection of connectionsQuery.data) {
        if (next[connection.id] === undefined) {
          next[connection.id] = connection.displayName;
        }
      }
      return next;
    });
  }, [connectionsQuery.data, connectionsQuery.isSuccess]);

  useEffect(() => {
    if (state !== "ok" || !connectionsQuery.isSuccess) return;
    if (connectionsQuery.data.length > 0) {
      if (!sawInitialConnections.current) {
        sawInitialConnections.current = true;
        setOnboardingProfile(null);
        setShowFirstConnectionOnboarding(false);
      }
      return;
    }
    if (!onboardingQuery.isSuccess || sawInitialConnections.current) return;
    sawInitialConnections.current = true;
    setOnboardingProfile(onboardingQuery.data);
    setShowFirstConnectionOnboarding(true);
  }, [
    connectionsQuery.data,
    connectionsQuery.isSuccess,
    onboardingQuery.data,
    onboardingQuery.isSuccess,
    state,
  ]);

  const normalizedActivityLogSearch = activityLogSearch.trim().toLowerCase();
  const filteredActivityLogs = activityLogs.filter((log) => {
    if (activityLogOutcome !== "all" && log.outcome !== activityLogOutcome) {
      return false;
    }
    if (normalizedActivityLogSearch.length === 0) return true;
    return [
      log.capability.replaceAll("_", " "),
      log.client.name,
      log.outcome.replaceAll("_", " "),
      ...log.references,
    ].some((value) =>
      value.toLowerCase().includes(normalizedActivityLogSearch),
    );
  });
  const sortedActivityLogs = [...filteredActivityLogs].sort((left, right) => {
    let comparison: number;
    switch (activityLogSort) {
      case "capability":
        comparison = left.capability.localeCompare(right.capability);
        break;
      case "startedAt":
        comparison = left.startedAt.localeCompare(right.startedAt);
        break;
      case "results":
        comparison = compareOptionalNumbers(
          left.counts.results,
          right.counts.results,
        );
        break;
      case "latencyMs":
        comparison = compareOptionalNumbers(left.latencyMs, right.latencyMs);
        break;
      case "outcome":
        comparison = left.outcome.localeCompare(right.outcome);
        break;
    }
    return activityLogSortDirection === "ascending" ? comparison : -comparison;
  });
  const activityLogPageCount = Math.max(
    1,
    Math.ceil(sortedActivityLogs.length / activityLogPageSize),
  );
  const currentActivityLogPage = Math.min(
    activityLogPage,
    activityLogPageCount - 1,
  );
  const visibleActivityLogs = sortedActivityLogs.slice(
    currentActivityLogPage * activityLogPageSize,
    (currentActivityLogPage + 1) * activityLogPageSize,
  );

  const changeActivityLogSort = (sort: ActivityLogSort) => {
    setActivityLogPage(0);
    if (activityLogSort === sort) {
      setActivityLogSortDirection((current) =>
        current === "ascending" ? "descending" : "ascending",
      );
      return;
    }
    setActivityLogSort(sort);
    setActivityLogSortDirection(
      sort === "startedAt" ? "descending" : "ascending",
    );
  };

  useEffect(
    () => () => {
      observationGeneration.current += 1;
      if (observationTimer.current !== null) {
        clearTimeout(observationTimer.current);
      }
      if (activeQrImageUrl.current !== null) {
        URL.revokeObjectURL(activeQrImageUrl.current);
      }
      lifecycleGeneration.current += 1;
      if (lifecycleTimer.current !== null) {
        clearTimeout(lifecycleTimer.current);
      }
      if (activeReconnectQrUrl.current !== null) {
        URL.revokeObjectURL(activeReconnectQrUrl.current);
      }
    },
    [],
  );

  const openSignIn = async () => {
    try {
      await clerk.openSignIn();
    } catch {
      setIdentityUnavailable(true);
    }
  };

  const openWaitlist = async () => {
    try {
      await clerk.openWaitlist();
    } catch {
      setIdentityUnavailable(true);
    }
  };

  const loadMoreActivityLogs = async (): Promise<boolean> => {
    if (activityLogCursor === null || activityLogsQuery.isFetchingNextPage) {
      return false;
    }
    const result = await activityLogsQuery.fetchNextPage();
    return (result.data?.pages.at(-1)?.logs.length ?? 0) > 0;
  };

  const goToNextActivityLogPage = async () => {
    if (currentActivityLogPage < activityLogPageCount - 1) {
      setActivityLogPage(currentActivityLogPage + 1);
      return;
    }
    if (await loadMoreActivityLogs()) {
      setActivityLogPage(currentActivityLogPage + 1);
    }
  };

  const deletePersonalAccount = async () => {
    if (
      !window.confirm(
        "Permanently delete your Personal Account and every WhatsApp Connection? This cannot be undone.",
      )
    )
      return;
    setDeletionState("deleting");
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const deletion = await fetch(personalAccountDeletionEndpoint, {
        headers: { authorization: `Bearer ${token}` },
        method: "DELETE",
      });
      const body = (await deletion.json()) as {
        readonly personal_account?: { readonly state?: unknown };
      };
      if (
        deletion.status !== 202 ||
        body.personal_account?.state !== "deleting"
      ) {
        throw new Error("deletion unavailable");
      }
      setState("signed_out");
      queryClient.clear();
    } catch {
      setDeletionState("unavailable");
    }
  };

  const deleteConnection = async (connection: SafeWhatsAppConnection) => {
    if (deletingConnectionId !== null) return;
    if (
      !window.confirm(
        `Start irreversible Connection Deletion for the WhatsApp Connection ending ${connection.numberSuffix}? Access stops immediately while provider cleanup continues.`,
      )
    ) {
      return;
    }

    setDeletingConnectionId(connection.id);
    setConnectionDeletionStatus("");
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const response = await fetch(
        `${connectionsEndpoint}/${encodeURIComponent(connection.id)}/delete`,
        {
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
        },
      );
      const body = (await response.json()) as {
        readonly deletion?: { readonly outcome?: unknown };
        readonly whatsapp_connection_id?: unknown;
      };
      if (
        !response.ok ||
        body.deletion?.outcome !== "complete" ||
        body.whatsapp_connection_id !== connection.id
      ) {
        throw new Error("invalid deletion response");
      }

      queryClient.setQueryData(
        queryKeys.connectionWorkspace(),
        (current: ReadonlyArray<SafeWhatsAppConnection> | undefined) =>
          removeConnection(current, connection.id),
      );
      setConfigurationConnectionId((current) =>
        current === connection.id ? null : current,
      );
      setReconnectConnectionId((current) =>
        current === connection.id ? null : current,
      );
      setConnectionLifecycleStatus((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setNameDrafts((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setNameStatus((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setRetentionAcknowledgements((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setRetentionDrafts((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setRetentionStatus((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setConnectionDeletionStatus(
        `Connection Deletion started for the WhatsApp Connection ending ${connection.numberSuffix}. Access stops immediately while provider cleanup continues.`,
      );
    } catch {
      setConnectionDeletionStatus(
        `Connection Deletion is temporarily unavailable for the WhatsApp Connection ending ${connection.numberSuffix}.`,
      );
    } finally {
      setDeletingConnectionId(null);
    }
  };

  const replaceQrImage = (next: string | null) => {
    if (activeQrImageUrl.current !== null) {
      URL.revokeObjectURL(activeQrImageUrl.current);
    }
    activeQrImageUrl.current = next;
    setQrImageUrl(next);
  };

  const replaceReconnectQr = (
    next: { readonly connectionId: string; readonly url: string } | null,
  ) => {
    if (activeReconnectQrUrl.current !== null) {
      URL.revokeObjectURL(activeReconnectQrUrl.current);
    }
    activeReconnectQrUrl.current = next?.url ?? null;
    setReconnectQr(next);
  };

  const stopObserving = () => {
    observationGeneration.current += 1;
    observationAttempt.current = 0;
    if (observationTimer.current !== null) {
      clearTimeout(observationTimer.current);
      observationTimer.current = null;
    }
    replaceQrImage(null);
  };
  const stopObservingOnIdentityChange = useEffectEvent(stopObserving);

  useEffect(() => {
    if (identityState === "signed_in") return;
    stopObservingOnIdentityChange();
  }, [identityState, stopObservingOnIdentityChange]);

  const resetSetupForDraftChange = () => {
    stopObserving();
    setupIntent.current = null;
    setupObservationMetrics.current = {
      qrObservedAtMs: null,
      setupStartedAtMs: null,
      startToQrCaptured: false,
      qrToActiveCaptured: false,
    };
    setSetupCleanupState(null);
    setSetupId(null);
    setupStateRef.current = "idle";
    setSetupState("idle");
  };

  const updateConnectionName = (value: string) => {
    resetSetupForDraftChange();
    setConnectionName(value);
  };

  const updateWhatsappNumber = (value: string) => {
    resetSetupForDraftChange();
    setWhatsappNumber(value);
  };

  const clearSetupDraft = () => {
    stopObserving();
    setupIntent.current = null;
    setupObservationMetrics.current = {
      qrObservedAtMs: null,
      setupStartedAtMs: null,
      startToQrCaptured: false,
      qrToActiveCaptured: false,
    };
    setConnectionName("");
    setSetupCleanupState(null);
    setSetupId(null);
    setupStateRef.current = "idle";
    setSetupState("idle");
    setWhatsappNumber("");
  };

  const loadConnections = async (token: string) => {
    try {
      const withPolicies = await fetchConnectionsWithPolicies(
        connectionsEndpoint,
        token,
      );
      queryClient.setQueryData(queryKeys.connectionWorkspace(), withPolicies);
      queryClient.setQueryData(queryKeys.connections(), withPolicies);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.accountInsights(),
      });
      return withPolicies;
    } catch {
      return null;
    }
  };

  const renameConnection = async (connection: SafeWhatsAppConnection) => {
    const name = nameDrafts[connection.id] ?? connection.displayName;
    setNameStatus((current) => ({
      ...current,
      [connection.id]: "Saving name…",
    }));
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const response = await fetch(
        `${connectionsEndpoint}/${encodeURIComponent(connection.id)}/name`,
        {
          body: JSON.stringify({ name }),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "PUT",
        },
      );
      const body = (await response.json()) as {
        readonly whatsapp_connection?: Record<string, unknown>;
      };
      const renamed =
        body.whatsapp_connection === undefined
          ? null
          : decodeSafeWhatsAppConnection(body.whatsapp_connection);
      if (!response.ok || renamed === null) throw new Error("rename failed");
      queryClient.setQueryData(
        queryKeys.connectionWorkspace(),
        (current: ReadonlyArray<SafeWhatsAppConnection> | undefined) =>
          replaceConnection(current, {
            ...connection,
            displayName: renamed.displayName,
          }),
      );
      setNameDrafts((current) => ({
        ...current,
        [connection.id]: renamed.displayName,
      }));
      setNameStatus((current) => ({
        ...current,
        [connection.id]: "Name saved.",
      }));
    } catch {
      setNameStatus((current) => ({
        ...current,
        [connection.id]: "Name could not be saved.",
      }));
    }
  };

  const updateRetention = async (connection: SafeWhatsAppConnection) => {
    const draft = retentionDrafts[connection.id];
    const days = draft === "until-deletion" ? null : Number(draft);
    const broadens =
      days === null ||
      (connection.retentionDays !== null && days > connection.retentionDays);
    setRetentionStatus((current) => ({
      ...current,
      [connection.id]: "Saving Message Retention Policy…",
    }));
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const response = await fetch(
        `${connectionsEndpoint}/${encodeURIComponent(connection.id)}/retention-policy`,
        {
          body: JSON.stringify({
            acknowledge_extension: broadens
              ? retentionAcknowledgements[connection.id] === true
              : undefined,
            days,
            expected_days: connection.retentionDays,
          }),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "PUT",
        },
      );
      if (!response.ok) throw new Error("update failed");
      const body = (await response.json()) as {
        readonly policy?: { readonly days?: number | null };
      };
      if (body.policy?.days !== null && typeof body.policy?.days !== "number")
        throw new Error("invalid policy");
      queryClient.setQueryData(
        queryKeys.connectionWorkspace(),
        (current: ReadonlyArray<SafeWhatsAppConnection> | undefined) =>
          replaceConnection(current, {
            ...connection,
            retentionDays: body.policy?.days ?? null,
          }),
      );
      setRetentionAcknowledgements((current) => ({
        ...current,
        [connection.id]: false,
      }));
      setRetentionStatus((current) => ({
        ...current,
        [connection.id]: `Message Retention Policy saved. Current policy: ${body.policy?.days === null ? "retain until Connection Deletion" : `${body.policy?.days} days`}. Shorter policies apply promptly to retained content.`,
      }));
    } catch {
      setRetentionStatus((current) => ({
        ...current,
        [connection.id]: "Message Retention Policy could not be saved.",
      }));
    }
  };

  const saveConnectionConfiguration = async (
    connection: SafeWhatsAppConnection,
  ) => {
    if (savingNames.has(connection.id)) return;
    const name = nameDrafts[connection.id] ?? connection.displayName;
    const retention =
      retentionDrafts[connection.id] ??
      (connection.retentionDays === null
        ? "until-deletion"
        : String(connection.retentionDays));
    const nameChanged = name !== connection.displayName;
    const retentionChanged =
      retention !==
      (connection.retentionDays === null
        ? "until-deletion"
        : String(connection.retentionDays));

    if (!nameChanged && !retentionChanged) return;
    setSavingNames((current) => new Set(current).add(connection.id));
    if (!nameChanged) {
      setNameStatus((current) => ({ ...current, [connection.id]: "" }));
    }
    if (!retentionChanged) {
      setRetentionStatus((current) => ({ ...current, [connection.id]: "" }));
    }
    try {
      await Promise.all([
        nameChanged ? renameConnection(connection) : Promise.resolve(),
        retentionChanged ? updateRetention(connection) : Promise.resolve(),
      ]);
    } finally {
      setSavingNames((current) => {
        const next = new Set(current);
        next.delete(connection.id);
        return next;
      });
    }
  };

  const reconcileConnectionLifecycle = async (
    connectionId: string,
    action: "disconnect" | "reconnect",
    generation: number,
  ): Promise<void> => {
    const isCurrent = () => lifecycleGeneration.current === generation;
    const observeAgain = () => {
      lifecycleTimer.current = setTimeout(() => {
        lifecycleTimer.current = null;
        void reconcileConnectionLifecycle(connectionId, action, generation);
      }, 750);
    };

    try {
      const token = await getToken();
      if (!isCurrent()) return;
      if (token === null) {
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]: "Connection lifecycle is temporarily unavailable.",
        }));
        setConnectionLifecycleAction(null);
        return;
      }
      const response = await fetch(
        `${connectionsEndpoint}/${encodeURIComponent(connectionId)}/${action}`,
        {
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
        },
      );
      if (!isCurrent()) return;
      if (
        response.ok &&
        response.headers.get("content-type")?.startsWith("image/svg+xml")
      ) {
        const image = await response.blob();
        if (!isCurrent()) return;
        replaceReconnectQr({
          connectionId,
          url: URL.createObjectURL(image),
        });
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]: "Scan the QR code to reconnect.",
        }));
        observeAgain();
        return;
      }

      const body = (await response.json()) as {
        readonly lifecycle?: {
          readonly action?: unknown;
          readonly outcome?: unknown;
        };
        readonly whatsapp_connection?: Record<string, unknown>;
      };
      const connection =
        body.whatsapp_connection === undefined
          ? null
          : decodeSafeWhatsAppConnection(body.whatsapp_connection);
      if (
        connection === null ||
        body.lifecycle?.action !== action ||
        (body.lifecycle.outcome !== "complete" &&
          body.lifecycle.outcome !== "in_progress" &&
          body.lifecycle.outcome !== "recovery_required")
      ) {
        throw new Error("invalid lifecycle response");
      }
      queryClient.setQueryData(
        queryKeys.connectionWorkspace(),
        (current: ReadonlyArray<SafeWhatsAppConnection> | undefined) =>
          replaceConnection(current, {
            ...connection,
            retentionDays:
              current?.find((candidate) => candidate.id === connectionId)
                ?.retentionDays ?? connection.retentionDays,
            retentionOptions:
              current?.find((candidate) => candidate.id === connectionId)
                ?.retentionOptions ?? connection.retentionOptions,
          }),
      );
      if (body.lifecycle.outcome === "in_progress") {
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]:
            action === "disconnect"
              ? "Disconnecting WhatsApp Connection."
              : "Reconnecting WhatsApp Connection.",
        }));
        observeAgain();
        return;
      }

      replaceReconnectQr(null);
      setConnectionLifecycleAction(null);
      setConnectionLifecycleStatus((current) => ({
        ...current,
        [connectionId]:
          body.lifecycle?.outcome === "complete"
            ? action === "disconnect"
              ? "WhatsApp Connection disconnected."
              : "WhatsApp Connection reconnected."
            : "WhatsApp Connection needs recovery before new side effects.",
      }));
    } catch {
      if (isCurrent()) {
        replaceReconnectQr(null);
        setConnectionLifecycleAction(null);
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]: "Connection lifecycle is temporarily unavailable.",
        }));
      }
    }
  };

  const startConnectionLifecycle = (
    connection: SafeWhatsAppConnection,
    action: "disconnect" | "reconnect",
  ) => {
    lifecycleGeneration.current += 1;
    if (lifecycleTimer.current !== null) {
      clearTimeout(lifecycleTimer.current);
      lifecycleTimer.current = null;
    }
    replaceReconnectQr(null);
    const generation = lifecycleGeneration.current;
    setConnectionLifecycleAction(`${connection.id}:${action}`);
    setConnectionLifecycleStatus((current) => ({
      ...current,
      [connection.id]:
        action === "disconnect"
          ? "Disconnecting WhatsApp Connection."
          : "Reconnecting WhatsApp Connection.",
    }));
    void reconcileConnectionLifecycle(connection.id, action, generation);
  };

  const observeSetup = async (
    setupId: string,
    generation: number,
  ): Promise<void> => {
    const isCurrent = () => observationGeneration.current === generation;
    const observeAgain = () => {
      const delayMs = nextConnectionSetupPollDelayMs(
        setupStateRef.current,
        observationAttempt.current,
      );
      observationAttempt.current += 1;
      observationTimer.current = setTimeout(() => {
        observationTimer.current = null;
        void observeSetup(setupId, generation);
      }, delayMs);
    };
    const markState = (nextState: SetupState) => {
      const previousState = setupStateRef.current;
      if (previousState !== nextState) {
        observationAttempt.current = 0;
      }
      setupStateRef.current = nextState;
      setSetupState(nextState);
      if (
        nextState === "qr_available" &&
        !setupObservationMetrics.current.startToQrCaptured
      ) {
        const observedAtMs = performance.now();
        const durationMs = observationMetricDurationMs(
          setupObservationMetrics.current.setupStartedAtMs,
          observedAtMs,
        );
        if (durationMs !== null) {
          captureProductAnalyticsEvent({
            durationMs,
            event: "connection_setup_timing_recorded",
            phase: "start_to_code_observed",
          });
          setupObservationMetrics.current = {
            ...setupObservationMetrics.current,
            qrObservedAtMs: observedAtMs,
            startToQrCaptured: true,
          };
        }
      }
      if (
        nextState === "connected" &&
        !setupObservationMetrics.current.qrToActiveCaptured
      ) {
        const durationMs = observationMetricDurationMs(
          setupObservationMetrics.current.qrObservedAtMs,
          performance.now(),
        );
        if (durationMs !== null) {
          captureProductAnalyticsEvent({
            durationMs,
            event: "connection_setup_timing_recorded",
            phase: "code_observed_to_active_observed",
          });
          setupObservationMetrics.current = {
            ...setupObservationMetrics.current,
            qrToActiveCaptured: true,
          };
        }
      }
    };

    try {
      const token = await getToken();
      if (!isCurrent()) return;
      if (token === null) {
        replaceQrImage(null);
        markState("unavailable");
        return;
      }
      const response = await fetch(`${connectionSetupEndpoint}/${setupId}/qr`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!isCurrent()) return;
      if (response.status === 200) {
        const image = await response.blob();
        if (!isCurrent()) return;
        replaceQrImage(URL.createObjectURL(image));
        markState("qr_available");
        observeAgain();
        return;
      }
      if (response.status === 202) {
        replaceQrImage(null);
        markState(
          response.headers.get("x-connection-setup-state") === "connecting"
            ? "connecting"
            : "pending",
        );
        observeAgain();
        return;
      }
      if (response.status === 204) {
        replaceQrImage(null);
        markState("connected");
        if ((await loadConnections(token)) === null) {
          if (isCurrent()) markState("unavailable");
        }
        return;
      }
      const body = (await response.json()) as { readonly error?: unknown };
      if (!isCurrent()) return;
      replaceQrImage(null);
      if (
        body.error === "number_confirmation_failed" ||
        body.error === "provider_capacity_unavailable" ||
        body.error === "provisioning_failed" ||
        body.error === "provisioning_quarantined"
      ) {
        markState(body.error);
        return;
      }
      markState("unavailable");
    } catch {
      if (isCurrent()) {
        replaceQrImage(null);
        markState("unavailable");
      }
    }
  };

  const startObserving = (setupId: string) => {
    stopObserving();
    observationAttempt.current = 0;
    void observeSetup(setupId, observationGeneration.current);
  };

  const checkBoundary = async () => {
    setState("loading");

    try {
      const token = await getToken();
      if (token === null) {
        setState("signed_out");
        return;
      }

      const response = await fetch(personalAccountEndpoint, {
        headers: {
          authorization: `Bearer ${token}`,
        },
        method: "POST",
      });
      if (!response.ok) {
        setState("unavailable");
        return;
      }
      const body = (await response.json()) as {
        readonly personal_account?: {
          readonly message_retention_days?: unknown;
          readonly state?: unknown;
          readonly stored_media_limit_bytes?: unknown;
          readonly whatsapp_connection_limit?: unknown;
        };
      };
      if (
        body.personal_account?.state !== "active" ||
        body.personal_account.message_retention_days !== 30 ||
        body.personal_account.whatsapp_connection_limit !== 3 ||
        body.personal_account.stored_media_limit_bytes !== 5_368_709_120
      ) {
        setState("unavailable");
        return;
      }
      sawInitialConnections.current = false;
      setState("ok");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.authorizations() }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.accountInsights(),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activityLogs() }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.onboardingProfile(),
        }),
      ]);
    } catch {
      setState("unavailable");
    }
  };

  // The transition to an authenticated Clerk session owns this one-time
  // bootstrap. The ref prevents development remount checks from duplicating it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: checkBoundary uses the values from this authenticated render.
  useEffect(() => {
    if (
      !autoInitialize ||
      !isLoaded ||
      !isSignedIn ||
      automaticallyInitialized.current
    ) {
      return;
    }

    automaticallyInitialized.current = true;
    void checkBoundary();
  }, [autoInitialize, isLoaded, isSignedIn]);

  useEffect(() => {
    if (view !== "activity") return;
    captureProductAnalyticsEvent({
      event: "feature_used",
      feature: "activity_logs_viewed",
    });
  }, [view]);

  useEffect(() => {
    if (view !== "overview") return;
    captureProductAnalyticsEvent({
      event: "feature_used",
      feature: "account_insights_viewed",
    });
  }, [view]);

  const revokeAuthorization = async (authorization: McpAuthorization) => {
    setRevokingAuthorization(authorization.id);
    try {
      await revokeAuthorizationMutation.mutateAsync(authorization);
    } finally {
      setRevokingAuthorization(null);
    }
  };

  const startSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    stopObserving();
    const requestGeneration = observationGeneration.current;
    setupObservationMetrics.current = {
      qrObservedAtMs: null,
      setupStartedAtMs: performance.now(),
      startToQrCaptured: false,
      qrToActiveCaptured: false,
    };
    setupStateRef.current = "loading";
    setSetupState("loading");
    setSetupCleanupState(null);

    const intent =
      setupIntent.current?.whatsappNumber === whatsappNumber &&
      setupIntent.current.name === connectionName
        ? setupIntent.current
        : {
            idempotencyKey: String(makeIdempotencyKey()),
            name: connectionName,
            whatsappNumber,
          };
    setupIntent.current = intent;

    try {
      const token = await getToken();
      if (observationGeneration.current !== requestGeneration) return;
      if (token === null) {
        setupStateRef.current = "unavailable";
        setSetupState("unavailable");
        return;
      }
      const response = await fetch(connectionSetupEndpoint, {
        body: JSON.stringify({
          idempotency_key: intent.idempotencyKey,
          name: intent.name,
          whatsapp_number: intent.whatsappNumber,
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      if (observationGeneration.current !== requestGeneration) return;
      const body = (await response.json()) as {
        readonly connection_setup?: {
          readonly expires_at?: unknown;
          readonly id?: unknown;
          readonly idempotent_replay?: unknown;
          readonly state?: unknown;
        };
        readonly error?: unknown;
      };
      if (response.ok && body.connection_setup !== undefined) {
        const setup = body.connection_setup;
        if (
          typeof setup.expires_at === "string" &&
          typeof setup.id === "string" &&
          /^cst_[A-Za-z0-9_-]{21}$/u.test(setup.id)
        ) {
          setSetupId(setup.id);
          if (setup.state === "pending") {
            setupStateRef.current =
              setup.idempotent_replay === true ? "replayed" : "pending";
            setSetupState(
              setup.idempotent_replay === true ? "replayed" : "pending",
            );
            startObserving(setup.id);
            return;
          }
          if (
            setup.state === "cancelled" ||
            setup.state === "expired" ||
            setup.state === "provisioned" ||
            setup.state === "activated" ||
            setup.state === "provisioning_failed" ||
            setup.state === "provisioning_quarantined"
          ) {
            setupStateRef.current =
              setup.state === "activated" ? "connected" : setup.state;
            setSetupState(
              setup.state === "activated" ? "connected" : setup.state,
            );
            if (setup.state === "provisioned") {
              startObserving(setup.id);
            } else if (
              setup.state === "activated" &&
              (await loadConnections(token)) === null &&
              observationGeneration.current === requestGeneration
            ) {
              setupStateRef.current = "unavailable";
              setSetupState("unavailable");
            }
            return;
          }
        }
      }
      if (body.error === "invalid_request") {
        setupStateRef.current = "invalid";
        setSetupState("invalid");
        return;
      }
      if (
        body.error === "whatsapp_number_unavailable" ||
        body.error === "connection_limit_reached"
      ) {
        setupStateRef.current =
          body.error === "whatsapp_number_unavailable"
            ? "number_unavailable"
            : body.error;
        setSetupState(
          body.error === "whatsapp_number_unavailable"
            ? "number_unavailable"
            : body.error,
        );
        return;
      }
      setupStateRef.current = "unavailable";
      setSetupState("unavailable");
    } catch {
      setupStateRef.current = "unavailable";
      setSetupState("unavailable");
    }
  };

  const cancelSetup = async () => {
    if (setupId === null) return;
    stopObserving();
    setupObservationMetrics.current = {
      qrObservedAtMs: null,
      setupStartedAtMs: null,
      startToQrCaptured: false,
      qrToActiveCaptured: false,
    };
    setupStateRef.current = "cancelling";
    setSetupState("cancelling");

    try {
      const token = await getToken();
      if (token === null) {
        setupStateRef.current = "unavailable";
        setSetupState("unavailable");
        return;
      }
      const response = await fetch(`${connectionSetupEndpoint}/${setupId}`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
        method: "DELETE",
      });
      const body = (await response.json()) as {
        readonly connection_setup?: {
          readonly cleanup_state?: unknown;
          readonly id?: unknown;
          readonly state?: unknown;
        };
      };
      if (
        response.ok &&
        body.connection_setup?.id === setupId &&
        (body.connection_setup.cleanup_state === "pending" ||
          body.connection_setup.cleanup_state === "retrying" ||
          body.connection_setup.cleanup_state === "complete") &&
        (body.connection_setup.state === "cancelled" ||
          body.connection_setup.state === "expired")
      ) {
        setupIntent.current = null;
        setSetupId(null);
        setSetupCleanupState(body.connection_setup.cleanup_state);
        setupStateRef.current = body.connection_setup.state;
        setSetupState(body.connection_setup.state);
        return;
      }
      setupStateRef.current = "unavailable";
      setSetupState("unavailable");
    } catch {
      setupStateRef.current = "unavailable";
      setSetupState("unavailable");
    }
  };

  return (
    <section
      aria-label="Signed-in API boundary"
      className="flex flex-col gap-10"
    >
      {identityState === "signed_in" && !autoInitialize ? (
        <Button
          className="self-start"
          disabled={state === "loading"}
          onClick={checkBoundary}
          size="lg"
          type="button"
        >
          {state === "loading" ? <Spinner data-icon="inline-start" /> : null}
          Continue to Personal Account
        </Button>
      ) : identityState === "signed_out" ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={openWaitlist} type="button">
            Join the waitlist
          </Button>
          <Button onClick={openSignIn} type="button" variant="outline">
            Sign in
          </Button>
        </div>
      ) : null}
      {!autoInitialize ? (
        <p
          className="text-sm text-muted-foreground"
          aria-live="polite"
          data-testid="api-boundary-status"
        >
          {identityState === "loading"
            ? "Checking sign-in status…"
            : identityState === "unavailable"
              ? "Sign-in is temporarily unavailable. Please refresh and try again."
              : identityState === "signed_out"
                ? "Join the private-beta waitlist, or sign in if you’re approved."
                : state === "ok"
                  ? "Personal Account ready"
                  : state === "loading"
                    ? "Preparing your Personal Account…"
                    : state === "unavailable"
                      ? "Your Personal Account is temporarily unavailable. Please try again."
                      : "Signed in. Continue to create or open your Personal Account."}
        </p>
      ) : dashboardLoading ? (
        <div className="flex flex-col gap-3">
          <span className="sr-only">Loading Personal Account</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : dashboardUnavailable ? (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          Your Personal Account is temporarily unavailable. Please try again.
        </p>
      ) : null}
      {dashboardReady &&
      showFirstConnectionOnboarding &&
      (view === "overview" || view === "connections") ? (
        <FirstConnectionOnboarding
          connectedConnection={connections[0] ?? null}
          getToken={getToken}
          initialProfile={onboardingProfile}
          mcpServerUrl={mcpServerUrl}
          onboardingProfileEndpoint={onboardingProfileEndpoint}
          onComplete={() => {
            clearSetupDraft();
            setShowFirstConnectionOnboarding(false);
          }}
          onProfileSaved={(profile) => {
            setOnboardingProfile(profile);
            queryClient.setQueryData(queryKeys.onboardingProfile(), profile);
          }}
          setupForm={{
            connectionName,
            onCancelSetup: cancelSetup,
            onConnectionNameChange: updateConnectionName,
            onResetSetup: clearSetupDraft,
            onStartSetup: startSetup,
            onWhatsappNumberChange: updateWhatsappNumber,
            qrImageUrl,
            setupCleanupState,
            setupId,
            setupState,
            whatsappNumber,
          }}
        />
      ) : null}
      {dashboardReady &&
      !(
        showFirstConnectionOnboarding &&
        (view === "overview" || view === "connections")
      ) ? (
        <>
          {view === "overview" ? (
            <AccountOverview
              authorizations={authorizations}
              connections={connections}
              insights={insights}
              insightsState={insightsState}
            />
          ) : null}
          {view === "authorizations" ? (
            <McpConnectionGuides serverUrl={mcpServerUrl} />
          ) : null}
          {view === "authorizations" ? (
            <section
              aria-label="MCP Authorizations"
              className="flex flex-col gap-5"
            >
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  Apps with access
                </h2>
                <p className="text-sm text-muted-foreground">
                  See what each MCP Client can do, or remove its access
                  instantly.
                </p>
              </div>
              {authorizationState === "loading" ? (
                <p aria-live="polite">Loading MCP Authorizations…</p>
              ) : authorizationState === "unavailable" ? (
                <p aria-live="polite">
                  MCP Authorizations are temporarily unavailable.
                </p>
              ) : authorizations.length === 0 ? (
                <p>No MCP Clients currently have access.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {authorizations.map((authorization) => {
                    const stateLabel =
                      authorization.revocationState === "revoked"
                        ? "Revoked"
                        : authorization.expiryState === "expired"
                          ? "Expired"
                          : "Active";
                    return (
                      <li
                        className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6"
                        key={authorization.id}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h3 className="font-medium">
                              {authorization.client.name}
                            </h3>
                            <p
                              className="mt-0.5 max-w-48 truncate font-mono text-xs text-muted-foreground"
                              title={authorization.client.id}
                            >
                              {authorization.client.id}
                            </p>
                          </div>
                          <Badge
                            data-testid="mcp-authorization-state"
                            variant="outline"
                          >
                            {stateLabel}
                          </Badge>
                        </div>
                        <dl className="grid gap-3 text-sm sm:grid-cols-2">
                          <div>
                            <dt className="text-muted-foreground">Created</dt>
                            <dd>
                              <time dateTime={authorization.createdAt}>
                                {displayTime(authorization.createdAt)} UTC
                              </time>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Expires</dt>
                            <dd>
                              <time dateTime={authorization.expiresAt}>
                                {displayTime(authorization.expiresAt)} UTC
                              </time>
                            </dd>
                          </div>
                        </dl>
                        <details className="text-sm text-muted-foreground">
                          <summary className="w-fit cursor-pointer select-none font-medium text-foreground">
                            Technical details
                          </summary>
                          <div className="mt-3 flex flex-col gap-1">
                            <p className="text-sm text-muted-foreground">
                              WhatsApp Connections
                            </p>
                            <ul className="flex flex-col gap-1 font-mono text-xs">
                              {authorization.connectionIds.map(
                                (connectionId) => (
                                  <li key={connectionId}>{connectionId}</li>
                                ),
                              )}
                            </ul>
                          </div>
                        </details>
                        <div className="flex flex-col gap-1">
                          <p className="text-sm text-muted-foreground">
                            Permissions
                          </p>
                          <ul className="flex flex-wrap gap-2 text-xs">
                            {authorization.scopes.map((scope) => (
                              <li key={scope}>
                                <Badge variant="secondary">
                                  {scopeLabels[scope]}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <Button
                          className="self-start"
                          aria-label={`Revoke ${authorization.client.name}`}
                          disabled={
                            authorization.revocationState === "revoked" ||
                            revokingAuthorization === authorization.id
                          }
                          onClick={() => revokeAuthorization(authorization)}
                          type="button"
                          variant="destructive"
                        >
                          {revokingAuthorization === authorization.id ? (
                            <Spinner data-icon="inline-start" />
                          ) : null}
                          {revokingAuthorization === authorization.id
                            ? "Revoking…"
                            : "Revoke access"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}
          {view === "activity" ? (
            <section aria-label="Activity Log" className="flex flex-col gap-5">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  Recent activity
                </h2>
                <p className="text-sm text-muted-foreground">
                  See how your MCP Clients used WhatsApp in the last 90 days.
                  Message content and full numbers are never shown here.
                </p>
              </div>
              {activityLogState === "loading" ? (
                <p aria-live="polite">Loading Activity Log…</p>
              ) : activityLogState === "unavailable" ? (
                <p aria-live="polite">
                  Activity Log is temporarily unavailable.
                </p>
              ) : activityLogs.length === 0 ? (
                <p>No tool activity in the last 90 days.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  <FieldGroup className="flex flex-col gap-2 sm:flex-row">
                    <Field className="sm:max-w-sm">
                      <FieldLabel className="sr-only" htmlFor="log-search">
                        Search Activity Log
                      </FieldLabel>
                      <Input
                        id="log-search"
                        onChange={(event) => {
                          setActivityLogSearch(event.target.value);
                          setActivityLogPage(0);
                        }}
                        placeholder="Search tools, clients, or references…"
                        type="search"
                        value={activityLogSearch}
                      />
                    </Field>
                    <Field className="sm:w-fit">
                      <FieldLabel className="sr-only" htmlFor="log-outcome">
                        Filter by outcome
                      </FieldLabel>
                      <Select
                        items={[
                          { label: "All outcomes", value: "all" },
                          ...activityLogOutcomes.map((outcome) => ({
                            label: outcome.replaceAll("_", " "),
                            value: outcome,
                          })),
                        ]}
                        onValueChange={(value) => {
                          if (value === null) return;
                          setActivityLogOutcome(
                            value as "all" | ActivityLog["outcome"],
                          );
                          setActivityLogPage(0);
                        }}
                        value={activityLogOutcome}
                      >
                        <SelectTrigger id="log-outcome">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="all">All outcomes</SelectItem>
                            {activityLogOutcomes.map((outcome) => (
                              <SelectItem key={outcome} value={outcome}>
                                <span className="capitalize">
                                  {outcome.replaceAll("_", " ")}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </FieldGroup>
                  <div className="rounded-xl border bg-card">
                    <Table className="min-w-4xl">
                      <TableHeader className="bg-muted/40 text-xs text-muted-foreground">
                        <TableRow>
                          <TableHead
                            aria-sort={
                              activityLogSort === "capability"
                                ? activityLogSortDirection
                                : "none"
                            }
                            className="px-4"
                          >
                            <Button
                              aria-label="Sort by tool"
                              className="-ml-2"
                              onClick={() =>
                                changeActivityLogSort("capability")
                              }
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Tool
                              <ArrowUpDownIcon data-icon="inline-end" />
                            </Button>
                          </TableHead>
                          <TableHead
                            aria-sort={
                              activityLogSort === "startedAt"
                                ? activityLogSortDirection
                                : "none"
                            }
                            className="px-4"
                          >
                            <Button
                              aria-label="Sort by started time"
                              className="-ml-2"
                              onClick={() => changeActivityLogSort("startedAt")}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Started
                              <ArrowUpDownIcon data-icon="inline-end" />
                            </Button>
                          </TableHead>
                          <TableHead
                            aria-sort={
                              activityLogSort === "results"
                                ? activityLogSortDirection
                                : "none"
                            }
                            className="px-4"
                          >
                            <Button
                              aria-label="Sort by results"
                              className="-ml-2"
                              onClick={() => changeActivityLogSort("results")}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Results
                              <ArrowUpDownIcon data-icon="inline-end" />
                            </Button>
                          </TableHead>
                          <TableHead
                            aria-sort={
                              activityLogSort === "latencyMs"
                                ? activityLogSortDirection
                                : "none"
                            }
                            className="px-4"
                          >
                            <Button
                              aria-label="Sort by latency"
                              className="-ml-2"
                              onClick={() => changeActivityLogSort("latencyMs")}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Latency
                              <ArrowUpDownIcon data-icon="inline-end" />
                            </Button>
                          </TableHead>
                          <TableHead className="px-4">References</TableHead>
                          <TableHead
                            aria-sort={
                              activityLogSort === "outcome"
                                ? activityLogSortDirection
                                : "none"
                            }
                            className="px-4 text-right"
                          >
                            <Button
                              aria-label="Sort by outcome"
                              className="-mr-2"
                              onClick={() => changeActivityLogSort("outcome")}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Outcome
                              <ArrowUpDownIcon data-icon="inline-end" />
                            </Button>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleActivityLogs.map((log, index) => (
                          <TableRow
                            data-testid="activity-log"
                            key={`${log.startedAt}:${log.references[0]}:${index}`}
                          >
                            <TableCell className="px-4 py-3 align-top">
                              <p className="whitespace-nowrap font-medium">
                                {log.capability.replaceAll("_", " ")}
                              </p>
                              <p className="whitespace-nowrap text-xs text-muted-foreground">
                                {log.principal === "api_key"
                                  ? `API Key · ${log.client.name}`
                                  : log.client.name}
                              </p>
                            </TableCell>
                            <TableCell className="px-4 py-3 align-top">
                              <time dateTime={log.startedAt}>
                                {displayTime(log.startedAt)} UTC
                              </time>
                            </TableCell>
                            <TableCell className="px-4 py-3 align-top">
                              {log.counts.results ?? "Pending"}
                            </TableCell>
                            <TableCell className="px-4 py-3 align-top">
                              {log.latencyMs === null
                                ? "Pending"
                                : `${log.latencyMs} ms`}
                            </TableCell>
                            <TableCell className="px-4 py-3 align-top">
                              <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                                {log.references.map((reference) => (
                                  <li key={reference}>{reference}</li>
                                ))}
                              </ul>
                            </TableCell>
                            <TableCell className="px-4 py-3 text-right align-top">
                              <Badge className="capitalize" variant="outline">
                                {log.outcome.replaceAll("_", " ")}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                        {visibleActivityLogs.length === 0 ? (
                          <TableRow>
                            <TableCell
                              className="h-24 text-center text-muted-foreground"
                              colSpan={6}
                            >
                              No Activity Log entries match these filters.
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>
                        {sortedActivityLogs.length === 0
                          ? "0 rows"
                          : `${currentActivityLogPage * activityLogPageSize + 1}–${Math.min(
                              (currentActivityLogPage + 1) *
                                activityLogPageSize,
                              sortedActivityLogs.length,
                            )} of ${sortedActivityLogs.length} loaded rows`}
                      </span>
                      <Select
                        items={[10, 25, 50].map((size) => ({
                          label: `${size} per page`,
                          value: String(size),
                        }))}
                        onValueChange={(value) => {
                          if (value === null) return;
                          setActivityLogPageSize(Number(value));
                          setActivityLogPage(0);
                        }}
                        value={String(activityLogPageSize)}
                      >
                        <SelectTrigger aria-label="Rows per page" size="sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {[10, 25, 50].map((size) => (
                              <SelectItem key={size} value={String(size)}>
                                {size} per page
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        Page {currentActivityLogPage + 1} of{" "}
                        {activityLogPageCount}
                      </span>
                      <Button
                        aria-label="Previous page"
                        disabled={currentActivityLogPage === 0}
                        onClick={() =>
                          setActivityLogPage(currentActivityLogPage - 1)
                        }
                        size="icon-sm"
                        type="button"
                        variant="outline"
                      >
                        <ChevronLeftIcon />
                      </Button>
                      <Button
                        aria-label="Next page"
                        disabled={
                          activityLogPageState === "loading" ||
                          (currentActivityLogPage >= activityLogPageCount - 1 &&
                            activityLogCursor === null)
                        }
                        onClick={goToNextActivityLogPage}
                        size="icon-sm"
                        type="button"
                        variant="outline"
                      >
                        {activityLogPageState === "loading" ? (
                          <Spinner />
                        ) : (
                          <ChevronRightIcon />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              {activityLogPageState === "unavailable" ? (
                <p aria-live="polite">
                  More Activity Log entries are unavailable.
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
      {dashboardReady &&
      !showFirstConnectionOnboarding &&
      view === "connections" ? (
        <section
          aria-label="WhatsApp Connections"
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                Your WhatsApp Connections
              </h2>
              <p className="text-sm text-muted-foreground">
                Connection health, message history, and reconnect controls.
              </p>
            </div>
            <Dialog
              onOpenChange={(open) => {
                const durableActiveSetup =
                  setupId !== null &&
                  setupState !== "cancelled" &&
                  setupState !== "expired" &&
                  setupState !== "connected";
                if (open || !durableActiveSetup) {
                  setSetupDialogOpen(open);
                }
                if (open) {
                  captureProductAnalyticsEvent({
                    event: "feature_used",
                    feature: "additional_connection_setup",
                  });
                }
                if (!open && !durableActiveSetup && setupId !== null) {
                  clearSetupDraft();
                }
              }}
              open={setupDialogOpen}
            >
              <DialogTrigger render={<Button />}>
                Register WhatsApp Number
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New WhatsApp Connection</DialogTitle>
                  <DialogDescription>
                    Enter the number you want to connect. You will scan a QR
                    code in WhatsApp next.
                  </DialogDescription>
                </DialogHeader>
                <ConnectionSetupForm
                  connectionName={connectionName}
                  idPrefix="additional-connection"
                  layout="dialog"
                  onCancelSetup={cancelSetup}
                  onConnectionNameChange={updateConnectionName}
                  onResetSetup={clearSetupDraft}
                  onStartSetup={startSetup}
                  onWhatsappNumberChange={updateWhatsappNumber}
                  qrImageUrl={qrImageUrl}
                  setupCleanupState={setupCleanupState}
                  setupId={setupId}
                  setupState={setupState}
                  whatsappNumber={whatsappNumber}
                />
              </DialogContent>
            </Dialog>
          </div>
          {connectionDeletionStatus.length > 0 ? (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {connectionDeletionStatus}
            </p>
          ) : null}
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No WhatsApp Connections yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {connections.map((connection) => (
                <li
                  className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10"
                  data-testid="whatsapp-connection"
                  key={connection.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium">
                          {connection.displayName}
                        </p>
                        <Badge
                          className="capitalize"
                          variant={
                            connection.state === "connected"
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {connection.state.replace("_", " ")}
                        </Badge>
                      </div>
                      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <div className="flex gap-1">
                          <dt>Number </dt>
                          <dd>ending {connection.numberSuffix}</dd>
                        </div>
                        <div className="flex gap-1">
                          <dt>Message history</dt>
                          <dd>
                            {connection.retentionDays === null
                              ? "until Connection Deletion"
                              : `${connection.retentionDays} days`}
                          </dd>
                        </div>
                        <div className="flex gap-1">
                          <dt>State changed</dt>
                          <dd>
                            <time dateTime={connection.stateChangedAt}>
                              {displayTime(connection.stateChangedAt)} UTC
                            </time>
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            aria-label={`Options for WhatsApp Connection ending ${connection.numberSuffix}`}
                            size="icon-sm"
                            variant="ghost"
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            disabled={deletingConnectionId === connection.id}
                            onClick={() =>
                              setConfigurationConnectionId(connection.id)
                            }
                          >
                            Configure
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={
                              deletingConnectionId === connection.id ||
                              connectionLifecycleAction !== null
                            }
                            onClick={() => void deleteConnection(connection)}
                            variant="destructive"
                          >
                            Delete Connection
                          </DropdownMenuItem>
                          {connection.state === "connected" ? (
                            <DropdownMenuItem
                              disabled={
                                connectionLifecycleAction !== null ||
                                deletingConnectionId === connection.id
                              }
                              onClick={() =>
                                startConnectionLifecycle(
                                  connection,
                                  "disconnect",
                                )
                              }
                              variant="destructive"
                            >
                              Disconnect
                            </DropdownMenuItem>
                          ) : connection.state === "connecting" ||
                            connection.state === "disconnected" ||
                            connection.state === "degraded" ||
                            connection.state === "reconnect_required" ? (
                            <DropdownMenuItem
                              disabled={deletingConnectionId === connection.id}
                              onClick={() =>
                                setReconnectConnectionId(connection.id)
                              }
                            >
                              Reconnect
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <Dialog
                    onOpenChange={(open) => {
                      if (!open) setConfigurationConnectionId(null);
                    }}
                    open={configurationConnectionId === connection.id}
                  >
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Configure WhatsApp Connection</DialogTitle>
                        <DialogDescription>
                          Rename this WhatsApp Connection or choose how long to
                          keep its message history.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogBody className="flex flex-col gap-6">
                        <Field>
                          <FieldLabel htmlFor={`name-${connection.id}`}>
                            Name
                          </FieldLabel>
                          <Input
                            disabled={savingNames.has(connection.id)}
                            id={`name-${connection.id}`}
                            maxLength={64}
                            onChange={(event) =>
                              setNameDrafts((current) => ({
                                ...current,
                                [connection.id]: event.target.value,
                              }))
                            }
                            required
                            value={
                              nameDrafts[connection.id] ??
                              connection.displayName
                            }
                          />
                          {nameStatus[connection.id] ? (
                            <p
                              aria-live="polite"
                              className="text-sm text-muted-foreground"
                            >
                              {nameStatus[connection.id]}
                            </p>
                          ) : null}
                        </Field>
                        <Separator />
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor={`retention-${connection.id}`}>
                              Keep message history for
                            </FieldLabel>
                            <Select
                              disabled={savingNames.has(connection.id)}
                              items={[
                                ...connection.retentionOptions.map((days) => ({
                                  label: `${days} days`,
                                  value: String(days),
                                })),
                                {
                                  label: "Retain until Connection Deletion",
                                  value: "until-deletion",
                                },
                              ]}
                              onValueChange={(value) => {
                                if (value === null) return;
                                setRetentionDrafts((current) => ({
                                  ...current,
                                  [connection.id]: value,
                                }));
                                setRetentionAcknowledgements((current) => ({
                                  ...current,
                                  [connection.id]: false,
                                }));
                              }}
                              value={
                                retentionDrafts[connection.id] ??
                                (connection.retentionDays === null
                                  ? "until-deletion"
                                  : String(connection.retentionDays))
                              }
                            >
                              <SelectTrigger
                                className="w-full"
                                id={`retention-${connection.id}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {connection.retentionOptions.map((days) => (
                                    <SelectItem key={days} value={String(days)}>
                                      {days} days
                                    </SelectItem>
                                  ))}
                                  <SelectItem value="until-deletion">
                                    Retain until Connection Deletion
                                  </SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          {(() => {
                            const draft = retentionDrafts[connection.id];
                            const next =
                              draft === "until-deletion"
                                ? null
                                : Number(draft ?? connection.retentionDays);
                            const broadens =
                              draft !== undefined &&
                              draft !==
                                (connection.retentionDays === null
                                  ? "until-deletion"
                                  : String(connection.retentionDays)) &&
                              (next === null ||
                                (connection.retentionDays !== null &&
                                  next > connection.retentionDays));
                            return broadens ? (
                              <Field orientation="horizontal">
                                <Checkbox
                                  checked={
                                    retentionAcknowledgements[connection.id] ===
                                    true
                                  }
                                  id={`retention-acknowledgement-${connection.id}`}
                                  onCheckedChange={(checked) =>
                                    setRetentionAcknowledgements((current) => ({
                                      ...current,
                                      [connection.id]: checked,
                                    }))
                                  }
                                />
                                <FieldLabel
                                  htmlFor={`retention-acknowledgement-${connection.id}`}
                                >
                                  I explicitly choose to retain message content
                                  for longer.
                                </FieldLabel>
                              </Field>
                            ) : null;
                          })()}
                          <p
                            aria-live="polite"
                            className="text-sm text-muted-foreground"
                          >
                            {retentionStatus[connection.id] ??
                              `Current policy: ${connection.retentionDays === null ? "retain until Connection Deletion" : `${connection.retentionDays} days`}.`}
                          </p>
                        </FieldGroup>
                      </DialogBody>
                      <DialogFooter>
                        <Button
                          disabled={(() => {
                            const name =
                              nameDrafts[connection.id] ??
                              connection.displayName;
                            const retention =
                              retentionDrafts[connection.id] ??
                              (connection.retentionDays === null
                                ? "until-deletion"
                                : String(connection.retentionDays));
                            const retentionChanged =
                              retention !==
                              (connection.retentionDays === null
                                ? "until-deletion"
                                : String(connection.retentionDays));
                            const nextRetention =
                              retention === "until-deletion"
                                ? null
                                : Number(retention);
                            const broadensRetention =
                              retentionChanged &&
                              (nextRetention === null ||
                                (connection.retentionDays !== null &&
                                  nextRetention > connection.retentionDays));
                            return (
                              savingNames.has(connection.id) ||
                              name.trim().length === 0 ||
                              (name === connection.displayName &&
                                !retentionChanged) ||
                              (broadensRetention &&
                                retentionAcknowledgements[connection.id] !==
                                  true)
                            );
                          })()}
                          onClick={() =>
                            void saveConnectionConfiguration(connection)
                          }
                          type="button"
                        >
                          {savingNames.has(connection.id) ? (
                            <Spinner data-icon="inline-start" />
                          ) : null}
                          Save changes
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  <Dialog
                    onOpenChange={(open) => {
                      if (!open) setReconnectConnectionId(null);
                    }}
                    open={reconnectConnectionId === connection.id}
                  >
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Reconnect WhatsApp Connection</DialogTitle>
                        <DialogDescription>
                          Restore the WhatsApp Connection ending{" "}
                          {connection.numberSuffix}. You may need to scan a new
                          QR code in WhatsApp.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogBody className="flex flex-col gap-5">
                        <p className="rounded-lg bg-muted px-3 py-2.5 text-sm leading-5 text-muted-foreground">
                          New side effects remain blocked until this WhatsApp
                          Connection recovers. Retained history remains
                          available under its Message Retention Policy.
                        </p>
                        {connectionLifecycleStatus[connection.id] ? (
                          <p
                            aria-live="polite"
                            className="text-sm text-muted-foreground"
                            data-testid="connection-lifecycle-status"
                          >
                            {connectionLifecycleStatus[connection.id]}
                          </p>
                        ) : null}
                        {reconnectQr?.connectionId === connection.id ? (
                          // The object URL contains only the authenticated ephemeral
                          // provider QR response and is revoked after reconciliation.
                          // biome-ignore lint/performance/noImgElement: QR bytes are already a complete generated SVG.
                          <img
                            alt="Reconnect this WhatsApp Connection QR code"
                            className="size-64 self-center rounded-lg bg-background p-3 ring-1 ring-border"
                            src={reconnectQr.url}
                          />
                        ) : null}
                      </DialogBody>
                      <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>
                          Cancel
                        </DialogClose>
                        <Button
                          aria-label={`Reconnect WhatsApp Connection ending ${connection.numberSuffix}`}
                          disabled={connectionLifecycleAction !== null}
                          onClick={() =>
                            startConnectionLifecycle(connection, "reconnect")
                          }
                          type="button"
                        >
                          {connectionLifecycleAction !== null ? (
                            <Spinner data-icon="inline-start" />
                          ) : null}
                          Reconnect
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {dashboardReady &&
      !showFirstConnectionOnboarding &&
      view === "settings" ? (
        <section
          aria-label="WhatsApp Recipient Exclusions"
          className="flex flex-col items-start gap-3"
        >
          <h2 className="text-lg font-semibold">Recipients Normal may track</h2>
          <p className="text-sm text-muted-foreground">
            Choose contacts and groups Normal must not track. A recipient you
            exclude disappears from every MCP Client, cannot be sent to, and has
            its stored history removed. Removing an exclusion permits only
            future activity.
          </p>
          <RecipientExclusions
            connections={connections}
            connectionsEndpoint={connectionsEndpoint}
            getToken={getToken}
          />
        </section>
      ) : null}
      {dashboardReady && view === "settings" ? (
        <section
          aria-label="Personal Account Deletion"
          className="flex flex-col items-start gap-3"
        >
          <h2 className="text-lg font-semibold">Delete Personal Account</h2>
          <p className="text-sm text-muted-foreground">
            Permanently revoke access, cancel incomplete Connection Setups, and
            delete every WhatsApp Connection.
          </p>
          <Button
            disabled={deletionState === "deleting"}
            onClick={() => void deletePersonalAccount()}
            type="button"
            variant="destructive"
          >
            {deletionState === "deleting" ? (
              <Spinner data-icon="inline-start" />
            ) : null}
            Delete Personal Account
          </Button>
          <p aria-live="polite">
            {deletionState === "deleting"
              ? "Personal Account Deletion is starting."
              : deletionState === "unavailable"
                ? "Personal Account Deletion is temporarily unavailable."
                : ""}
          </p>
        </section>
      ) : null}
    </section>
  );
}
