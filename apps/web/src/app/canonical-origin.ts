import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function redirectToCanonicalOrigin(path: string) {
  const canonicalWebOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN;
  if (process.env.NODE_ENV !== "development" || !canonicalWebOrigin) {
    return;
  }

  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const requestOrigin = host === null ? null : `${protocol}://${host}`;

  if (requestOrigin !== canonicalWebOrigin) {
    redirect(`${canonicalWebOrigin}${path}`);
  }
}
