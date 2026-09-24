"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { mapWithConcurrency } = require("../lib/concurrency");

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test("results keep the input order regardless of completion order", async () => {
  const items = [30, 1, 20, 2];

  const result = await mapWithConcurrency(items, 4, async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return ms;
  });

  assert.deepEqual(result, items);
});

test("never runs more than the limit at once", async () => {
  let inFlight = 0;
  let peak = 0;

  await mapWithConcurrency(
    Array.from({ length: 12 }, (_, i) => i),
    3,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    }
  );

  assert.equal(peak, 3);
});

test("every item is processed exactly once", async () => {
  const seen = [];

  await mapWithConcurrency(
    Array.from({ length: 25 }, (_, i) => i),
    4,
    async (item) => {
      await tick();
      seen.push(item);
    }
  );

  assert.deepEqual(
    seen.sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, i) => i)
  );
});

test("an empty list resolves without starting a worker", async () => {
  let called = false;
  const result = await mapWithConcurrency([], 3, async () => {
    called = true;
  });

  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("a failing item rejects the whole run", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("model call failed");
      return item;
    }),
    /model call failed/
  );
});

test("a limit below 1 is rejected rather than hanging forever", async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (item) => item),
    /at least 1/
  );
});
