export class ChatQueue {
  private queues = new Map<number, Promise<unknown>>();

  enqueue<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const current = this.queues.get(chatId) ?? Promise.resolve();
    const next = current.then(task).catch((err) => {
      // prevent queue from breaking
      throw err;
    });
    this.queues.set(chatId, next.then(() => undefined, () => undefined));
    return next;
  }
}
