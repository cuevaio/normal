import { z } from "zod";

export {
  decodeRecoveryVerificationResponse,
  type RecoveryVerificationResponse as VerificationResponse,
  type ReplayEvidence,
} from "@whatsapp-mcp/contracts/recovery";

export const drillKindSchema = z.enum(["weekly_restore", "quarterly_game_day"]);

export const startRequestSchema = z
  .object({
    drill: drillKindSchema,
    requested_source_point_at: z.iso.datetime({ offset: true }),
    serving: z.literal(false),
  })
  .strict();

export type StartRequest = z.infer<typeof startRequestSchema>;
