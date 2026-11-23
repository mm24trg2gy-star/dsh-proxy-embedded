import test from "node:test";
import assert from "node:assert/strict";

import { makeAdmit } from "../lib/index.js";

test("admission fails closed when the connection service is missing", () => {
  const admit = makeAdmit({ get: () => undefined });
  const result = admit({ headers: {} });
  assert.equal(result.code, 503);
});

test("admission forwards 401/403 from the host", () => {
  const admit403 = makeAdmit({ get: () => ({ requestRejection: () => 403 }) });
  assert.equal(admit403({ headers: {} }).code, 403);
  const admit401 = makeAdmit({ get: () => ({ requestRejection: () => 401 }) });
  assert.equal(admit401({ headers: {} }).code, 401);
});

test("admission lets an authenticated request through", () => {
  const admit = makeAdmit({ get: () => ({ requestRejection: () => undefined }) });
  assert.equal(admit({ headers: {} }), null);
});

test("admission fails closed when the host admission throws", () => {
  const admit = makeAdmit({
    get: () => ({ requestRejection: () => { throw new Error("boom"); } }),
  });
  assert.equal(admit({ headers: {} }).code, 503);
});
