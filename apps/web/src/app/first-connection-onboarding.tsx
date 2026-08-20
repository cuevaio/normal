"use client";

import { Check, Copy } from "lucide-react";
import {
  type FormEvent,
  type FormEventHandler,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
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
}

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
      {setupState === "idle" ? null : (
        <p
          aria-live="polite"
          className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground"
          data-testid="connection-setup-status"
        >
          {connectionSetupStatusText(setupState, setupCleanupState)}
        </p>
      )}
      {qrImageUrl === null ? null : (
        <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center">
          {/* The object URL is created from the authenticated, non-persisted
          SVG response and is revoked as soon as setup completes. */}
          {/* biome-ignore lint/performance/noImgElement: QR bytes are already a complete generated SVG. */}
          <img
            alt="Scan this WhatsApp QR code"
            className="size-64 self-center rounded-lg bg-background p-3 ring-1 ring-border"
            src={qrImageUrl}
          />
          <div>
            <p className="font-medium">Scan with WhatsApp</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
              <li>Open WhatsApp on your phone.</li>
              <li>Open Settings, then Linked Devices.</li>
              <li>Choose Link a Device and scan this QR code.</li>
            </ol>
          </div>
        </div>
      )}
    </>
  );
  const actions = (
    <>
      {canCancelSetup(setupId, setupState) ? (
        <Button onClick={onCancelSetup} type="button" variant="outline">
          Cancel setup
        </Button>
      ) : null}
      {setupId !== null &&
      (setupState === "expired" || setupState === "unavailable") ? (
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
  const [profile, setProfile] = useState(initialProfile);
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    makeDraft(initialProfile),
  );
  const [profileState, setProfileState] = useState<
    "idle" | "saving" | "unavailable"
  >("idle");
  const [stage, setStage] = useState<OnboardingStage>(
    setupForm.setupState === "connected" && connectedConnection !== null
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
      connectedConnection !== null &&
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
  }, [connectedConnection, setupForm.setupState, stage]);

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

      {stage === "success" && connectedConnection !== null ? (
        <div className="flex flex-col gap-6">
          <div className="rounded-2xl bg-background p-5 ring-1 ring-border">
            <dl className="grid gap-3 text-sm md:grid-cols-3">
              <div className="rounded-xl bg-muted/40 p-4">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="mt-1 font-medium">
                  {connectedConnection.displayName}
                </dd>
              </div>
              <div className="rounded-xl bg-muted/40 p-4">
                <dt className="text-muted-foreground">WhatsApp Number</dt>
                <dd className="mt-1 font-medium">
                  ending {connectedConnection.numberSuffix}
                </dd>
              </div>
              <div className="rounded-xl bg-muted/40 p-4">
                <dt className="text-muted-foreground">
                  Message Retention Policy
                </dt>
                <dd className="mt-1 font-medium">
                  {connectedConnection.retentionDays === null
                    ? "Retain until Connection Deletion"
                    : `${connectedConnection.retentionDays} days`}
                </dd>
              </div>
            </dl>
            <Separator className="my-5" />
            <p className="text-sm leading-6 text-muted-foreground">
              Normal observes supported WhatsApp Conversations from activation
              forward. Earlier WhatsApp history is not imported.
            </p>
          </div>
          {intendedMcpClient === "claude" || intendedMcpClient === "chatgpt" ? (
            <McpConnectionGuides
              client={intendedMcpClient}
              onGuideOpened={() =>
                captureProductAnalyticsEvent({
                  event: "feature_used",
                  feature: "mcp_guide_opened",
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
