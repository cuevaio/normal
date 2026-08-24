import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  CreateSessionRequest,
  ListSessionsRequest,
  ReconcileSessionRequest,
  RepairSessionConfigurationRequest,
  SessionRequest,
  VerifySessionNumberRequest,
} from "@whatsapp-mcp/contracts/provider-control";
import {
  createProductionHandler,
  createProductionRpc,
  type ProviderControlEnvironment,
} from "./production";

type Env = ProviderControlEnvironment & {
  readonly PROVIDER_ALLOCATION_GATE: DurableObjectNamespace<ProviderAllocationGate>;
};

export class ProviderAllocationGate extends DurableObject<Env> {
  private serial = Promise.resolve();

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

  connectSession(request: SessionRequest) {
    return this.serialized(() =>
      createProductionRpc(this.env).connectSession(request),
    );
  }

  createSession(request: CreateSessionRequest) {
    return this.serialized(() =>
      createProductionRpc(this.env).createSession(request),
    );
  }

  reconcileSession(request: ReconcileSessionRequest) {
    return this.serialized(() =>
      createProductionRpc(this.env).reconcileSession(request),
    );
  }

  repairSessionConfiguration(request: RepairSessionConfigurationRequest) {
    return this.serialized(() =>
      createProductionRpc(this.env).repairSessionConfiguration(request),
    );
  }
}

export default class ProviderControl extends WorkerEntrypoint<Env> {
  private allocationGate() {
    return this.env.PROVIDER_ALLOCATION_GATE.getByName("webshare-proxy-pool");
  }

  fetch(request: Request) {
    return createProductionHandler(this.env)(request);
  }

  connectSession(request: SessionRequest) {
    return this.allocationGate().connectSession(request);
  }

  createSession(request: CreateSessionRequest) {
    return this.allocationGate().createSession(request);
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
    return this.allocationGate().reconcileSession(request);
  }

  repairSessionConfiguration(request: RepairSessionConfigurationRequest) {
    return this.allocationGate().repairSessionConfiguration(request);
  }

  verifySessionNumber(request: VerifySessionNumberRequest) {
    return createProductionRpc(this.env).verifySessionNumber(request);
  }
}
