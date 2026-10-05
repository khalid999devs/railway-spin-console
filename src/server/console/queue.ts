export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Runs tasks one at a time, in the order they were added. A task that throws
 * rejects its own promise and does not stop the ones behind it.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}
