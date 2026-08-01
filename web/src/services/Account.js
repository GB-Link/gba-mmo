/**
 * Account token storage: one bearer token per server URL, in localStorage.
 */
import { WsClient } from './WsClient.js';

const STORAGE_PREFIX = 'gbammo.token.';

export function loadToken(serverUrl) {
    return localStorage.getItem(STORAGE_PREFIX + serverUrl);
}

export function saveToken(serverUrl, token) {
    localStorage.setItem(STORAGE_PREFIX + serverUrl, token);
}

export function clearToken(serverUrl) {
    localStorage.removeItem(STORAGE_PREFIX + serverUrl);
}

/** Creates an account over a short-lived connection; stores and returns the token. */
export async function createAccount(serverUrl, name, email) {
    const ws = new WsClient();
    await ws.connect(serverUrl);
    try {
        const token = await ws.create(name, email);
        if (!token) throw new Error('Account creation failed');
        saveToken(serverUrl, token);
        return token;
    } finally {
        ws.disconnect();
    }
}
