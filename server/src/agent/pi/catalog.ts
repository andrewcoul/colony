import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { CatalogModel, Provider } from "../../settings.js";
import type { Price } from "../../shared/types.js";

/** pi-ai's built-in providers behind Colony's: ChatGPT and OpenCode Zen and Go. */
export const builtins = { openai: openaiProvider(), opencode: opencodeProvider(), "opencode-go": opencodeGoProvider() } as const;
/** Members' Bots run on OpenCode Go's catalog. */
const builtinOf = (id: Provider["id"]) => builtins[id === "opencode-go-members" ? "opencode-go" : id as keyof typeof builtins];

/** What a provider offers to pick from. */
export function catalogOf(provider: Pick<Provider, "id" | "models">): CatalogModel[] {
  if (provider.id === "dev") return provider.models.map((id) => ({ id, name: id, images: false }));
  return builtinOf(provider.id).getModels().map((model) => ({ id: model.id, name: model.name, images: model.input.includes("image") }));
}

/**
 * A model's list price in pi-ai's catalog (dollars per million tokens): $0 for a model it lists as
 * free, null when the catalog doesn't have the model.
 */
export function catalogPrice(providerId: keyof typeof builtins, model: string): Price | null {
  const cost = builtins[providerId].getModels().find((item) => item.id === model)?.cost;
  return cost ? { input: cost.input, output: cost.output, cached: cost.cacheRead } : null;
}
