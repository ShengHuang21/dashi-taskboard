import type { Comment } from "./types";

export interface RegisteredReviewReceipt {
  status: "changes_requested" | "pass";
  reviewerThreadId: string;
  model: string;
  reasoningEffort: string;
  sourceRef: string;
  implementation?: { threadId: string; model: string; reasoningEffort: string };
}

export function latestRegisteredReviewReceipt(comments: Comment[]): RegisteredReviewReceipt | null {
  for (const comment of [...comments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))) {
    const match = comment.body.match(/```taskboard-review-receipt\s+v1\s*\n([\s\S]*?)```/i);
    if (!match) continue;
    try {
      const receipt = JSON.parse(match[1]);
      const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
      if (!["pass", "changes_requested"].includes(receipt.status)
        || ![receipt.reviewerThreadId, receipt.model, receipt.reasoningEffort, receipt.sourceRef, receipt.candidate?.digest].every(nonempty)
        || (receipt.implementation && ![receipt.implementation.threadId, receipt.implementation.model, receipt.implementation.reasoningEffort].every(nonempty))) return null;
      return receipt;
    } catch { return null; }
  }
  return null;
}
