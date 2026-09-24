/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * Reviewing files strictly one at a time made a large pull request take minutes
 * of mostly idle wall-clock; a small pool keeps it quick without tripping the
 * provider's rate limits.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (limit < 1) {
    throw new Error(`Concurrency limit must be at least 1, got ${limit}.`);
  }

  const results = new Array<R>(items.length);
  let cursor = 0;

  async function drain(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;

      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => drain())
  );

  return results;
}
