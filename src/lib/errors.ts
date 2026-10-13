import { ConvexError } from "convex/values";

export function errorText(error: unknown) {
  if (error instanceof ConvexError) {
    if (typeof error.data === "string") return error.data;
    if (error.data && typeof error.data === "object" && "kind" in error.data && error.data.kind === "RateLimited") {
      return "You've hit the message limit. Give it a minute, or come back tomorrow if you've sent 100 today.";
    }
  }
  return "Something went wrong. Check your connection and try again.";
}
