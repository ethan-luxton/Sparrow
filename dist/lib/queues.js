export class ChatQueue {
    queues = new Map();
    pending = new Map();
    enqueue(chatId, task) {
        const current = this.queues.get(chatId) ?? Promise.resolve();
        this.pending.set(chatId, (this.pending.get(chatId) ?? 0) + 1);
        const next = current.then(task).catch((err) => {
            // prevent queue from breaking
            throw err;
        });
        this.queues.set(chatId, next.then(() => undefined, () => undefined));
        return next.finally(() => {
            const remaining = (this.pending.get(chatId) ?? 1) - 1;
            if (remaining <= 0)
                this.pending.delete(chatId);
            else
                this.pending.set(chatId, remaining);
        });
    }
    isBusy(chatId) {
        return (this.pending.get(chatId) ?? 0) > 0;
    }
}
