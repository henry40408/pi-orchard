import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Config } from "../src/config/schema.ts";
import { CLASSIFIER_MODEL_ENV, withClassifierModelFromEnvironment } from "../src/model.ts";

describe("withClassifierModelFromEnvironment", () => {
  // Only the model matters here.
  const classifier = { model: "configured/model" } as Config["classifier"];

  it("lets the variable of the parent beat the config", () => {
    const result = withClassifierModelFromEnvironment(classifier, { [CLASSIFIER_MODEL_ENV]: "judge/model" });
    assert.equal(result.model, "judge/model");
  });

  it("keeps the config without the variable, and when it is empty", () => {
    assert.equal(withClassifierModelFromEnvironment(classifier, {}), classifier);
    assert.equal(withClassifierModelFromEnvironment(classifier, { [CLASSIFIER_MODEL_ENV]: "" }), classifier);
  });
});
