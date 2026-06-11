const XLSX   = require('xlsx');
const logger = require('../utils/logger');
const repo   = require('../db/questionRepository');

// ── Helpers ───────────────────────────────────────────────────────────

function cell(row, idx) {
  const v = row[idx];
  return (v === undefined || v === null) ? '' : String(v).trim();
}

function findColIdx(headers, candidates) {
  const lower = headers.map(h => String(h || '').toLowerCase().trim());
  for (const c of candidates) {
    const i = lower.findIndex(h => h.includes(c.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}

function getSheet(wb, candidates) {
  for (const name of candidates) {
    const found = wb.SheetNames.find(
      s => s.toLowerCase().replace(/\s+/g, ' ').trim() === name.toLowerCase()
    );
    if (found) return wb.Sheets[found];
  }
  for (const name of candidates) {
    const found = wb.SheetNames.find(
      s => s.toLowerCase().includes(name.toLowerCase())
    );
    if (found) return wb.Sheets[found];
  }
  return null;
}

function sheetToRows(ws) {
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

// ── FR/EN split ───────────────────────────────────────────────────────

// Patterns that reliably identify the start of an English sentence
const EN_START_PATTERNS = [
  /^True or false[:\s]/i,
  /^True\/false[:\s]/i,
  /^Performing\b/i,
  /^Using\b/i,
  /^To (perform|prepare|introduce|use|carry|apply|verify|ensure|implement|conduct|check|assess|reduce|increase|avoid|prevent|obtain|achieve|monitor|detect|guarantee|control|validate)\b/i,
  /^Can (a|an|the|you|we|it)\b/i,
  /^Should\b/i,
  /^Is (it|the|a|an|this|there)\b/i,
  /^Are (the|there|these|those|you)\b/i,
  /^Do (the|you|we|they)\b/i,
  /^Does (the|this|it)\b/i,
  /^What\b/i,
  /^Which\b/i,
  /^How (many|much|is|are|do|does|should|can|often|long)\b/i,
  /^Why\b/i,
  /^When\b/i,
  /^In [a-z]/i,      // "In your opinion", "In order to", "In a GMP environment"…
  /^According to\b/i,
  /^During\b/i,
  /^As part of\b/i,
  /^After\b/i,
  /^Before\b/i,
  /^A (batch|product|process|sample|test|validation|qualification|bioproduct)\b/i,
  /^The (batch|product|process|sample|test|validation|qualification|purpose|goal|aim|use|role|main|key|first|last)\b/i,
  /^For (a|the|an|this)\b/i,
  /^It is\b/i,
  /^This (is|can|should|must|involves)\b/i,
  /^Aseptic\b/i,
  /^Fill(ing)?\b/i,
  /^Based on\b/i,
  /^Due to\b/i,
];

// French markers
const FR_DIACRITICS = /[éèêëàâùûüîïôœç]/i;
// Uses \b so single words match too ("du", "la", "vrai"…)
const FR_STARTERS = /^(le|la|les|un|une|des|du|ce|cet|cette|ces|il|elle|ils|elles|on|nous|vous|je|tu|en|au|aux|pour|dans|avec|par|sur|sous|qui|que|quand|comment|pourquoi|quel|quelle|vrai|faux|réaliser|effectuer|utiliser|lors|afin)\b/i;

function hasFrenchMarker(text) {
  return FR_DIACRITICS.test(text) || FR_STARTERS.test(text);
}

function looksEnglish(sentence) {
  const s = sentence.trim();
  if (!s) return false;
  for (const pat of EN_START_PATTERNS) {
    if (pat.test(s)) return true;
  }
  return false;
}

function looksNotFrench(sentence) {
  const s = sentence.trim();
  if (!s) return false;
  if (FR_DIACRITICS.test(s)) return false;
  if (FR_STARTERS.test(s)) return false;
  return true;
}

function splitFrEn(text) {
  if (!text || typeof text !== 'string') return { fr: text || '', en: '' };

  // 0. Remove CSS-style junk pasted from Word/Pages (e.g. "p.p1 {margin: 0.0px; font: 12px}")
  let t = text
    .replace(/\r/g, '')
    .replace(/[\w.-]+\s*\{[^}]*\}/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
  if (!t) return { fr: '', en: '' };

  // 1. Explicit "True or false" marker
  const tfIdx = t.search(/(?<=[.?!:]\s{0,2}|\n)True\s+or\s+[Ff]alse\s*[:\s—-]/);
  if (tfIdx > 0) {
    return { fr: t.slice(0, tfIdx).trim(), en: t.slice(tfIdx).trim() };
  }
  const tfLine = t.match(/^(.+?)\n+(True\s+or\s+[Ff]alse\s*[:\s—-].*)$/s);
  if (tfLine) {
    return { fr: tfLine[1].trim(), en: tfLine[2].trim() };
  }

  // 1.5. Slash separator: " /EN" or " / EN"
  const slashMatch = t.match(/^(.+?)\s+\/\s*(.+)$/s);
  if (slashMatch && slashMatch[1] && slashMatch[2]) {
    return { fr: slashMatch[1].trim(), en: slashMatch[2].trim() };
  }

  // 2. Newline-based split
  if (t.includes('\n')) {
    const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      if (looksEnglish(lines[i]) || looksNotFrench(lines[i])) {
        return {
          fr: lines.slice(0, i).join(' ').trim(),
          en: lines.slice(i).join(' ').trim(),
        };
      }
    }
    return { fr: lines.join(' '), en: '' };
  }

  // 2.3. Period directly followed by a digit: "...du lot.98% of the specifications"
  //      French ends with ".", English starts with a figure/percentage.
  {
    const dotDigitRe = /\.\s*(?=[0-9])/g;
    let m;
    while ((m = dotDigitRe.exec(t)) !== null) {
      const frPart = t.slice(0, m.index + 1).trim();
      const enPart = t.slice(m.index + m[0].length).trim();
      if (FR_DIACRITICS.test(frPart) && looksNotFrench(enPart)) {
        return { fr: frPart, en: enPart };
      }
    }
  }

  // 2.5. Colon (possibly preceded by ?/!) directly followed by uppercase EN
  //      e.g. ":Lyophilization", "? :In this example", "?:What"
  //      Guard relaxed: looksEnglish(enPart) alone is sufficient (covers no-diacritic FR parts).
  {
    const colonRe = /:\s*(?=[A-Z])/g;
    let m;
    while ((m = colonRe.exec(t)) !== null) {
      const splitAt = m.index + m[0].length;
      const frPart  = t.slice(0, m.index + 1).trim();
      const enPart  = t.slice(splitAt).trim();
      if (looksEnglish(enPart) || (FR_DIACRITICS.test(frPart) && looksNotFrench(enPart))) {
        return { fr: frPart, en: enPart };
      }
    }
  }

  // 2.6. Closing/opening quote directly before uppercase EN start
  //      e.g. "définition de...\"The maximum allowed dose"
  {
    const quoteRe = /["«»“”]\s*(?=[A-Z])/g;
    let m;
    while ((m = quoteRe.exec(t)) !== null) {
      const splitAt = m.index + m[0].length;
      const frPart  = t.slice(0, splitAt).trim();
      const enPart  = t.slice(splitAt).trim();
      if (FR_DIACRITICS.test(frPart) && (looksEnglish(enPart) || looksNotFrench(enPart))) {
        return { fr: frPart, en: enPart };
      }
    }
  }

  // 2.7. Lowercase FR letter directly concatenated to uppercase EN word (no space, no punct)
  //      e.g. "cuveYou", "réservoirDuring", "causées parData"
  {
    const luRe = /[a-zéèêëàâùûîïôœç](?=[A-Z][a-z])/g;
    let m;
    while ((m = luRe.exec(t)) !== null) {
      const splitAt = m.index + 1; // position of the uppercase letter
      const frPart  = t.slice(0, splitAt);
      const enPart  = t.slice(splitAt);
      if (FR_DIACRITICS.test(frPart) && (looksEnglish(enPart) || looksNotFrench(enPart))) {
        return { fr: frPart.trim(), en: enPart.trim() };
      }
    }
  }

  // 2.8. '?' directly before uppercase EN word (no space or minimal space): "?What", "?Which"
  //      Guard: looksEnglish only — avoids splitting French follow-up sentences ("? Bravo").
  {
    const questRe = /\?\s*(?=[A-Z][a-z])/g;
    let m;
    while ((m = questRe.exec(t)) !== null) {
      const splitAt = m.index + m[0].length;
      const frPart  = t.slice(0, splitAt).trim();
      const enPart  = t.slice(splitAt).trim();
      if (looksEnglish(enPart)) {
        return { fr: frPart, en: enPart };
      }
    }
  }

  // 3. Single line with sentence punctuation (\s* catches no-space after period)
  const segments = t.split(/(?<=[.?!])\s*(?=[A-ZÀ-Ö])/).map(s => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    for (let i = 1; i < segments.length; i++) {
      const frSoFar = segments.slice(0, i).join(' ');
      if (looksEnglish(segments[i]) || (looksNotFrench(segments[i]) && hasFrenchMarker(frSoFar))) {
        return { fr: frSoFar.trim(), en: segments.slice(i).join(' ').trim() };
      }
    }
  }

  // 4. Short choice texts: first uppercase word (non-initial) with no-diacritic tail
  //    e.g. "La température Temperature", "Transport routier Road transport"
  const words = t.split(/\s+/);
  if (words.length >= 3) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (/^[A-Z]/.test(w) && !FR_DIACRITICS.test(w)) {
        const tail = words.slice(i).join(' ');
        if (!FR_DIACRITICS.test(tail) && !FR_STARTERS.test(tail)) {
          const fr = words.slice(0, i).join(' ');
          if (hasFrenchMarker(fr) || i >= 2) {
            return { fr, en: tail };
          }
        }
      }
    }
  }

  return { fr: t, en: '' };
}

// ── Formations parser ─────────────────────────────────────────────────

const REF_PATTERN = /\b(P\d+M\d+[a-z]?)\b/i;

function normalizeComp(str) {
  return str
    .replace(/\(Pilote\s+BLC\)/gi, '')
    .replace(/\(pilote\)/gi, '')
    .replace(/\(TEST\)/gi, '')
    .replace(/\bP\d+M\d+[a-z]?\b/gi, '')  // remove ref itself
    .replace(/[-–—_]/g, ' ')               // normalize dashes
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanModuleName(title, ref) {
  return title
    .replace(/\(Pilote\s+BLC\)/gi, '')
    .replace(/\(pilote\)/gi, '')
    .replace(/\(TEST\)/gi, '')
    .replace(new RegExp(`\\b${ref}\\b`, 'i'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[^a-zA-ZÀ-ÿ]+/, '')
    .trim();
}

function parseFormationsExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const ws = getSheet(wb, ['Formations', 'Modules', 'Formation', 'Sheet1']) ||
             wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('Aucune feuille trouvée dans le fichier formations');

  const rows    = sheetToRows(ws);
  if (rows.length < 2) throw new Error('Fichier formations vide');

  const headers  = rows[0];
  const titleIdx = findColIdx(headers, [
    'titre de la formation', 'nom de la formation',
    'titre', 'nom', 'name', 'formation', 'module',
  ]);
  if (titleIdx < 0) throw new Error('Colonne titre non trouvée. Colonnes : ' + headers.join(', '));

  // map: normalizedCompetenceName → { ref, name_fr }
  const map     = new Map();
  let skipped   = 0;

  for (let i = 1; i < rows.length; i++) {
    const title = cell(rows[i], titleIdx);
    if (!title) continue;

    if (/\b(TEST|POSITIONNE|Evaluation)\b/i.test(title)) { skipped++; continue; }

    const m = title.match(REF_PATTERN);
    if (!m) { skipped++; continue; }

    const ref     = m[1].toUpperCase();
    const name_fr = cleanModuleName(title, ref) || title;

    // Store under normalized competence key (everything after the ref)
    const normKey = normalizeComp(title);
    map.set(normKey, { ref, name_fr });

    // Also store under just the cleaned name for partial matching
    const nameKey = name_fr.trim().toLowerCase().replace(/[-–—_]/g, ' ').replace(/\s{2,}/g, ' ');
    if (nameKey !== normKey) map.set(nameKey, { ref, name_fr });
  }

  logger.info('[parseFormations] terminé', { found: map.size / 2 | 0, skipped });
  if (map.size > 0) {
    const sample = [...map.keys()].slice(0, 3);
    logger.info('[parseFormations] clés exemples', { sample });
  }
  return map;
}

// ── Questions parser ──────────────────────────────────────────────────

function stripStars(text) {
  return text.replace(/^\*+|\*+$/g, '').trim();
}

function isCorrectAnswer(text) {
  return /^\*/.test(text.trim()) || /\*$/.test(text.trim());
}

function resolveCompetence(rawComp, compToRef, warnings) {
  if (!rawComp) return null;

  // Direct ref in competence cell?
  const directRef = rawComp.match(REF_PATTERN);
  if (directRef) return directRef[1].toUpperCase();

  // Normalize the competence name from the questions file
  const normComp = normalizeComp(rawComp);

  // Exact normalized match
  if (compToRef.has(normComp)) return compToRef.get(normComp).ref;

  // Fallback: partial match — find the longest key that is contained in the competence
  let bestMatch = null;
  let bestLen   = 0;
  for (const [key, val] of compToRef) {
    if (key.length > bestLen && normComp.includes(key)) {
      bestMatch = val.ref;
      bestLen   = key.length;
    }
  }
  if (bestMatch) return bestMatch;

  // Reverse partial: competence string contained in a key
  for (const [key, val] of compToRef) {
    if (normComp.length > 6 && key.includes(normComp)) {
      return val.ref;
    }
  }

  warnings.push(`Compétence non mappée: "${rawComp.slice(0, 80)}"`);
  return null;
}

function parseVraiFaux(ws, compToRef, warnings) {
  const rows    = sheetToRows(ws);
  if (rows.length < 2) return [];
  const headers = rows[0];

  const qIdx    = findColIdx(headers, ['question', 'intitulé', 'énoncé', 'enonce', 'libellé']);
  const repIdx  = findColIdx(headers, ['réponse', 'reponse', 'response', 'answer', 'bonne réponse', 'correct']);
  const expIdx  = findColIdx(headers, ['explication', 'explanation', 'feedback', 'commentaire', 'justification']);
  const compIdx = findColIdx(headers, ['compétence', 'competence', 'objectif', 'formation', 'module', 'tag']);

  if (qIdx < 0) { logger.warn('[VraiFaux] colonne Question non trouvée'); return []; }

  const questions = [];
  for (let i = 1; i < rows.length; i++) {
    const row  = rows[i];
    const rawQ = cell(row, qIdx);
    if (!rawQ) continue;

    const rawRep  = repIdx  >= 0 ? cell(row, repIdx)  : '';
    const rawExp  = expIdx  >= 0 ? cell(row, expIdx)  : '';
    const rawComp = compIdx >= 0 ? cell(row, compIdx) : '';

    const { fr: text_fr, en: text_en } = splitFrEn(rawQ);
    if (!text_fr) continue;

    const repLower   = rawRep.toLowerCase();
    const isVrai     = repLower.includes('vrai') || repLower.includes('true');
    const choices_fr = [
      { letter: 'A', text: 'Vrai',  correct: isVrai  },
      { letter: 'B', text: 'Faux',  correct: !isVrai },
    ];
    const choices_en = [
      { letter: 'A', text: 'True',  correct: isVrai  },
      { letter: 'B', text: 'False', correct: !isVrai },
    ];

    const { fr: expl_fr, en: expl_en } = splitFrEn(rawExp);
    const module_ref = resolveCompetence(rawComp, compToRef, warnings);

    questions.push({
      text_fr, text_en, type: 'true_false',
      choices_fr, choices_en,
      explanation_fr: expl_fr || null,
      explanation_en: expl_en || null,
      module_ref,
    });
  }
  return questions;
}

function parseChoixMultiple(ws, compToRef, warnings) {
  const rows    = sheetToRows(ws);
  if (rows.length < 2) return [];
  const headers = rows[0];

  const qIdx    = findColIdx(headers, ['question', 'intitulé', 'énoncé', 'enonce', 'libellé']);
  const expIdx  = findColIdx(headers, ['explication', 'explanation', 'feedback', 'commentaire', 'justification']);
  const compIdx = findColIdx(headers, ['compétence', 'competence', 'objectif', 'formation', 'module', 'tag']);

  const repCols = headers.reduce((acc, h, i) => {
    const lower = String(h || '').toLowerCase();
    if (lower.includes('réponse') || lower.includes('reponse') ||
        lower.includes('response') || lower.includes('answer') ||
        lower.includes('choix') || lower.includes('option')) {
      if (!lower.includes('expl') && !lower.includes('comp') && !lower.includes('objectif')) {
        acc.push(i);
      }
    }
    return acc;
  }, []);

  if (qIdx < 0 || repCols.length === 0) {
    logger.warn('[ChoixMultiple] colonnes Question ou Réponse non trouvées');
    return [];
  }

  const LETTERS   = ['A', 'B', 'C', 'D', 'E', 'F'];
  const questions = [];

  for (let i = 1; i < rows.length; i++) {
    const row  = rows[i];
    const rawQ = cell(row, qIdx);
    if (!rawQ) continue;

    const { fr: text_fr, en: text_en } = splitFrEn(rawQ);
    if (!text_fr) continue;

    const choices_fr = [];
    const choices_en = [];

    repCols.forEach((colIdx, ci) => {
      if (ci >= LETTERS.length) return;
      const raw = cell(row, colIdx);
      if (!raw) return;
      const correct = isCorrectAnswer(raw);
      const cleaned = stripStars(raw);
      const { fr, en } = splitFrEn(cleaned);

      choices_fr.push({ letter: LETTERS[ci], text: fr || cleaned, correct });
      choices_en.push({ letter: LETTERS[ci], text: en || fr || cleaned, correct });
    });

    if (choices_fr.length === 0) continue;
    if (!choices_fr.some(c => c.correct)) {
      choices_fr[0].correct = true;
      choices_en[0].correct = true;
      warnings.push(`Ligne ${i + 1} : aucune bonne réponse marquée (*) — première option considérée correcte`);
    }

    const rawExp  = expIdx  >= 0 ? cell(row, expIdx)  : '';
    const rawComp = compIdx >= 0 ? cell(row, compIdx) : '';
    const { fr: expl_fr, en: expl_en } = splitFrEn(rawExp);
    const module_ref = resolveCompetence(rawComp, compToRef, warnings);

    // Auto-detect multiple correct answers
    const multiple_correct = choices_fr.filter(c => c.correct).length > 1 ? 1 : 0;

    questions.push({
      text_fr, text_en, type: 'multiple_choice',
      choices_fr, choices_en,
      explanation_fr: expl_fr || null,
      explanation_en: expl_en || null,
      module_ref, multiple_correct,
    });
  }
  return questions;
}

// ── Main entry points ─────────────────────────────────────────────────

function parseRiseUpQuestionsExcel(questionsBuffer, compToRef) {
  const wb       = XLSX.read(questionsBuffer, { type: 'buffer' });
  const warnings = [];
  const allQ     = [];

  const wsTF = getSheet(wb, ['Vrai ou faux', 'Vrai/Faux', 'True or false', 'True/False', 'VF']);
  if (wsTF) {
    const q = parseVraiFaux(wsTF, compToRef, warnings);
    logger.info(`[parseQuestions] Vrai/Faux: ${q.length} questions`);
    allQ.push(...q);
  } else {
    logger.warn('[parseQuestions] feuille Vrai/Faux non trouvée. Feuilles : ' + wb.SheetNames.join(', '));
  }

  const wsQCM = getSheet(wb, ['Choix multiple', 'Choix multiples', 'QCM', 'Multiple choice', 'MCQ']);
  if (wsQCM) {
    const q = parseChoixMultiple(wsQCM, compToRef, warnings);
    logger.info(`[parseQuestions] Choix multiple: ${q.length} questions`);
    allQ.push(...q);
  } else {
    logger.warn('[parseQuestions] feuille Choix multiple non trouvée. Feuilles : ' + wb.SheetNames.join(', '));
  }

  logger.info(`[parseQuestions] total: ${allQ.length}, avertissements: ${warnings.length}`);
  if (warnings.length > 0) {
    logger.warn('[parseQuestions] premiers avertissements', { sample: warnings.slice(0, 10) });
  }
  return { questions: allQ, warnings };
}

async function importFromRiseUp(questionsBuffer, formationsBuffer) {
  const compToRef = parseFormationsExcel(formationsBuffer);

  let modules_created = 0;
  for (const [, mod] of compToRef) {
    // Deduplicate: only insert each ref once
    const seen = new Set();
    if (!seen.has(mod.ref)) {
      repo.insertModule(mod);
      seen.add(mod.ref);
      modules_created++;
    }
  }

  const { questions, warnings } = parseRiseUpQuestionsExcel(questionsBuffer, compToRef);

  let imported = 0, skipped = 0;
  for (const q of questions) {
    try {
      const { created } = repo.insertQuestion(q);
      if (created) imported++; else skipped++;
    } catch (err) {
      logger.warn('[import] erreur insertion', { err: err.message });
      skipped++;
    }
  }

  logger.info('[importFromRiseUp] terminé', { imported, skipped, modules_created, warnings: warnings.length });
  return { imported, skipped, modules_created, warnings };
}

module.exports = { importFromRiseUp, parseFormationsExcel, parseRiseUpQuestionsExcel, splitFrEn };
