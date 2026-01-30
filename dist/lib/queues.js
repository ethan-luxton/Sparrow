export class ChatQueue {
    queues = new Map();
    enqueue(chatId, task) {
        const current = this.queues.get(chatId) ?? Promise.resolve();
        const next = current.then(task).catch((err) => {
            // prevent queue from breaking
            throw err;
        });
        this.queues.set(chatId, next.then(() => undefined, () => undefined));
        return next;
    }
}
