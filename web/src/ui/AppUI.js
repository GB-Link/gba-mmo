import { UsbConnection, MODE } from '../services/UsbConnection.js';
import { SerialConnection } from '../services/SerialConnection.js';
import { multiboot } from '../services/Multiboot.js';
import { WsClient } from '../services/WsClient.js';
import { Bridge } from '../services/Bridge.js';
import * as Account from '../services/Account.js';

const SETTINGS_KEY = 'gbammo.settings';
const ROM_PATH = 'data/gba-mmo_mb.gba';
const PRODUCTION_SERVER_URL = 'wss://gbammoserver.gblink.io';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultServerUrl() {
    // A plain-http page implies the bundled dev server (WebUSB requires a
    // secure context); its WebSocket listens on port 8080.
    if (location.protocol === 'http:') {
        return `ws://${location.hostname}:8080`;
    }
    return PRODUCTION_SERVER_URL;
}

export class AppUI {
    constructor() {
        this.el = {};
        for (const id of ['btn-settings', 'btn-settings-close', 'settings-overlay',
                'btn-theme', 'btn-connect', 'adapter-status',
                'server-url', 'account-status', 'account-ready', 'account-setup',
                'create-name', 'create-email', 'btn-create',
                'create-overlay', 'btn-create-confirm', 'btn-create-cancel',
                'token-input', 'btn-use-token', 'btn-copy-token',
                'btn-new-character', 'btn-forget', 'forget-overlay',
                'btn-forget-confirm', 'btn-forget-cancel',
                'btn-multiboot', 'btn-already',
                'btn-start', 'game-status', 'stats-line', 'log-container',
                'set-usgap', 'set-idlepoll', 'set-idlems', 'browser-warning']) {
            this.el[id] = document.getElementById(id);
        }

        this.usb = null;
        this.romData = null;
        this.multibooted = false;
        // True once the firmware entered GB mode this session (multiboot's
        // setup does it). SetMode glitches the SC line, which permanently
        // desyncs an armed 32-bit slave SIO, so it is never reissued after
        // the game has booted.
        this.gbModeActive = false;
        this.bridge = null;
        this.ws = null;
        this.bridgeRunning = false;
        this.busy = false;
        // Keeps the create/import forms visible after the user confirmed the
        // replace-character warning, even though a token is already saved.
        this.setupRevealed = false;
        this._lastStatsRender = 0;

        this.settings = this.loadSettings();
        this.el['server-url'].value = this.settings.serverUrl;
        this.el['set-usgap'].value = this.settings.usGap;
        this.el['set-idlepoll'].checked = this.settings.idlePoll;
        this.el['set-idlems'].value = this.settings.idleMs;

        if (localStorage.getItem('gbammo.lightMode') === '1') {
            document.body.classList.add('light-mode');
        }

        const hasUsb = !!navigator.usb;
        const hasSerial = !!navigator.serial;
        this.transport = hasUsb ? 'usb' : (hasSerial ? 'serial' : null);
        if (this.transport === null) {
            this.el['browser-warning'].classList.add('show');
            this.el['btn-connect'].disabled = true;
        } else if (this.transport === 'serial') {
            this.el['btn-connect'].textContent = 'Connect Serial';
        }

        this.bindEvents();
        this.refreshAccountPanels();
        this.updateButtons();
        this.loadRom();
    }

