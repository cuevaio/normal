import { expect, type Page } from "@playwright/test";

export const expectSuccessToast = (page: Page, message: string) =>
  expect(
    page
      .locator("[data-sonner-toast][data-front='true']")
      .filter({ hasText: message }),
  ).toBeVisible();
