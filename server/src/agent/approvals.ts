import type { Store } from "../store.js";
import type { Approval } from "../shared/types.js";

const APPROVAL_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * The gate for actions that leave your PC or can't be undone (borrowed from OpenBot's
 * policy gateway): the run pauses, an Approve/Deny card appears, and the tool only
 * proceeds on approval. It fails closed: timeouts, stops, and restarts all deny.
 */
export class ApprovalGate {
  private waiting = new Map<string, (approved: boolean) => void>();

  constructor(private store: Store) {}

  async request(input: Omit<Approval, "id" | "status" | "createdAt" | "resolvedAt">, signal: AbortSignal): Promise<boolean> {
    const approval = this.store.createApproval(input);
    const message = this.store.getMessage(input.messageId);
    if (message) this.store.updateMessage(message.id, { cards: [...message.cards, { type: "approval", approvalId: approval.id }] });
    this.store.setPresence(input.botId, "waiting", input.summary);

    const approved = await new Promise<boolean>((resolve) => {
      const finish = (value: boolean, status: "approved" | "denied" | "expired") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiting.delete(approval.id);
        this.store.resolveApproval(approval.id, status);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false, "expired"), APPROVAL_TIMEOUT_MS);
      const onAbort = () => finish(false, "denied");
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(approval.id, (value) => finish(value, value ? "approved" : "denied"));
    });

    this.store.setPresence(input.botId, "working", approved ? "Approved — continuing" : "Approval denied");
    return approved;
  }

  /** Returns false if the approval isn't waiting (already resolved, expired, or unknown). */
  resolve(approvalId: string, approved: boolean) {
    const resolver = this.waiting.get(approvalId);
    if (!resolver) return false;
    resolver(approved);
    return true;
  }
}
