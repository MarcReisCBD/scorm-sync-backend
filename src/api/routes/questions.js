const express = require('express');
const multer  = require('multer');
const repo    = require('../../db/questionRepository');
const { importFromRiseUp } = require('../../services/questionImporter');
const { httpAuthMiddleware } = require('../../middleware/auth');
const logger  = require('../../utils/logger');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── GET /api/modules ──────────────────────────────────────────────────
router.get('/modules', (req, res) => {
  try {
    res.json(repo.getAllModules());
  } catch (err) {
    logger.error('getAllModules failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/questions ────────────────────────────────────────────────
router.get('/questions', (req, res) => {
  try {
    const { moduleRef, search, type, lang, page, limit } = req.query;
    const result = repo.getQuestions({
      moduleRef: moduleRef || undefined,
      search:    search    || undefined,
      type:      type      || undefined,
      lang:      lang      || 'fr',
      page:      parseInt(page  || '1',  10),
      limit:     parseInt(limit || '20', 10),
    });
    res.json(result);
  } catch (err) {
    logger.error('getQuestions failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/questions/import ─────────────────────────────────────────
router.post(
  '/questions/import',
  httpAuthMiddleware,
  upload.fields([
    { name: 'questions',  maxCount: 1 },
    { name: 'formations', maxCount: 1 },
  ]),
  async (req, res) => {
    if (req.user.role !== 'trainer') return res.status(403).json({ error: 'Trainers only' });

    const qFile = req.files?.questions?.[0];
    const fFile = req.files?.formations?.[0];

    if (!qFile || !fFile) {
      return res.status(400).json({ error: 'Les deux fichiers sont requis : questions et formations' });
    }

    try {
      const result = await importFromRiseUp(qFile.buffer, fFile.buffer);
      res.json(result);
    } catch (err) {
      logger.error('importFromRiseUp failed', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/questions/random ─────────────────────────────────────────
router.post('/questions/random', (req, res) => {
  try {
    const { moduleRefs, count, language, type } = req.body;
    if (!moduleRefs || !Array.isArray(moduleRefs) || moduleRefs.length === 0) {
      return res.status(400).json({ error: 'moduleRefs (array) requis' });
    }
    const questions = repo.getRandomQuestions(moduleRefs, Math.min(parseInt(count || '5', 10), 100), type || undefined);
    // Return in requested language
    const lang = language || 'fr';
    const out = questions.map(q => ({
      ...q,
      text:    lang === 'en' ? (q.text_en || q.text_fr) : q.text_fr,
      choices: lang === 'en' ? q.choices_en : q.choices_fr,
    }));
    res.json(out);
  } catch (err) {
    logger.error('getRandomQuestions failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rooms/:id/quiz/:quizId/questions ─────────────────────────
router.post('/rooms/:id/quiz/:quizId/questions', httpAuthMiddleware, (req, res) => {
  if (req.user.role !== 'trainer') return res.status(403).json({ error: 'Trainers only' });
  try {
    const { questionIds, language } = req.body;
    if (!Array.isArray(questionIds)) return res.status(400).json({ error: 'questionIds array requis' });
    repo.assignQuestionsToQuiz(req.params.id, req.params.quizId, questionIds, language || 'fr');
    res.json({ assigned: questionIds.length });
  } catch (err) {
    logger.error('assignQuestionsToQuiz failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rooms/:id/quiz/:quizId/questions ──────────────────────────
router.get('/rooms/:id/quiz/:quizId/questions', (req, res) => {
  try {
    const questions = repo.getQuizQuestions(req.params.id, req.params.quizId);
    if (questions.length > 0) {
      console.log('[quiz/questions] q[0] multiple_correct:', questions[0].multiple_correct, '| correct:', JSON.stringify(questions[0].correct));
    }
    res.json(questions);
  } catch (err) {
    logger.error('getQuizQuestions failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
