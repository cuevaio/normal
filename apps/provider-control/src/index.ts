import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  CreateSessionRequest,
  ListSessionsRequest,
  ProviderControlResult,
  ReconcileSessionRequest,
  RepairSessionConfigurationRequest,
  SessionReconciliation,
  SessionRequest,
  VerifySessionNumberRequest,
} from "@whatsapp-mcp/contracts/provider-control";
import {
  createProductionHandler,
  createProductionRpc,
  type ProviderControlEnvironment,
} from "./production";

type Env = ProviderControlEnvironment;

const allocationQuarantineKey = "allocation-quarantine";
const allocationReconciliationRetryMs = 30_000;

interface AllocationQuarantine {
  readonly reconcileAfter: number;
  readonly setupMarker: string;
}

const allocationUnavailable = <Value>(): ProviderControlResult<Value> => ({
  error: {
    _tag: "ProviderControlFailure",
    code: "unavailable",
    operation: "lifecycle-write",
    retryAfterMs: null,
    retryDecision: "reconcile_before_repeat",
  },
  ok: false,
});

export class ProviderAllocationGate extends DurableObject<Env> {
  private serial = Promise.resolve();

  private rpc() {
    return createProductionRpc(this.env);
  }

  private async serialized<Value>(operation: () => Promise<Value>) {
    const previous = this.serial;
    let release: () => void = () => undefined;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async release(setupMarker: string) {
    const existing = await this.ctx.storage.get<AllocationQuarantine>(
      allocationQuarantineKey,
    );
    if (existing?.setupMarker !== setupMarker) {
      throw new Error("allocation reservation mismatch");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete(allocationQuarantineKey);
  }

  private async settle(
    quarantine: AllocationQuarantine,
    result: ProviderControlResult<SessionReconciliation>,
  ) {
    const now = Date.now();
    const visible = result.ok && result.value.outcome !== "absent";
    const settledObservation =
      result.ok || (!result.ok && result.error.code === "integrity_failed");
    if (visible || (now >= quarantine.reconcileAfter && settledObservation)) {
      await this.release(quarantine.setupMarker);
      return true;
    }
    await this.ctx.storage.setAlarm(
      Math.max(
        quarantine.reconcileAfter,
        now + allocationReconciliationRetryMs,
      ),
    );
    return false;
  }

  private async reconcileQuarantine(quarantine: AllocationQuarantine) {
    const result = await createProductionRpc(this.env).reconcileSession({
      requireConnectReady: true,
      setupMarker: quarantine.setupMarker,
    });
    return this.settle(quarantine, result);
  }

  private async allocationAvailable() {
    const quarantine = await this.ctx.storage.get<AllocationQuarantine>(
      allocationQuarantineKey,
    );
    return quarantine === undefined
      ? true
      : this.reconcileQuarantine(quarantine);
  }

  private async allocate<Value>(
    operation: () => Promise<ProviderControlResult<Value>>,
  ) {
    return (await this.allocationAvailable())
      ? operation()
      : allocationUnavailable<Value>();
  }

  alarm() {
    return this.serialized(async () => {
      const quarantine = await this.ctx.storage.get<AllocationQuarantine>(
        allocationQuarantineKey,
      );
      if (quarantine !== undefined) {
        await this.reconcileQuarantine(quarantine);
      }
    });
  }

  connectSession(request: SessionRequest) {
    return this.serialized(() => this.rpc().connectSession(request));
  }

  createSession(request: CreateSessionRequest) {
    return this.serialized(() =>
      this.allocate(() => this.rpc().createSession(request)),
    );
  }

  reconcileSession(request: ReconcileSessionRequest) {
    return this.serialized(async () => {
      const result = await this.rpc().reconcileSession(request);
      const quarantine = await this.ctx.storage.get<AllocationQuarantine>(
        allocationQuarantineKey,
      );
      if (
        quarantine?.setupMarker === request.setupMarker &&
        (request.requireConnectReady === true ||
          request.webhookUrl !== undefined)
      ) {
        await this.settle(quarantine, result);
      }
      return result;
    });
  }

  repairSessionConfiguration(request: RepairSessionConfigurationRequest) {
    return this.serialized(() =>
      this.allocate(() => this.rpc().repairSessionConfiguration(request)),
    );
  }
}

export default class ProviderControl extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return createProductionHandler(this.env)(request);
  }

  connectSession(request: SessionRequest) {
    return createProductionRpc(this.env).connectSession(request);
  }

  createSession(request: CreateSessionRequest) {
    return createProductionRpc(this.env).createSession(request);
  }

  deleteSession(request: SessionRequest) {
    return createProductionRpc(this.env).deleteSession(request);
  }

  disconnectSession(request: SessionRequest) {
    return createProductionRpc(this.env).disconnectSession(request);
  }

  getQrCode(request: SessionRequest) {
    return createProductionRpc(this.env).getQrCode(request);
  }

  listSessions(request: ListSessionsRequest) {
    return createProductionRpc(this.env).listSessions(request);
  }

  reconcileSession(request: ReconcileSessionRequest) {
    return createProductionRpc(this.env).reconcileSession(request);
  }

  repairSessionConfiguration(request: RepairSessionConfigurationRequest) {
    return createProductionRpc(this.env).repairSessionConfiguration(request);
  }

  verifySessionNumber(request: VerifySessionNumberRequest) {
    return createProductionRpc(this.env).verifySessionNumber(request);
  }
}
