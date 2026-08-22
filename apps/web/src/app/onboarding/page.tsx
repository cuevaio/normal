import type { Metadata } from "next";
import { connection } from "next/server";
import { redirectToCanonicalOrigin } from "../canonical-origin";
import { getPersonalAccountConfiguration } from "../personal-account-configuration";
import { OnboardingExperience } from "./onboarding-experience";

export const metadata: Metadata = {
  title: "Onboarding | Normal",
  description: "Connect your first WhatsApp Connection to Normal.",
  robots: { follow: false, index: false },
};

export default async function OnboardingPage() {
  await connection();
  await redirectToCanonicalOrigin("/onboarding");
  return (
    <OnboardingExperience configuration={getPersonalAccountConfiguration()} />
  );
}
