import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useResource } from "../src/use-resource";
import { VaultError } from "../src/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("rapid query changes, returning to an old query and late responses never expose previous results", async () => {
  const requests: { query: string; signal: AbortSignal; resolve: (value: string) => void }[] = [];
  let current!: ReturnType<typeof useResource<string>>;
  let renderer!: ReactTestRenderer;
  function Harness({ query, enabled = true }: { query: string; enabled?: boolean }) {
    current = useResource(
      query,
      (signal) => new Promise<string>((resolve) => requests.push({ query, signal, resolve })),
      enabled,
    );
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness, { query: "A" }));
  });
  await act(tick);
  await act(async () => {
    requests[0].resolve("old A");
  });
  assert.equal(current.value, "old A");
  await act(async () => {
    renderer.update(createElement(Harness, { query: "B" }));
  });
  assert.equal(current.value, undefined);
  await act(tick);
  await act(async () => {
    renderer.update(createElement(Harness, { query: "A" }));
  });
  assert.equal(current.value, undefined);
  assert.equal(current.loading, true);
  await act(tick);
  assert.deepEqual(
    requests.map((request) => request.query),
    ["A", "B", "A"],
  );
  assert.equal(requests[1].signal.aborted, true);
  await act(async () => {
    requests[1].resolve("late B");
  });
  assert.equal(current.value, undefined);
  await act(async () => {
    requests[2].resolve("new A");
  });
  assert.equal(current.value, "new A");
  await act(async () => {
    renderer.update(createElement(Harness, { query: "A", enabled: false }));
  });
  assert.equal(current.value, undefined);
  assert.equal(current.loading, false);
  assert.equal(requests[2].signal.aborted, true);
  await act(async () => {
    renderer.unmount();
  });
});

test("permission failures clear data and refresh retries without retaining old errors", async () => {
  let calls = 0;
  let current!: ReturnType<typeof useResource<string>>;
  let renderer!: ReactTestRenderer;
  function Harness() {
    current = useResource("record", async () => {
      calls++;
      if (calls === 2) throw new VaultError("授权已撤销", 403);
      return `result ${calls}`;
    });
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  await act(tick);
  assert.equal(current.value, "result 1");
  await act(async () => {
    current.refresh();
  });
  assert.equal(current.value, undefined);
  await act(tick);
  assert.equal(current.error?.status, 403);
  assert.equal(current.value, undefined);
  await act(async () => {
    current.refresh();
  });
  assert.equal(current.error, undefined);
  await act(tick);
  assert.equal(current.value, "result 3");
  await act(async () => {
    renderer.unmount();
  });
});
