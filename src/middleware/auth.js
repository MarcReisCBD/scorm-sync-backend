const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const SECRET = process.env.JWT_SECRET;

function httpAuthMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function wsAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Missing token'));
  try {
    const payload = jwt.verify(token, SECRET);
    socket.data.user = payload;
    socket.data.role = payload.role;
    next();
  } catch (err) {
    logger.warn('WS auth failed', { err: err.message });
    next(new Error('Invalid token'));
  }
}

module.exports = { httpAuthMiddleware, wsAuthMiddleware };
