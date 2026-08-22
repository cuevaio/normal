import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { isClerkPublishableKey } from "../effect/clerk-config";
import { parseProductAnalyticsConfiguration } from "../effect/product-analytics";
import { ProductAnalyticsBootstrap } from "./product-analytics-bootstrap";
import { QueryProvider } from "./query-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_WEB_ORIGIN ?? "http://localhost:3000",
  ),
  title: "Normal | WhatsApp in ChatGPT and Claude",
  description:
    "Bring your WhatsApp data into ChatGPT and Claude. Search conversations, summarize groups, find details, and draft replies with explicit permissions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const productAnalytics = parseProductAnalyticsConfiguration({
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    projectKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  });
  const content = (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ProductAnalyticsBootstrap configuration={productAnalytics} />
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );

  if (!isClerkPublishableKey(publishableKey)) return content;

  return (
    <ClerkProvider publishableKey={publishableKey}>{content}</ClerkProvider>
  );
}
