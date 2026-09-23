import test from "node:test";
import assert from "node:assert/strict";

import { shouldFocusWorkerTab } from "../assets/extension/src/core/focus-policy.js";

test("shouldFocusWorkerTab only focuses for explicit user actions", () => {
  assert.equal(shouldFocusWorkerTab("task-run"), false);
  assert.equal(shouldFocusWorkerTab("zip-setup"), false);
  assert.equal(shouldFocusWorkerTab("user-open-worker"), true);
});
