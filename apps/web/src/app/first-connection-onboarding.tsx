"use client";

import { Check, Copy } from "lucide-react";
import {
  type FormEvent,
  type FormEventHandler,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import { captureProductAnalyticsEvent } from "../effect/product-analytics";
import { McpConnectionGuides } from "./mcp-connection-guides";

export type ConnectionSetupState =
  | "cancelled"
  | "cancelling"
  | "idle"
  | "loading"
  | "pending"
  | "connecting"
  | "qr_available"
  | "connected"
  | "number_confirmation_failed"
  | "provisioned"
  | "provider_capacity_unavailable"
  | "provisioning_failed"
  | "provisioning_quarantined"
  | "replayed"
  | "invalid"
  | "number_unavailable"
  | "connection_limit_reached"
  | "expired"
  | "unavailable";

export type ConnectionSetupCleanupState = "complete" | "pending" | "retrying";

export type OnboardingStage =
  | "welcome"
  | "profile"
  | "security"
  | "connection_setup"
  | "success";

export type PrimaryUseCase =
  | "conversation_search"
  | "summaries"
  | "draft_replies"
  | "outbound_sends"
  | "follow_ups"
  | "exploration"
  | "other";

export type WhatsAppUsageContext = "personal" | "work" | "both";

export type OnboardingRole =
  | "founder_or_owner"
  | "engineer"
  | "product_or_design"
  | "operations_or_support"
  | "marketing_or_sales"
  | "consultant_or_freelancer"
  | "student_or_researcher"
  | "other"
  | "not_sure";

export type IntendedMcpClient = "claude" | "chatgpt" | "other" | "not_sure";

export type ResearchCallInterest = "yes" | "no" | "not_sure";

export interface OnboardingProfile {
  readonly primaryUseCase: PrimaryUseCase;
  readonly whatsappUsageContext: WhatsAppUsageContext;
  readonly role: OnboardingRole;
  readonly intendedMcpClient: IntendedMcpClient;
  readonly researchCallInterest: ResearchCallInterest;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface FirstConnectionConnection {
  readonly displayName: string;
  readonly numberSuffix: string;
  readonly retentionDays: number | null;
  readonly state:
    | "connected"
    | "connecting"
    | "degraded"
    | "deleting"
    | "disconnected"
    | "reconnect_required";
}

export interface FirstConnectionSuccessModel {
  readonly authorizationCopy: string;
  readonly clientName: string;
  readonly connection: FirstConnectionConnection;
  readonly nextActionHref: string | null;
  readonly nextStepCopy: string;
}

type VerificationClient = Extract<IntendedMcpClient, "claude" | "chatgpt">;

interface ProfileDraft {
  readonly primaryUseCase: PrimaryUseCase | "";
  readonly whatsappUsageContext: WhatsAppUsageContext | "";
  readonly role: OnboardingRole | "";
  readonly intendedMcpClient: IntendedMcpClient | "";
  readonly researchCallInterest: ResearchCallInterest | "";
}

type ProfileSelectValue =
  | PrimaryUseCase
  | WhatsAppUsageContext
  | OnboardingRole
  | IntendedMcpClient
  | ResearchCallInterest;

export interface ConnectionSetupFormProps {
  readonly connectionName: string;
  readonly idPrefix: string;
  readonly layout: "dialog" | "inline";
  readonly onCancelSetup: () => void;
  readonly onResetSetup: () => void;
  readonly onConnectionNameChange: (value: string) => void;
  readonly onStartSetup: FormEventHandler<HTMLFormElement>;
  readonly onWhatsappNumberChange: (value: string) => void;
  readonly qrImageUrl: string | null;
  readonly setupCleanupState: ConnectionSetupCleanupState | null;
  readonly setupId: string | null;
  readonly setupState: ConnectionSetupState;
  readonly whatsappNumber: string;
}

interface FirstConnectionOnboardingProps {
  readonly connectedConnection: FirstConnectionConnection | null;
  readonly getToken: () => Promise<string | null>;
  readonly initialProfile: OnboardingProfile | null;
  readonly mcpServerUrl: string;
  readonly onboardingProfileEndpoint: string;
  readonly onComplete: () => void;
  readonly onProfileSaved: (profile: OnboardingProfile) => void;
  readonly setupForm: Omit<ConnectionSetupFormProps, "idPrefix" | "layout">;
}

const primaryUseCaseOptions = [
  {
    label: "Search WhatsApp Conversations",
    value: "conversation_search",
  },
  { label: "Summaries", value: "summaries" },
  { label: "Draft replies", value: "draft_replies" },
  { label: "Outbound sends", value: "outbound_sends" },
  { label: "Follow-ups", value: "follow_ups" },
  { label: "Explore what is possible", value: "exploration" },
  { label: "Other", value: "other" },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly value: PrimaryUseCase;
}>;

const whatsappUsageContextOptions = [
  { label: "Personal", value: "personal" },
  { label: "Work", value: "work" },
  { label: "Both", value: "both" },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly value: WhatsAppUsageContext;
}>;

const roleOptions = [
  { label: "Founder or owner", value: "founder_or_owner" },
  { label: "Engineer", value: "engineer" },
  { label: "Product or design", value: "product_or_design" },
  { label: "Operations or support", value: "operations_or_support" },
  { label: "Marketing or sales", value: "marketing_or_sales" },
  { label: "Consultant or freelancer", value: "consultant_or_freelancer" },
  { label: "Student or researcher", value: "student_or_researcher" },
  { label: "Other", value: "other" },
  { label: "Not sure", value: "not_sure" },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly value: OnboardingRole;
}>;

const intendedMcpClientOptions = [
  { label: "Claude", value: "claude" },
  { label: "ChatGPT", value: "chatgpt" },
  { label: "Another MCP Client", value: "other" },
  { label: "Not sure yet", value: "not_sure" },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly value: IntendedMcpClient;
}>;

const researchCallInterestOptions = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
  { label: "Not sure", value: "not_sure" },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly value: ResearchCallInterest;
}>;

const primaryUseCases = new Set<PrimaryUseCase>(
  primaryUseCaseOptions.map((option) => option.value),
);
const whatsappUsageContexts = new Set<WhatsAppUsageContext>(
  whatsappUsageContextOptions.map((option) => option.value),
);
const roles = new Set<OnboardingRole>(
  roleOptions.map((option) => option.value),
);
const intendedMcpClients = new Set<IntendedMcpClient>(
  intendedMcpClientOptions.map((option) => option.value),
);
const researchCallInterests = new Set<ResearchCallInterest>(
  researchCallInterestOptions.map((option) => option.value),
);

const setupCompletionFailures = new Map<
  ConnectionSetupState,
  "failed" | "cancelled" | "capacity_unavailable"
>([
  ["cancelled", "cancelled"],
  ["expired", "cancelled"],
  ["number_confirmation_failed", "failed"],
  ["provider_capacity_unavailable", "capacity_unavailable"],
  ["provisioning_failed", "failed"],
  ["provisioning_quarantined", "failed"],
  ["unavailable", "failed"],
]);

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isPrimaryUseCase(value: unknown): value is PrimaryUseCase {
  return (
    typeof value === "string" && primaryUseCases.has(value as PrimaryUseCase)
  );
}

function isWhatsAppUsageContext(value: unknown): value is WhatsAppUsageContext {
  return (
    typeof value === "string" &&
    whatsappUsageContexts.has(value as WhatsAppUsageContext)
  );
}

function isOnboardingRole(value: unknown): value is OnboardingRole {
  return typeof value === "string" && roles.has(value as OnboardingRole);
}

function isIntendedMcpClient(value: unknown): value is IntendedMcpClient {
  return (
    typeof value === "string" &&
    intendedMcpClients.has(value as IntendedMcpClient)
  );
}

function isResearchCallInterest(value: unknown): value is ResearchCallInterest {
  return (
    typeof value === "string" &&
    researchCallInterests.has(value as ResearchCallInterest)
  );
}

export function decodeOnboardingProfileResponse(
  value: unknown,
): OnboardingProfile | null | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const profile = (value as { readonly profile?: unknown }).profile;
  if (profile === null) return null;
  if (typeof profile !== "object" || profile === null) return undefined;
  const record = profile as Record<string, unknown>;
  if (
    !isPrimaryUseCase(record.primary_use_case) ||
    !isWhatsAppUsageContext(record.whatsapp_usage_context) ||
    !isOnboardingRole(record.role) ||
    !isIntendedMcpClient(record.intended_mcp_client) ||
    !isResearchCallInterest(record.research_call_interest) ||
    !isIsoDate(record.created_at) ||
    !isIsoDate(record.updated_at) ||
    (record.completed_at !== null && !isIsoDate(record.completed_at))
  ) {
    return undefined;
  }
  return {
    primaryUseCase: record.primary_use_case,
    whatsappUsageContext: record.whatsapp_usage_context,
    role: record.role,
    intendedMcpClient: record.intended_mcp_client,
    researchCallInterest: record.research_call_interest,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    completedAt: record.completed_at,
  };
}

