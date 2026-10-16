import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { ModelSource } from "./models.js";

/*
 * A scripted model for pi runtime tests: pi-ai's faux provider plays back one turn per model
 * call and records what each call was sent. Requests to summarise a conversation (compaction)
 * get a summary without using up a turn.
 */

export type Turn = AssistantMessage;
export const textTurn = (text: string) => fauxAssistantMessage(text);
export const toolTurn = (name: string, input: JsonObject, say?: string) =>
  fauxAssistantMessage([...(say ? [fauxText(say)] : []), fauxToolCall(name, input, { id: `call-${name}-${Math.random().toString(36).slice(2, 8)}` })], { stopReason: "toolUse" });

export type Script = { turns: Turn[]; prompts: TranscriptContext[]; toolNames: string[][]; summaries: number };

export function scriptedModels(options: { contextWindow?: number } = {}) {
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "mock-model", input: ["text", "image"], contextWindow: options.contextWindow ?? 200_000, maxTokens: 4096 },
      { id: "other-model", input: ["text"], contextWindow: options.contextWindow ?? 200_000, maxTokens: 4096 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const state = { script: { turns: [], prompts: [], toolNames: [], summaries: 0 } as Script, calls: 0 };
  const respond = (context: TranscriptContext) => {
    const text = JSON.stringify(context.messages);
    const tools = toolsOffered(context);
    if (!tools.length && text.includes("<conversation>")) {
      state.script.summaries += 1;
      return fauxAssistantMessage(`## Goal\nSummary ${state.script.summaries} of the earlier conversation.`);
    }
    state.script.prompts.push(context);
    state.script.toolNames.push(tools);
    const turns = state.script.turns;
    return turns[Math.min(state.calls++, turns.length - 1)] ?? textTurn("…");
  };
  faux.setResponses(Array.from({ length: 2000 }, () => respond));
  const source: ModelSource = { models, ref: (target) => ({ provider: "faux", modelId: target.model }) };
  return {
    source,
    /** Plays these turns from the next model call on, and records the prompts afresh. */
    play(turns: Turn[]) {
      state.script = { turns, prompts: [], toolNames: [], summaries: 0 };
      state.calls = 0;
      return state.script;
    },
  };
}

export const promptText = (context: TranscriptContext | undefined) => JSON.stringify(context ?? null);

/** The tools a request offered: added and removed along the transcript by system messages. */
function toolsOffered(context: TranscriptContext) {
  const offered = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) offered.delete(typeof tool === "string" ? tool : (tool as { name: string }).name);
  }
  return [...offered];
}
