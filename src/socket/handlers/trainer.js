const roomService = require('../../services/roomService');
const voteService = require('../../services/voteService');
const { ROOM_STATUS } = require('../../utils/constants');
const logger = require('../../utils/logger');

const VOTE_TIMER_SECONDS = parseInt(process.env.VOTE_TIMER_SECONDS || '45', 10);

// Called when vote timer expires — emits vote_result to the room
function onVoteExpire(io) {
  return async (rid) => {
    const r = await voteService.closeVote(rid);
    io.to(`room:${rid}`).emit('vote_result', {
      votes:         r.votes,
      vote1Results:  r.vote1Results,
      syncPoint:     r.currentSyncPoint,
      correctAnswer: (r.currentQuestionData && r.currentQuestionData.correct) || null,
    });
  };
}

function registerTrainerHandlers(io, socket) {
  socket.on('join_room', async ({ roomId } = {}) => {
    socket.join(`room:${roomId}`);
    socket.data.roomId = roomId;
    socket.emit('room_joined', { roomId });
  });

  socket.on('force_vote', async ({ syncPoint } = {}) => {
    const roomId = socket.data.roomId;
    logger.info('[force_vote] payload reçu', { syncPoint: syncPoint || '(null)', roomId });
    if (!roomId) return;
    try {
      const opened = await voteService.openVote(roomId, 1, { syncPoint, onExpire: onVoteExpire(io) });
      io.to(`room:${roomId}`).emit('vote_open', {
        syncPoint:    opened.currentSyncPoint,
        timerSeconds: VOTE_TIMER_SECONDS,
        isSecondVote: false,
        questionData: opened.currentQuestionData || null,
      });
    } catch (err) {
      logger.error('force_vote error', { err: err.message });
      socket.emit('error', { message: err.message });
    }
  });

  // doubleVote: true  → save results, open debate phase (debate_open)
  // doubleVote: false → close cleanly, broadcast vote_result
  socket.on('close_vote', async ({ doubleVote = false } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      if (doubleVote) {
        const saved = await voteService.saveVote1Results(roomId);
        await roomService.updateRoom(roomId, { status: ROOM_STATUS.DEBATE });
        io.to(`room:${roomId}`).emit('debate_open', { vote1Results: saved.vote1Results });
      } else {
        const room = await voteService.closeVote(roomId);
        io.to(`room:${roomId}`).emit('vote_result', {
          votes:         room.votes,
          vote1Results:  room.vote1Results,
          syncPoint:     room.currentSyncPoint,
          correctAnswer: (room.currentQuestionData && room.currentQuestionData.correct) || null,
        });
      }
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  // Opens phase 2 — vote1Results already saved by close_vote({ doubleVote: true })
  socket.on('open_second_vote', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      const room = await roomService.getRoomById(roomId);
      const opened = await voteService.openVote(roomId, 2, {
        syncPoint: room.currentSyncPoint,
        onExpire: onVoteExpire(io),
      });
      io.to(`room:${roomId}`).emit('vote_open', {
        syncPoint:    opened.currentSyncPoint,
        timerSeconds: VOTE_TIMER_SECONDS,
        isSecondVote: true,
        questionData: opened.currentQuestionData || null,
      });
    } catch (err) {
      logger.error('open_second_vote error', { err: err.message });
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('global_pause', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      const room = await roomService.getRoomById(roomId);
      await roomService.updateRoom(roomId, { status: ROOM_STATUS.PAUSED, pausedFromStatus: room.status });
      io.to(`room:${roomId}`).emit('global_pause');
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('global_resume', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      const room = await roomService.getRoomById(roomId);
      const resumeStatus = room.pausedFromStatus || ROOM_STATUS.CONTENT;
      await roomService.updateRoom(roomId, { status: resumeStatus, pausedFromStatus: null });
      io.to(`room:${roomId}`).emit('global_resume');
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('skip_sync', async ({ syncPoint } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      await roomService.updateRoom(roomId, { status: ROOM_STATUS.CONTENT, currentSyncPoint: syncPoint || null });
      io.to(`room:${roomId}`).emit('skip_sync');
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('continue_all', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      const room = await roomService.getRoomById(roomId);
      const lastSyncPoint = room ? room.currentSyncPoint : null;
      await roomService.updateRoom(roomId, {
        status:           ROOM_STATUS.WAITING,
        waitingLearners:  [],
        currentSyncPoint: null,
        votes:            { A: 0, B: 0, C: 0, D: 0 },
        vote1Results:     null,
      });
      logger.info('[continue_all] room reset to WAITING', { roomId, lastSyncPoint });
      io.to(`room:${roomId}`).emit('continue_all', { isLastQuestion: lastSyncPoint === 'q3' });
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('extend_timer', async ({ extraSeconds = 30 } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (voteService.extendTimer(roomId, extraSeconds)) {
      io.to(`room:${roomId}`).emit('timer_extended', { extraSeconds });
    } else {
      socket.emit('error', { message: 'No active timer' });
    }
  });

  socket.on('set_auto_vote', async ({ enabled } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      await roomService.updateRoom(roomId, { autoVote: enabled !== false });
      logger.info('[set_auto_vote]', { roomId, enabled });
    } catch (err) {
      logger.error('set_auto_vote error', { err: err.message });
    }
  });
}

module.exports = { registerTrainerHandlers };
