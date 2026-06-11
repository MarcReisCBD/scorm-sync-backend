const roomService = require('../../services/roomService');
const voteService = require('../../services/voteService');
const { ROOM_STATUS } = require('../../utils/constants');
const logger = require('../../utils/logger');

const QUORUM = parseFloat(process.env.QUORUM_PERCENT || '90') / 100;
const VOTE_TIMER_SECONDS = parseInt(process.env.VOTE_TIMER_SECONDS || '45', 10);

// Per-room arrival lock — sérialise les learner_arrived pour éviter les race conditions Redis
// (plusieurs apprenants se connectant simultanément écraseraient waitingLearners les uns les autres)
const _arrivalChains = new Map();
function withArrivalLock(roomId, fn) {
  const chain = (_arrivalChains.get(roomId) || Promise.resolve()).then(fn).catch((err) => {
    logger.error('[arrivalLock] error', { roomId, err: err.message });
  });
  _arrivalChains.set(roomId, chain);
  chain.finally(() => {
    if (_arrivalChains.get(roomId) === chain) _arrivalChains.delete(roomId);
  });
  return chain;
}

function registerLearnerHandlers(io, socket) {
  const { user } = socket.data;

  // roomId comes from the enriched JWT (set after POST /api/rooms/join)
  // SCORM joins room socket as observer (without being added to waitingLearners)
  socket.on('watch_room', async () => {
    const roomId = user.roomId;
    if (!roomId) return;
    socket.join(`room:${roomId}`);
    socket.data.roomId = roomId;
    logger.info('[watch_room]', { learnerId: user.sub, roomId });

    // Snapshot immédiat — le SCORM peut rejoindre après que des apprenants sont déjà connectés
    try {
      const room = await roomService.getRoomById(roomId);
      if (room) {
        const names = room.learnerNames || {};
        socket.emit('waiting_update', {
          syncPoint: room.currentSyncPoint,
          waiting:   room.waitingLearners.length,
          total:     room.totalLearners,
          learners:  room.waitingLearners.map(id => ({ id, name: names[id] || 'Apprenant' })),
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
      }
    } catch (err) {
      logger.error('[watch_room] snapshot error', { err: err.message });
    }
  });

  socket.on('learner_arrived', ({ syncPoint } = {}) => {
    const roomId = user.roomId;
    logger.info('[learner_arrived]', { learnerId: user.sub, syncPoint: syncPoint || '(none)', roomId });
    if (!roomId) { socket.emit('error', { message: 'No room in token — call /api/rooms/join first' }); return; }

    // Serialize per-room to prevent concurrent race on waitingLearners
    withArrivalLock(roomId, async () => {
      try {
        const room = await roomService.getRoomById(roomId);
        if (!room || room.status === ROOM_STATUS.CLOSED) {
          socket.emit('error', { message: 'Room not found or closed' });
          return;
        }

        socket.join(`room:${roomId}`);
        socket.data.roomId = roomId;

        const waiting = room.waitingLearners || [];
        logger.info('[learner_arrived] waitingLearners avant:', { list: waiting, syncPoint: syncPoint || '(none)', status: room.status });
        if (!waiting.includes(user.sub)) {
          waiting.push(user.sub);
          await roomService.updateRoom(roomId, { waitingLearners: waiting });
        }

        const updated = await roomService.getRoomById(roomId);
        const names   = updated.learnerNames || {};
        io.to(`room:${roomId}`).emit('waiting_update', {
          syncPoint,
          waiting:  updated.waitingLearners.length,
          total:    updated.totalLearners,
          learners: updated.waitingLearners.map((id) => ({ id, name: names[id] || 'Apprenant' })),
        });

        // Notify SCORM watchers that a smartphone has connected with its LMS identity
        io.to(`room:${roomId}`).emit('learner_connected', {
          learnerId:   user.sub,
          learnerName: names[user.sub] || user.name || 'Apprenant',
        });

        // If question data exists, push it to this socket (late joiner or QR watcher)
        if (updated.currentQuestionData) {
          socket.emit('question_data', updated.currentQuestionData);
        }

        // If vote already open, push vote_open directly to this socket (late joiner)
        if (updated.status === ROOM_STATUS.VOTE) {
          socket.emit('vote_open', {
            syncPoint:    updated.currentSyncPoint,
            timerSeconds: VOTE_TIMER_SECONDS,
            isSecondVote: updated.vote1Results !== null,
            questionData: updated.currentQuestionData || null,
          });
        }

        // Auto-trigger vote when quorum is reached — only when SCORM provides syncPoint
        // (smartphone emits learner_arrived without syncPoint; quorum must wait for SCORM's arrived())
        if (
          syncPoint &&
          updated.totalLearners > 0 &&
          updated.status === ROOM_STATUS.WAITING &&
          updated.waitingLearners.length / updated.totalLearners >= QUORUM &&
          updated.autoVote !== false
        ) {
          logger.info('Quorum reached, auto-opening vote', { roomId, syncPoint });
          const opened = await voteService.openVote(roomId, 1, {
            syncPoint,
            onExpire: async (rid) => {
              const r = await voteService.closeVote(rid);
              io.to(`room:${rid}`).emit('vote_result', {
                votes: r.votes,
                vote1Results: r.vote1Results,
                syncPoint: r.currentSyncPoint,
              });
            },
          });
          io.to(`room:${roomId}`).emit('vote_open', {
            syncPoint:    opened.currentSyncPoint,
            timerSeconds: VOTE_TIMER_SECONDS,
            isSecondVote: false,
            questionData: opened.currentQuestionData || null,
          });
        }
      } catch (err) {
        logger.error('learner_arrived error', { err: err.message });
        socket.emit('error', { message: 'Server error' });
      }
    });
  });

  socket.on('submit_vote', async ({ value } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) { socket.emit('vote_ack', { ok: false, error: 'Not in a room' }); return; }
    try {
      // value peut être une lettre 'A' ou un tableau ['A','C'] (réponses multiples)
      const normalizedValue = Array.isArray(value) ? value : [value];
      const room = await roomService.getRoomById(roomId);
      const responseTimeMs = room.voteOpenedAt ? Date.now() - room.voteOpenedAt : null;
      const syncPoint = room.currentSyncPoint;

      const learnerAnswers = room.learnerAnswers || {};
      const learnerResponseTimes = room.learnerResponseTimes || {};
      if (!learnerAnswers[user.sub]) learnerAnswers[user.sub] = {};
      if (!learnerResponseTimes[user.sub]) learnerResponseTimes[user.sub] = {};
      if (syncPoint) {
        learnerAnswers[user.sub][syncPoint] = normalizedValue.length === 1 ? normalizedValue[0] : normalizedValue;
        if (responseTimeMs != null) learnerResponseTimes[user.sub][syncPoint] = responseTimeMs;
      }

      const updated = await voteService.submitVote(roomId, value);
      await roomService.updateRoom(roomId, { learnerAnswers, learnerResponseTimes });

      socket.emit('vote_ack', { ok: true });
      const total = Object.values(updated.votes).reduce((s, n) => s + n, 0);
      io.to(`room:${roomId}`).emit('vote_progress', {
        total, max: updated.totalLearners,
        learnerId: user.sub, value: normalizedValue.length === 1 ? normalizedValue[0] : normalizedValue, responseTimeMs,
      });
    } catch (err) {
      logger.warn('submit_vote error', { err: err.message });
      socket.emit('vote_ack', { ok: false, error: err.message });
    }
  });

  socket.on('get_question_data', async (_data, callback) => {
    if (typeof callback !== 'function') return;
    const roomId = socket.data.roomId;
    if (!roomId) { callback(null); return; }
    try {
      const room = await roomService.getRoomById(roomId);
      callback(room ? (room.currentQuestionData || null) : null);
    } catch (err) {
      callback(null);
    }
  });

  socket.on('question_data', async (data = {}, callback) => {
    const { syncPoint, question, choices, correct, multipleCorrect } = data;
    const roomId = socket.data.roomId;
    // Log complet du payload reçu (clés uniquement pour choices, texte tronqué)
    logger.info('[question_data] payload complet', {
      syncPoint,
      multipleCorrect,
      correct: JSON.stringify(correct),
      choices_keys: choices ? Object.keys(choices) : null,
      question_head: question ? question.slice(0, 60) : null,
    });
    if (!roomId || !syncPoint) {
      logger.warn('[question_data] ignoré — roomId ou syncPoint manquant', { roomId, syncPoint });
      if (typeof callback === 'function') callback({ ok: false });
      return;
    }
    try {
      const qd = { syncPoint, question, choices, correct: correct || null, multipleCorrect: multipleCorrect || 0 };
      await roomService.updateRoom(roomId, { currentQuestionData: qd });
      if (typeof callback === 'function') callback({ ok: true });
      logger.info('[question_data] ACK envoyé', { syncPoint, roomId });
      io.to(`room:${roomId}`).emit('question_data', qd);
    } catch (err) {
      logger.error('question_data error', { err: err.message });
      if (typeof callback === 'function') callback({ ok: false });
    }
  });

  socket.on('continue_all_auto', async ({ score, correct, total } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    logger.info('[continue_all_auto]', { learnerId: user.sub, score, correct, total, roomId });
    try {
      await roomService.updateRoom(roomId, {
        status:           ROOM_STATUS.CONTENT,
        currentSyncPoint: null,
        waitingLearners:  [],
        votes:            { A: 0, B: 0, C: 0, D: 0 },
        vote1Results:     null,
      });
    } catch (err) {
      logger.error('continue_all_auto error', { err: err.message });
    }
  });

  socket.on('session_complete', ({ score, correct, total } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    logger.info('[session_complete]', { learnerId: user.sub, score, correct, total });
    io.to(`room:${roomId}`).emit('session_complete', {
      learnerId: user.sub,
      score,
      correct,
      total,
    });
  });

  socket.on('disconnect', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      const room = await roomService.getRoomById(roomId);
      if (!room) return;
      const waiting = (room.waitingLearners || []).filter((id) => id !== user.sub);
      await roomService.updateRoom(roomId, { waitingLearners: waiting });
      io.to(`room:${roomId}`).emit('waiting_update', {
        syncPoint: room.currentSyncPoint,
        waiting: waiting.length,
        total: room.totalLearners,
      });
    } catch (err) {
      logger.error('learner disconnect error', { err: err.message });
    }
  });
}

module.exports = { registerLearnerHandlers };
