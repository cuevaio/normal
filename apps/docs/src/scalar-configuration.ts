import {
  SCALAR_BUNDLE_PUBLIC_PATH,
  SCALAR_SCRIPT_NONCE,
} from "./scalar-bundle";

export const scalarConfiguration = {
  cdn: SCALAR_BUNDLE_PUBLIC_PATH,
  defaultHttpClient: {
    clientKey: "curl",
    targetKey: "shell",
  },
  hideClientButton: true,
  hideTestRequestButton: true,
  hiddenClients: {
    js: true,
  },
  nonce: SCALAR_SCRIPT_NONCE,
  pageTitle: "Normal API",
  persistAuth: false,
  telemetry: false,
  url: "/openapi.json",
} as const;
