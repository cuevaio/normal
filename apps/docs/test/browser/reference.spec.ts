import { expect, test } from "@playwright/test";
import { SCALAR_BUNDLE_PUBLIC_PATH } from "../../src/scalar-bundle";
import { SCALAR_BUNDLE_CACHE_CONTROL } from "../../src/static-headers";

const assertReference = async (
  page: import("@playwright/test").Page,
  viewport: { readonly height: number; readonly width: number },
) => {
  await page.setViewportSize(viewport);
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Normal API" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Getting started" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /test request/i })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("curl -sS https://api.normal.fast/v1/connections"),
  ).toBeVisible();
  expect(await page.locator("input[type='password']").count()).toBe(0);
};

test("loads the Scalar reference on a desktop viewport", async ({ page }) => {
  await assertReference(page, { height: 900, width: 1280 });
});

test("loads the Scalar reference on a mobile viewport", async ({ page }) => {
  await assertReference(page, { height: 812, width: 375 });
});

test("serves the self-hosted Scalar bundle with immutable caching", async ({
  request,
}) => {
  const response = await request.get(SCALAR_BUNDLE_PUBLIC_PATH);
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["cache-control"]).toBe(SCALAR_BUNDLE_CACHE_CONTROL);
  expect(await response.text()).not.toContain("cdn.jsdelivr.net");
});