    bindEvents() {
        this.el['btn-theme'].addEventListener('click', () => {
            document.body.classList.toggle('light-mode');
            localStorage.setItem('gbammo.lightMode',
                document.body.classList.contains('light-mode') ? '1' : '0');
        });
        this.el['btn-settings'].addEventListener('click', () => {
            this.el['settings-overlay'].classList.add('show');
        });
        this.bindOverlayClose('settings-overlay', 'btn-settings-close');
        this.bindOverlayClose('forget-overlay', 'btn-forget-cancel');
        this.bindOverlayClose('create-overlay', 'btn-create-cancel');

        this.el['btn-connect'].addEventListener('click', () => this.connectAdapter());
        this.el['btn-create'].addEventListener('click', () => this.createAccount());
        this.el['btn-create-confirm'].addEventListener('click', () => {
            this.el['create-overlay'].classList.remove('show');
            this.setupRevealed = true;
            this.refreshAccountPanels();
            this.el['create-name'].focus();
        });
        this.el['btn-use-token'].addEventListener('click', () => this.useToken());
        this.el['btn-copy-token'].addEventListener('click', () => this.copyToken());
        this.el['btn-new-character'].addEventListener('click', () => {
            this.el['create-overlay'].classList.add('show');
        });
        this.el['btn-forget'].addEventListener('click', () => {
            this.el['forget-overlay'].classList.add('show');
        });
        this.el['btn-forget-confirm'].addEventListener('click', () => {
            this.el['forget-overlay'].classList.remove('show');
            Account.clearToken(this.serverUrl());
            this.el['token-input'].value = '';
            this.setupRevealed = false;
            this.log('Token forgotten for this server');
            this.refreshAccountPanels();
            this.updateButtons();
        });
        this.el['btn-multiboot'].addEventListener('click', () => this.sendMultiboot());
        this.el['btn-already'].addEventListener('click', () => this.alreadyLoaded());
        this.el['btn-start'].addEventListener('click', () => {
            if (this.bridgeRunning) {
                this.bridge?.stop('stopped');
            } else {
                this.startGame();
            }
        });
        this.el['server-url'].addEventListener('change', () => {
            this.settings.serverUrl = this.serverUrl();
            this.saveSettings();
            this.setupRevealed = false;
            this.refreshAccountPanels();
            this.updateButtons();
        });
        this.el['set-usgap'].addEventListener('change', () => {
            this.settings.usGap = Math.max(36,
                Math.min(50000, Number(this.el['set-usgap'].value) || 1000));
            this.el['set-usgap'].value = this.settings.usGap;
            this.saveSettings();
        });
        this.el['set-idlepoll'].addEventListener('change', () => {
            this.settings.idlePoll = this.el['set-idlepoll'].checked;
            this.saveSettings();
        });
        this.el['set-idlems'].addEventListener('change', () => {
            this.settings.idleMs = Math.max(10,
                Math.min(1000, Number(this.el['set-idlems'].value) || 50));
            this.el['set-idlems'].value = this.settings.idleMs;
            this.saveSettings();
        });
    }

