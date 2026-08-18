import docsPackage from "../package.json" with { type: "json" };

export const SCALAR_BUNDLE_VERSION =
  docsPackage.dependencies["@scalar/api-reference"];
export const SCALAR_BUNDLE_PUBLIC_DIRECTORY = `/vendor/scalar/${SCALAR_BUNDLE_VERSION}`;
export const SCALAR_BUNDLE_FILE_NAME = "standalone.js";
export const SCALAR_BUNDLE_PUBLIC_PATH = `${SCALAR_BUNDLE_PUBLIC_DIRECTORY}/${SCALAR_BUNDLE_FILE_NAME}`;
export const SCALAR_SCRIPT_NONCE = "normal-docs-scalar";
