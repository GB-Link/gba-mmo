/**
 * Relay between the multibooted GBA MMO ROM and the WebSocket server — a
 * port of the Raspberry Pi client's loop (client/main.c) to the GB-Link
 * adapter driven in GB mode with 4-byte chunks (32-bit SIO words).
 *
 * Wire protocol with the ROM (source/serial.c), all words big-endian:
 *   server -> GBA:  0xBEEF0000|(payloadLen+4), payload 4B/word, 0xDEADBEEF
 *   GBA -> server:  0x000000WW word count, then WW words of PlayerStatus
 *   idle:           0x00000000 both directions
 *
 * The ROM is a 32-bit SIO slave with a one-transfer response lag; the echo
 * stream is demuxed statefully across exchanges, mirroring the Pi's
 * transfer() loop.
 */

// 14 words = 56 bytes per USB transfer, under the 64-byte endpoint packet
// size, and the firmware clocks/echoes strictly one batch at a time.
const BATCH_WORDS = 14;

// The ROM's receive buffer is 512 bytes and the length word counts
// payload + 4 terminator bytes.
const MAX_PAYLOAD = 508;

// The ROM sends at most 7 words per PlayerStatus; a larger count word is
// garbage and gets dropped so the demux resyncs.
const MAX_UP_WORDS = 8;

// Idle words clocked per poll: response lag + count word + a maximal
// 7-word PlayerStatus, with slack; still a single USB batch.
const IDLE_POLL_WORDS = 12;

const QUEUE_WARN = 5;
const QUEUE_STOP = 50;

export class BridgeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
    }
}

export class Bridge {
    constructor(usb, ws, options = {}) {
        this.usb = usb;
        this.ws = ws;
        this.idlePollMs = options.idlePollMs ?? 0;   // 0 disables idle polling
        this.log = options.log ?? (() => {});
        this.onStats = options.onStats ?? null;

        this.running = false;
        this.stats = {
            down: 0, downBytes: 0,
            up: 0, upBytes: 0,
            junk: 0, oversized: 0, queuePeak: 0,
        };

        this._queue = [];
        this._wake = null;
        this._stopReason = null;
        this._warnedDepth = false;

        // Demux state for the GBA -> server direction.
        this._expected = 0;
        this._collected = [];
    }

    get queueDepth() {
        return this._queue.length;
    }

    /** Queues one ServerUpdate payload for delivery to the GBA. */
    enqueue(payload) {
        if (!this.running) return;
        if (payload.length > MAX_PAYLOAD) {
            this.stats.oversized++;
            this.log(`Refused oversized ${payload.length}B server update`, 'error');
            return;
        }
        this._queue.push(payload);
        if (this._queue.length > this.stats.queuePeak) {
            this.stats.queuePeak = this._queue.length;
        }
        if (this._queue.length >= QUEUE_STOP) {
            this.log(`Bridge fell behind (${this._queue.length} queued updates), stopping`, 'error');
            this.stop('fell-behind');
            return;
        }
        if (this._queue.length >= QUEUE_WARN) {
            if (!this._warnedDepth) {
                this._warnedDepth = true;
                this.log(`Bridge running behind: ${this._queue.length} updates queued`, 'info');
            }
        } else {
            this._warnedDepth = false;
        }
        this._wake?.();
    }

    /**
     * Pumps until stop() is called; resolves with the stop reason. Throws
     * BridgeError('usb-timeout') if the GBA link stops responding.
     */
    async run() {
        this.running = true;
        this._stopReason = null;
        try {
            while (this.running) {
                const payload = await this._nextPayload();
                if (!this.running) break;

                if (payload === null) {
                    // Idle poll: drain any pending PlayerStatus between ticks.
                    await this._exchangeWords(new Array(IDLE_POLL_WORDS).fill(0));
                    continue;
                }

                await this._exchangeWords(this._buildWords(payload));
                this.stats.down++;
                this.stats.downBytes += payload.length;

                if (this._queue.length > 0) {
                    // The ROM decodes the update inside its serial ISR on the
                    // terminator word; two expendable idle words keep the next
                    // header out of that window.
                    await this._exchangeWords([0, 0]);
                }
                this.onStats?.(this.stats);
            }
        } finally {
            this.running = false;
            this._wake?.();
        }
        return this._stopReason ?? 'stopped';
    }

