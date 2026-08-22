import { expect, type Page } from "@playwright/test";

export const expectSuccessToast = (page: Page, message: string) =>
  expect(
    page.locator("[data-sonner-toast]").filter({ hasText: message }),
  ).toBeVisible();
