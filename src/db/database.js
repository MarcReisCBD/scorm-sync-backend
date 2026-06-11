const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH  = path.join(DATA_DIR, 'questions.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS modules (
      ref        TEXT PRIMARY KEY,
      name_fr    TEXT NOT NULL,
      rise_up_id TEXT
    );

    CREATE TABLE IF NOT EXISTS questions (
      id               TEXT PRIMARY KEY,
      text_fr          TEXT NOT NULL,
      text_en          TEXT,
      type             TEXT NOT NULL,
      choices_fr       TEXT NOT NULL,
      choices_en       TEXT NOT NULL,
      explanation_fr   TEXT,
      explanation_en   TEXT,
      module_ref       TEXT,
      multiple_correct INTEGER DEFAULT 0,
      created_at       INTEGER
    );

    CREATE TABLE IF NOT EXISTS quiz_questions (
      id          TEXT PRIMARY KEY,
      room_id     TEXT NOT NULL,
      quiz_id     TEXT NOT NULL,
      question_id TEXT NOT NULL,
      position    INTEGER,
      language    TEXT DEFAULT 'fr'
    );

    CREATE INDEX IF NOT EXISTS idx_questions_module   ON questions(module_ref);
    CREATE INDEX IF NOT EXISTS idx_questions_text_fr  ON questions(text_fr);
    CREATE INDEX IF NOT EXISTS idx_quiz_room          ON quiz_questions(room_id, quiz_id);
  `);

  // Migration : ajout de colonnes sans casser les BDD existantes
  try { _db.exec('ALTER TABLE questions ADD COLUMN multiple_correct INTEGER DEFAULT 0'); } catch (_) {}

  return _db;
}

module.exports = { getDb };