    stop(reason = 'stopped') {
        if (this._stopReason === null) this._stopReason = reason;
        this.running = false;
        this._wake?.();
    }

    _nextPayload() {
        if (this._queue.length > 0) {
            return Promise.resolve(this._queue.shift());
        }
        return new Promise((resolve) => {
            let timer = null;
            this._wake = () => {
                if (timer !== null) clearTimeout(timer);
                this._wake = null;
                resolve(this._queue.length > 0 ? this._queue.shift() : null);
            };
            if (this.idlePollMs > 0) {
                timer = setTimeout(() => {
                    this._wake = null;
                    resolve(null);
                }, this.idlePollMs);
            }
        });
    }

    _buildWords(payload) {
        const wordCount = Math.ceil(payload.length / 4);
        const words = new Array(wordCount + 2);
        words[0] = (0xBEEF0000 | (payload.length + 4)) >>> 0;
        for (let w = 0; w < wordCount; w++) {
            const i = w * 4;
            words[w + 1] = (((payload[i] ?? 0) << 24) |
                ((payload[i + 1] ?? 0) << 16) |
                ((payload[i + 2] ?? 0) << 8) |
                (payload[i + 3] ?? 0)) >>> 0;
        }
        words[wordCount + 1] = 0xDEADBEEF;
        return words;
    }

    /**
     * Clocks words through the adapter in <=14-word batches, strictly one
     * batch in flight, and feeds every echoed word through the demux.
     */
    async _exchangeWords(words) {
        for (let i = 0; i < words.length; i += BATCH_WORDS) {
            const slice = words.slice(i, i + BATCH_WORDS);
            const tx = new Uint8Array(slice.length * 4);
            for (let w = 0; w < slice.length; w++) {
                const val = slice[w];
                tx[w * 4] = (val >>> 24) & 0xFF;
                tx[w * 4 + 1] = (val >>> 16) & 0xFF;
                tx[w * 4 + 2] = (val >>> 8) & 0xFF;
                tx[w * 4 + 3] = val & 0xFF;
            }
            await this.usb.writeBytes(tx);

            const expected = tx.length;
            const rx = new Uint8Array(expected);
            let got = 0;
            while (got < expected) {
                const chunk = await this.usb.readBytesRaw(expected - got, 2000);
                if (!chunk || chunk.length === 0) {
                    throw new BridgeError('usb-timeout',
                        `GBA link not responding (${got}/${expected} echo bytes)`);
                }
                if (chunk.length > expected - got) {
                    this.stats.junk++;
                }
                rx.set(chunk.subarray(0, expected - got), got);
                got += chunk.length;
            }

            for (let w = 0; w < slice.length; w++) {
                const o = w * 4;
                this._feedEcho(((rx[o] << 24) | (rx[o + 1] << 16) |
                    (rx[o + 2] << 8) | rx[o + 3]) >>> 0);
            }
        }
    }

    /** Port of the Pi demux (client/main.c transfer()). */
    _feedEcho(word) {
        if (this._expected === 0) {
            if (word === 0) return;
            if (word > MAX_UP_WORDS) {
                this.stats.junk++;
                return;
            }
            this._expected = word;
            this._collected.length = 0;
            return;
        }

        this._collected.push((word >>> 24) & 0xFF, (word >>> 16) & 0xFF,
            (word >>> 8) & 0xFF, word & 0xFF);

        if (this._collected.length >= this._expected * 4) {
            // Trailing bytes of the last word may be stale ROM buffer content;
            // sent as-is, as the Pi did. The server tolerates them.
            const payload = Uint8Array.from(this._collected);
            this._expected = 0;
            this._collected.length = 0;
            this.stats.up++;
            this.stats.upBytes += payload.length;
            try {
                this.ws.send(payload);
            } catch (e) {
                this.log(`Upstream send failed: ${e.message}`, 'error');
            }
        }
    }
}
