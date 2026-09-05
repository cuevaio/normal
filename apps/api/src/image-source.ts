import {
  makeVerifiedImageBytes,
  maximumOutboundImageBytes,
  type VerifiedImageBytes,
} from "@whatsapp-mcp/whatsapp-provider/session";
import { decodeBase64, isStandardPaddedBase64 } from "./base64-url";
import { downloadVerifiedFile, type OutboundFileFetch } from "./pdf-source";

const maximumImageBase64Length = 6_666_668;
export const decodeImageBase64 = (value: string): VerifiedImageBytes => {
  if (
    value.length > maximumImageBase64Length ||
    !isStandardPaddedBase64(value)
  ) {
    throw new Error("invalid image base64");
  }
  return makeVerifiedImageBytes(decodeBase64(value));
};

export const downloadImage = async (
  value: string,
  fetcher: OutboundFileFetch = globalThis.fetch,
): Promise<VerifiedImageBytes> =>
  downloadVerifiedFile(
    value,
    {
      accept: "image/jpeg, image/png",
      maximumBytes: maximumOutboundImageBytes,
      verify: makeVerifiedImageBytes,
    },
    fetcher,
  );