function makeDraft(profile: OnboardingProfile | null): ProfileDraft {
  return {
    primaryUseCase: profile?.primaryUseCase ?? "",
    whatsappUsageContext: profile?.whatsappUsageContext ?? "",
    role: profile?.role ?? "",
    intendedMcpClient: profile?.intendedMcpClient ?? "",
    researchCallInterest: profile?.researchCallInterest ?? "",
  };
}

function isActiveConnection(
  connection: FirstConnectionConnection | null,
): connection is FirstConnectionConnection {
  return connection !== null && connection.state === "connected";
}

export function getFirstConnectionSuccessModel(
  connection: FirstConnectionConnection | null,
  intendedMcpClient: IntendedMcpClient,
): FirstConnectionSuccessModel | null {
  if (!isActiveConnection(connection)) return null;

  const clientName =
    intendedMcpClient === "claude"
      ? "Claude"
      : intendedMcpClient === "chatgpt"
        ? "ChatGPT"
        : "your MCP Client";

  return {
    authorizationCopy: `${clientName} still needs its own MCP Authorization for this WhatsApp Connection.`,
    clientName,
    connection,
    nextActionHref:
      intendedMcpClient === "claude"
        ? "https://claude.ai/settings/connectors"
        : intendedMcpClient === "chatgpt"
          ? "https://chatgpt.com/plugins"
          : null,
    nextStepCopy: `Create the MCP Authorization in ${clientName} next so it can access only the WhatsApp Connections and permissions you choose.`,
  };
}

