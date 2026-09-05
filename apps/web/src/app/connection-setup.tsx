"use client";

import type { FormEventHandler } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  FormOverlayBody,
  FormOverlayFooter,
} from "@/components/ui/form-overlay";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

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
  | "number_cleanup_in_progress"
  | "number_deletion_in_progress"
  | "number_unavailable"
  | "connection_limit_reached"
  | "expired"
  | "unavailable";

export type ConnectionSetupCleanupState = "complete" | "pending" | "retrying";

export interface ConnectionSetupFormProps {
  readonly connectionName: string;
  readonly idPrefix: string;
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
  if (setupState === "number_cleanup_in_progress") {
    return "Your previous Connection Setup is still releasing this WhatsApp Number. Please try again in a few minutes.";
  }
  if (setupState === "number_deletion_in_progress") {
    return "Your previous Connection Deletion is still removing this WhatsApp Number. Please try again in a few minutes.";
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
  if (setupState === "number_cleanup_in_progress") {
    return {
      body: "Your previous Connection Setup ended, but provider cleanup must finish before Normal can reserve this number again.",
      hint: "Try the same WhatsApp Number again in a few minutes.",
      title: "Connection Setup cleanup in progress",
    };
  }
  if (setupState === "number_deletion_in_progress") {
    return {
      body: "Your previous WhatsApp Connection is deleted, but provider cleanup must finish before Normal can reserve this number again.",
      hint: "Try the same WhatsApp Number again in a few minutes.",
      title: "Connection Deletion in progress",
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

export function ConnectionSetupForm({
  connectionName,
  idPrefix,
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
      <Button disabled={inputsDisabled} type="submit">
        {setupState === "loading" ? <Spinner data-icon="inline-start" /> : null}
        Continue
      </Button>
    </>
  );

  return (
    <form className="contents" onSubmit={onStartSetup}>
      <FormOverlayBody className="flex flex-col gap-5">
        {fields}
      </FormOverlayBody>
      <FormOverlayFooter>{actions}</FormOverlayFooter>
    </form>
  );
}
