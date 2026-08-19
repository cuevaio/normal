import { WorkerEntrypoint } from "cloudflare:workers";
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

type Env = ProviderControlEnvironment;

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
