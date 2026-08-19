import { makePgWhatsAppConnectionRepository } from "@whatsapp-mcp/db/whatsapp-connection";
import { Effect, Layer } from "effect";
import {
  WhatsAppConnectionPersistence,
  WhatsAppConnectionPersistenceError,
} from "./whatsapp-connection";

export interface WhatsAppConnectionPersistenceEnvironment {
  readonly HYPERDRIVE?:
    | {
        readonly connectionString: string;
      }
    | undefined;
}

export const makeWhatsAppConnectionPersistenceLayer = (
  environment: WhatsAppConnectionPersistenceEnvironment,
) => {
  const connectionString = environment.HYPERDRIVE?.connectionString;
  const repository =
    typeof connectionString === "string"
      ? makePgWhatsAppConnectionRepository(connectionString)
      : null;
  const getRepository = () => {
    if (repository === null) throw new Error("database unavailable");
    return repository;
  };
  const persistenceError = () => new WhatsAppConnectionPersistenceError();

  return Layer.succeed(WhatsAppConnectionPersistence, {
    activate: (input) =>
      Effect.tryPromise({
        try: () => getRepository().activate(input),
        catch: persistenceError,
      }),
    claimLifecycle: (input) =>
      Effect.tryPromise({
        try: () => getRepository().claimLifecycle(input),
        catch: persistenceError,
      }),
    finishLifecycle: (input) =>
      Effect.tryPromise({
        try: () => getRepository().finishLifecycle(input),
        catch: persistenceError,
      }),
    prepareDeletion: (input) =>
      Effect.tryPromise({
        try: () => getRepository().prepareDeletion(input),
        catch: persistenceError,
      }),
    finishDeletion: (input) =>
      Effect.tryPromise({
        try: () => getRepository().finishDeletion(input),
        catch: persistenceError,
      }),
    list: (clerkUserId) =>
      Effect.tryPromise({
        try: () => getRepository().listForUser(clerkUserId),
        catch: persistenceError,
      }),
    loadForRename: (input) =>
      Effect.tryPromise({
        try: () => getRepository().loadForUser(input),
        catch: persistenceError,
      }),
    rename: (input) =>
      Effect.tryPromise({
        try: () => getRepository().rename(input),
        catch: persistenceError,
      }),
    loadSetup: (input) =>
      Effect.tryPromise({
        try: () => getRepository().loadSetupForActivation(input),
        catch: persistenceError,
      }),
    failSetupActivation: (input) =>
      Effect.tryPromise({
        try: () => getRepository().failSetupActivation(input),
        catch: persistenceError,
      }),
  });
};
