import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { CatalogModel, Provider } from "../../settings.js";

/** pi-ai's built-in providers behind Colony's: ChatGPT and OpenCode Zen and Go. */
export const builtins = { openai: openaiProvider(), opencode: opencodeProvider(), "opencode-go": opencodeGoProvider() } as const;

/** What a provider offers to pick from. */
export function catalogOf(provider: Pick<Provider, "id" | "models">): CatalogModel[] {
  if (provider.id === "dev") return provider.models.map((id) => ({ id, name: id, images: false }));
  return builtins[provider.id].getModels().map((model) => ({ id: model.id, name: model.name, images: model.input.includes("image") }));
}
