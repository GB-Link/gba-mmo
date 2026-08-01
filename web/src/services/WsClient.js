/**
 * WebSocket client for the gba-mmo server.
 * Text frames carry the ASCII control protocol (login~~/create~~ and their
 * replies); binary frames are raw protobuf messages relayed verbatim to and
 * from the GBA.
 */
export class WsClient {
    constructor() {
        this.ws = null;
        this.onBinary = null;   // (Uint8Array) => void
        this.onClose = null;    // () => void
        this._textWaiters = [];
    }

    get isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    connect(url, timeoutMs = 5000) {
        this.disconnect();
        return new Promise((resolve, reject) => {
            let socket;
            try {
                socket = new WebSocket(url);
            } catch (e) {
                reject(e);
                return;
            }
            socket.binaryType = 'arraybuffer';
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error(`Timed out connecting to ${url}`));
            }, timeoutMs);

            socket.onopen = () => {
                if (this.ws !== socket) return;
                clearTimeout(timer);
                resolve();
            };
            socket.onerror = () => {
                if (this.ws !== socket) return;
                clearTimeout(timer);
                reject(new Error(`WebSocket error connecting to ${url}`));
            };
            socket.onmessage = (event) => {
                if (this.ws !== socket) return;
                if (typeof event.data === 'string') {
                    const waiter = this._textWaiters.shift();
                    if (waiter) waiter.resolve(event.data);
                } else {
                    this.onBinary?.(new Uint8Array(event.data));
                }
            };
            socket.onclose = () => {
                if (this.ws !== socket) return;
                clearTimeout(timer);
                this.ws = null;
                this._rejectWaiters(new Error('WebSocket closed'));
                this.onClose?.();
            };

            this.ws = socket;
        });
    }

    disconnect() {
        const socket = this.ws;
        if (!socket) return;
        // Detach before closing so onClose is not reported for a
        // user-initiated disconnect.
        this.ws = null;
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        try {
            socket.close();
        } catch (e) { /* already closed */ }
        this._rejectWaiters(new Error('WebSocket closed'));
    }

    send(data) {
        if (!this.isConnected) throw new Error('WebSocket not connected');
        this.ws.send(data);
    }

    /** Sends a text command and resolves with the next text frame. */
    request(text, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const waiter = {};
            const timer = setTimeout(() => {
                const index = this._textWaiters.indexOf(waiter);
                if (index >= 0) this._textWaiters.splice(index, 1);
                reject(new Error('Timed out waiting for server reply'));
            }, timeoutMs);
            waiter.resolve = (value) => {
                clearTimeout(timer);
                resolve(value);
            };
            waiter.reject = (err) => {
                clearTimeout(timer);
                reject(err);
            };
            this._textWaiters.push(waiter);
            try {
                this.send(text);
            } catch (e) {
                const index = this._textWaiters.indexOf(waiter);
                if (index >= 0) this._textWaiters.splice(index, 1);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    async login(token) {
        return (await this.request(`login~~${token}`)) === 'success';
    }

    /** Returns the new account token, or null if creation failed. */
    async create(name, email) {
        const reply = await this.request(`create~~${name}~~${email}`);
        if (!reply.startsWith('success~~')) return null;
        return reply.substring('success~~'.length);
    }

    _rejectWaiters(err) {
        for (const waiter of this._textWaiters.splice(0)) {
            waiter.reject(err);
        }
    }
}
