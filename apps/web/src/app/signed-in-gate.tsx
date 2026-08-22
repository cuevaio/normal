"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function SignedInGate({ children }: { readonly children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();

  if (!isLoaded) {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
        <p className="text-sm text-muted-foreground">
          Checking sign in status…
        </p>
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
        <section className="w-full max-w-md rounded-2xl bg-background p-8 shadow-sm ring-1 ring-border">
          <Link className="wordmark" href="/">
            Normal<span aria-hidden="true">.</span>
          </Link>
          <h1 className="mt-10 text-3xl font-semibold tracking-tight">
            Sign in to your dashboard
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Your dashboard is only available to authenticated Users.
          </p>
          <Button className="mt-8 w-full" onClick={() => clerk.openSignIn()}>
            Sign in
          </Button>
        </section>
      </main>
    );
  }

  return children;
}
