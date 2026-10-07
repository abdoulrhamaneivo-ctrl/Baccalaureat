'use strict';

const { normalize } = require('../dist/data.js');

const GAME_TYPES = ['petit-bac', 'capitales'];
const PREFIX = 'petit-bac:stats:v1';
const MATCH_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

const STORE_MATCH_SCRIPT = `
if not redis.call('SET', KEYS[1], '1', 'EX', ARGV[2], 'NX') then
  return 0
end
redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('LTRIM', KEYS[2], 0, 499)
for index = 3, #ARGV, 3 do
  redis.call('ZINCRBY', KEYS[3], ARGV[index + 2], ARGV[index])
  redis.call('HSET', KEYS[4], ARGV[index], ARGV[index + 1])
end
return 1
`;

function pseudoKey(value) {
  return normalize(String(value || '')).slice(0, 64);
}

function parseMatch(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch (_) { return null; }
}

function createStatsStore(redis = null, options = {}) {
  const matches = new Map(GAME_TYPES.map((gameType) => [gameType, []]));
  const totals = new Map(GAME_TYPES.map((gameType) => [gameType, new Map()]));
  const names = new Map(GAME_TYPES.map((gameType) => [gameType, new Map()]));
  const acceptedWords = new Map();
  const currentTime = options.now || Date.now;

  const key = (part, gameType) => `${PREFIX}:${part}:${gameType}`;
  const validGameType = (gameType) => GAME_TYPES.includes(gameType);

  async function recordMatch(match) {
    if (!match || !validGameType(match.gameType) || !Array.isArray(match.players)) return false;
    const publicMatch = {
      id: String(match.id),
      gameType: match.gameType,
      completedAt: Number(match.completedAt) || currentTime(),
      roundsPlayed: Number(match.roundsPlayed) || 0,
      players: match.players.map((player) => ({
        pseudo: String(player.pseudo || '').slice(0, 24),
        score: Math.max(0, Number(player.score) || 0),
      })),
    };
    if (redis) {
      const args = [JSON.stringify(publicMatch), MATCH_TTL_SECONDS];
      for (const player of publicMatch.players) {
        const member = pseudoKey(player.pseudo);
        if (!member) continue;
        args.push(member, player.pseudo, player.score);
      }
      const result = await redis.eval(
        STORE_MATCH_SCRIPT,
        4,
        `${PREFIX}:match:${publicMatch.id}`,
        key('history', publicMatch.gameType),
        key('ranking', publicMatch.gameType),
        key('names', publicMatch.gameType),
        ...args,
      );
      return Number(result) === 1;
    }

    const list = matches.get(publicMatch.gameType);
    if (list.some((entry) => entry.id === publicMatch.id)) return false;
    list.unshift(publicMatch);
    list.length = Math.min(list.length, 500);
    for (const player of publicMatch.players) {
      const member = pseudoKey(player.pseudo);
      if (!member) continue;
      const board = totals.get(publicMatch.gameType);
      board.set(member, (board.get(member) || 0) + player.score);
      names.get(publicMatch.gameType).set(member, player.pseudo);
    }
    return true;
  }

  async function getOverview() {
    const result = {};
    for (const gameType of GAME_TYPES) {
      if (redis) {
        const [rows, rawHistory] = await Promise.all([
          redis.zrevrange(key('ranking', gameType), 0, 9, 'WITHSCORES'),
          redis.lrange(key('history', gameType), 0, 19),
        ]);
        const pairs = [];
        for (let index = 0; index + 1 < rows.length; index += 2) pairs.push([rows[index], rows[index + 1]]);
        const displayNames = pairs.length ? await redis.hmget(key('names', gameType), ...pairs.map(([member]) => member)) : [];
        result[gameType] = {
          leaderboard: pairs.map(([member, score], index) => ({ pseudo: displayNames[index] || member, score: Number(score) || 0 })),
          history: rawHistory.map(parseMatch).filter(Boolean),
        };
      } else {
        result[gameType] = {
          leaderboard: [...totals.get(gameType).entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 10)
            .map(([member, score]) => ({ pseudo: names.get(gameType).get(member) || member, score })),
          history: [...matches.get(gameType)].slice(0, 20),
        };
      }
    }
    return result;
  }

  async function addApprovedWord(word, categoryIndex) {
    const normalizedWord = normalize(String(word || '').trim());
    if (normalizedWord.length < 2 || !Number.isInteger(categoryIndex) || categoryIndex < 0 || categoryIndex > 5) return false;
    const entry = { word: String(word).trim(), categoryIndex, approvedAt: currentTime() };
    if (redis) await redis.hset(`${PREFIX}:dictionary`, `${categoryIndex}:${normalizedWord}`, JSON.stringify(entry));
    acceptedWords.set(`${categoryIndex}:${normalizedWord}`, entry);
    return true;
  }

  async function getApprovedWords() {
    if (redis) {
      const entries = await redis.hgetall(`${PREFIX}:dictionary`);
      return Object.values(entries || {}).map(parseMatch).filter((entry) => entry && typeof entry.word === 'string' && Number.isInteger(entry.categoryIndex));
    }
    return [...acceptedWords.values()];
  }

  return { recordMatch, getOverview, addApprovedWord, getApprovedWords };
}

module.exports = { GAME_TYPES, createStatsStore, pseudoKey };
