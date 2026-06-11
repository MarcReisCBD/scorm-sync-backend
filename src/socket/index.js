const { Server } = require('socket.io');
const { wsAuthMiddleware } = require('../middleware/auth');
const { registerLearnerHandlers } = require('./handlers/learner');
const { registerTrainerHandlers } = require('./handlers/trainer');
const { registerDisplayHandlers } = require('./handlers/display');
const { ROLES } = require('../utils/constants');
const logger = require('../utils/logger');

const WS_RATE_LIMIT = 50;
const WS_RATE_WINDOW_MS = 60 * 1000;

// ip -> { count: number, resetAt: number }
const connectionCounts = new Map();

function checkWsRateLimit(ip) {
  const now = Date.now();
  const entry = connectionCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    connectionCounts.set(ip, { count: 1, resetAt: now + WS_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= WS_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: function (origin, callback) {
        if (!origin || process.env.NODE_ENV === 'development') return callback(null, origin || '*');
        const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
        callback(allowed.includes(origin) ? null : new Error('CORS'), origin);
      },
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    },
  });

  io.use(wsAuthMiddleware);

  io.use((socket, next) => {
    const ip = socket.handshake.address;
    if (!checkWsRateLimit(ip)) return next(new Error('Too many connections'));
    next();
  });

  io.on('connection', (socket) => {
    const { role } = socket.data;
    logger.info('Socket connected', { id: socket.id, role });

    if (role === ROLES.LEARNER) {
      registerLearnerHandlers(io, socket);
    } else if (role === ROLES.TRAINER) {
      registerTrainerHandlers(io, socket);
    } else if (role === ROLES.DISPLAY) {
      registerDisplayHandlers(io, socket);
    } else {
      logger.warn('Unknown role, disconnecting', { id: socket.id });
      socket.disconnect(true);
    }
  });

  return io;
}

module.exports = { initSocket };
