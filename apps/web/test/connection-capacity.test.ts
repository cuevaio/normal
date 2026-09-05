import { describe, expect, test } from "bun:test";
import {
  getWhatsAppConnectionCapacity,
  WHATSAPP_CONNECTION_LIMIT,
} from "../src/app/connection-capacity";

describe("WhatsApp Connection capacity", () => {
  test("allows the first three number slots and stops at the limit", () => {
    expect(WHATSAPP_CONNECTION_LIMIT).toBe(3);
    expect(getWhatsAppConnectionCapacity(0)).toEqual({
      limit: 3,
      reached: false,
    });
    expect(getWhatsAppConnectionCapacity(1)).toEqual({
      limit: 3,
      reached: false,
    });
    expect(getWhatsAppConnectionCapacity(2)).toEqual({
      limit: 3,
      reached: false,
    });
    expect(getWhatsAppConnectionCapacity(3)).toEqual({
      limit: 3,
      reached: true,
    });
  });
});
