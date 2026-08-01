import {WebSocket, WebSocketServer} from 'ws';

import Player from './player.mjs';
import {Interface, MapLocation, PlayerStatus} from './proto.mjs';
import Teleporter from './teleporter.mjs';
import {capUpdate} from './update_cap.mjs';
import {createWebServer} from './web.mjs';
import worldObjectTracker from './world_object_tracker.mjs';

const PORT = process.env.PORT || 8080;
const PORT_WEB = process.env.PORT_WEB || 8081;

const TICK_INTERVAL_MS = 1000 / 5;

// Map of connection key to session info.
const clientList = new Map();
let nextConnectionId = 1;

const wss = new WebSocketServer({port: PORT, maxPayload: 1024});

wss.on('connection', (ws) => {
  const clientKey = `ws#${nextConnectionId++}`;

  ws.on('message', (data) => {
    handleMessage(clientKey, ws, Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  ws.on('close', () => {
    if (clientList.has(clientKey)) {
      removePlayer(clientKey);
    }
  });
  ws.on('error', (err) => {
    console.log(`Error from ${clientKey}`, err);
  });
});

async function handleMessage(clientKey, ws, message) {
  const client = clientList.get(clientKey);
  if (message.toString().startsWith('login~~')) {
    if (client == undefined) {
      const playerToken = message.toString().replace(/^login~~/, '').trim();

      const player = await Player.load(playerToken);
      if (player == null) {
        ws.send('failed');
        return;
      }

      ws.send('success');

      // Remove any other instances of that player from the client list.
      for (const [otherKey, other] of clientList) {
        if (other.player.playerToken == playerToken) {
          removePlayer(otherKey);
        }
      }

      clientList.set(clientKey, {
        'ws': ws,
        'lastSeen': new Date(),
        'player': player
      });
    }
  } else if (message.toString().startsWith('create~~')) {
    const [username, email] =
        message.toString().replace(/^create~~/, '').trim().split('~~');
    const cookie = await Player.create(username, email);
    ws.send(`success~~${cookie}`);
  } else {
    try {
      const p = decodePlayerStatus(message);
      client.player.updateWithStatus(p);

      clientList.get(clientKey).lastSeen = new Date();
    } catch (e) {
      console.log('Error processing: ', message.toString('hex'), e);
    }
  }
}

// The GBA packs PlayerStatus into 32-bit link words, so up to 3 stale
// padding bytes can trail the message. protobufjs 6 skipped them; 8 rejects
// them, so retry with the tail trimmed.
function decodePlayerStatus(message) {
  for (let trim = 0;; trim++) {
    try {
      return PlayerStatus.decode(message.subarray(0, message.length - trim));
    } catch (e) {
      if (trim >= 3 || trim >= message.length) {
        throw e;
      }
    }
  }
}

const teleporters = new Map();
teleporters.set(MapLocation.values.TOWN, [
  new Teleporter(
      432, 240, 32, 32, MapLocation.values.TOWN, MapLocation.values.VAR_ROCK,
      200, 224),
  new Teleporter(
      432, 344, 32, 32, MapLocation.values.TOWN,
      MapLocation.values.LUMBER_RIDGE, 256, 224),
]);
teleporters.set(MapLocation.values.VAR_ROCK, [
  new Teleporter(
      144, 224, 32, 32, MapLocation.values.VAR_ROCK, MapLocation.values.TOWN,
      392, 232),
]);
teleporters.set(MapLocation.values.LUMBER_RIDGE, [
  new Teleporter(
      248, 192, 32, 32, MapLocation.values.LUMBER_RIDGE,
      MapLocation.values.TOWN, 392, 336),
]);

// Log users out after 1 minute of no received messages.
const LOGOUT_LIMIT_MS = 1 * 60 * 1000;

setInterval(() => {
  worldObjectTracker.tick();
  const worldObjects = worldObjectTracker.getWorldObjects();

  for (const [clientKey, clientInfo] of clientList) {
    if ((new Date() - clientInfo.lastSeen) > LOGOUT_LIMIT_MS) {
      removePlayer(clientKey);
      continue;
    }

    const player = clientInfo.player;
    player.tick();

    teleporters.get(player.currentMap).forEach(teleporter => {
      teleporter.tick(player);
    });

    const updateObject = {
      worldObject: worldObjects.get(player.currentMap)
                       .filter(
                           worldObject => worldObject.objectId !=
                               player.worldObject.objectId),
      removedWorldObjectIds: worldObjectTracker.availableIds,
      currentMap: player.currentMap,
      inventory: player.inventory,
    };
    if (player.message != '') {
      updateObject.networkMessage = player.message;
      player.message = '';
    }
    if (player.interface != undefined) {
      updateObject.launchInterface = player.interface;
      switch (player.interface) {
        case Interface.values.BANK:
          player.bankChanged = true;
          break;
      }
      player.interface = undefined;
    }
    if (player.hasSkillUpdate) {
      updateObject.skillStats = player.getSkillStats();
      player.hasSkillUpdate = false;
    }
    if (player.hasPositionUpdate) {
      updateObject.playerStatus = player.getPositionUpdate();
      player.hasPositionUpdate = false;
    }
    if (player.resourceInteraction != undefined) {
      updateObject.interactingSkill = player.resourceInteraction.skillType;
    }
    if (player.bankChanged) {
      updateObject.bank = player.encodeBank();
      player.bankChanged = false;
    }
    if (player.coinsChanged) {
      updateObject.coinCount = player.coins;
      player.coinsChanged = false;
    }

    const update = capUpdate(updateObject);

    if (clientInfo.ws.readyState === WebSocket.OPEN) {
      clientInfo.ws.send(update);
    }
  }
}, TICK_INTERVAL_MS);

wss.on('listening', () => {
  console.log(`GBA MMO server: WebSocket at ws://localhost:${PORT}`);
});

createWebServer().listen(PORT_WEB, () => {
  console.log(`GBA MMO server: web client at http://localhost:${PORT_WEB}/`);
});

function removePlayer(clientKey) {
  const client = clientList.get(clientKey);
  if (client == undefined) {
    return;
  }
  clientList.delete(clientKey);
  client.player.logout();
  client.ws.close();
}
