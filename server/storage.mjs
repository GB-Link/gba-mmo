import {fileURLToPath} from 'node:url';
import storage from 'node-persist';

// Pin the storage directory next to the server code so the account database
// does not depend on the process working directory.
const storageInit = storage.init(
    {dir: fileURLToPath(new URL('.node-persist/storage', import.meta.url))});


async function getPlayer(playerToken) {
  return getItem(`player/${playerToken}`);
}

async function setPlayer(playerToken, value) {
  return setItem(`player/${playerToken}`, value);
}

async function getItem(key) {
  await storageInit;
  return await storage.getItem(key);
}

async function setItem(key, value) {
  await storageInit;
  await storage.setItem(key, value);
}

export {getPlayer, setPlayer};