'use strict';

const { normalize } = require('../dist/data.js');

const GAME_TYPES = ['petit-bac', 'capitales', 'culture'];
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
  const pool = options.pool || null;
  const matches = new Map(GAME_TYPES.map((gameType) => [gameType, []]));
  const totals = new Map(GAME_TYPES.map((gameType) => [gameType, new Map()]));
  const names = new Map(GAME_TYPES.map((gameType) => [gameType, new Map()]));
  const acceptedWords = new Map();
  const currentTime = options.now || Date.now;
  const key = (part, gameType) => `${PREFIX}:${part}:${gameType}`;
  const validGameType = (gameType) => GAME_TYPES.includes(gameType);
  const cleanMatch = (match) => ({
    id: String(match.id),
    gameType: match.gameType,
    completedAt: Number(match.completedAt) || currentTime(),
    roundsPlayed: Number(match.roundsPlayed) || 0,
    players: match.players.map((player) => ({
      pseudo: String(player.pseudo || '').slice(0, 24),
      score: Math.max(0, Number(player.score) || 0),
    })),
  });

  async function initialize() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_matches (
        match_id TEXT PRIMARY KEY,
        game_type TEXT NOT NULL CHECK (game_type IN ('petit-bac', 'capitales', 'culture')),
        completed_at BIGINT NOT NULL,
        rounds_played INTEGER NOT NULL,
        players JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS game_matches_recent_idx ON game_matches (game_type, completed_at DESC);
      CREATE TABLE IF NOT EXISTS game_leaderboard_totals (
        game_type TEXT NOT NULL CHECK (game_type IN ('petit-bac', 'capitales', 'culture')),
        pseudo_key TEXT NOT NULL,
        pseudo TEXT NOT NULL,
        score BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (game_type, pseudo_key)
      );
      CREATE INDEX IF NOT EXISTS game_leaderboard_rank_idx ON game_leaderboard_totals (game_type, score DESC);
      CREATE TABLE IF NOT EXISTS game_approved_words (
        category_index SMALLINT NOT NULL,
        normalized_word TEXT NOT NULL,
        word TEXT NOT NULL,
        approved_at BIGINT NOT NULL,
        PRIMARY KEY (category_index, normalized_word)
      );
      CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL);
    `);
  }

  async function recordMatch(match) {
    if (!match || !validGameType(match.gameType) || !Array.isArray(match.players)) return false;
    const publicMatch = cleanMatch(match);
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          'INSERT INTO game_matches (match_id, game_type, completed_at, rounds_played, players) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (match_id) DO NOTHING RETURNING match_id',
          [publicMatch.id, publicMatch.gameType, publicMatch.completedAt, publicMatch.roundsPlayed, JSON.stringify(publicMatch.players)],
        );
        if (!inserted.rowCount) { await client.query('COMMIT'); return false; }
        for (const player of publicMatch.players) {
          const member = pseudoKey(player.pseudo);
          if (!member) continue;
          await client.query(
            'INSERT INTO game_leaderboard_totals (game_type, pseudo_key, pseudo, score) VALUES ($1, $2, $3, $4) ON CONFLICT (game_type, pseudo_key) DO UPDATE SET pseudo = EXCLUDED.pseudo, score = game_leaderboard_totals.score + EXCLUDED.score',
            [publicMatch.gameType, member, player.pseudo, player.score],
          );
        }
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    }
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

  async function updateMatch(match) {
    if (!match || !validGameType(match.gameType) || !Array.isArray(match.players)) return false;
    const publicMatch = cleanMatch(match);
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT players FROM game_matches WHERE match_id = $1 FOR UPDATE', [publicMatch.id]);
        if (!existing.rowCount) { await client.query('ROLLBACK'); return false; }
        const oldPlayers = Array.isArray(existing.rows[0].players) ? existing.rows[0].players : parseMatch(existing.rows[0].players) || [];
        const deltas = new Map();
        for (const player of oldPlayers) {
          const member = pseudoKey(player.pseudo);
          if (member) deltas.set(member, { pseudo: player.pseudo, delta: (deltas.get(member)?.delta || 0) - (Number(player.score) || 0) });
        }
        for (const player of publicMatch.players) {
          const member = pseudoKey(player.pseudo);
          if (member) deltas.set(member, { pseudo: player.pseudo, delta: (deltas.get(member)?.delta || 0) + player.score });
        }
        for (const [member, change] of deltas) {
          await client.query(
            'INSERT INTO game_leaderboard_totals (game_type, pseudo_key, pseudo, score) VALUES ($1, $2, $3, $4) ON CONFLICT (game_type, pseudo_key) DO UPDATE SET pseudo = EXCLUDED.pseudo, score = GREATEST(0, game_leaderboard_totals.score + EXCLUDED.score)',
            [publicMatch.gameType, member, change.pseudo, change.delta],
          );
        }
        await client.query('UPDATE game_matches SET completed_at = $2, rounds_played = $3, players = $4 WHERE match_id = $1', [publicMatch.id, publicMatch.completedAt, publicMatch.roundsPlayed, JSON.stringify(publicMatch.players)]);
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    }
    if (redis && GAME_TYPES.slice(0, 2).includes(publicMatch.gameType)) {
      const historyKey = key('history', publicMatch.gameType);
      const rows = await redis.lrange(historyKey, 0, -1);
      const index = rows.findIndex((value) => parseMatch(value)?.id === publicMatch.id);
      if (index < 0) return false;
      const previous = parseMatch(rows[index]);
      const transaction = redis.multi();
      for (const player of previous.players || []) {
        const member = pseudoKey(player.pseudo);
        if (member) transaction.zincrby(key('ranking', publicMatch.gameType), -(Number(player.score) || 0), member);
      }
      for (const player of publicMatch.players) {
        const member = pseudoKey(player.pseudo);
        if (!member) continue;
        transaction.zincrby(key('ranking', publicMatch.gameType), player.score, member);
        transaction.hset(key('names', publicMatch.gameType), member, player.pseudo);
      }
      transaction.lset(historyKey, index, JSON.stringify(publicMatch));
      await transaction.exec();
      return true;
    }
    const list = matches.get(publicMatch.gameType);
    const index = list.findIndex((entry) => entry.id === publicMatch.id);
    if (index < 0) return false;
    const previous = list[index];
    for (const player of previous.players) {
      const member = pseudoKey(player.pseudo);
      if (!member) continue;
      const board = totals.get(publicMatch.gameType);
      board.set(member, Math.max(0, (board.get(member) || 0) - player.score));
    }
    for (const player of publicMatch.players) {
      const member = pseudoKey(player.pseudo);
      if (!member) continue;
      const board = totals.get(publicMatch.gameType);
      board.set(member, (board.get(member) || 0) + player.score);
      names.get(publicMatch.gameType).set(member, player.pseudo);
    }
    list[index] = publicMatch;
    return true;
  }

  async function getOverview() {
    const result = {};
    for (const gameType of GAME_TYPES) {
      if (pool) {
        const [leaders, recent] = await Promise.all([
          pool.query('SELECT pseudo, score FROM game_leaderboard_totals WHERE game_type = $1 ORDER BY score DESC, pseudo_key ASC LIMIT 10', [gameType]),
          pool.query('SELECT match_id, completed_at, rounds_played, players FROM game_matches WHERE game_type = $1 ORDER BY completed_at DESC LIMIT 20', [gameType]),
        ]);
        result[gameType] = {
          leaderboard: leaders.rows.map((row) => ({ pseudo: row.pseudo, score: Number(row.score) || 0 })),
          history: recent.rows.map((row) => ({ id: row.match_id, gameType, completedAt: Number(row.completed_at), roundsPlayed: row.rounds_played, players: row.players })),
        };
      } else if (redis && GAME_TYPES.slice(0, 2).includes(gameType)) {
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
    if (normalizedWord.length < 3 || !Number.isInteger(categoryIndex) || categoryIndex < 0 || categoryIndex > 5) return false;
    const entry = { word: String(word).trim(), categoryIndex, approvedAt: currentTime() };
    if (pool) {
      await pool.query('INSERT INTO game_approved_words (category_index, normalized_word, word, approved_at) VALUES ($1, $2, $3, $4) ON CONFLICT (category_index, normalized_word) DO UPDATE SET word = EXCLUDED.word, approved_at = EXCLUDED.approved_at', [categoryIndex, normalizedWord, entry.word, entry.approvedAt]);
    } else if (redis) {
      await redis.hset(`${PREFIX}:dictionary`, `${categoryIndex}:${normalizedWord}`, JSON.stringify(entry));
    }
    acceptedWords.set(`${categoryIndex}:${normalizedWord}`, entry);
    return true;
  }

  async function getApprovedWords() {
    if (pool) {
      const rows = await pool.query('SELECT word, category_index, approved_at FROM game_approved_words');
      return rows.rows.map((row) => ({ word: row.word, categoryIndex: row.category_index, approvedAt: Number(row.approved_at) }));
    }
    if (redis) {
      const entries = await redis.hgetall(`${PREFIX}:dictionary`);
      return Object.values(entries || {}).map(parseMatch).filter((entry) => entry && typeof entry.word === 'string' && Number.isInteger(entry.categoryIndex));
    }
    return [...acceptedWords.values()];
  }

  async function migrateLegacyRedis(legacyRedis) {
    if (!pool || !legacyRedis) return false;
    const migrationName = 'upstash_stats_v1';
    const { rows } = await pool.query('SELECT 1 FROM app_migrations WHERE name = $1', [migrationName]);
    if (rows.length) return false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const gameType of ['petit-bac', 'capitales']) {
        const rawMatches = await legacyRedis.lrange(key('history', gameType), 0, -1);
        const importedMatches = [];
        for (const raw of rawMatches) {
          const match = parseMatch(raw);
          if (!match || !Array.isArray(match.players) || !match.id) continue;
          importedMatches.push(cleanMatch({ ...match, gameType }));
        }
        if (importedMatches.length) await client.query(
          `INSERT INTO game_matches (match_id, game_type, completed_at, rounds_played, players)
           SELECT match_id, game_type, completed_at, rounds_played, players
           FROM jsonb_to_recordset($1::jsonb) AS imported(match_id TEXT, game_type TEXT, completed_at BIGINT, rounds_played INTEGER, players JSONB)
           ON CONFLICT (match_id) DO NOTHING`,
          [JSON.stringify(importedMatches.map((match) => ({ match_id: match.id, game_type: gameType, completed_at: match.completedAt, rounds_played: match.roundsPlayed, players: match.players })))],
        );
        const computedTotals = new Map();
        for (const match of importedMatches) for (const player of match.players) {
          const pseudo_key = pseudoKey(player.pseudo);
          if (!pseudo_key) continue;
          const existing = computedTotals.get(pseudo_key) || { game_type: gameType, pseudo_key, pseudo: player.pseudo, score: 0 };
          existing.score += player.score;
          existing.pseudo = player.pseudo;
          computedTotals.set(pseudo_key, existing);
        }
        if (computedTotals.size) await client.query(
          `INSERT INTO game_leaderboard_totals (game_type, pseudo_key, pseudo, score)
           SELECT game_type, pseudo_key, pseudo, score
           FROM jsonb_to_recordset($1::jsonb) AS imported(game_type TEXT, pseudo_key TEXT, pseudo TEXT, score BIGINT)
           ON CONFLICT (game_type, pseudo_key) DO UPDATE SET score = game_leaderboard_totals.score + EXCLUDED.score`,
          [JSON.stringify([...computedTotals.values()])],
        );
        const ranking = await legacyRedis.zrevrange(key('ranking', gameType), 0, -1, 'WITHSCORES');
        const members = [];
        for (let index = 0; index + 1 < ranking.length; index += 2) members.push([ranking[index], ranking[index + 1]]);
        const displayNames = members.length ? await legacyRedis.hmget(key('names', gameType), ...members.map(([member]) => member)) : [];
        const legacyLeaders = [];
        for (let index = 0; index < members.length; index += 1) {
          const [member, score] = members[index];
          legacyLeaders.push({ game_type: gameType, pseudo_key: member, pseudo: displayNames[index] || member, score: Number(score) || 0 });
        }
        if (legacyLeaders.length) await client.query(
          `INSERT INTO game_leaderboard_totals (game_type, pseudo_key, pseudo, score)
           SELECT game_type, pseudo_key, pseudo, score
           FROM jsonb_to_recordset($1::jsonb) AS imported(game_type TEXT, pseudo_key TEXT, pseudo TEXT, score BIGINT)
           ON CONFLICT (game_type, pseudo_key) DO UPDATE SET pseudo = EXCLUDED.pseudo, score = EXCLUDED.score`,
          [JSON.stringify(legacyLeaders)],
        );
      }
      const legacyWords = await legacyRedis.hgetall(`${PREFIX}:dictionary`);
      const importedWords = [];
      for (const raw of Object.values(legacyWords || {})) {
        const entry = parseMatch(raw);
        if (!entry || !Number.isInteger(entry.categoryIndex)) continue;
        const normalized = normalize(String(entry.word || '').trim());
        if (!normalized) continue;
        importedWords.push({ category_index: entry.categoryIndex, normalized_word: normalized, word: entry.word, approved_at: Number(entry.approvedAt) || currentTime() });
      }
      if (importedWords.length) await client.query(
        `INSERT INTO game_approved_words (category_index, normalized_word, word, approved_at)
         SELECT category_index, normalized_word, word, approved_at
         FROM jsonb_to_recordset($1::jsonb) AS imported(category_index SMALLINT, normalized_word TEXT, word TEXT, approved_at BIGINT)
         ON CONFLICT (category_index, normalized_word) DO NOTHING`,
        [JSON.stringify(importedWords)],
      );
      await client.query('INSERT INTO app_migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [migrationName, currentTime()]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return { initialize, recordMatch, updateMatch, getOverview, addApprovedWord, getApprovedWords, migrateLegacyRedis };
}

module.exports = { GAME_TYPES, createStatsStore, pseudoKey };
