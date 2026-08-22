"use client";

import type { getPersonalAccountConfiguration } from "./personal-account-configuration";
import {
  type PersonalAccountView,
  PublicBoundaryJourney,
} from "./public-boundary-journey";

type PersonalAccountConfiguration = ReturnType<
  typeof getPersonalAccountConfiguration
>;

export function ConfiguredPersonalAccountJourney({
  configuration,
  onFirstConnectionOnboardingChange,
  view,
}: {
  readonly configuration: PersonalAccountConfiguration;
  readonly onFirstConnectionOnboardingChange?: (required: boolean) => void;
  readonly view: PersonalAccountView;
}) {
  if (configuration === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Your Personal Account is temporarily unavailable.
      </p>
    );
  }

  return (
    <PublicBoundaryJourney
      accountInsightsEndpoint={configuration.accountInsightsEndpoint}
      activityLogsEndpoint={configuration.activityLogsEndpoint}
      autoInitialize
      clerkJwtTemplate={configuration.clerkJwtTemplate}
      connectionsEndpoint={configuration.connectionsEndpoint}
      connectionSetupEndpoint={configuration.connectionSetupEndpoint}
      mcpAuthorizationsEndpoint={configuration.mcpAuthorizationsEndpoint}
      mcpServerUrl={configuration.mcpServerUrl}
      {...(onFirstConnectionOnboardingChange === undefined
        ? {}
        : {
            onFirstConnectionOnboardingChange,
          })}
      onboardingProfileEndpoint={configuration.onboardingProfileEndpoint}
      personalAccountDeletionEndpoint={
        configuration.personalAccountDeletionEndpoint
      }
      personalAccountEndpoint={configuration.personalAccountEndpoint}
      view={view}
    />
  );
}
