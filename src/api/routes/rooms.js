const express = require('express');
const jwt = require('jsonwebtoken');
const roomService = require('../../services/roomService');
const { httpAuthMiddleware } = require('../../middleware/auth');
const { ROLES } = require('../../utils/constants');
const logger = require('../../utils/logger');

const router = express.Router();
const SECRET = process.env.JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES_IN || '6h';

// POST /api/rooms — trainer creates a room
router.post('/', httpAuthMiddleware, async (req, res) => {
  if (req.user.role !== ROLES.TRAINER) return res.status(403).json({ error: 'Trainers only' });
  const { moduleId, totalLearners } = req.body;
  try {
    const room = await roomService.createRoom({ trainerId: req.user.sub, moduleId, totalLearners });
    res.status(201).json({ roomId: room.id, code: room.code });
  } catch (err) {
    logger.error('createRoom failed', { err: err.message });
    res.status(500).json({ error: 'Could not create room' });
  }
});

// POST /api/rooms/join — learner joins via code, gets enriched JWT
router.post('/join', httpAuthMiddleware, async (req, res) => {
  if (req.user.role !== ROLES.LEARNER) return res.status(403).json({ error: 'Learners only' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const room = await roomService.getRoomByCode(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.status === 'closed') return res.status(410).json({ error: 'Room is closed' });

    // Best-effort capacity pre-filter (not authoritative — parallel joins can race;
    // the authoritative check is in learner_arrived socket handler under withArrivalLock)
    const existingNames = room.learnerNames || {};
    if (!existingNames[req.user.sub] && room.totalLearners > 0 && Object.keys(existingNames).length >= room.totalLearners) {
      return res.status(403).json({ error: 'Salle complète' });
    }
    // Name registration moved to learner_arrived socket handler (atomic under lock)

    const token = jwt.sign(
      { sub: req.user.sub, name: req.user.name, role: ROLES.LEARNER, roomId: room.id },
      SECRET,
      { expiresIn: EXPIRES }
    );
    res.json({ token, roomId: room.id });
  } catch (err) {
    logger.error('joinRoom failed', { err: err.message });
    res.status(500).json({ error: 'Could not join room' });
  }
});

// DELETE /api/rooms/:id — trainer closes a room
router.delete('/:id', httpAuthMiddleware, async (req, res) => {
  if (req.user.role !== ROLES.TRAINER) return res.status(403).json({ error: 'Trainers only' });
  try {
    const room = await roomService.getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.trainerId !== req.user.sub) return res.status(403).json({ error: 'Not your room' });
    await roomService.closeRoom(req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('closeRoom failed', { err: err.message });
    res.status(500).json({ error: 'Could not close room' });
  }
});

// GET /api/rooms/:id/state — trainer gets full room state
router.get('/:id/state', httpAuthMiddleware, async (req, res) => {
  if (req.user.role !== ROLES.TRAINER) return res.status(403).json({ error: 'Trainers only' });
  try {
    const room = await roomService.getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.trainerId !== req.user.sub) return res.status(403).json({ error: 'Not your room' });
    res.json(room);
  } catch (err) {
    logger.error('getRoomState failed', { err: err.message });
    res.status(500).json({ error: 'Could not get room state' });
  }
});

module.exports = router;
