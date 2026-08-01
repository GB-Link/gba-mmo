import {ServerUpdate} from './proto.mjs';

// The GBA's receive buffer is 512 bytes and the serial frame's length word
// counts payload + 4 terminator bytes, so an encoded update must never exceed
// 508 bytes. worldObject and removedWorldObjectIds are fully re-sent every
// tick, so trimming them is lossless; the edge-triggered fields (message,
// interface, skill stats, bank, coins) are never touched.
const MAX_UPDATE_BYTES = 508;

function capUpdate(updateObject) {
  let update = ServerUpdate.encode(updateObject).finish();
  if (update.length <= MAX_UPDATE_BYTES) {
    return update;
  }

  // removedWorldObjectIds aliases the tracker's live free-list; copy before
  // trimming.
  updateObject.removedWorldObjectIds = [...updateObject.removedWorldObjectIds];
  while (update.length > MAX_UPDATE_BYTES &&
         updateObject.removedWorldObjectIds.length > 0) {
    updateObject.removedWorldObjectIds.pop();
    update = ServerUpdate.encode(updateObject).finish();
  }

  while (update.length > MAX_UPDATE_BYTES &&
         updateObject.worldObject.length > 0) {
    updateObject.worldObject.pop();
    update = ServerUpdate.encode(updateObject).finish();
  }

  return update;
}

export {capUpdate, MAX_UPDATE_BYTES};
