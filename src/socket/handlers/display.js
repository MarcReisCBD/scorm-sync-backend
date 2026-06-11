const roomService = require('../../services/roomService');
const { ROOM_STATUS } = require('../../utils/constants');
const logger = require('../../utils/logger');

const VOTE_TIMER_SECONDS = parseInt(process.env.VOTE_TIMER_SECONDS || '45', 10);

function registerDisplayHandlers(io, socket) {
  const { user } = socket.data;
  const roomId = user && user.roomId;

  if (!roomId) {
    logger.warn('[display] No roomId in token, disconnecting');
    socket.disconnect(true);
    return;
  }

  socket.join(`room:${roomId}`);
  socket.data.roomId = roomId;
  logger.info('[display] Joined room as observer', { roomId });

  // Snapshot immédiat — l'écran de diffusion peut s'ouvrir après que des apprenants sont connectés
  roomService.getRoomById(roomId).then(function(room) {
    if (!room) return;
    const names = room.learnerNames || {};
    socket.emit('waiting_update', {
      syncPoint: room.currentSyncPoint,
      waiting:   room.waitingLearners.length,
      total:     room.totalLearners,
      learners:  room.waitingLearners.map(function(id) { return { id, name: names[id] || 'Apprenant' }; }),
    });
    if (room.currentQuestionData) {
      socket.emit('question_data', room.currentQuestionData);
    }
    if (room.status === ROOM_STATUS.VOTE) {
      socket.emit('vote_open', {
        syncPoint:    room.currentSyncPoint,
        timerSeconds: VOTE_TIMER_SECONDS,
        isSecondVote: room.vote1Results !== null,
        questionData: room.currentQuestionData || null,
      });
    }
  }).catch(function(err) {
    logger.error('[display] snapshot error', { err: err.message });
  });
}

module.exports = { registerDisplayHandlers };
