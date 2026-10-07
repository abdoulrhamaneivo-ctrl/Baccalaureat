'use strict';

const { CATEGORIES, normalize, assess } = require('../dist/data.js');
const WORLD_COUNTRIES = require('../dist/world-data.js');
const { CULTURE_CATEGORIES, CULTURE_QUESTIONS } = require('../dist/culture-data.js');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DURATIONS = [30, 60, 90, 120];
const DEFAULT_CONFIG = Object.freeze({
  rounds: 5,
  duration: 60,
  categories: [...CATEGORIES],
  letterMode: 'random',
  firstLetter: 'A',
  excludedLetters: '',
  pauseSeconds: 10,
});
const CAPITALS_CONTINENTS = Object.freeze(['Afrique', 'Amériques', 'Asie', 'Europe', 'Océanie']);
const DEFAULT_CAPITALS_CONFIG = Object.freeze({ rounds: 10, duration: 15, questionMode: 'random', continents: [...CAPITALS_CONTINENTS], categories: [], letterMode: 'random', firstLetter: '', excludedLetters: '', pauseSeconds: 5 });
const CAPITALS_DURATIONS = [10, 15, 20, 30];
const CULTURE_DURATIONS = [10, 15, 20, 30];
const DEFAULT_CULTURE_CONFIG = Object.freeze({ rounds: 10, duration: 20, categories: [...CULTURE_CATEGORIES] });

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Configuration invalide.' };
  const rounds = Number(input.rounds);
  const duration = Number(input.duration);
  const categories = Array.isArray(input.categories) ? [...new Set(input.categories)] : [];
  const letterMode = input.letterMode;
  const firstLetter = String(input.firstLetter || '').trim().toUpperCase();
  const excludedLetters = String(input.excludedLetters || '').toUpperCase().replace(/[^A-Z]/g, '').split('').filter((letter, index, list) => list.indexOf(letter) === index).join('');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) return { error: 'Choisissez entre 1 et 50 manches.' };
  if (!DURATIONS.includes(duration)) return { error: 'Durée invalide.' };
  if (!categories.length || categories.some((category) => !CATEGORIES.includes(category))) return { error: 'Choisissez au moins une catégorie valide.' };
  if (!['random', 'host'].includes(letterMode)) return { error: 'Mode de choix des lettres invalide.' };
  if (!/^[A-Z]$/.test(firstLetter)) return { error: 'La première lettre doit être comprise entre A et Z.' };
  if (excludedLetters.length === LETTERS.length) return { error: 'Conservez au moins une lettre disponible.' };
  if (letterMode === 'host' && excludedLetters.includes(firstLetter)) return { error: 'La première lettre ne peut pas faire partie des lettres exclues.' };
  return {
    value: { rounds, duration, categories, letterMode, firstLetter, excludedLetters, pauseSeconds: 10 },
  };
}

function validateCapitalsConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Configuration invalide.' };
  const rounds = Number(input.rounds);
  const duration = Number(input.duration);
  const questionMode = input.questionMode || 'random';
  const continents = Array.isArray(input.continents) ? [...new Set(input.continents)] : [...CAPITALS_CONTINENTS];
  if (!Number.isInteger(rounds) || rounds < 5 || rounds > 30) return { error: 'Choisissez entre 5 et 30 questions.' };
  if (!CAPITALS_DURATIONS.includes(duration)) return { error: 'Durée de question invalide.' };
  if (!['random', 'country', 'capital'].includes(questionMode)) return { error: 'Choisissez un type de question valide.' };
  if (!continents.length || continents.some((continent) => !CAPITALS_CONTINENTS.includes(continent))) return { error: 'Choisissez au moins un continent valide.' };
  return { value: { ...DEFAULT_CAPITALS_CONFIG, rounds, duration, questionMode, continents } };
}

function validateCultureConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Configuration invalide.' };
  const rounds = Number(input.rounds);
  const duration = Number(input.duration);
  const categories = Array.isArray(input.categories) ? [...new Set(input.categories)] : [];
  if (!Number.isInteger(rounds) || rounds < 5 || rounds > 30) return { error: 'Choisissez entre 5 et 30 questions.' };
  if (!CULTURE_DURATIONS.includes(duration)) return { error: 'Durée de question invalide.' };
  if (!categories.length || categories.some((category) => !CULTURE_CATEGORIES.includes(category))) return { error: 'Choisissez au moins un thème valide.' };
  return { value: { rounds, duration, categories } };
}