function isCompleteDraft(draft: ProfileDraft): draft is {
  readonly primaryUseCase: PrimaryUseCase;
  readonly whatsappUsageContext: WhatsAppUsageContext;
  readonly role: OnboardingRole;
  readonly intendedMcpClient: IntendedMcpClient;
  readonly researchCallInterest: ResearchCallInterest;
} {
  return (
    draft.primaryUseCase !== "" &&
    draft.whatsappUsageContext !== "" &&
    draft.role !== "" &&
    draft.intendedMcpClient !== "" &&
    draft.researchCallInterest !== ""
  );
}

function connectionSetupStatusText(
  setupState: ConnectionSetupState,
  cleanupState: ConnectionSetupCleanupState | null,
): string {
  if (setupState === "loading") return "Starting Connection Setup.";
  if (setupState === "unavailable") {
    return "Connection Setup is temporarily unavailable.";
  }
  if (setupState === "pending") {
    return "Connection Setup started. Preparing your QR code.";
  }
  if (setupState === "replayed") {
    return "Connection Setup already started. Preparing your QR code.";
  }
  if (setupState === "qr_available") return "Scan this QR code with WhatsApp.";
  if (setupState === "connecting") {
    return "Waiting for WhatsApp to finish connecting.";
  }
  if (setupState === "connected") return "WhatsApp Connection active.";
  if (setupState === "number_confirmation_failed") {
    return "We couldn't confirm that this QR code was scanned by the WhatsApp account you entered. Start again and scan with that same account.";
  }
  if (setupState === "provisioned") return "Connection Setup is ready.";
  if (setupState === "provider_capacity_unavailable") {
    return "WhatsApp Connection capacity is temporarily unavailable. Please try again later.";
  }
  if (setupState === "provisioning_failed") {
    return "Connection Setup could not be prepared.";
  }
  if (setupState === "provisioning_quarantined") {
    return "Connection Setup needs support review.";
  }
  if (setupState === "cancelling") return "Cancelling Connection Setup.";
  if (setupState === "cancelled") {
    return cleanupState === "complete"
      ? "Connection Setup cancelled. Provider cleanup is complete."
      : cleanupState === "retrying"
        ? "Connection Setup cancelled. Provider cleanup is retrying."
        : "Connection Setup cancelled. Provider cleanup is in progress.";
  }
  if (setupState === "expired") {
    return cleanupState === "complete"
      ? "Connection Setup expired. Provider cleanup is complete."
      : cleanupState === "retrying"
        ? "Connection Setup expired. Provider cleanup is retrying."
        : "Connection Setup expired. Provider cleanup is in progress.";
  }
  if (setupState === "number_unavailable") {
    return "That WhatsApp Number is already in use.";
  }
  if (setupState === "connection_limit_reached") {
    return "Your Personal Account already has three active setup or Connection slots.";
  }
  if (setupState === "invalid") {
    return "Enter a valid international WhatsApp Number.";
  }
  return "";
}

function canCancelSetup(
  setupId: string | null,
  setupState: ConnectionSetupState,
): boolean {
  return (
    setupId !== null &&
    (setupState === "pending" ||
      setupState === "replayed" ||
      setupState === "qr_available" ||
      setupState === "connecting" ||
      setupState === "provisioned" ||
      setupState === "provider_capacity_unavailable" ||
      setupState === "provisioning_failed" ||
      setupState === "provisioning_quarantined")
  );
}

function isConnectionSetupLoadingState(
  setupState: ConnectionSetupState,
): boolean {
  return (
    setupState === "loading" ||
    setupState === "pending" ||
    setupState === "replayed" ||
    setupState === "connecting"
  );
}

function connectionSetupPanelCopy(
  setupState: ConnectionSetupState,
  cleanupState: ConnectionSetupCleanupState | null,
): {
  readonly body: string;
  readonly hint: string;
  readonly title: string;
} | null {
  if (setupState === "loading") {
    return {
      body: "Normal is starting your Connection Setup and reserving space for the QR step.",
      hint: "Keep this page open while the setup starts.",
      title: "Starting Connection Setup",
    };
  }
  if (setupState === "pending") {
    return {
      body: "Your Connection Setup is active. The QR code will appear here as soon as it is ready.",
      hint: "If this takes too long, you can cancel setup below and try again.",
      title: "Preparing your QR code",
    };
  }
  if (setupState === "replayed") {
    return {
      body: "This Connection Setup was already started. Normal is waiting for the current QR code.",
      hint: "Leave this page open or cancel setup below if you want to restart.",
      title: "Resuming Connection Setup",
    };
  }
  if (setupState === "connecting") {
    return {
      body: "The QR code was scanned. Keep WhatsApp open on your phone while the connection finishes.",
      hint: "This area updates automatically when WhatsApp finishes linking.",
      title: "Waiting for WhatsApp",
    };
  }
  if (setupState === "provider_capacity_unavailable") {
    return {
      body: "WhatsApp Connection capacity is temporarily unavailable for new setups.",
      hint: "Please try again later.",
      title: "Temporarily unavailable",
    };
  }
  if (setupState === "provisioning_failed") {
    return {
      body: "Normal could not finish preparing this Connection Setup before the QR step.",
      hint: "Cancel setup below, then start again to request a fresh QR code.",
      title: "Connection Setup could not be prepared",
    };
  }
  if (setupState === "provisioning_quarantined") {
    return {
      body: "This Connection Setup needs support review before Normal can continue.",
      hint: "Please contact support if you still need help connecting.",
      title: "Connection Setup needs review",
    };
  }
  if (setupState === "cancelling") {
    return {
      body: "Normal is cancelling this Connection Setup and removing its temporary resources.",
      hint: "You can start again after cancellation finishes.",
      title: "Cancelling Connection Setup",
    };
  }
  if (setupState === "cancelled") {
    return {
      body:
        cleanupState === "complete"
          ? "This Connection Setup was cancelled and cleanup is complete."
          : cleanupState === "retrying"
            ? "This Connection Setup was cancelled and cleanup is retrying."
            : "This Connection Setup was cancelled and cleanup is still in progress.",
      hint: "Use Start again to request a new QR code when you are ready.",
      title: "Connection Setup cancelled",
    };
  }
  if (setupState === "expired") {
    return {
      body:
        cleanupState === "complete"
          ? "This QR code expired before WhatsApp finished linking. Cleanup is complete."
          : cleanupState === "retrying"
            ? "This QR code expired before WhatsApp finished linking. Cleanup is retrying."
            : "This QR code expired before WhatsApp finished linking. Cleanup is still in progress.",
      hint: "Use Start again to request a fresh QR code.",
      title: "Connection Setup expired",
    };
  }
  if (setupState === "number_unavailable") {
    return {
      body: "That WhatsApp Number is already reserved by another Connection Setup or WhatsApp Connection.",
      hint: "Enter a different WhatsApp Number and continue.",
      title: "WhatsApp Number unavailable",
    };
  }
  if (setupState === "connection_limit_reached") {
    return {
      body: "Your Personal Account already has three active setup or Connection slots.",
      hint: "Delete or finish another setup before starting a new one.",
      title: "Connection limit reached",
    };
  }
  if (setupState === "invalid") {
    return {
      body: "Enter a valid international WhatsApp Number to continue.",
      hint: "Include the country code, for example +51.",
      title: "Check the WhatsApp Number",
    };
  }
  if (setupState === "unavailable") {
    return {
      body: "Normal cannot continue this Connection Setup right now.",
      hint: "Use Start again or try again later.",
      title: "Connection Setup unavailable",
    };
  }
  return null;
}

