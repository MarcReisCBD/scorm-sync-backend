const { getDb }      = require('./database');
const { randomUUID } = require('crypto');

// ── Modules ───────────────────────────────────────────────────────────

function insertModule({ ref, name_fr, rise_up_id = null }) {
  getDb().prepare(`
    INSERT INTO modules (ref, name_fr, rise_up_id)
    VALUES (?, ?, ?)
    ON CONFLICT(ref) DO UPDATE SET
      name_fr    = excluded.name_fr,
      rise_up_id = COALESCE(excluded.rise_up_id, rise_up_id)
  `).run(ref, name_fr, rise_up_id);
}

function getAllModules() {
  return getDb().prepare(`
    SELECT m.ref, m.name_fr, m.rise_up_id,
           COUNT(q.id) AS question_count
    FROM modules m
    LEFT JOIN questions q ON q.module_ref = m.ref
    GROUP BY m.ref
    ORDER BY m.ref
  `).all();
}

// ── Questions ─────────────────────────────────────────────────────────

function insertQuestion(q) {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM questions
    WHERE text_fr = ?
      AND (module_ref IS ? OR module_ref = ?)
  `).get(q.text_fr, q.module_ref || null, q.module_ref || null);

  const choicesFr = JSON.stringify(q.choices_fr || []);
  const choicesEn = JSON.stringify(q.choices_en || []);

  const multipleCorrect = q.multiple_correct || 0;

  if (existing) {
    db.prepare(`
      UPDATE questions SET
        text_en          = ?,
        type             = ?,
        choices_fr       = ?,
        choices_en       = ?,
        explanation_fr   = ?,
        explanation_en   = ?,
        module_ref       = ?,
        multiple_correct = ?
      WHERE id = ?
    `).run(
      q.text_en || null, q.type, choicesFr, choicesEn,
      q.explanation_fr || null, q.explanation_en || null,
      q.module_ref || null, multipleCorrect, existing.id,
    );
    return { id: existing.id, created: false };
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO questions
      (id, text_fr, text_en, type, choices_fr, choices_en,
       explanation_fr, explanation_en, module_ref, multiple_correct, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, q.text_fr, q.text_en || null, q.type, choicesFr, choicesEn,
    q.explanation_fr || null, q.explanation_en || null,
    q.module_ref || null, multipleCorrect, Date.now(),
  );
  return { id, created: true };
}

function getQuestions({ moduleRef, search, type, lang = 'fr', page = 1, limit = 20 } = {}) {
  const db = getDb();
  const conditions = [];
  const params     = [];

  if (moduleRef) { conditions.push('q.module_ref = ?'); params.push(moduleRef); }
  if (type)      { conditions.push('q.type = ?');       params.push(type); }
  if (search) {
    const col = lang === 'en' ? 'q.text_en' : 'q.text_fr';
    conditions.push(`${col} LIKE ?`);
    params.push(`%${search}%`);
  }

  const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (page - 1) * limit;

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM questions q ${where}`
  ).get(...params).n;

  // Global coverage counts (unfiltered — for the lang coverage display)
  const total_fr = db.prepare(
    `SELECT COUNT(*) AS n FROM questions WHERE text_fr IS NOT NULL AND text_fr != ''`
  ).get().n;
  const total_en = db.prepare(
    `SELECT COUNT(*) AS n FROM questions WHERE text_en IS NOT NULL AND text_en != ''`
  ).get().n;

  const rows = db.prepare(`
    SELECT q.*, m.name_fr AS module_name
    FROM questions q
    LEFT JOIN modules m ON m.ref = q.module_ref
    ${where}
    ORDER BY q.module_ref, q.created_at
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    questions: rows.map(parseRow),
    total,
    total_fr,
    total_en,
    page,
    pages: Math.ceil(total / limit),
  };
}

function getQuestionCount(moduleRef) {
  return getDb().prepare(
    'SELECT COUNT(*) AS n FROM questions WHERE module_ref = ?'
  ).get(moduleRef).n;
}

function getRandomQuestions(moduleRefs, count, type) {
  if (!moduleRefs || moduleRefs.length === 0) return [];
  const placeholders = moduleRefs.map(() => '?').join(',');
  const typeClause   = type ? 'AND type = ?' : '';
  const params       = type ? [...moduleRefs, type, count] : [...moduleRefs, count];
  const rows = getDb().prepare(`
    SELECT * FROM questions
    WHERE module_ref IN (${placeholders}) ${typeClause}
    ORDER BY RANDOM()
    LIMIT ?
  `).all(...params);
  return rows.map(parseRow);
}

// ── Quiz assignment ───────────────────────────────────────────────────

function assignQuestionsToQuiz(roomId, quizId, questionIds, language = 'fr') {
  const db = getDb();
  db.prepare(
    'DELETE FROM quiz_questions WHERE room_id = ? AND quiz_id = ?'
  ).run(roomId, quizId);

  const stmt = db.prepare(`
    INSERT INTO quiz_questions (id, room_id, quiz_id, question_id, position, language)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((ids) => {
    ids.forEach((qid, i) => stmt.run(randomUUID(), roomId, quizId, qid, i, language));
  });
  insertMany(questionIds);
}

function getQuizQuestions(roomId, quizId) {
  const rows = getDb().prepare(`
    SELECT q.*, qq.position, qq.language
    FROM quiz_questions qq
    JOIN questions q ON q.id = qq.question_id
    WHERE qq.room_id = ? AND qq.quiz_id = ?
    ORDER BY qq.position
  `).all(roomId, quizId);

  if (rows.length > 0) {
    console.log('[getQuizQuestions] row[0] raw multiple_correct:', rows[0].multiple_correct, '| id:', rows[0].id && rows[0].id.substr(0, 8));
  }

  return rows.map(r => {
    const q               = parseRow(r);
    const lang            = r.language || 'fr';
    const choices         = lang === 'en' ? q.choices_en : q.choices_fr;
    const multipleCorrect = q.multiple_correct || 0;
    const correctItems    = choices.filter(c => c.correct);
    const correct = multipleCorrect
      ? correctItems.map(c => c.letter)
      : (correctItems[0] ? correctItems[0].letter : null);
    const result = {
      id:               q.id,
      text:             lang === 'en' ? (q.text_en || q.text_fr) : q.text_fr,
      type:             q.type,
      choices,
      correct,
      multiple_correct: multipleCorrect,
      explanation:      lang === 'en' ? (q.explanation_en || q.explanation_fr) : q.explanation_fr,
      module_ref:       q.module_ref,
      position:         r.position,
      language:         lang,
    };
    return result;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseRow(row) {
  return {
    ...row,
    choices_fr: tryParse(row.choices_fr, []),
    choices_en: tryParse(row.choices_en, []),
  };
}

function tryParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = {
  insertModule,
  getAllModules,
  insertQuestion,
  getQuestions,
  getQuestionCount,
  getRandomQuestions,
  assignQuestionsToQuiz,
  getQuizQuestions,
};
