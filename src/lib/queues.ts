export class ChatQueue {
  private queues = new Map<number, Promise<unknown>>();
  private pending = new Map<number, number>();

  enqueue<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const current = this.queues.get(chatId) ?? Promise.resolve();
    this.pending.set(chatId, (this.pending.get(chatId) ?? 0) + 1);
    const next = current.then(task).catch((err) => {
      // prevent queue from breaking
      throw err;
    });
    this.queues.set(chatId, next.then(() => undefined, () => undefined));
    return next.finally(() => {
      const remaining = (this.pending.get(chatId) ?? 1) - 1;
      if (remaining <= 0) this.pending.delete(chatId);
      else this.pending.set(chatId, remaining);
    });
  }

  isBusy(chatId: number): boolean {
    return (this.pending.get(chatId) ?? 0) > 0;
  }
}
