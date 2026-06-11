require('dotenv').config();
const fs   = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimiter = require('./middleware/rateLimit');
const roomsRouter     = require('./api/routes/rooms');
const authRouter      = require('./api/routes/auth');
const questionsRouter = require('./api/routes/questions');
const { initSocket } = require('./socket');
const logger = require('./utils/logger');

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();

if (process.env.NODE_ENV === 'development') {
  app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false }));
} else {
  app.use(helmet());
}

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (process.env.NODE_ENV === 'development') return callback(null, origin);
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
    if (allowed.includes(origin)) return callback(null, origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  credentials: false,
};
// Preflight OPTIONS — regex car Express 5 n'accepte plus le wildcard '*'
app.options(/(.*)/, cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());
app.use(rateLimiter);

// Explicit routes AVANT les middlewares static
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, '..', 'admin.html')));
app.get('/health',  (_req, res) => res.json({ status: 'ok' }));
app.get('/vote',    (_req, res) => res.sendFile(path.join(__dirname, '../public/vote.html')));
app.get('/display', (_req, res) => res.sendFile(path.join(__dirname, '../public/display.html')));

app.use(express.static(path.join(__dirname, '..'), { index: 'test.html' }));
app.use(express.static(path.join(__dirname, '../public')));

// SDK bundlé : socket.io.min.js + scorm-sync-sdk.js servis en un seul fichier
app.get('/sdk/scorm-sync-sdk.js', (_req, res) => {
  const socketIOPath = path.join(__dirname, '../scorm-test/socket.io.min.js');
  const sdkPath      = path.join(__dirname, 'sdk/scorm-sync-sdk.js');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const socketIO = fs.readFileSync(socketIOPath, 'utf8');
  const sdk      = fs.readFileSync(sdkPath, 'utf8');
  res.send(socketIO + '\n\n' + sdk);
});

// qrcode.min.js servi séparément (chargé à la demande par generateQRCode)
app.get('/sdk/qrcode.min.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(__dirname, 'sdk/qrcode.min.js'));
});

app.use('/api/rooms', roomsRouter);
app.use('/api/auth',  authRouter);
app.use('/api',       questionsRouter);

const server = http.createServer(app);
initSocket(server);

server.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`, { env: process.env.NODE_ENV });
});

module.exports = { app, server };
