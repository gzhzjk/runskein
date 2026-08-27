/**
 * Amortized-O(1) FIFO. Reads advance a head index instead of calling
 * Array.shift(), which would re-index every queued item on each read.
 */
export class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  /** Number of items still queued. */
  get length(): number {
    return this.items.length - this.head;
  }

  /** Append one item to the back of the queue. */
  push(value: T): void {
    this.items.push(value);
  }

  /**
   * Take the front item.
   * @returns the item, or undefined when the queue is empty.
   */
  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const value = this.items[this.head++];
    // Compact once the consumed prefix is both sizeable and at least half the
    // backing array, so read items cannot be retained indefinitely.
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head >= 64 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return value;
  }

  /** Drop every queued item. */
  clear(): void {
    this.items = [];
    this.head = 0;
  }
}