    bindOverlayClose(overlayId, closeButtonId) {
        const overlay = this.el[overlayId];
        this.el[closeButtonId].addEventListener('click', () => {
            overlay.classList.remove('show');
        });
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                overlay.classList.remove('show');
            }
        });
    }

    loadSettings() {
        const defaults = {
            serverUrl: defaultServerUrl(),
            usGap: 100,
            idlePoll: true,
            idleMs: 50,
        };
        try {
            return {...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')};
        } catch (e) {
            return defaults;
        }
    }

    saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    }

    serverUrl() {
        return this.el['server-url'].value.trim().replace(/\/+$/, '') ||
            defaultServerUrl();
    }

    log(message, level = '') {
        const container = this.el['log-container'];
        const entry = document.createElement('div');
        entry.className = `log-entry${level ? ` ${level}` : ''}`;
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${message}`;
        container.appendChild(entry);
        while (container.children.length > 500) {
            container.removeChild(container.firstChild);
        }
        container.scrollTop = container.scrollHeight;
    }

    setStatus(element, text, connected) {
        element.textContent = text;
        element.className = `status ${connected ? 'connected' : 'disconnected'}`;
    }

    async loadRom() {
        try {
            const response = await fetch(ROM_PATH, {cache: 'no-store'});
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.romData = await response.arrayBuffer();
            let build = '';
            if (crypto.subtle) {
                const hash = await crypto.subtle.digest('SHA-256', this.romData);
                build = ` (build ${[...new Uint8Array(hash)].slice(0, 4)
                    .map(b => b.toString(16).padStart(2, '0')).join('')})`;
            }
            this.log(`ROM loaded: ${(this.romData.byteLength / 1024).toFixed(1)} KB${build}`);
        } catch (e) {
            this.log(`Could not load ${ROM_PATH}: ${e.message}. Serve this page ` +
                'with "node server/index.mjs" from the gba-mmo repo.', 'error');
        }
        this.updateButtons();
    }

    async connectAdapter() {
        if (this.usb?.isConnected) return;
        try {
            this.usb = this.transport === 'usb' ? new UsbConnection() : new SerialConnection();
            await this.usb.connect();
            await this.usb.setVoltage('3v3');
            this.setStatus(this.el['adapter-status'], 'Connected', true);
            this.log('Adapter connected (3.3V)', 'success');
        } catch (e) {
            this.usb = null;
            this.setStatus(this.el['adapter-status'], 'Disconnected', false);
            this.log(`Adapter connection failed: ${e.message}`, 'error');
        }
        this.updateButtons();
    }

    async createAccount() {
        if (!this.usb?.isConnected) {
            this.log('Connect the adapter before creating an account', 'error');
            return;
        }
        if (Account.loadToken(this.serverUrl()) && !this.setupRevealed) {
            this.el['create-overlay'].classList.add('show');
            return;
        }
        const name = this.el['create-name'].value.trim();
        const email = this.el['create-email'].value.trim();
        if (!name) {
            this.log('Enter a character name first', 'error');
            return;
        }
        if (name.includes('~~') || email.includes('~~')) {
            this.log('Name/email must not contain "~~"', 'error');
            return;
        }
        this.busy = true;
        this.updateButtons();
        try {
            await Account.createAccount(this.serverUrl(), name, email);
            this.setupRevealed = false;
            this.el['create-name'].value = '';
            this.el['create-email'].value = '';
            this.log(`Account "${name}" created — token saved for this server`, 'success');
        } catch (e) {
            this.log(`Account creation failed: ${e.message}`, 'error');
        } finally {
            this.busy = false;
            this.refreshAccountPanels();
            this.updateButtons();
        }
    }

    useToken() {
        const token = this.el['token-input'].value.trim();
        if (!token) {
            this.log('Paste a token first', 'error');
            return;
        }
        if (Account.loadToken(this.serverUrl()) && !this.setupRevealed) {
            this.el['create-overlay'].classList.add('show');
            return;
        }
        Account.saveToken(this.serverUrl(), token);
        this.setupRevealed = false;
        this.el['token-input'].value = '';
        this.log('Token saved for this server', 'success');
        this.refreshAccountPanels();
        this.updateButtons();
    }

    async copyToken() {
        const token = Account.loadToken(this.serverUrl());
        if (!token) return;
        try {
            await navigator.clipboard.writeText(token);
            this.log('Token copied to clipboard — store it somewhere safe', 'success');
        } catch (e) {
            this.setupRevealed = true;
            this.refreshAccountPanels();
            this.el['token-input'].value = token;
            this.el['token-input'].select();
            this.log('Clipboard unavailable — token shown in the field below, copy it manually', 'info');
        }
    }

    refreshAccountPanels() {
        const token = Account.loadToken(this.serverUrl());
        this.setStatus(this.el['account-status'],
            token ? 'Character ready' : 'No account token', !!token);
        this.el['account-ready'].classList.toggle('hidden', !token);
        this.el['account-setup'].classList.toggle('hidden',
            !!token && !this.setupRevealed);
    }

    async sendMultiboot() {
        if (!this.usb?.isConnected || !this.romData || this.busy || this.bridgeRunning) return;
        this.busy = true;
        this.updateButtons();
        try {
            await this.usb.setVoltage('3v3');
            const ok = await multiboot(this.usb, this.romData, (m, level) => this.log(m, level));
            if (ok) {
                this.multibooted = true;
                this.gbModeActive = true;
                this.log('GBA is booting the game — now press Start Game', 'success');
            }
        } catch (e) {
            this.log(`Multiboot failed: ${e.message}`, 'error');
        } finally {
            this.busy = false;
            this.updateButtons();
        }
    }

    async alreadyLoaded() {
        if (!this.usb?.isConnected || this.busy || this.bridgeRunning) return;
        if (!this.gbModeActive) {
            this.log('Assuming the game is already running on the GBA. If it fails ' +
                'to connect, power-cycle the GBA and use Send Multiboot.', 'info');
            await this.usb.setMode(MODE.GB_LINK);
            await delay(100);
            this.gbModeActive = true;
        }
        this.multibooted = true;
        this.updateButtons();
    }

    async startGame() {
        if (!this.usb?.isConnected || !this.multibooted || this.bridgeRunning || this.busy) return;
        const serverUrl = this.serverUrl();
        const token = Account.loadToken(serverUrl);
        if (!token) {
            this.log('No account token for this server — create an account first', 'error');
            return;
        }
        this.busy = true;
        this.updateButtons();
        try {
            // Re-tune pacing only; never SetMode once the game is running.
            await this.usb.setTimingConfig(this.settings.usGap, 4);
            await delay(100);

            this.ws = new WsClient();
            await this.ws.connect(serverUrl);

            this.bridge = new Bridge(this.usb, this.ws, {
                idlePollMs: this.settings.idlePoll ? this.settings.idleMs : 0,
                log: (m, level) => this.log(m, level),
                onStats: (stats) => this.renderStats(stats),
            });
            const runPromise = this.bridge.run();
            this.ws.onBinary = (payload) => this.bridge.enqueue(payload);
            this.ws.onClose = () => {
                this.log('Server closed the connection (logged in elsewhere or idle timeout)', 'error');
                this.bridge?.stop('ws-closed');
            };

            if (!await this.ws.login(token)) {
                this.log('Login failed — this token is not known to the server. ' +
                    'Forget the token and create a new account.', 'error');
                this.bridge.stop('stopped');
                await runPromise.catch(() => {});
                this.ws.disconnect();
                this.bridge = null;
                this.ws = null;
                return;
            }

            this.log(`Logged in — relaying (word gap ${this.settings.usGap}µs, ` +
                `idle poll ${this.settings.idlePoll ? this.settings.idleMs + 'ms' : 'off'})`, 'success');
            this.bridgeRunning = true;
            this.setStatus(this.el['game-status'], 'Playing', true);
            runPromise
                .then((reason) => this.onBridgeStopped(reason))
                .catch((e) => this.onBridgeFailed(e));
        } catch (e) {
            this.log(`Start failed: ${e.message}`, 'error');
            this.bridge?.stop('stopped');
            this.ws?.disconnect();
            this.bridge = null;
            this.ws = null;
        } finally {
            this.busy = false;
            this.updateButtons();
        }
    }

    onBridgeStopped(reason) {
        this.teardownBridge();
        if (reason === 'ws-closed') {
            this.log('Disconnected. The GBA keeps running — press Start Game to reconnect.', 'info');
        } else if (reason === 'fell-behind') {
            this.log('Stopped after falling behind the server. Press Start Game to reconnect.', 'error');
        } else {
            this.log('Stopped. The GBA keeps running — press Start Game to reconnect.');
        }
    }

    onBridgeFailed(e) {
        this.teardownBridge();
        if (e.code === 'usb-timeout') {
            this.log('GBA link not responding — check the cable, then power-cycle ' +
                'the GBA and Send Multiboot again.', 'error');
        } else {
            this.log(`Bridge error: ${e.message}`, 'error');
        }
        this.setStatus(this.el['game-status'], 'Link error', false);
    }

    teardownBridge() {
        this.bridgeRunning = false;
        this.bridge = null;
        this.ws?.disconnect();
        this.ws = null;
        this.setStatus(this.el['game-status'], 'Idle', false);
        this.updateButtons();
    }

    renderStats(stats) {
        const now = Date.now();
        if (now - this._lastStatsRender < 250) return;
        this._lastStatsRender = now;
        this.el['stats-line'].textContent =
            `↓ ${stats.down} updates (${stats.downBytes} B) · ` +
            `↑ ${stats.up} statuses (${stats.upBytes} B) · ` +
            `queue ${this.bridge?.queueDepth ?? 0} (peak ${stats.queuePeak}) · ` +
            `junk ${stats.junk}`;
    }

    updateButtons() {
        const adapter = !!this.usb?.isConnected;
        const token = !!Account.loadToken(this.serverUrl());
        this.el['btn-connect'].disabled = this.transport === null || adapter || this.busy;
        this.el['btn-create'].disabled = !adapter || this.busy || this.bridgeRunning;
        this.el['btn-use-token'].disabled = this.busy || this.bridgeRunning;
        this.el['btn-copy-token'].disabled = !token;
        this.el['btn-new-character'].disabled = !adapter || this.busy || this.bridgeRunning;
        this.el['btn-forget'].disabled = !token || this.bridgeRunning;
        this.el['btn-multiboot'].disabled =
            !adapter || !this.romData || this.busy || this.bridgeRunning;
        this.el['btn-already'].disabled =
            !adapter || this.busy || this.bridgeRunning || this.multibooted;
        this.el['btn-start'].disabled =
            !adapter || !this.multibooted || !token || this.busy;
        this.el['btn-start'].textContent = this.bridgeRunning ? 'Stop' : 'Start Game';
    }
}