function SelectField({
  description,
  id,
  label,
  onChange,
  options,
  value,
}: {
  readonly description?: string;
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: ProfileSelectValue) => void;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly value: ProfileSelectValue;
  }>;
  readonly value: ProfileSelectValue | "";
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={options}
        onValueChange={(next) => {
          if (next !== null) onChange(next as ProfileSelectValue);
        }}
        value={value}
      >
        <SelectTrigger className="w-full" id={id}>
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function CopyServerUrl({ serverUrl }: { readonly serverUrl: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(serverUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border bg-muted/25 px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">MCP server URL</p>
        <p className="truncate font-mono text-sm" title={serverUrl}>
          {serverUrl}
        </p>
      </div>
      <Button
        aria-label="Copy MCP server URL"
        onClick={copy}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}

function CopyPrompt({
  ariaLabel,
  label,
  value,
}: {
  readonly ariaLabel: string;
  readonly label: string;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="rounded-xl border bg-muted/25 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Button
          aria-label={ariaLabel}
          onClick={copy}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      <pre className="mt-3 whitespace-pre-wrap text-sm leading-6">{value}</pre>
    </div>
  );
}

export function buildVerificationPromptCopy(
  client: VerificationClient,
  connection: FirstConnectionConnection,
) {
  const clientName = client === "claude" ? "Claude" : "ChatGPT";
  const invocation =
    client === "claude" ? "Usa Normal" : "Usa el conector Normal";
  const authorizationHelpClient = client === "claude" ? "Claude" : "ChatGPT";

  const spanishPrompt = `${invocation} para verificar, solo en modo de lectura, que puedes ver mi conexión de WhatsApp llamada "${connection.displayName}" terminada en ${connection.numberSuffix}. Responde solo con el nombre visible y el sufijo del número; nunca muestres el número completo. Si Normal no aparece, dímelo y recuérdame revisar la autorización de ${authorizationHelpClient}. Si Normal aparece pero esta conexión activa no está en los resultados, recuérdame modificar o crear una autorización MCP que la seleccione explícitamente. Recomienda reconectarla en Normal solo si aparece como no disponible. No envíes mensajes ni pidas permisos adicionales.`;

  const englishPrompt = `Use Normal for a read-only check that you can see my WhatsApp Connection named "${connection.displayName}" ending in ${connection.numberSuffix}. Reply with the display name and the number suffix only, never the full number. If Normal is unavailable, tell me and remind me to review the ${authorizationHelpClient} authorization. If Normal is available but this active connection is missing from the results, remind me to revise or create an MCP Authorization that explicitly selects it. Recommend reconnecting it in Normal only if it is listed as unavailable. Do not send messages or request any additional permissions.`;

  return {
    clientName,
    englishPrompt,
    expectedEnglishResponse: `${connection.displayName}, number ending in ${connection.numberSuffix}.`,
    expectedSpanishResponse: `${connection.displayName}, número terminado en ${connection.numberSuffix}.`,
    missingConnectionHelp:
      "If Normal is enabled but this active WhatsApp Connection is missing from the results, revise the existing MCP Authorization or create a new one that explicitly selects this connection.",
    missingToolHelp: `If ${clientName} says Normal is unavailable, reopen MCP Authorization and confirm that this WhatsApp Connection is selected for ${clientName}.`,
    spanishPrompt,
    unavailableConnectionHelp:
      "Reconnect in Normal only when the WhatsApp Connection is listed but its lifecycle state is unavailable.",
  };
}

function VerificationPromptCard({
  client,
  connection,
}: {
  readonly client: VerificationClient;
  readonly connection: FirstConnectionConnection;
}) {
  const copy = buildVerificationPromptCopy(client, connection);

  return (
    <section
      className="rounded-2xl bg-background p-5 ring-1 ring-border"
      data-testid="mcp-verification-prompt"
    >
      <p className="text-sm font-medium text-muted-foreground">
        First-run verification
      </p>
      <h3 className="mt-1 text-lg font-semibold tracking-tight">
        Verify {copy.clientName} can see this WhatsApp Connection
      </h3>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        Paste this before any broader read request or send. It performs a
        read-only connection check and asks for display name plus number suffix
        only.
      </p>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <CopyPrompt
          ariaLabel={`Copy ${copy.clientName} verification prompt in Spanish`}
          label="Spanish prompt"
          value={copy.spanishPrompt}
        />
        <CopyPrompt
          ariaLabel={`Copy ${copy.clientName} verification prompt in English`}
          label="English equivalent"
          value={copy.englishPrompt}
        />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl bg-muted/40 p-4 text-sm leading-6">
          <p className="font-medium">Expected response</p>
          <p className="mt-2 text-muted-foreground">
            The reply should mention <strong>{connection.displayName}</strong>{" "}
            and suffix <strong>{connection.numberSuffix}</strong> only, never
            the full WhatsApp Number.
          </p>
          <p className="mt-2 text-muted-foreground">
            Example: {copy.expectedSpanishResponse}
          </p>
          <p className="text-muted-foreground">
            English: {copy.expectedEnglishResponse}
          </p>
        </div>
        <div className="rounded-xl bg-muted/40 p-4 text-sm leading-6">
          <p className="font-medium">If the tool or connection is missing</p>
          <p className="mt-2 text-muted-foreground">{copy.missingToolHelp}</p>
          <p className="mt-2 text-muted-foreground">
            {copy.missingConnectionHelp}
          </p>
          <p className="mt-2 text-muted-foreground">
            {copy.unavailableConnectionHelp}
          </p>
          <p className="mt-2 text-muted-foreground">
            Use{" "}
            <a
              className="underline underline-offset-4"
              href="/dashboard/authorizations"
            >
              MCP Authorizations
            </a>{" "}
            for access review and{" "}
            <a
              className="underline underline-offset-4"
              href="/dashboard/connections"
            >
              WhatsApp Connections
            </a>{" "}
            for reconnection help.
          </p>
        </div>
      </div>
    </section>
  );
}

export function ConnectionSetupForm({
  connectionName,
  idPrefix,
  layout,
  onCancelSetup,
  onResetSetup,
  onConnectionNameChange,
  onStartSetup,
  onWhatsappNumberChange,
  qrImageUrl,
  setupCleanupState,
  setupId,
  setupState,
  whatsappNumber,
}: ConnectionSetupFormProps) {
  const connectionNameId = `${idPrefix}-connection-name`;
  const whatsappNumberId = `${idPrefix}-whatsapp-number`;
  const inputsDisabled = setupState === "loading" || setupId !== null;
  const statusText = connectionSetupStatusText(setupState, setupCleanupState);
  const panelCopy = connectionSetupPanelCopy(setupState, setupCleanupState);
  const showSetupPanel = setupState !== "idle";
  const showLoadingPanel = isConnectionSetupLoadingState(setupState);
  const showSetupVisual = qrImageUrl !== null || showLoadingPanel;
  const fields = (
    <>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={connectionNameId}>Name</FieldLabel>
          <Input
            autoComplete="off"
            disabled={inputsDisabled}
            id={connectionNameId}
            maxLength={64}
            onChange={(event) => onConnectionNameChange(event.target.value)}
            placeholder="Personal WhatsApp"
            required
            value={connectionName}
          />
          <FieldDescription>
            Use a name that helps you identify this WhatsApp Connection.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={whatsappNumberId}>WhatsApp number</FieldLabel>
          <Input
            autoComplete="tel"
            disabled={inputsDisabled}
            id={whatsappNumberId}
            inputMode="tel"
            onChange={(event) => onWhatsappNumberChange(event.target.value)}
            placeholder="+1 555 012 3456"
            required
            type="tel"
            value={whatsappNumber}
          />
          <FieldDescription>
            Include the country code, for example +51. The QR code expires after
            15 minutes.
          </FieldDescription>
        </Field>
      </FieldGroup>
      {showSetupPanel ? (
        <>
          <p aria-atomic="true" aria-live="polite" className="sr-only">
            {statusText}
          </p>
          <div
            className={`grid gap-5 rounded-2xl border bg-muted/20 p-4 ${showSetupVisual ? "sm:grid-cols-[auto_1fr] sm:items-center" : ""}`}
            data-testid="connection-setup-panel"
          >
            {showSetupVisual ? (
              <div className="flex justify-center sm:justify-start">
                {qrImageUrl === null ? (
                  <div
                    aria-hidden="true"
                    className="flex size-64 items-center justify-center rounded-xl bg-background p-4 ring-1 ring-border"
                    data-testid="connection-setup-loading-placeholder"
                  >
                    <div className="flex w-full flex-col gap-3">
                      <Skeleton className="aspect-square w-full rounded-lg motion-reduce:animate-none" />
                      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
                      <Skeleton className="h-4 w-5/6 motion-reduce:animate-none" />
                    </div>
                  </div>
                ) : (
                  <>
                    {/* The object URL is created from the authenticated, non-persisted
                  SVG response and is revoked as soon as setup completes. */}
                    {/* biome-ignore lint/performance/noImgElement: QR bytes are already a complete generated SVG. */}
                    <img
                      alt="Scan this WhatsApp QR code"
                      className="size-64 self-center rounded-lg bg-background p-3 ring-1 ring-border"
                      src={qrImageUrl}
                    />
                  </>
                )}
              </div>
            ) : null}
            <div className="space-y-3">
              <p
                className="text-sm font-medium text-foreground"
                data-testid="connection-setup-status"
              >
                {statusText}
              </p>
              {qrImageUrl === null ? (
                panelCopy === null ? null : (
                  <div className="space-y-2">
                    <p className="text-base font-medium">{panelCopy.title}</p>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {panelCopy.body}
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {panelCopy.hint}
                    </p>
                    {showLoadingPanel ? (
                      <div
                        className="inline-flex items-center gap-2 rounded-full bg-background px-3 py-1.5 text-sm text-muted-foreground ring-1 ring-border"
                        data-testid="connection-setup-loading-progress"
                      >
                        <Spinner className="motion-reduce:animate-none" />
                        <span>
                          {setupState === "loading"
                            ? "Provisioning setup"
                            : setupState === "connecting"
                              ? "Waiting for WhatsApp"
                              : "Waiting for QR code"}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )
              ) : (
                <div>
                  <p className="font-medium">Scan with WhatsApp</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                    <li>Open WhatsApp on your phone.</li>
                    <li>Open Settings, then Linked Devices.</li>
                    <li>Choose Link a Device and scan this QR code.</li>
                  </ol>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
  const actions = (
    <>
      {canCancelSetup(setupId, setupState) ? (
        <Button onClick={onCancelSetup} type="button" variant="outline">
          Cancel setup
        </Button>
      ) : null}
      {setupState === "cancelled" ||
      (setupId !== null &&
        (setupState === "expired" ||
          setupState === "number_confirmation_failed" ||
          setupState === "unavailable")) ? (
        <Button onClick={onResetSetup} type="button" variant="outline">
          Start again
        </Button>
      ) : null}
      <Button disabled={setupState === "loading"} type="submit">
        {setupState === "loading" ? <Spinner data-icon="inline-start" /> : null}
        Continue
      </Button>
    </>
  );

  if (layout === "dialog") {
    return (
      <form className="contents" onSubmit={onStartSetup}>
        <DialogBody className="flex flex-col gap-5">{fields}</DialogBody>
        <DialogFooter>{actions}</DialogFooter>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={onStartSetup}>
      <div className="flex flex-col gap-5">{fields}</div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {actions}
      </div>
    </form>
  );
}

export function FirstConnectionOnboarding({
  connectedConnection,
  getToken,
  initialProfile,
  mcpServerUrl,
  onboardingProfileEndpoint,
  onComplete,
  onProfileSaved,
  setupForm,
}: FirstConnectionOnboardingProps) {
  const activeConnection = isActiveConnection(connectedConnection)
    ? connectedConnection
    : null;
  const [profile, setProfile] = useState(initialProfile);
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    makeDraft(initialProfile),
  );
  const [profileState, setProfileState] = useState<
    "idle" | "saving" | "unavailable"
  >("idle");
  const [stage, setStage] = useState<OnboardingStage>(
    setupForm.setupState === "connected" && activeConnection !== null
      ? "success"
      : setupForm.setupId !== null
        ? "connection_setup"
        : initialProfile?.completedAt === null || initialProfile === null
          ? "welcome"
          : "security",
  );
  const viewedStages = useRef<Set<OnboardingStage>>(new Set());
  const reportedSetupOutcome = useRef(false);
  const completedConnectionSetupStage = useRef(false);

  useEffect(() => {
    if (viewedStages.current.has(stage)) return;
    viewedStages.current.add(stage);
    captureProductAnalyticsEvent({
      event: "onboarding_stage_viewed",
      stage,
    });
    if (stage === "security") {
      captureProductAnalyticsEvent({ event: "onboarding_security_reached" });
    }
  }, [stage]);

  useEffect(() => {
    if (
      setupForm.setupState === "connected" &&
      activeConnection !== null &&
      stage !== "success"
    ) {
      if (!reportedSetupOutcome.current) {
        reportedSetupOutcome.current = true;
        captureProductAnalyticsEvent({
          event: "connection_setup_completed",
          outcome: "success",
        });
      }
      if (!completedConnectionSetupStage.current) {
        completedConnectionSetupStage.current = true;
        captureProductAnalyticsEvent({
          event: "onboarding_stage_completed",
          stage: "connection_setup",
        });
      }
      setStage("success");
      return;
    }
    const outcome = setupCompletionFailures.get(setupForm.setupState);
    if (outcome !== undefined && !reportedSetupOutcome.current) {
      reportedSetupOutcome.current = true;
      captureProductAnalyticsEvent({
        event: "connection_setup_completed",
        outcome,
      });
    }
  }, [activeConnection, setupForm.setupState, stage]);

  const completeStage = (
    completedStage: OnboardingStage,
    next: OnboardingStage,
  ) => {
    captureProductAnalyticsEvent({
      event: "onboarding_stage_completed",
      stage: completedStage,
    });
    setStage(next);
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isCompleteDraft(draft)) return;
    setProfileState("saving");
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const response = await fetch(onboardingProfileEndpoint, {
        body: JSON.stringify({
          primary_use_case: draft.primaryUseCase,
          whatsapp_usage_context: draft.whatsappUsageContext,
          role: draft.role,
          intended_mcp_client: draft.intendedMcpClient,
          research_call_interest: draft.researchCallInterest,
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "PUT",
      });
      const body = (await response.json()) as unknown;
      const savedProfile = decodeOnboardingProfileResponse(body);
      if (!response.ok || savedProfile === undefined || savedProfile === null) {
        throw new Error("profile unavailable");
      }
      setProfile(savedProfile);
      setDraft(makeDraft(savedProfile));
      onProfileSaved(savedProfile);
      setProfileState("idle");
      captureProductAnalyticsEvent({
        event: "onboarding_stage_completed",
        stage: "profile",
      });
      captureProductAnalyticsEvent({ event: "onboarding_profile_completed" });
      setStage("security");
    } catch {
      setProfileState("unavailable");
    }
  };

  const startSetup = (event: FormEvent<HTMLFormElement>) => {
    reportedSetupOutcome.current = false;
    captureProductAnalyticsEvent({ event: "connection_setup_started" });
    setupForm.onStartSetup(event);
  };

  const finishOnboarding = () => {
    captureProductAnalyticsEvent({
      event: "onboarding_stage_completed",
      stage: "success",
    });
    captureProductAnalyticsEvent({ event: "onboarding_completed" });
    onComplete();
  };

  const intendedMcpClient =
    profile?.intendedMcpClient ??
    (draft.intendedMcpClient === "" ? "not_sure" : draft.intendedMcpClient);
  const successModel = getFirstConnectionSuccessModel(
    activeConnection,
    intendedMcpClient,
  );

  return (
    <section
      aria-labelledby="first-connection-onboarding-heading"
      className="flex flex-col gap-6"
      data-testid="first-connection-onboarding"
    >
      <div className="rounded-2xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
        <p className="text-sm font-medium text-muted-foreground">
          First WhatsApp Connection
        </p>
        <h2
          className="mt-1 text-2xl font-semibold tracking-tight"
          id="first-connection-onboarding-heading"
        >
          {stage === "welcome"
            ? "Connect WhatsApp to Normal"
            : stage === "profile"
              ? "Tell us how you plan to use Normal"
              : stage === "security"
                ? "Security and control"
                : stage === "connection_setup"
                  ? "Start Connection Setup"
                  : "WhatsApp Connection active"}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {stage === "welcome"
            ? "Set up your first WhatsApp Connection inside the dashboard."
            : stage === "profile"
              ? "Choose fixed options so we can tailor the first MCP Client next step."
              : stage === "security"
                ? "Review the controls before you scan an ephemeral QR code."
                : stage === "connection_setup"
                  ? "Use your phone to scan the QR code when it appears."
                  : "Your first WhatsApp Connection is ready for MCP Authorization."}
        </p>
      </div>

      {stage === "welcome" ? (
        <div className="rounded-2xl bg-background p-5 ring-1 ring-border">
          <div className="grid gap-3 md:grid-cols-3">
            {[
              {
                title: "Plan for a few minutes",
                description:
                  "Connection Setup usually takes only a few minutes, including scanning the QR code.",
              },
              {
                title: "Keep your phone nearby",
                description:
                  "You will need WhatsApp on your phone to approve the QR step.",
              },
              {
                title: "Observation starts after activation",
                description:
                  "Normal observes supported WhatsApp Conversations after activation. Earlier WhatsApp history is not imported.",
              },
            ].map((item) => (
              <article className="rounded-xl bg-muted/40 p-4" key={item.title}>
                <h3 className="font-medium">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {item.description}
                </p>
              </article>
            ))}
          </div>
          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => completeStage("welcome", "profile")}
              type="button"
            >
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {stage === "profile" ? (
        <form
          className="rounded-2xl bg-background p-5 ring-1 ring-border"
          onSubmit={saveProfile}
        >
          <FieldGroup>
            <SelectField
              description="Pick the closest fit."
              id="onboarding-primary-use-case"
              label="Primary use case"
              onChange={(value) => {
                if (isPrimaryUseCase(value)) {
                  setDraft((current) => ({
                    ...current,
                    primaryUseCase: value,
                  }));
                }
              }}
              options={primaryUseCaseOptions}
              value={draft.primaryUseCase}
            />
            <SelectField
              id="onboarding-whatsapp-usage-context"
              label="WhatsApp usage context"
              onChange={(value) => {
                if (isWhatsAppUsageContext(value)) {
                  setDraft((current) => ({
                    ...current,
                    whatsappUsageContext: value,
                  }));
                }
              }}
              options={whatsappUsageContextOptions}
              value={draft.whatsappUsageContext}
            />
            <SelectField
              id="onboarding-role"
              label="Role"
              onChange={(value) => {
                if (isOnboardingRole(value)) {
                  setDraft((current) => ({ ...current, role: value }));
                }
              }}
              options={roleOptions}
              value={draft.role}
            />
            <SelectField
              id="onboarding-intended-mcp-client"
              label="Intended MCP Client"
              onChange={(value) => {
                if (isIntendedMcpClient(value)) {
                  setDraft((current) => ({
                    ...current,
                    intendedMcpClient: value,
                  }));
                }
              }}
              options={intendedMcpClientOptions}
              value={draft.intendedMcpClient}
            />
            <SelectField
              id="onboarding-research-call-interest"
              label="Interested in a short research call?"
              onChange={(value) => {
                if (isResearchCallInterest(value)) {
                  setDraft((current) => ({
                    ...current,
                    researchCallInterest: value,
                  }));
                }
              }}
              options={researchCallInterestOptions}
              value={draft.researchCallInterest}
            />
          </FieldGroup>
          {profileState === "unavailable" ? (
            <p
              aria-live="polite"
              className="mt-4 rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground"
            >
              Onboarding profile could not be saved. Please try again.
            </p>
          ) : null}
          <div className="mt-5 flex justify-end">
            <Button
              disabled={!isCompleteDraft(draft) || profileState === "saving"}
              type="submit"
            >
              {profileState === "saving" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              Save and continue
            </Button>
          </div>
        </form>
      ) : null}

      {stage === "security" ? (
        <div className="rounded-2xl bg-background p-5 ring-1 ring-border">
          <ul className="grid gap-3 md:grid-cols-2">
            {[
              "Sensitive fields use scoped encryption tied to the Personal Account and WhatsApp Connection.",
              "MCP Authorization permissions are separate; send permission does not imply message read permission.",
              "Every outbound tool call asks the MCP Client for Client Confirmation, but Normal does not treat it as a server-verified security boundary.",
              "Routine operator access to message content is prohibited.",
              "MCP Authorization is revocable and covers only the WhatsApp Connections you choose.",
              "Connection Deletion stops access immediately before cleanup continues.",
              "The Connection Setup QR code is ephemeral and expires if not used.",
            ].map((control) => (
              <li
                className="rounded-xl bg-muted/40 p-4 text-sm leading-6"
                key={control}
              >
                {control}
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => completeStage("security", "connection_setup")}
              type="button"
            >
              Continue to Connection Setup
            </Button>
          </div>
        </div>
      ) : null}

      {stage === "connection_setup" ? (
        <div className="rounded-2xl bg-background p-5 ring-1 ring-border">
          <ConnectionSetupForm
            {...setupForm}
            idPrefix="first-connection"
            layout="inline"
            onStartSetup={startSetup}
          />
        </div>
      ) : null}

      {stage === "success" && successModel !== null ? (
        <div className="flex flex-col gap-6">
          <div className="rounded-2xl bg-background p-5 ring-1 ring-border">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl bg-muted/40 p-4">
                <p className="text-sm font-medium">Completed</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Your WhatsApp Connection is active.
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-4">
                <p className="text-sm font-medium">Next required step</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {successModel.authorizationCopy}
                </p>
              </div>
            </div>
            <dl className="grid gap-3 text-sm md:grid-cols-3">
              <div className="rounded-xl bg-muted/40 p-4">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="mt-1 font-medium">
                  {successModel.connection.displayName}
                </dd>
              </div>
              <div className="rounded-xl bg-muted/40 p-4">
                <dt className="text-muted-foreground">
                  Active WhatsApp Number
                </dt>
                <dd className="mt-1 font-medium">
                  ending {successModel.connection.numberSuffix}
                </dd>
              </div>
              <div className="rounded-xl bg-muted/40 p-4">
                <dt className="text-muted-foreground">
                  Message Retention Policy
                </dt>
                <dd className="mt-1 font-medium">
                  {successModel.connection.retentionDays === null
                    ? "Retain until Connection Deletion"
                    : `${successModel.connection.retentionDays} days`}
                </dd>
              </div>
            </dl>
            <Separator className="my-5" />
            <p className="text-sm leading-6 text-muted-foreground">
              Normal observes supported WhatsApp Conversations from activation
              forward. Earlier WhatsApp history is not imported.
            </p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm leading-6 text-muted-foreground">
                {successModel.nextStepCopy}
              </p>
              {successModel.nextActionHref !== null ? (
                <a
                  className={buttonVariants()}
                  href={successModel.nextActionHref}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open {successModel.clientName}
                </a>
              ) : (
                <div className="min-w-0 sm:max-w-sm">
                  <CopyServerUrl serverUrl={mcpServerUrl} />
                </div>
              )}
            </div>
          </div>
          {intendedMcpClient === "claude" || intendedMcpClient === "chatgpt" ? (
            <VerificationPromptCard
              client={intendedMcpClient}
              connection={successModel.connection}
            />
          ) : null}
          {intendedMcpClient === "claude" || intendedMcpClient === "chatgpt" ? (
            <McpConnectionGuides
              client={intendedMcpClient}
              onGuideOpened={() =>
                captureProductAnalyticsEvent({
                  event: "feature_used",
                  feature: "mcp_guide_opened",
                })
              }
              onProminentChatGptOpened={() =>
                captureProductAnalyticsEvent({
                  event: "feature_used",
                  feature: "onboarding_chatgpt_opened",
                })
              }
              serverUrl={mcpServerUrl}
            />
          ) : (
            <section className="rounded-2xl bg-background p-5 ring-1 ring-border">
              <h3 className="text-lg font-semibold tracking-tight">
                Connect an MCP Client
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Add the Normal MCP server to your chosen MCP Client, then select
                this WhatsApp Connection and approve only the permissions you
                want.
              </p>
              <div className="mt-4">
                <CopyServerUrl serverUrl={mcpServerUrl} />
              </div>
            </section>
          )}
          <div className="flex justify-end">
            <Button onClick={finishOnboarding} type="button">
              Go to dashboard
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
