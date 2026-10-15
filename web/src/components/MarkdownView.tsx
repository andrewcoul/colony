import { memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { imageUrl } from "../lib/api";
import { isWebUrl, openExternal } from "../lib/links";
import { useCopy } from "../hooks/useCopy";
import { Button } from "./ui/button";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { copied, copy } = useCopy();
  const code = Array.isArray(children) ? children[0] : children;
  const className = code && typeof code === "object" && "props" in code ? String((code.props as { className?: string }).className || "") : "";
  const language = /language-([\w+-]+)/.exec(className)?.[1] || "code";
  return (
    <div className="mb-3.5 overflow-hidden rounded-xl border border-rule bg-code">
      <div className="flex items-center justify-between border-b border-rule py-1 pr-1.5 pl-3.5 text-meta text-muted">
        <span>{language}</span>
        <Button size="icon-sm" aria-label={copied ? "Copied" : "Copy code"} onClick={() => void copy(textOf(children).replace(/\n$/, ""))}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto p-3.5">{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
      event.preventDefault();
      if (isWebUrl(href)) void openExternal(href);
    }}>{children}</a>
  ),
  // Remote images could leak the user's IP to arbitrary hosts; don't load them.
  img: ({ alt }) => <span className="text-label text-muted">[image{alt ? ": " + alt : ""}]</span>,
};

/** In a Doc, web images load through Colony's image proxy, so the site never sees this device. */
const docComponents: Components = {
  ...components,
  img: ({ src, alt }) => (typeof src === "string" && isWebUrl(src)
    ? <img src={imageUrl(src)} alt={alt ?? ""} loading="lazy" className="my-2 max-h-80 rounded-lg" />
    : <span className="text-label text-muted">[image{alt ? ": " + alt : ""}]</span>),
};

export const MarkdownView = memo(function MarkdownView({ text, images = "blocked" }: { text: string; images?: "blocked" | "proxied" }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={images === "proxied" ? docComponents : components}>{text}</Markdown>
    </div>
  );
});
