const roomService = require('./roomService');
const { VOTE_VALUES, ROOM_STATUS } = require('../utils/constants');
const logger = require('../utils/logger');

const VOTE_TIMER_MS = parseInt(process.env.VOTE_TIMER_SECONDS || '45', 10) * 1000;

// Map<roomId, { timer: Timeout, onExpire: Function }>
const activeTimers = new Map();

function clearTimer(roomId) {
  if (activeTimers.has(roomId)) {
    clearTimeout(activeTimers.get(roomId).timer);
    activeTimers.delete(roomId);
  }
}

async function openVote(roomId, phase = 1, { onExpire, syncPoint } = {}) {
  clearTimer(roomId);

  // Read room first to log state and get fallback syncPoint
  const currentRoom = await roomService.getRoomById(roomId);
  const effectiveSyncPoint = syncPoint || (currentRoom && currentRoom.currentSyncPoint) || null;
  const qd = currentRoom && currentRoom.currentQuestionData;
  logger.info('[openVote]', {
    roomId, phase,
    syncPointReceived: syncPoint,
    effectiveSyncPoint,
    hasQuestionData: !!qd,
    currentQuestionData_keys: qd ? Object.keys(qd) : null,
    multipleCorrect: qd ? qd.multipleCorrect : 'NO_QD',
  });

  const updates = {
    status: ROOM_STATUS.VOTE,
    votes: { A: 0, B: 0, C: 0, D: 0 },
    votePhase: phase,
    voteOpenedAt: Date.now(),
    ...(phase === 1 ? { vote1Results: null } : {}),
    ...(effectiveSyncPoint !== null ? { currentSyncPoint: effectiveSyncPoint } : {}),
  };
  const room = await roomService.updateRoom(roomId, updates);

  const timer = setTimeout(async () => {
    activeTimers.delete(roomId);
    logger.info('Vote timer expired', { roomId, phase });
    if (onExpire) await onExpire(roomId);
  }, VOTE_TIMER_MS);

  activeTimers.set(roomId, { timer, onExpire });
  logger.info('Vote opened', { roomId, phase });
  return room;
}

async function submitVote(roomId, value) {
  // value peut être une lettre 'A' ou un tableau ['A','C'] (réponses multiples)
  const values = Array.isArray(value) ? value : [value];
  if (!values.every(v => VOTE_VALUES.includes(v))) {
    throw new Error(`Invalid vote value: ${JSON.stringify(value)}`);
  }
  const room = await roomService.getRoomById(roomId);
  if (!room) throw new Error(`Room ${roomId} not found`);
  if (room.status !== ROOM_STATUS.VOTE) throw new Error('No active vote');

  const votes = { ...room.votes };
  values.forEach(v => { votes[v] = (votes[v] || 0) + 1; });
  return roomService.updateRoom(roomId, { votes });
}

async function closeVote(roomId) {
  clearTimer(roomId);
  const room = await roomService.getRoomById(roomId);
  if (!room) throw new Error(`Room ${roomId} not found`);
  return roomService.updateRoom(roomId, { status: ROOM_STATUS.RESULT });
}

async function saveVote1Results(roomId) {
  const room = await roomService.getRoomById(roomId);
  if (!room) throw new Error(`Room ${roomId} not found`);
  return roomService.updateRoom(roomId, {
    vote1Results: { ...room.votes },
    votes: { A: 0, B: 0, C: 0, D: 0 },
  });
}

function extendTimer(roomId, extraSeconds) {
  const entry = activeTimers.get(roomId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  const timer = setTimeout(async () => {
    activeTimers.delete(roomId);
    if (entry.onExpire) await entry.onExpire(roomId);
  }, extraSeconds * 1000);
  activeTimers.set(roomId, { ...entry, timer });
  return true;
}

module.exports = { openVote, submitVote, closeVote, saveVote1Results, extendTimer, clearTimer };
