const { randomUUID } = require('crypto');
const redis = require('./redisService');
const { ROOM_STATUS } = require('../utils/constants');
const logger = require('../utils/logger');

const TTL = parseInt(process.env.ROOM_TTL_SECONDS || '14400', 10);

const ANIMALS = ['TIGRE', 'AIGLE', 'LOUP', 'OURS', 'RENARD', 'LYNX', 'BISON', 'COBRA', 'GECKO', 'IBIS'];

const roomKey = (id) => `room:${id}`;
const codeKey = (code) => `room:code:${code}`;

function generateCode() {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${animal}-${num}`;
}

async function createRoom({ trainerId, moduleId, totalLearners = 0 }) {
  const id = randomUUID();
  let code;
  for (let i = 0; i < 10; i++) {
    const candidate = generateCode();
    const existing = await redis.getJSON(codeKey(candidate));
    if (!existing) { code = candidate; break; }
  }
  if (!code) code = `ROOM-${id.slice(0, 6).toUpperCase()}`;

  const now = new Date().toISOString();
  const room = {
    id,
    code,
    trainerId,
    moduleId,
    totalLearners,
    status: ROOM_STATUS.WAITING,
    currentSyncPoint: null,
    waitingLearners: [],
    votes: { A: 0, B: 0, C: 0, D: 0 },
    vote1Results: null,
    createdAt: now,
    updatedAt: now,
  };

  await redis.setJSON(roomKey(id), room, TTL);
  await redis.setJSON(codeKey(code), id, TTL);
  logger.info('Room created', { id, code });
  return room;
}

async function getRoomById(id) {
  return redis.getJSON(roomKey(id));
}

async function getRoomByCode(code) {
  const id = await redis.getJSON(codeKey(code));
  if (!id) return null;
  return redis.getJSON(roomKey(id));
}

async function updateRoom(id, updates) {
  const room = await getRoomById(id);
  if (!room) throw new Error(`Room ${id} not found`);
  const updated = { ...room, ...updates, updatedAt: new Date().toISOString() };
  await redis.setJSON(roomKey(id), updated, TTL);
  return updated;
}

async function closeRoom(id) {
  const room = await getRoomById(id);
  if (!room) return;
  await updateRoom(id, { status: ROOM_STATUS.CLOSED });
  await redis.del(codeKey(room.code));
  logger.info('Room closed', { id });
}

module.exports = { createRoom, getRoomById, getRoomByCode, updateRoom, closeRoom };
