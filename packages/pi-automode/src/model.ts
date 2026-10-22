import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompleteFn } from "./classifier/classify.ts";
import type { Config } from "./config/schema.ts";

type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry">;

/**
 * The classifier model of a child pi. pi-subagent sets it, so a child that works on a cheap model
 * is still checked by the model of its parent. It beats the config files. Defined by pi-automode.
 */
export const CLASSIFIER_MODEL_ENV = "PI_AUTOMODE_CLASSIFIER_MODEL";

export function withClassifierModelFromEnvironment(
  classifier: Config["classifier"],
  environment: Record<string, string | undefined>,
): Config["classifier"] {
  const model = environment[CLASSIFIER_MODEL_ENV];
  return model ? { ...classifier, model } : classifier;
}

// "provider/model-id": the id may itself contain slashes, so only the first one splits.
function findConfiguredModel(registry: ModelContext["modelRegistry"], setting: string) {
  const slash = setting.indexOf("/");
  const model = registry.find(setting.slice(0, slash), setting.slice(slash + 1));
  if (!model) throw new Error(`classifier model not found: ${setting}`);
  return model;
}

/**
 * Runs the classifier prompt on the configured model, or on the session's model
 * when none is configured. Auth comes from pi's model registry.
 */
export function createPiComplete(context: ModelContext, classifier: Config["classifier"]): CompleteFn {
  return async ({ system, user, signal }) => {
    const model = classifier.model ? findConfiguredModel(context.modelRegistry, classifier.model) : context.model;
    if (!model) throw new Error("no model is available for the classifier");

    const stream = context.modelRegistry.streamSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { reasoning: classifier.reasoningLevel, signal },
    );
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? `model call ${message.stopReason}`);
    }
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  };
}