function validatePlayerName(value) {
  if (typeof value !== 'string') return { error: 'Saisissez un pseudo.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) return { error: 'Le pseudo doit contenir de 1 à 24 caractères.' };
  return { value: name };
}

function validateAnswer(value) {
  if (typeof value !== 'string') return { error: 'Réponse invalide.' };
  if (value.length > 70) return { error: 'La réponse est trop longue.' };
  return { value: value.trim() };
}

function normalizeQuizAnswer(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/œ/gi, 'oe').replace(/æ/gi, 'ae').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isCapitalsAnswerCorrect(answer, question) {
  const normalized = normalizeQuizAnswer(answer);
  if (!normalized || !question) return false;
  const accepted = question.kind === 'country' ? question.country.names : question.country.capitals;
  return accepted.some((candidate) => normalizeQuizAnswer(candidate) === normalized);
}

function calculateCapitalsScores(players, answersByPlayer, question) {
  const result = Object.create(null);
  for (const player of players) {
    const word = answersByPlayer[player.id]?.[0] || '';
    const correct = isCapitalsAnswerCorrect(word, question);
    result[player.id] = {
      total: correct ? 10 : 0,
      answers: [{ word, correct, duplicate: false, points: correct ? 10 : 0, reason: correct ? 'Bonne réponse' : 'Réponse incorrecte' }],
    };
  }
  return result;
}

function calculateCultureScores(players, answersByPlayer, question) {
  const result = Object.create(null);
  for (const player of players) {
    const submitted = String(answersByPlayer[player.id]?.[0] || '');
    const selectedIndex = /^\d+$/.test(submitted) ? Number(submitted) : -1;
    const correct = Boolean(question && selectedIndex === question.answer);
    const word = selectedIndex >= 0 ? question?.options?.[selectedIndex] || '' : '';
    result[player.id] = {
      total: correct ? 10 : 0,
      answers: [{ word, correct, duplicate: false, points: correct ? 10 : 0, reason: correct ? 'Bonne réponse' : 'Réponse incorrecte' }],
    };
  }
  return result;
}

function calculateRoundScores(players, answersByPlayer, approvalsByPlayer, categories, letter) {
  const result = Object.create(null);
  for (const player of players) result[player.id] = { total: 0, answers: [] };

  categories.forEach((category, categoryIndex) => {
    const eligibleAnswers = [];
    for (const player of players) {
      const word = answersByPlayer[player.id]?.[categoryIndex] || '';
      const judged = assess(word, CATEGORIES.indexOf(category), letter);
      const approved = judged.eligible && approvalsByPlayer[player.id]?.[categoryIndex] === true;
      const correct = judged.points > 0 || approved;
      const key = correct ? normalize(word) : '';
      const answer = {
        word,
        correct,
        duplicate: false,
        points: 0,
        reason: correct ? (approved && judged.points === 0 ? 'Validé par les joueurs' : 'Mot reconnu') : judged.reason,
      };
      result[player.id].answers[categoryIndex] = answer;
      if (key) eligibleAnswers.push({ playerId: player.id, key });
    }

    const counts = new Map();
    for (const entry of eligibleAnswers) counts.set(entry.key, (counts.get(entry.key) || 0) + 1);
    for (const entry of eligibleAnswers) {
      const answer = result[entry.playerId].answers[categoryIndex];
      answer.duplicate = counts.get(entry.key) > 1;
      answer.points = answer.duplicate ? 0 : 10;
      answer.reason = answer.duplicate ? 'Réponse correcte en doublon · 0 point' : answer.reason;
      result[entry.playerId].total += answer.points;
    }
  });

  return result;
}

module.exports = {
  LETTERS, DURATIONS, DEFAULT_CONFIG, DEFAULT_CAPITALS_CONFIG, CAPITALS_DURATIONS, CAPITALS_CONTINENTS,
  CULTURE_CATEGORIES, CULTURE_QUESTIONS, DEFAULT_CULTURE_CONFIG, CULTURE_DURATIONS,
  WORLD_COUNTRIES, validateConfig, validateCapitalsConfig, validateCultureConfig, validatePlayerName,
  validateAnswer, normalizeQuizAnswer, isCapitalsAnswerCorrect,
  calculateRoundScores, calculateCapitalsScores, calculateCultureScores,
};
