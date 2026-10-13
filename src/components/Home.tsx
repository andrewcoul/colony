import type { ReactNode } from "react";
import { BookOpen, Code2, Newspaper, PenLine } from "lucide-react";
import { LogoMark } from "./Logo";
import { Button } from "./ui/button";

const suggestions = [
  { icon: Newspaper, label: "Latest news", prompt: "What are the most important news stories today? Search the web and cite sources.", webSearch: true },
  { icon: Code2, label: "Write code", prompt: "Help me plan a small TypeScript project I can build this weekend." },
  { icon: BookOpen, label: "Explain simply", prompt: "Explain a surprising idea from science in simple terms, with an everyday example." },
  { icon: PenLine, label: "Help me write", prompt: "Help me write something. First ask what it's for, who will read it, and the tone I want." },
] as const;

export type Suggestion = (typeof suggestions)[number];

/** Empty state: wordmark, the composer (passed in), and starter prompts. */
export function Home({ composer, notice, onSuggestion }: {
  composer: ReactNode;
  notice?: ReactNode;
  onSuggestion: (suggestion: Suggestion) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-7 overflow-y-auto px-6 pt-6 pb-[12vh] max-sm:px-3">
      <h1 className="m-0 flex items-center gap-3.5 text-[44px] leading-tight font-semibold tracking-[-0.045em] max-md:text-4xl">
        <LogoMark size={44} strokeWidth={1.6} />Colony
      </h1>
      <div className="w-full max-w-chat">{composer}</div>
      {notice}
      <div className="flex max-w-chat flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <Button key={suggestion.label} variant="outline" size="pill" className="h-9 px-3.5 text-soft [&_svg]:text-muted" onClick={() => onSuggestion(suggestion)}>
            <suggestion.icon size={15} />{suggestion.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
