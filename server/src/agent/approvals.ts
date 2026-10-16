import type { Store } from "../store.js";
import type { Approval, ApprovalRequest } from "../shared/types.js";

const APPROVAL_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * The gate for actions that leave your PC or can't be undone (borrowed from OpenBot's
 * policy gateway): the run pauses, an Approve/Deny card appears, and the tool only
 * proceeds on approval. It fails closed: timeouts and stops deny. A restart keeps it waiting only
 * when the turn resumes and asks again for the same action (see adopt).
 */
export class ApprovalGate {
  private waiting = new Map<string, (approved: boolean) => void>();

  constructor(private store: Store) {}

  async request(input: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    // After a restart, a resumed turn asking for the same thing re-attaches to the approval
    // that was already waiting (and keeps its original deadline) instead of asking twice.
    const kept = this.adopt(input);
    const approval = kept ?? this.store.createApproval(input);
    if (!kept) this.store.appendCard(input.messageId, { type: "approval", approvalId: approval.id });
    this.store.setPresence(input.botId, "waiting", input.summary);

    const approved = await new Promise<boolean>((resolve) => {
      const finish = (value: boolean, status: "approved" | "denied" | "expired") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiting.delete(approval.id);
        this.store.resolveApproval(approval.id, status);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false, "expired"), Math.max(0, approval.createdAt + APPROVAL_TIMEOUT_MS - Date.now()));
      const onAbort = () => finish(false, "denied");
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(approval.id, (value) => finish(value, value ? "approved" : "denied"));
    });

    this.store.setPresence(input.botId, "working", approved ? "Approved — continuing" : "Approval denied");
    return approved;
  }

  /**
   * A pending approval from before a restart for this reply and tool, if it asks for exactly
   * the same action. One that asks for something different is expired: the new request replaces it.
   */
  private adopt(input: ApprovalRequest) {
    let match: Approval | undefined;
    for (const approval of this.store.listApprovals("pending")) {
      if (approval.messageId !== input.messageId || approval.tool !== input.tool || this.waiting.has(approval.id)) continue;
      if (!match && approval.detail === input.detail) match = approval;
      else this.store.resolveApproval(approval.id, "expired");
    }
    return match;
  }

  /** Expires approvals on these replies that nobody is waiting for any more (left over from before a restart). */
  expireUnclaimed(messageIds: string[]) {
    const ids = new Set(messageIds);
    for (const approval of this.store.listApprovals("pending")) {
      if (ids.has(approval.messageId) && !this.waiting.has(approval.id)) this.store.resolveApproval(approval.id, "expired");
    }
  }

  /** Returns false if the approval isn't waiting (already resolved, expired, or unknown). */
  resolve(approvalId: string, approved: boolean) {
    const resolver = this.waiting.get(approvalId);
    if (!resolver) return false;
    resolver(approved);
    return true;
  }
}
