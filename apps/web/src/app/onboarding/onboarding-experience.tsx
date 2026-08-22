"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfiguredPersonalAccountJourney } from "../configured-personal-account-journey";
import type { getPersonalAccountConfiguration } from "../personal-account-configuration";
import { SignedInGate } from "../signed-in-gate";

type PersonalAccountConfiguration = ReturnType<
  typeof getPersonalAccountConfiguration
>;

export function OnboardingExperience({
  configuration,
}: {
  readonly configuration: PersonalAccountConfiguration;
}) {
  const router = useRouter();
  const [onboardingRequired, setOnboardingRequired] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    if (onboardingRequired === false) {
      router.replace("/dashboard");
    }
  }, [onboardingRequired, router]);

  return (
    <SignedInGate>
      <main className="min-h-screen bg-muted/30">
        <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-16">
          <ConfiguredPersonalAccountJourney
            configuration={configuration}
            onFirstConnectionOnboardingChange={setOnboardingRequired}
            view="onboarding"
          />
        </div>
      </main>
    </SignedInGate>
  );
}
