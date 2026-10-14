/**
 * Which shell commands need the user's approval. The container is the security boundary;
 * this is the "spend and send" guardrail: anything that publishes, sends, or pushes
 * outside your PC waits for a tap. Reading, building, testing, and editing run freely.
 */
const RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+push\b/, reason: "Pushes code to a remote" },
  { pattern: /\bgh\s+(pr|issue|release|repo|gist)\s+(create|merge|close|delete|edit|comment|review)\b/, reason: "Changes something on GitHub" },
  { pattern: /\bgh\s+api\b.*-X\s*(POST|PUT|PATCH|DELETE)/i, reason: "Writes to the GitHub API" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b|\b(twine|cargo)\s+(upload|publish)\b/, reason: "Publishes a package" },
  { pattern: /\bcurl\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data\S*|-F|--form|-T|--upload-file)\b)/i, reason: "Sends data to a website" },
  { pattern: /\bwget\b[^|;&]*--(post|method)/i, reason: "Sends data to a website" },
  { pattern: /\b(ssh|scp|sftp|rsync)\b\s+\S*@|\b(scp|rsync)\b[^|;&]*\s\S+:\S*/, reason: "Connects to another machine" },
  { pattern: /\b(sendmail|mail|mailx|mutt|swaks)\b/, reason: "Sends email" },
  { pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/workspace\/?|~\/?|\$HOME\/?|\/)(\s|$)/, reason: "Deletes the whole workspace" },
];

export function approvalReason(command: string): string | null {
  for (const rule of RULES) if (rule.pattern.test(command)) return rule.reason;
  return null;
}
