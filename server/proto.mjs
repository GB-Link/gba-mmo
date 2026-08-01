import {fileURLToPath} from 'node:url';
import protobuf from 'protobufjs';

// Message definitions vendored from https://github.com/maciel310/gba-mmo-protos
// (MIT). Override the location with GBA_MMO_PROTOS_DIR.
const protosDir = process.env.GBA_MMO_PROTOS_DIR ||
    fileURLToPath(new URL('../protos', import.meta.url));

const root = protobuf.loadSync([
  `${protosDir}/world_object.proto`,
  `${protosDir}/network_messages.proto`
]);
const ServerUpdate = root.lookupType('ServerUpdate');
const PlayerStatus = root.lookupType('PlayerStatus');
const SkillStats = root.lookupType('SkillStats');
const Direction = root.lookupEnum('Direction');
const SpriteSize = root.lookupEnum('SpriteSize');
const Skill = root.lookupEnum('Skill');
const MapLocation = root.lookupEnum('MapLocation');
const Item = root.lookupEnum('Item');
const Interface = root.lookupEnum('Interface');

export {
  ServerUpdate,
  PlayerStatus,
  Direction,
  SpriteSize,
  SkillStats,
  Skill,
  MapLocation,
  Item,
  Interface,
};
