'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { CATEGORIES, normalize, assess, addAcceptedWord } = require('./dist/data.js');
const {
  LETTERS,
  DEFAULT_CONFIG,
  DEFAULT_CAPITALS_CONFIG,
  DEFAULT_CULTURE_CONFIG,
  validateConfig,
  validateCapitalsConfig,
  validateCultureConfig,
  validatePlayerName,
  validateAnswer,
  calculateRoundScores,
  calculateCapitalsScores,
  calculateCultureScores,
  isCapitalsAnswerCorrect,
  WORLD_COUNTRIES,
  CAPITALS_CONTINENTS,
  CULTURE_QUESTIONS,
  CULTURE_TRUE_FALSE_QUESTIONS,
} = require('./server/game-rules.js');
const { createStatsStore } = require('./server/stats-store.js');

const REVIEW_SECONDS = 20;
const CAPITALS_REVIEW_SECONDS = 5;
const DISCONNECTED_ROOM_TTL = 10 * 60 * 1000;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createGameServer(options = {}) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    serveClient: true,
    path: options.socketPath || '/socket.io',
    addTrailingSlash: options.addTrailingSlash !== false,
    cors: { origin: false },
  });
  const rooms = new Map();
  const transactions = new AsyncLocalStorage();
  const redis = options.redis || null;
  const checkpointRedis = options.checkpointRedis || null;
  const roomRedis = checkpointRedis || redis;
  const port = options.port ?? Number(process.env.PORT || 3000);
  const now = options.now || Date.now;
  const stats = options.statsStore || createStatsStore(options.statsRedis !== undefined ? options.statsRedis : redis, { now, pool: options.statsPool });
  const scheduleTimer = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  let closing = false;
  const checkpointTimers = new Map();
  const checkpointWrites = new Map();

  if (options.serveStatic !== false) app.use(express.static(path.join(__dirname, 'dist'), { extensions: ['html'] }));
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

  const correctionVotesRequired = (players) => players.length === 2 ? 1 : players.length >= 3 ? 2 : Infinity;
  let dictionaryRefreshedAt = 0;
  const refreshAcceptedWords = async () => {
    if (now() - dictionaryRefreshedAt < 5_000) return;
    const entries = await stats.getApprovedWords();
    for (const entry of entries) addAcceptedWord(entry.word, entry.categoryIndex);
    dictionaryRefreshedAt = now();
  };
  const storeAcceptedWord = async (word, categoryIndex) => {
    try { await stats.addApprovedWord(word, categoryIndex); }
    catch (error) { logTimerError(error); }
  };
  const recordFinishedGame = (room) => {
    if (room.matchId) return;
    room.matchId = crypto.randomUUID();
    room.matchPlayers = room.players.map((player) => ({ id: player.id, name: player.name, score: player.score }));
    const match = {
      id: room.matchId,
      gameType: room.gameType,
      completedAt: room.matchCompletedAt = now(),
      roundsPlayed: room.history.length,
      players: room.players.map((player) => ({ pseudo: player.name, score: player.score })),
    };
    const persist = () => { void stats.recordMatch(match).catch(logTimerError); };
    const context = transactions.getStore();
    if (context) context.afterCommit.push(persist);
    else void persist();
  };
  const updateFinishedGame = (room) => {
    if (!room.matchId || typeof stats.updateMatch !== 'function') return;
    const activeScores = new Map(room.players.map((player) => [player.id, player.score]));
    const matchPlayers = room.matchPlayers || room.players.map((player) => ({ id: player.id, name: player.name, score: player.score }));
    for (const participant of matchPlayers) {
      if (activeScores.has(participant.id)) participant.score = activeScores.get(participant.id);
    }
    const match = {
      id: room.matchId,
      gameType: room.gameType,
      completedAt: room.matchCompletedAt || now(),
      roundsPlayed: room.history.length,
      players: matchPlayers.map((player) => ({ pseudo: player.name, score: player.score })),
    };
    const persist = () => { void stats.updateMatch(match).catch(logTimerError); };
    const context = transactions.getStore();
    if (context) context.afterCommit.push(persist);
    else persist();
  };

  const roomKey = (code) => `petit-bac:room:${code}`;
  const lockKey = (code) => code === null ? 'petit-bac:lock:create' : `petit-bac:lock:${code}`;
  const correctionReviewers = (room) => room.state === 'finished' && Array.isArray(room.matchPlayers) && room.matchPlayers.length
    ? room.matchPlayers
    : room.players;
  const correctionVotesRequiredForRoom = (room) => correctionVotesRequired({ length: correctionReviewers(room).length });
  const serializedRoom = (room) => {
    const { timers: _timers, ...state } = room;
    return JSON.stringify(state);
  };
  const acquireLock = async (key) => {
    const token = crypto.randomBytes(16).toString('hex');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await redis.set(key, token, 'PX', 8000, 'NX')) return token;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('La salle est occupée. Réessayez dans quelques secondes.');
  };
  const releaseLock = (key, token) => redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    token,
  );

  const clearTimer = (room, key) => {
    if (room.timers[key]) cancelTimer(room.timers[key]);
    room.timers[key] = null;
  };
  const clearAllTimers = (room) => Object.keys(room.timers).forEach((key) => clearTimer(room, key));

  const restoreTimers = (room) => {
    const remaining = (deadline) => Math.max(1, deadline - now());
    if (room.state === 'playing' && room.roundEndsAt) {
      const roundNumber = room.roundNumber;
      room.timers.round = scheduleTimer(() => runTimer(() => endRound(room.code, roundNumber)), remaining(room.roundEndsAt));
    } else if (room.state === 'correction' && room.correctionEndsAt) {
      const roundNumber = room.roundNumber;
      room.timers.review = scheduleTimer(() => runTimer(() => advanceAfterCorrection(room.code, roundNumber)), remaining(room.correctionEndsAt));
    } else if (room.state === 'break' && room.breakEndsAt) {
      const roundNumber = room.roundNumber;
      room.timers.break = scheduleTimer(() => runTimer(() => startNextRound(room.code, roundNumber)), remaining(room.breakEndsAt));
    }
    if (!room.players.some((player) => player.connected)) {
      room.timers.idle = scheduleTimer(() => runTimer(() => expireDisconnectedRoom(room.code)), DISCONNECTED_ROOM_TTL);
    }
  };

  const persistRoom = async (code) => {
    if (!roomRedis) return;
    const room = rooms.get(code);
    if (!room) {
      await roomRedis.del(roomKey(code));
      return;
    }
    const ttl = room.players.some((player) => player.connected) ? 24 * 60 * 60 : Math.ceil(DISCONNECTED_ROOM_TTL / 1000);
    await roomRedis.set(roomKey(code), serializedRoom(room), 'EX', ttl);
  };
  const writeCheckpoint = (code) => {
    const previous = checkpointWrites.get(code) || Promise.resolve();
    const next = previous.catch(logTimerError).then(() => persistRoom(code));
    checkpointWrites.set(code, next);
    next.catch(logTimerError).finally(() => {
      if (checkpointWrites.get(code) === next) checkpointWrites.delete(code);
    });
    return next;
  };
  const scheduleCheckpoint = (code) => {
    if (!checkpointRedis) return;
    const previous = checkpointTimers.get(code);
    if (previous) clearTimeout(previous);
    checkpointTimers.set(code, setTimeout(() => {
      checkpointTimers.delete(code);
      void writeCheckpoint(code);
    }, options.checkpointDelayMs || 5000));
  };
  const restoreCheckpointedRooms = async () => {
    if (!checkpointRedis) return 0;
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, page] = await checkpointRedis.scan(cursor, 'MATCH', 'petit-bac:room:*', 'COUNT', 100);
      cursor = String(nextCursor);
      keys.push(...page);
    } while (cursor !== '0');
    let restored = 0;
    for (let offset = 0; offset < keys.length; offset += 100) {
      const pageKeys = keys.slice(offset, offset + 100);
      const values = await checkpointRedis.mget(...pageKeys);
      for (let index = 0; index < pageKeys.length; index += 1) {
        try {
          const room = typeof values[index] === 'string' ? JSON.parse(values[index]) : values[index];
          if (!room || !Array.isArray(room.players) || !['petit-bac', 'capitales', 'culture'].includes(room.gameType)) continue;
          if (room.gameType === 'petit-bac') room.config.pauseSeconds ??= DEFAULT_CONFIG.pauseSeconds;
          room.teamMode = Boolean(room.teamMode);
          room.eliminationMode = Boolean(room.eliminationMode);
          room.eliminationDraw = Boolean(room.eliminationDraw);
          room.eliminationNotice ||= null;
          room.teamCount = [2, 3, 4].includes(Number(room.teamCount)) ? Number(room.teamCount) : 2;
          room.players.forEach((player) => { player.teamId ??= null; player.left ||= false; player.eliminatedAt ??= null; });
          room.currentAnswers ||= Object.create(null);
          room.currentAnswerRevisions ||= Object.create(null);
          room.currentApprovals ||= Object.create(null);
          room.currentVotes ||= Object.create(null);
          room.currentAnswerOrder ||= Object.create(null);
          room.currentHints ||= Object.create(null);
          room.answerSequence ||= 0;
          room.rankingOrder ||= room.players.map((player) => player.id);
          room.pendingAcceptedWords ||= [];
          room.usedQuestions ||= [];
          for (const player of room.players) {
            const answerCount = room.gameType === 'petit-bac' ? room.config.categories.length : 1;
            room.currentAnswers[player.id] ||= Array(answerCount).fill('');
            room.currentAnswerRevisions[player.id] ||= Array(answerCount).fill(0);
            room.currentApprovals[player.id] ||= Array(answerCount).fill(false);
            room.currentVotes[player.id] ||= Array.from({ length: answerCount }, () => Object.create(null));
            room.currentAnswerOrder[player.id] ||= Array(answerCount).fill(0);
            player.connected = false;
            player.socketId = null;
          }
          room.hostId = room.players.find((player) => player.id === room.hostId)?.id || room.players[0]?.id;
          room.timers = { round: null, review: null, break: null, idle: null };
          rooms.set(room.code, room);
          restoreTimers(room);
          scheduleCheckpoint(room.code);
          restored += 1;
        } catch (error) {
          console.error(`Impossible de reprendre la salle ${pageKeys[index]} :`, error.message);
        }
      }
    }
    return restored;
  };

  const withRoomTransaction = async (code, operation, metadata = {}) => {
    const key = lockKey(code);
    let token;
    try {
      token = await acquireLock(key);
      if (code !== null) {
        const cached = rooms.get(code);
        if (cached) clearAllTimers(cached);
        const stored = await redis.get(roomKey(code));
        if (stored) {
          const room = typeof stored === 'string' ? JSON.parse(stored) : stored;
          if (room.gameType === 'petit-bac') room.config.pauseSeconds ??= DEFAULT_CONFIG.pauseSeconds;
          room.teamMode = Boolean(room.teamMode);
          room.eliminationMode = Boolean(room.eliminationMode);
          room.eliminationDraw = Boolean(room.eliminationDraw);
          room.eliminationNotice ||= null;
          room.teamCount = [2, 3, 4].includes(Number(room.teamCount)) ? Number(room.teamCount) : 2;
          room.players.forEach((player) => { player.teamId ??= null; player.left ||= false; player.eliminatedAt ??= null; });
          room.currentAnswers ||= Object.create(null);
          room.currentAnswerRevisions ||= Object.create(null);
          room.currentApprovals ||= Object.create(null);
          room.currentVotes ||= Object.create(null);
          room.currentAnswerOrder ||= Object.create(null);
          room.currentHints ||= Object.create(null);
          room.answerSequence ||= 0;
          room.rankingOrder ||= room.players.map((player) => player.id);
          for (const player of room.players) {
            const answerCount = room.gameType === 'petit-bac' ? room.config.categories.length : 1;
            room.currentAnswers[player.id] ||= Array(answerCount).fill('');
            room.currentAnswerRevisions[player.id] ||= Array(answerCount).fill(0);
            room.currentApprovals[player.id] ||= Array(answerCount).fill(false);
            room.currentVotes[player.id] ||= Array.from({ length: answerCount }, () => Object.create(null));
            room.currentAnswerOrder[player.id] ||= Array(answerCount).fill(0);
          }
          room.timers = { round: null, review: null, break: null, idle: null };
          rooms.set(code, room);
          restoreTimers(room);
        } else {
          rooms.delete(code);
        }
      }
      const context = { ...metadata, changedRooms: new Set(), persistRooms: new Set(), acknowledgements: [], afterCommit: [] };
      const roomBeforeOperation = code === null ? null : rooms.get(code);
      await transactions.run(context, () => {
        if (code !== null) {
          const room = rooms.get(code);
          const isAnswerUpdate = context.event === 'answer:update' || context.event === 'answers:update';
          const arrivedBeforeDeadline = isAnswerUpdate && room?.state === 'playing' && room.roundEndsAt && context.receivedAt < room.roundEndsAt;
          if (room && !arrivedBeforeDeadline) reconcileRoomTime(room);
        }
        return operation();
      });
      const roomsToPersist = new Set(context.persistRooms);
      for (const changedCode of context.changedRooms) roomsToPersist.add(changedCode);
      for (const changedCode of roomsToPersist) await persistRoom(changedCode);
      for (const callback of context.afterCommit) await callback();
      for (const ack of context.acknowledgements) ack.callback(ack.response);
      for (const changedCode of context.changedRooms) {
        const room = rooms.get(changedCode);
        if (room) emitStateImmediately(room);
      }
    } finally {
      if (token) await releaseLock(key, token).catch(logTimerError);
    }
  };

  const logTimerError = (error) => {
    if (error) console.error('Erreur de minuterie de salle :', error.message);
  };
  void refreshAcceptedWords().catch(logTimerError);
  const dictionaryRefreshTimer = setInterval(() => { void refreshAcceptedWords().catch(logTimerError); }, 15_000);
  dictionaryRefreshTimer.unref?.();
  const runTimer = (operation) => {
    try {
      const result = operation();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          logTimerError(error);
          scheduleTimer(() => runTimer(operation), 1000);
        });
      }
    } catch (error) {
      logTimerError(error);
      scheduleTimer(() => runTimer(operation), 1000);
    }
  };

  const generateCode = () => {
    let code;
    do {
      code = Array.from(crypto.randomBytes(6), (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
    } while (rooms.has(code));
    return code;
  };
  const makeRoom = (host) => {
    const code = generateCode();
    const gameType = host.gameType;
    const room = {
      code,
      gameType,
      hostId: host.id,
      players: [host],
      state: 'lobby',
      teamMode: false,
      teamCount: 2,
      eliminationMode: false,
      eliminationDraw: false,
      eliminationNotice: null,
      config: gameType === 'capitales'
        ? { ...DEFAULT_CAPITALS_CONFIG, continents: [...DEFAULT_CAPITALS_CONFIG.continents] }
        : gameType === 'culture'
          ? { ...DEFAULT_CULTURE_CONFIG, categories: [...DEFAULT_CULTURE_CONFIG.categories] }
          : { ...DEFAULT_CONFIG, categories: [...DEFAULT_CONFIG.categories] },
      roundNumber: 0,
      letter: null,
      roundStartedAt: null,
      roundEndsAt: null,
      correctionEndsAt: null,
      breakEndsAt: null,
      usedLetters: [],
      usedCountries: [],
      usedQuestions: [],
      question: null,
      currentAnswers: Object.create(null),
      currentAnswerRevisions: Object.create(null),
      currentApprovals: Object.create(null),
      currentVotes: Object.create(null),
      currentAnswerOrder: Object.create(null),
      answerSequence: 0,
      currentHints: Object.create(null),
      currentScores: null,
      history: [],
      rankingOrder: [host.id],
      roundStartingRanking: [host.id],
      pendingAcceptedWords: [],
      matchId: null,
      gameStartedAt: null,
      timers: { round: null, review: null, break: null, idle: null },
      createdAt: now(),
    };
    rooms.set(code, room);
    return room;
  };
  const rankedPlayers = (room, tieOrder = room.rankingOrder || room.players.map((player) => player.id)) => {
    const previous = new Map(tieOrder.map((playerId, index) => [playerId, index]));
    return [...room.players].sort((left, right) => (room.eliminationMode ? Number(Number.isInteger(left.eliminatedAt)) - Number(Number.isInteger(right.eliminatedAt)) : 0)
      || right.score - left.score
      || (previous.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (previous.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  };
  const balanceTeams = (room) => {
    const counts = Array(room.teamCount).fill(0);
    for (const player of room.players) {
      const teamId = counts.indexOf(Math.min(...counts));
      player.teamId = teamId;
      counts[teamId] += 1;
    }
  };
  const addToSmallestTeam = (room, player) => {
    const counts = Array(room.teamCount).fill(0);
    for (const member of room.players) {
      if (member.id !== player.id && Number.isInteger(member.teamId) && member.teamId >= 0 && member.teamId < room.teamCount) counts[member.teamId] += 1;
    }
    player.teamId = counts.indexOf(Math.min(...counts));
  };
  const teamStandings = (room) => Array.from({ length: room.teamCount }, (_, id) => {
    const players = room.players.filter((player) => player.teamId === id);
    const eliminationRounds = players.map((player) => player.eliminatedAt).filter(Number.isInteger);
    const eliminatedAt = eliminationRounds.length ? Math.min(...eliminationRounds) : null;
    return {
      id,
      name: `Équipe ${id + 1}`,
      score: players.reduce((total, player) => total + (Number(player.score) || 0), 0),
      eliminatedAt,
      eliminated: eliminatedAt !== null,
      players: players.map((player) => ({ id: player.id, name: player.name, connected: player.connected, left: Boolean(player.left), eliminatedAt: player.eliminatedAt ?? null })),
    };
  }).sort((left, right) => (room.eliminationMode ? Number(left.eliminated) - Number(right.eliminated) : 0)
    || right.score - left.score || left.id - right.id).map((team, index) => ({ ...team, rank: index + 1 }));
  const playerEliminationRound = (room, player) => {
    if (!room.eliminationMode || !player) return null;
    if (Number.isInteger(player.eliminatedAt)) return player.eliminatedAt;
    if (!room.teamMode) return null;
    const team = teamStandings(room).find((candidate) => candidate.id === player.teamId);
    return team ? team.eliminatedAt : room.roundNumber;
  };
  const isPlayerEliminated = (room, player) => Number.isInteger(playerEliminationRound(room, player));
  const activeCompetitors = (room) => room.teamMode
    ? teamStandings(room).filter((team) => !team.eliminated)
    : room.players.filter((player) => !Number.isInteger(player.eliminatedAt)).map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      playerIds: [player.id],
    }));
  const eliminateLastCompetitor = (room) => {
    const active = activeCompetitors(room);
    room.eliminationDraw = false;
    room.eliminationNotice = null;
    if (active.length === 0) {
      room.eliminationDraw = true;
      room.eliminationNotice = 'Tous les concurrents ont été éliminés. Le Rush se termine sans gagnant.';
      return true;
    }
    if (active.length > 2) {
      const lowestScore = Math.min(...active.map((competitor) => competitor.score));
      const last = active.filter((competitor) => competitor.score === lowestScore);
      if (last.length === active.length) {
        room.eliminationNotice = `Égalité générale entre les ${room.teamMode ? 'équipes' : 'joueurs'} : une manche de départage commence.`;
        return false;
      }
      for (const eliminated of last) {
        const playerIds = eliminated.playerIds || eliminated.players.map((player) => player.id);
        for (const player of room.players) {
          if (playerIds.includes(player.id)) player.eliminatedAt = room.roundNumber;
        }
      }
      const remaining = activeCompetitors(room);
      const eliminatedNames = last.map((competitor) => competitor.name).join(', ');
      if (remaining.length === 0) {
        room.eliminationDraw = true;
        room.eliminationNotice = `Tous les concurrents étaient à égalité à la dernière place (${eliminatedNames}) et sont éliminés ensemble. Le Rush se termine sans gagnant.`;
        return true;
      }
      if (last.length > 1) {
        room.eliminationNotice = `Égalité à la dernière place : ${eliminatedNames}. Ils sont éliminés ensemble après la manche ${room.roundNumber}. ${remaining.length} ${room.teamMode ? 'équipes' : 'joueurs'} restent en lice.`;
      } else {
        room.eliminationNotice = `${eliminatedNames} est éliminé${room.teamMode ? 'e' : ''} après la manche ${room.roundNumber}. ${remaining.length} ${room.teamMode ? 'équipes' : 'joueurs'} restent en lice.`;
      }
    }
    const remaining = activeCompetitors(room);
    if (remaining.length === 2) {
      const [first, second] = remaining;
      if (first.score === second.score) {
        room.eliminationNotice = `Égalité entre ${first.name} et ${second.name} : une manche de départage commence.`;
        return false;
      }
      const winner = first.score > second.score ? first : second;
      room.eliminationNotice = `${winner.name} remporte le Rush après ${room.roundNumber} manches.`;
      return true;
    }
    if (remaining.length === 1) {
      room.eliminationNotice = `${remaining[0].name} remporte le Rush après ${room.roundNumber} manches.`;
      return true;
    }
    return remaining.length < 2;
  };
  const stateFor = (room, viewer) => {
    const ranks = new Map(rankedPlayers(room).map((player, index) => [player.id, index + 1]));
    const result = {
      code: room.code,
      gameType: room.gameType,
      state: room.state,
      serverNow: now(),
      hostId: room.hostId,
      hostName: room.players.find((player) => player.id === room.hostId)?.name || null,
      isHost: viewer?.id === room.hostId,
      config: { ...room.config, categories: [...room.config.categories] },
      teamMode: Boolean(room.teamMode),
      teamCount: room.teamCount,
      teams: room.teamMode ? teamStandings(room) : [],
      eliminationMode: Boolean(room.eliminationMode),
      eliminationDraw: Boolean(room.eliminationDraw),
      eliminationNotice: room.eliminationNotice,
      activeCompetitors: room.eliminationMode ? activeCompetitors(room).length : null,
      myEliminated: isPlayerEliminated(room, viewer),
      players: room.players.map((player) => ({ id: player.id, name: player.name, score: player.score, rank: ranks.get(player.id), teamId: player.teamId ?? null, left: Boolean(player.left), eliminatedAt: playerEliminationRound(room, player), connected: player.connected, isHost: player.id === room.hostId })),
      roundNumber: room.roundNumber,
      letter: room.letter,
      roundStartedAt: room.roundStartedAt,
      roundEndsAt: room.roundEndsAt,
      correctionEndsAt: room.correctionEndsAt,
      breakEndsAt: room.breakEndsAt,
      reviewSeconds: room.gameType === 'petit-bac' ? REVIEW_SECONDS : CAPITALS_REVIEW_SECONDS,
      categories: room.config.categories,
      myPlayerId: viewer?.id || null,
      manualNextRound: !room.eliminationMode && room.gameType === 'petit-bac' && room.config.pauseSeconds === 0,
    };
    if (viewer && room.gameType === 'culture') {
      result.myHint = room.currentHints?.[viewer.id] || null;
      result.canUseHint = room.state === 'playing' && !result.myHint && viewer.score >= 5 && !room.currentAnswers?.[viewer.id]?.[0];
    }
    if (room.gameType === 'capitales' && room.question) {
      result.question = {
        kind: room.question.kind,
        flagCode: room.question.country.code,
        flagUrl: `/flags/${room.question.country.code}.svg`,
        prompt: room.question.kind === 'country' ? 'Quel est le nom de ce pays ?' : `Quelle est la capitale de ${room.question.country.name} ?`,
      };
      if (['correction', 'finished'].includes(room.state)) {
        result.question.countryName = room.question.country.name;
        result.question.answer = room.question.kind === 'country' ? room.question.country.name : room.question.country.capital;
      }
    }
    if (room.gameType === 'culture' && room.question) {
      result.question = {
        category: room.question.category,
        prompt: room.question.prompt,
        options: [...room.question.options],
      };
      if (['correction', 'finished'].includes(room.state)) {
        result.question.answerIndex = room.question.answer;
        result.question.answer = room.question.options[room.question.answer];
        result.question.explanation = room.question.explanation || '';
      }
    }
    if (room.state === 'playing' && viewer) {
      result.myAnswers = [...(room.currentAnswers[viewer.id] || [])];
      result.myAnswerRevisions = [...(room.currentAnswerRevisions[viewer.id] || [])];
    }
    if (['correction', 'finished'].includes(room.state) && room.currentScores && ['capitales', 'culture'].includes(room.gameType)) {
      result.roundResults = room.players.map((player) => ({
        playerId: player.id,
        name: player.name,
        answers: [{ category: room.gameType === 'capitales' ? (room.question.kind === 'country' ? 'Pays' : 'Capitale') : room.question.category, ...(room.currentScores[player.id]?.answers[0] || { word: '', correct: false, points: 0, reason: 'Réponse vide' }), canApprove: false }],
        roundScore: room.currentScores[player.id]?.total || 0,
      }));
    } else if (['correction', 'finished'].includes(room.state) && room.currentScores) {
      result.roundResults = room.players.map((player) => ({
        playerId: player.id,
        name: player.name,
        answers: room.config.categories.map((category, index) => {
          const word = room.currentAnswers[player.id]?.[index] || '';
          const judged = assess(word, CATEGORIES.indexOf(category), room.letter);
          const ballots = room.currentVotes?.[player.id]?.[index] || Object.create(null);
          const requiredVotes = correctionVotesRequiredForRoom(room);
          return {
            category,
            ...(room.currentScores[player.id]?.answers[index] || { word, correct: false, duplicate: false, points: 0, reason: 'Réponse vide' }),
            canApprove: judged.eligible && judged.points === 0,
            canReview: room.state === 'correction' && viewer?.id !== player.id && judged.eligible && judged.points === 0 && !(viewer?.id && Object.prototype.hasOwnProperty.call(ballots, viewer.id)),
            approvalVotes: Object.values(ballots).filter((vote) => vote === true).length,
            rejectionVotes: Object.values(ballots).filter((vote) => vote === false).length,
            requiredVotes,
            myVote: viewer?.id && Object.prototype.hasOwnProperty.call(ballots, viewer.id) ? ballots[viewer.id] : null,
          };
        }),
        roundScore: room.currentScores[player.id]?.total || 0,
      }));
    }
    if (room.state === 'finished') {
      result.finalRanking = rankedPlayers(room).map((player, index) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        rank: index + 1,
      }));
      result.roundsPlayed = room.history.length;
      if (room.gameType === 'petit-bac') {
        result.roundHistory = room.history.map((entry) => ({
          number: entry.number,
          letter: entry.letter,
          players: room.players.map((player) => {
            const ballotsByCategory = entry.votes?.[player.id] || [];
            return {
              playerId: player.id,
              name: player.name,
              roundScore: entry.scores?.[player.id]?.total || 0,
              answers: room.config.categories.map((category, index) => {
                const answer = entry.scores?.[player.id]?.answers?.[index] || { word: '', correct: false, duplicate: false, points: 0, reason: 'Réponse vide' };
                const ballots = ballotsByCategory[index] || {};
                const requiredVotes = correctionVotesRequiredForRoom(room);
                const myVote = viewer?.id && Object.prototype.hasOwnProperty.call(ballots, viewer.id) ? ballots[viewer.id] : null;
                return {
                  category,
                  ...answer,
                  canReview: Boolean(entry.answers?.[player.id]) && viewer?.id !== player.id && answer.eligible && !answer.correct && !entry.approvals?.[player.id]?.[index] && myVote === null,
                  approvalVotes: Object.values(ballots).filter((vote) => vote === true).length,
                  rejectionVotes: Object.values(ballots).filter((vote) => vote === false).length,
                  requiredVotes,
                  myVote,
                };
              }),
            };
          }),
        }));
      }
    }
    return result;
  };
  const emitStateImmediately = (room) => {
    for (const player of room.players) {
      if (!player.connected || !player.socketId) continue;
      io.to(player.socketId).emit('game:state', stateFor(room, player));
    }
  };
  const emitState = (room) => {
    const context = transactions.getStore();
    if (context) {
      context.changedRooms.add(room.code);
      context.persistRooms.add(room.code);
    }
    else {
      emitStateImmediately(room);
      scheduleCheckpoint(room.code);
    }
  };
  const hostOnly = (socket, room, ack) => {
    const player = room.players.find((candidate) => candidate.socketId === socket.id && candidate.connected);
    if (!player || player.id !== room.hostId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Seul l’hôte peut effectuer cette action.' });
      return null;
    }
    return player;
  };
  const getPlayerRoom = (socket, ack) => {
    for (const room of rooms.values()) {
      const player = room.players.find((candidate) => candidate.socketId === socket.id && candidate.connected);
      if (player) return { room, player };
    }
    if (typeof ack === 'function') ack({ ok: false, error: 'Votre session de jeu a expiré. Rejoignez la salle à nouveau.' });
    return null;
  };
  const ackSuccess = (ack, room, player, extra = {}) => {
    if (typeof ack === 'function') ack({ ok: true, ...extra, state: stateFor(room, player) });
  };

  const pickLetter = (room, firstRound) => {
    const allowed = LETTERS.split('').filter((letter) => !room.config.excludedLetters.includes(letter));
    if (room.config.letterMode === 'host' && firstRound) return room.config.firstLetter;
    let unused = allowed.filter((letter) => !room.usedLetters.includes(letter));
    if (!unused.length) {
      const previous = room.usedLetters.at(-1);
      room.usedLetters = [];
      unused = allowed.filter((letter) => letter !== previous);
      if (!unused.length) unused = allowed;
    }
    return unused[crypto.randomInt(unused.length)];
  };
  const pickQuestion = (room) => {
    const allowedContinents = new Set(room.config.continents || CAPITALS_CONTINENTS);
    const pool = WORLD_COUNTRIES.filter((country) => allowedContinents.has(country.continent));
    let unused = pool.filter((country) => !room.usedCountries.includes(country.code));
    if (!unused.length) {
      const previous = room.usedCountries.at(-1);
      room.usedCountries = [];
      unused = pool.filter((country) => country.code !== previous);
    }
    const choices = unused.length ? unused : pool;
    const country = choices[crypto.randomInt(choices.length)];
    room.usedCountries.push(country.code);
    const questionMode = room.config.questionMode || 'random';
    const kind = questionMode === 'random' ? (crypto.randomInt(2) === 0 ? 'country' : 'capital') : questionMode;
    return { kind, country };
  };
  const pickCultureQuestion = (room) => {
    const allowed = new Set(room.config.categories);
    const source = room.config.mode === 'vrai-faux' ? CULTURE_TRUE_FALSE_QUESTIONS : CULTURE_QUESTIONS;
    const pool = source.filter((question) => allowed.has(question.category));
    let unused = pool.filter((question) => !room.usedQuestions.includes(question.id));
    if (!unused.length) {
      const previous = room.usedQuestions.at(-1);
      room.usedQuestions = [];
      unused = pool.filter((question) => question.id !== previous);
    }
    const available = unused.length ? unused : pool;
    const previousCategory = room.question?.category;
    const varied = available.filter((question) => question.category !== previousCategory);
    const choices = varied.length ? varied : available;
    const question = choices[crypto.randomInt(choices.length)];
    room.usedQuestions.push(question.id);
    return question;
  };
  const scoreCurrentRound = (room, answers = room.currentAnswers, approvals = room.currentApprovals, answerOrder = room.currentAnswerOrder) => {
    const scoringPlayers = room.eliminationMode ? room.players.filter((player) => !isPlayerEliminated(room, player)) : room.players;
    return room.gameType === 'capitales'
      ? calculateCapitalsScores(scoringPlayers, answers, room.question)
      : room.gameType === 'culture'
        ? calculateCultureScores(scoringPlayers, answers, room.question)
        : calculateRoundScores(scoringPlayers, answers, approvals, room.config.categories, room.letter, answerOrder, { teamMode: room.teamMode });
  };
  const refreshCorrectionScores = (room) => {
    for (const player of room.players) {
      const answers = room.currentApprovals[player.id] || (room.currentApprovals[player.id] = []);
      const ballotsByCategory = room.currentVotes?.[player.id] || [];
      for (let index = 0; index < room.config.categories.length; index += 1) {
        const ballots = ballotsByCategory[index] || {};
        const required = correctionVotesRequiredForRoom(room);
        const approvals = Object.values(ballots).filter((vote) => vote === true).length;
        const rejections = Object.values(ballots).filter((vote) => vote === false).length;
        answers[index] = approvals >= required && approvals > rejections;
      }
    }
    const previousScores = room.currentScores || room.history.at(-1)?.scores || Object.create(null);
    const nextScores = scoreCurrentRound(room);
    for (const player of room.players) {
      player.score += (nextScores[player.id]?.total || 0) - (previousScores[player.id]?.total || 0);
    }
    room.currentScores = nextScores;
    if (room.history.length) {
      const entry = room.history.at(-1);
      entry.scores = nextScores;
      entry.approvals = JSON.parse(JSON.stringify(room.currentApprovals));
      entry.votes = JSON.parse(JSON.stringify(room.currentVotes));
    }
    room.rankingOrder = rankedPlayers(room, room.roundStartingRanking || room.rankingOrder).map((player) => player.id);
  };
  const refreshHistoricalScores = (room) => {
    for (const entry of room.history) {
      if (!entry.answers) continue;
      entry.approvals ||= Object.create(null);
      for (const player of room.players) {
        const answers = entry.approvals[player.id] || (entry.approvals[player.id] = []);
        const ballotsByCategory = entry.votes?.[player.id] || [];
        for (let index = 0; index < room.config.categories.length; index += 1) {
          const ballots = ballotsByCategory[index] || {};
          const required = correctionVotesRequiredForRoom(room);
          const approvals = Object.values(ballots).filter((vote) => vote === true).length;
          const rejections = Object.values(ballots).filter((vote) => vote === false).length;
          answers[index] = approvals >= required && approvals > rejections;
        }
      }
      const previousScores = entry.scores || Object.create(null);
      const nextScores = calculateRoundScores(room.players, entry.answers, entry.approvals, room.config.categories, entry.letter, entry.answerOrder, { teamMode: room.teamMode });
      for (const player of room.players) {
        player.score += (nextScores[player.id]?.total || 0) - (previousScores[player.id]?.total || 0);
      }
      entry.scores = nextScores;
    }
    room.rankingOrder = rankedPlayers(room).map((player) => player.id);
  };
  const startRound = (room) => {
    clearTimer(room, 'break');
    clearTimer(room, 'round');
    room.roundStartingRanking = rankedPlayers(room).map((player) => player.id);
    room.roundNumber += 1;
    if (room.gameType === 'capitales') {
      room.letter = null;
      room.question = pickQuestion(room);
    } else if (room.gameType === 'culture') {
      room.letter = null;
      room.question = pickCultureQuestion(room);
    } else {
      room.letter = pickLetter(room, room.roundNumber === 1);
      room.usedLetters.push(room.letter);
      room.question = null;
    }
    room.state = 'playing';
    room.roundStartedAt = now();
    room.roundEndsAt = room.roundStartedAt + room.config.duration * 1000;
    room.correctionEndsAt = null;
    room.breakEndsAt = null;
    room.currentAnswers = Object.create(null);
    room.currentAnswerRevisions = Object.create(null);
    room.currentApprovals = Object.create(null);
    room.currentVotes = Object.create(null);
    room.currentAnswerOrder = Object.create(null);
    room.currentHints = Object.create(null);
    room.currentScores = null;
    for (const player of room.players) {
      const answerCount = room.gameType === 'petit-bac' ? room.config.categories.length : 1;
      room.currentAnswers[player.id] = Array(answerCount).fill('');
      room.currentAnswerRevisions[player.id] = Array(answerCount).fill(0);
      room.currentApprovals[player.id] = Array(answerCount).fill(false);
      room.currentVotes[player.id] = Array.from({ length: answerCount }, () => Object.create(null));
      room.currentAnswerOrder[player.id] = Array(answerCount).fill(0);
    }
    const roundNumber = room.roundNumber;
    room.timers.round = scheduleTimer(() => runTimer(() => endRound(room.code, roundNumber)), room.config.duration * 1000);
    emitState(room);
  };
  const finishGame = (room) => {
    clearTimer(room, 'review');
    clearTimer(room, 'break');
    room.state = 'finished';
    room.correctionEndsAt = null;
    room.breakEndsAt = null;
    recordFinishedGame(room);
    emitState(room);
  };
  const beginCorrection = (room) => {
    clearTimer(room, 'review');
    room.currentScores = scoreCurrentRound(room);
    for (const player of room.players) player.score += room.currentScores[player.id]?.total || 0;
    room.history.push({
      number: room.roundNumber,
      letter: room.letter,
      scores: room.currentScores,
      answers: JSON.parse(JSON.stringify(room.currentAnswers)),
      answerOrder: JSON.parse(JSON.stringify(room.currentAnswerOrder)),
      approvals: JSON.parse(JSON.stringify(room.currentApprovals)),
      votes: JSON.parse(JSON.stringify(room.currentVotes)),
      rankingBefore: [...(room.roundStartingRanking || room.rankingOrder)],
    });
    room.rankingOrder = rankedPlayers(room, room.roundStartingRanking || room.rankingOrder).map((player) => player.id);
    room.state = 'correction';
    const reviewSeconds = room.gameType === 'petit-bac' ? REVIEW_SECONDS : CAPITALS_REVIEW_SECONDS;
    room.correctionEndsAt = now() + reviewSeconds * 1000;
    room.roundEndsAt = null;
    room.timers.review = scheduleTimer(() => runTimer(() => advanceAfterCorrection(room.code, room.roundNumber)), reviewSeconds * 1000);
    emitState(room);
  };
  function endRound(code, roundNumber) {
    if (redis && !transactions.getStore()) return withRoomTransaction(code, () => endRound(code, roundNumber));
    const room = rooms.get(code);
    if (!room || room.state !== 'playing' || room.roundNumber !== roundNumber) return;
    clearTimer(room, 'round');
    beginCorrection(room);
  }
  function advanceAfterCorrection(code, roundNumber) {
    if (redis && !transactions.getStore()) return withRoomTransaction(code, () => advanceAfterCorrection(code, roundNumber));
    const room = rooms.get(code);
    if (!room || room.state !== 'correction' || room.roundNumber !== roundNumber) return;
    clearTimer(room, 'review');
    for (const entry of room.pendingAcceptedWords || []) addAcceptedWord(entry.word, entry.categoryIndex);
    room.pendingAcceptedWords = [];
    if (room.eliminationMode && eliminateLastCompetitor(room)) {
      finishGame(room);
      return;
    }
    if (!room.eliminationMode && room.roundNumber >= room.config.rounds) {
      finishGame(room);
      return;
    }
    room.state = 'break';
    room.correctionEndsAt = null;
    const manual = !room.eliminationMode && room.gameType === 'petit-bac' && room.config.pauseSeconds === 0;
    const pauseSeconds = room.eliminationMode ? 2 : room.gameType === 'petit-bac' || room.gameType === 'capitales' ? room.config.pauseSeconds : 1;
    if (manual) {
      room.breakEndsAt = null;
      clearTimer(room, 'break');
    } else {
      room.breakEndsAt = now() + pauseSeconds * 1000;
      room.timers.break = scheduleTimer(() => runTimer(() => startNextRound(code, roundNumber)), pauseSeconds * 1000);
    }
    emitState(room);
  }

  function startNextRound(code, roundNumber) {
    if (redis && !transactions.getStore()) return withRoomTransaction(code, () => startNextRound(code, roundNumber));
    const room = rooms.get(code);
    if (!room || room.state !== 'break' || room.roundNumber !== roundNumber) return;
    startRound(room);
  }

  function reconcileRoomTime(room) {
    let changed = false;
    const transitionLimit = room.eliminationMode ? 300 : room.config.rounds * 3 + 3;
    for (let attempt = 0; attempt < transitionLimit; attempt += 1) {
      const currentTime = now();
      if (room.state === 'playing' && room.roundEndsAt && currentTime >= room.roundEndsAt) {
        endRound(room.code, room.roundNumber);
      } else if (room.state === 'correction' && room.correctionEndsAt && currentTime >= room.correctionEndsAt) {
        advanceAfterCorrection(room.code, room.roundNumber);
      } else if (room.state === 'break' && room.breakEndsAt && currentTime >= room.breakEndsAt) {
        startNextRound(room.code, room.roundNumber);
      } else {
        break;
      }
      changed = true;
    }
    return changed;
  }

  function expireDisconnectedRoom(code) {
    if (redis && !transactions.getStore()) return withRoomTransaction(code, () => expireDisconnectedRoom(code));
    const room = rooms.get(code);
    if (!room || room.players.some((player) => player.connected)) return;
    clearAllTimers(room);
    rooms.delete(code);
    transactions.getStore()?.persistRooms.add(code);
    if (!transactions.getStore()) scheduleCheckpoint(code);
  }

  io.on('connection', (socket) => {
    socket.on('time:sync', (_payload, ack) => ack?.({ serverNow: now() }));
    socket.on('stats:get', async (_payload, ack) => {
      try { ack?.({ ok: true, games: await stats.getOverview() }); }
      catch (error) { ack?.({ ok: false, error: 'Impossible de charger les classements.' }); }
    });

    if (redis) {
      const register = socket.on.bind(socket);
      const transactionalEvents = new Set([
        'room:create', 'room:join', 'session:resume', 'game:configure', 'game:start', 'game:sync',
        'answer:update', 'answers:update', 'correction:approve', 'correction:finish', 'round:next', 'culture:hint', 'team:choose', 'game:replay',
        'room:leave', 'disconnect',
      ]);
      socket.on = (event, listener) => {
        if (!transactionalEvents.has(event)) return register(event, listener);
        return register(event, (...received) => {
          const args = [...received];
          const ackIndex = args.findLastIndex((argument) => typeof argument === 'function');
          const originalAck = ackIndex >= 0 ? args[ackIndex] : null;
          if (originalAck) {
            args[ackIndex] = (response) => {
              const context = transactions.getStore();
              if (context) context.acknowledgements.push({ callback: originalAck, response });
              else originalAck(response);
            };
          }
          let code = socket.data.roomCode || null;
          if (event === 'room:create') code = null;
          if (event === 'room:join' || event === 'session:resume') {
            code = String(args[0]?.code || '').toUpperCase().replace(/\s/g, '').slice(0, 12);
          }
          const receivedAt = now();
          withRoomTransaction(code, () => listener(...args), { event, receivedAt }).catch((error) => {
            logTimerError(error);
            originalAck?.({ ok: false, error: error.message || 'Impossible de mettre à jour la salle.' });
          });
        });
      };
    }

    socket.on('room:create', (payload = {}, ack) => {
      const checkedName = validatePlayerName(payload.name);
      if (checkedName.error) return ack?.({ ok: false, error: checkedName.error });
      const gameType = payload.gameType || 'petit-bac';
      if (!['petit-bac', 'capitales', 'culture'].includes(gameType)) return ack?.({ ok: false, error: 'Choix du jeu invalide.' });
      const player = { id: crypto.randomBytes(24).toString('hex'), name: checkedName.value, score: 0, connected: true, socketId: socket.id, gameType, eliminatedAt: null };
      const room = makeRoom(player);
      socket.data.roomCode = room.code;
      socket.join(room.code);
      ackSuccess(ack, room, player, { token: player.id, code: room.code });
      emitState(room);
    });

    socket.on('room:join', (payload = {}, ack) => {
      const code = String(payload.code || '').toUpperCase().replace(/\s/g, '');
      const room = rooms.get(code);
      if (!room) return ack?.({ ok: false, error: 'Cette salle est introuvable.' });
      if (room.state === 'finished') return ack?.({ ok: false, error: 'Cette partie est terminée. Demandez à l’hôte de la relancer pour rejoindre la salle.' });
      if ((room.teamMode || room.eliminationMode) && room.state !== 'lobby') return ack?.({ ok: false, error: 'Cette partie a déjà commencé.' });
      if (room.players.length >= 20) return ack?.({ ok: false, error: 'Cette salle a atteint sa limite de 20 joueurs.' });
      const checkedName = validatePlayerName(payload.name);
      if (checkedName.error) return ack?.({ ok: false, error: checkedName.error });
      if (room.players.some((player) => normalize(player.name) === normalize(checkedName.value))) return ack?.({ ok: false, error: 'Ce pseudo est déjà utilisé dans la salle.' });
      const player = { id: crypto.randomBytes(24).toString('hex'), name: checkedName.value, score: 0, connected: true, socketId: socket.id, eliminatedAt: null };
      room.players.push(player);
      if (room.teamMode) addToSmallestTeam(room, player);
      const answerCount = room.gameType === 'petit-bac' ? room.config.categories.length : 1;
      room.currentAnswers[player.id] = Array(answerCount).fill('');
      room.currentAnswerRevisions[player.id] = Array(answerCount).fill(0);
      room.currentApprovals[player.id] = Array(answerCount).fill(false);
      room.currentVotes[player.id] = Array.from({ length: answerCount }, () => Object.create(null));
      room.currentAnswerOrder[player.id] = Array(answerCount).fill(0);
      clearTimer(room, 'idle');
      socket.data.roomCode = room.code;
      socket.join(room.code);
      if (room.state === 'correction' && room.gameType === 'petit-bac') refreshCorrectionScores(room);
      ackSuccess(ack, room, player, { token: player.id, code: room.code });
      emitState(room);
    });

    socket.on('session:resume', (payload = {}, ack) => {
      const code = String(payload.code || '').toUpperCase().replace(/\s/g, '');
      const room = rooms.get(code);
      const token = typeof payload.token === 'string' ? payload.token : '';
      const player = room?.players.find((candidate) => candidate.id === token);
      if (!room || !player) return ack?.({ ok: false, error: 'Impossible de retrouver cette partie. Vous pouvez en rejoindre une autre.' });
      if (player.socketId && player.socketId !== socket.id) io.in(player.socketId).disconnectSockets(true);
      player.connected = true;
      player.left = false;
      player.socketId = socket.id;
      clearTimer(room, 'idle');
      socket.data.roomCode = room.code;
      socket.join(room.code);
      ackSuccess(ack, room, player, { token: player.id, code: room.code });
      emitState(room);
    });

    socket.on('game:configure', (payload = {}, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room } = linked;
      if (!hostOnly(socket, room, ack)) return;
      if (room.state !== 'lobby') return ack?.({ ok: false, error: 'La configuration est verrouillée après le démarrage.' });
      const checked = room.gameType === 'capitales' ? validateCapitalsConfig(payload.config) : room.gameType === 'culture' ? validateCultureConfig(payload.config) : validateConfig(payload.config);
      if (checked.error) return ack?.({ ok: false, error: checked.error });
      const teamMode = payload.teamMode === undefined ? Boolean(room.teamMode) : payload.teamMode === true;
      const eliminationMode = payload.eliminationMode === undefined ? Boolean(room.eliminationMode) : payload.eliminationMode === true;
      const teamCount = payload.teamCount === undefined ? Number(room.teamCount) || 2 : Number(payload.teamCount);
      if (![2, 3, 4].includes(teamCount)) return ack?.({ ok: false, error: 'Choisissez entre 2 et 4 équipes.' });
      const teamSetupChanged = teamMode !== Boolean(room.teamMode) || teamCount !== room.teamCount;
      room.config = checked.value;
      room.teamMode = teamMode;
      room.teamCount = teamCount;
      room.eliminationMode = eliminationMode;
      room.eliminationNotice = null;
      if (!teamMode) room.players.forEach((player) => { player.teamId = null; });
      else if (teamSetupChanged || room.players.some((player) => !Number.isInteger(player.teamId) || player.teamId < 0 || player.teamId >= teamCount)) balanceTeams(room);
      ackSuccess(ack, room, linked.player);
      emitState(room);
    });

    socket.on('team:choose', (payload = {}, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      const teamId = Number(payload.teamId);
      if (room.state !== 'lobby' || !room.teamMode) return ack?.({ ok: false, error: 'Les équipes se choisissent dans la salle d’attente.' });
      if (!Number.isInteger(teamId) || teamId < 0 || teamId >= room.teamCount) return ack?.({ ok: false, error: 'Cette équipe n’existe pas.' });
      player.teamId = teamId;
      ackSuccess(ack, room, player);
      emitState(room);
    });

    socket.on('game:start', (_payload, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room } = linked;
      if (!hostOnly(socket, room, ack)) return;
      if (room.state !== 'lobby') return ack?.({ ok: false, error: 'Cette partie est déjà lancée.' });
      if (room.players.filter((player) => player.connected).length < 2) return ack?.({ ok: false, error: 'Il faut au moins deux joueurs connectés pour démarrer.' });
      if (room.teamMode && teamStandings(room).some((team) => !team.players.some((member) => member.connected))) {
        return ack?.({ ok: false, error: 'Chaque équipe doit avoir au moins un joueur connecté.' });
      }
      room.roundNumber = 0;
      room.matchId = null;
      room.matchCompletedAt = null;
      room.matchPlayers = null;
      room.gameStartedAt = now();
      room.usedLetters = [];
      room.usedCountries = [];
      room.usedQuestions = [];
      room.history = [];
      room.answerSequence = 0;
      room.eliminationNotice = null;
      room.eliminationDraw = false;
      room.rankingOrder = room.players.map((player) => player.id);
      room.roundStartingRanking = [...room.rankingOrder];
      for (const player of room.players) {
        player.score = 0;
        player.eliminatedAt = null;
      }
      ack?.({ ok: true });
      startRound(room);
    });

    const updateAnswers = (socket, updates, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      if (room.state !== 'playing') return ack?.({ ok: false, error: 'Les réponses sont verrouillées.' });
      if (isPlayerEliminated(room, player)) return ack?.({ ok: false, error: 'Vous avez été éliminé et suivez la suite de la partie.' });
      const receivedAt = transactions.getStore()?.receivedAt ?? now();
      if (receivedAt >= room.roundEndsAt) {
        endRound(room.code, room.roundNumber);
        return ack?.({ ok: false, error: 'Le temps est écoulé ; les réponses sont verrouillées.' });
      }
      const answerLimit = room.gameType === 'petit-bac' ? room.config.categories.length : 1;
      if (!Array.isArray(updates) || !updates.length || updates.length > answerLimit) return ack?.({ ok: false, error: 'Réponses invalides.' });
      const seen = new Set();
      const validated = [];
      for (const update of updates) {
        const categoryIndex = Number(update?.categoryIndex);
        if (!Number.isInteger(categoryIndex) || categoryIndex < 0 || categoryIndex >= answerLimit || seen.has(categoryIndex)) {
          return ack?.({ ok: false, error: 'Catégorie invalide.' });
        }
        seen.add(categoryIndex);
        const checked = validateAnswer(update.value);
        if (checked.error) return ack?.({ ok: false, error: checked.error });
        const storedRevision = room.currentAnswerRevisions[player.id][categoryIndex] || 0;
        const hasRevision = update.revision !== undefined;
        const requestedRevision = Number(update.revision);
        if (hasRevision && (!Number.isSafeInteger(requestedRevision) || requestedRevision < 1)) {
          return ack?.({ ok: false, error: 'Version de réponse invalide.' });
        }
        if (hasRevision && requestedRevision > storedRevision) {
          validated.push({ categoryIndex, value: checked.value, revision: requestedRevision, enteredAt: update.enteredAt });
        } else if (!hasRevision) {
          validated.push({ categoryIndex, value: checked.value, revision: storedRevision + 1, enteredAt: update.enteredAt });
        }
      }
      for (const update of validated) {
        room.currentAnswers[player.id][update.categoryIndex] = update.value;
        room.currentAnswerRevisions[player.id][update.categoryIndex] = update.revision;
        room.answerSequence = (room.answerSequence || 0) + 1;
        room.currentAnswerOrder[player.id] ||= Array(answerLimit).fill(0);
        const requestedEntryTime = Number(update.enteredAt);
        const entryTime = Number.isFinite(requestedEntryTime)
          ? Math.min(receivedAt, Math.max(room.roundStartedAt || 0, requestedEntryTime))
          : receivedAt;
        room.currentAnswerOrder[player.id][update.categoryIndex] = entryTime * 1000 + room.answerSequence;
      }
      if (validated.length) {
        const context = transactions.getStore();
        if (context) context.persistRooms.add(room.code);
        else scheduleCheckpoint(room.code);
      }
      ack?.({
        ok: true,
        revisions: [...room.currentAnswerRevisions[player.id]],
        values: [...room.currentAnswers[player.id]],
      });
    };

    socket.on('answer:update', (payload = {}, ack) => {
      updateAnswers(socket, [{ categoryIndex: payload.categoryIndex, value: payload.value, revision: payload.revision }], ack);
    });
    socket.on('answers:update', (payload = {}, ack) => {
      updateAnswers(socket, payload.answers, ack);
    });

    socket.on('game:sync', (_payload, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      reconcileRoomTime(linked.room);
      ack?.({ ok: true });
    });

    socket.on('round:next', (_payload, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      if (!hostOnly(socket, room, ack)) return;
      if (room.gameType !== 'petit-bac' || room.state !== 'break' || room.config.pauseSeconds !== 0) {
        return ack?.({ ok: false, error: 'Le lancement manuel de la manche suivante n’est pas disponible.' });
      }
      ack?.({ ok: true });
      startNextRound(room.code, room.roundNumber);
    });

    socket.on('culture:hint', (payload = {}, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      if (room.gameType !== 'culture' || room.state !== 'playing' || !room.question) {
        return ack?.({ ok: false, error: 'Les indices sont disponibles pendant une question de culture générale.' });
      }
      if (isPlayerEliminated(room, player)) return ack?.({ ok: false, error: 'Vous avez été éliminé et suivez la suite de la partie.' });
      if (room.currentAnswers?.[player.id]?.[0]) return ack?.({ ok: false, error: 'Répondez avant de demander un indice.' });
      const direction = payload.direction;
      if (!['first', 'last'].includes(direction)) return ack?.({ ok: false, error: 'Choisissez le début ou la fin de la réponse.' });
      if (room.currentHints?.[player.id]) return ack?.({ ok: false, error: 'Un indice a déjà été utilisé pour cette question.' });
      if (player.score < 5) return ack?.({ ok: false, error: 'Il faut au moins 5 points pour acheter un indice.' });
      const answer = Array.from(String(room.question.options[room.question.answer] || ''));
      const letters = direction === 'first' ? answer.slice(0, 3).join('') : answer.slice(-3).join('');
      room.currentHints ||= Object.create(null);
      room.currentHints[player.id] = { direction, letters };
      player.score -= 5;
      ackSuccess(ack, room, player);
      emitState(room);
    });

    socket.on('correction:approve', async (payload = {}, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      if (room.gameType !== 'petit-bac') return ack?.({ ok: false, error: 'La correction du quiz est automatique.' });
      if (!['correction', 'finished'].includes(room.state)) return ack?.({ ok: false, error: 'La correction n’est pas ouverte.' });
      if (room.state === 'finished' && !correctionReviewers(room).some((participant) => participant.id === player.id)) {
        return ack?.({ ok: false, error: 'Seuls les joueurs de cette partie peuvent vérifier les réponses.' });
      }
      const target = room.players.find((candidate) => candidate.id === payload.playerId);
      const categoryIndex = Number(payload.categoryIndex);
      if (!target || !Number.isInteger(categoryIndex) || categoryIndex < 0 || categoryIndex >= room.config.categories.length) return ack?.({ ok: false, error: 'Réponse introuvable.' });
      if (target.id === player.id) return ack?.({ ok: false, error: 'Vous ne pouvez pas corriger votre propre réponse.' });
      if (typeof payload.approved !== 'boolean') return ack?.({ ok: false, error: 'Choisissez de valider ou de refuser cette réponse.' });
      const historical = room.state === 'finished'
        ? room.history.find((entry) => entry.number === Number(payload.roundNumber))
        : null;
      if (room.state === 'finished' && !historical) return ack?.({ ok: false, error: 'Cette manche est introuvable.' });
      const letter = historical?.letter || room.letter;
      const word = historical ? historical.answers?.[target.id]?.[categoryIndex] : room.currentAnswers[target.id]?.[categoryIndex];
      const judged = assess(word || '', CATEGORIES.indexOf(room.config.categories[categoryIndex]), letter);
      if (historical
        ? !historical.scores?.[target.id]?.answers?.[categoryIndex]?.eligible || historical.scores[target.id].answers[categoryIndex].correct
        : !judged.eligible || judged.points > 0) return ack?.({ ok: false, error: judged.reason });
      if (historical?.approvals?.[target.id]?.[categoryIndex]) return ack?.({ ok: false, error: 'Cette réponse a déjà été validée par les joueurs.' });
      let ballotsByCategory;
      if (historical) {
        historical.votes ||= Object.create(null);
        ballotsByCategory = historical.votes[target.id] ||= Array.from({ length: room.config.categories.length }, () => Object.create(null));
      } else ballotsByCategory = room.currentVotes?.[target.id];
      const ballots = ballotsByCategory[categoryIndex] ||= Object.create(null);
      if (Object.prototype.hasOwnProperty.call(ballots, player.id)) {
        return ack?.({ ok: false, error: 'Votre vote pour cette réponse a déjà été enregistré.' });
      }
      ballots[player.id] = payload.approved;
      if (historical) {
        const approvals = Object.values(ballots).filter((vote) => vote === true).length;
        const rejections = Object.values(ballots).filter((vote) => vote === false).length;
        const accepted = approvals >= correctionVotesRequiredForRoom(room) && approvals > rejections;
        if (accepted) {
          const category = CATEGORIES.indexOf(room.config.categories[categoryIndex]);
          addAcceptedWord(word, category);
          void storeAcceptedWord(word, category);
        }
        refreshHistoricalScores(room);
        updateFinishedGame(room);
      } else {
        refreshCorrectionScores(room);
      }
      if (!historical && room.currentApprovals[target.id]?.[categoryIndex]) {
        room.pendingAcceptedWords ||= [];
        const category = CATEGORIES.indexOf(room.config.categories[categoryIndex]);
        if (!room.pendingAcceptedWords.some((entry) => entry.categoryIndex === category && normalize(entry.word) === normalize(word))) {
          room.pendingAcceptedWords.push({ word, categoryIndex: category });
        }
        void storeAcceptedWord(word, category);
      }
      ackSuccess(ack, room, player);
      emitState(room);
    });

    socket.on('correction:finish', (_payload, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      if (!hostOnly(socket, room, ack)) return;
      if (room.state !== 'correction') return ack?.({ ok: false, error: 'La correction n’est pas ouverte.' });
      ack?.({ ok: true });
      advanceAfterCorrection(room.code, room.roundNumber);
    });

    socket.on('game:replay', (_payload, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      if (!hostOnly(socket, room, ack)) return;
      if (room.state !== 'finished') return ack?.({ ok: false, error: 'La partie n’est pas terminée.' });
      room.state = 'lobby';
      room.players = room.players.filter((participant) => !participant.left);
      if (room.teamMode && teamStandings(room).some((team) => !team.players.length)) balanceTeams(room);
      room.roundNumber = 0;
      room.matchId = null;
      room.matchCompletedAt = null;
      room.matchPlayers = null;
      room.gameStartedAt = null;
      room.letter = null;
      room.roundStartedAt = null;
      room.roundEndsAt = null;
      room.correctionEndsAt = null;
      room.breakEndsAt = null;
      room.usedLetters = [];
      room.usedCountries = [];
      room.usedQuestions = [];
      room.question = null;
      room.currentAnswers = Object.create(null);
      room.currentAnswerRevisions = Object.create(null);
      room.currentApprovals = Object.create(null);
      room.currentVotes = Object.create(null);
      room.currentAnswerOrder = Object.create(null);
      room.currentHints = Object.create(null);
      room.answerSequence = 0;
      room.currentScores = null;
      room.history = [];
      room.eliminationNotice = null;
      room.eliminationDraw = false;
      room.players.forEach((participant) => { participant.score = 0; participant.eliminatedAt = null; });
      room.rankingOrder = room.players.map((participant) => participant.id);
      room.roundStartingRanking = [...room.rankingOrder];
      ackSuccess(ack, room, player);
      emitState(room);
    });

    socket.on('room:leave', (_payload, ack) => {
      const linked = getPlayerRoom(socket, ack);
      if (!linked) return;
      const { room, player } = linked;
      if ((room.teamMode || room.eliminationMode) && room.state !== 'lobby' && room.state !== 'finished') {
        player.connected = false;
        player.socketId = null;
        player.left = true;
        if (room.eliminationMode && !room.teamMode && !Number.isInteger(player.eliminatedAt)) {
          player.eliminatedAt = room.roundNumber;
          room.eliminationNotice = `${player.name} a quitté le Rush et est éliminé.`;
        }
        if (room.hostId === player.id) room.hostId = room.players.find((candidate) => candidate.connected)?.id || player.id;
        if (!room.players.some((candidate) => candidate.connected)) {
          clearTimer(room, 'idle');
          room.timers.idle = scheduleTimer(() => runTimer(() => expireDisconnectedRoom(room.code)), DISCONNECTED_ROOM_TTL);
        }
        emitState(room);
      } else {
        room.players = room.players.filter((candidate) => candidate.id !== player.id);
        if (!room.players.length) {
          clearAllTimers(room);
          rooms.delete(room.code);
          transactions.getStore()?.persistRooms.add(room.code);
          if (!transactions.getStore()) scheduleCheckpoint(room.code);
        } else {
          if (room.hostId === player.id) room.hostId = room.players.find((candidate) => candidate.connected)?.id || room.players[0].id;
          delete room.currentAnswers[player.id];
          delete room.currentAnswerRevisions[player.id];
          delete room.currentApprovals[player.id];
          delete room.currentVotes[player.id];
          delete room.currentAnswerOrder[player.id];
          delete room.currentHints[player.id];
          for (const ballots of Object.values(room.currentVotes)) {
            for (const categoryVotes of ballots) delete categoryVotes[player.id];
          }
          if (room.currentScores) delete room.currentScores[player.id];
          if (room.state === 'correction' && room.gameType === 'petit-bac') refreshCorrectionScores(room);
          if (room.teamMode && room.state === 'lobby') balanceTeams(room);
          emitState(room);
        }
      }
      socket.leave(room.code);
      socket.data.roomCode = null;
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      if (closing) return;
      const room = socket.data.roomCode
        ? rooms.get(socket.data.roomCode)
        : [...rooms.values()].find((candidate) => candidate.players.some((player) => player.socketId === socket.id));
      if (!room) return;
      const player = room.players.find((candidate) => candidate.socketId === socket.id);
      if (!player) return;
      player.connected = false;
      player.socketId = null;
      if (room.hostId === player.id) {
        room.hostId = room.players.find((candidate) => candidate.connected)?.id || player.id;
      }
      if (!room.players.some((candidate) => candidate.connected)) {
        clearTimer(room, 'idle');
        room.timers.idle = scheduleTimer(() => runTimer(() => expireDisconnectedRoom(room.code)), DISCONNECTED_ROOM_TTL);
      }
      emitState(room);
    });
  });

  return {
    app,
    server,
    io,
    rooms,
    port,
    restoreRooms: restoreCheckpointedRooms,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.host || '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve(server.address());
      });
    }),
    close: async () => {
      closing = true;
      clearInterval(dictionaryRefreshTimer);
      for (const room of rooms.values()) clearAllTimers(room);
      const pendingCheckpointCodes = new Set([...checkpointTimers.keys(), ...checkpointWrites.keys(), ...rooms.keys()]);
      for (const timer of checkpointTimers.values()) clearTimeout(timer);
      checkpointTimers.clear();
      if (checkpointRedis) await Promise.all([...pendingCheckpointCodes].map((code) => writeCheckpoint(code).catch(logTimerError)));
      return new Promise((resolve, reject) => {
        const fallback = setTimeout(() => {
          server.closeAllConnections?.();
          if (server.listening) server.close();
          resolve();
        }, 1500);
        io.close((error) => {
          clearTimeout(fallback);
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

if (require.main === module) {
  const gameServer = createGameServer();
  gameServer.listen().then(({ port }) => {
    console.log(`Petit Bac prêt sur le port ${port}`);
  }).catch((error) => {
    console.error('Impossible de démarrer le serveur du Petit Bac :', error);
    process.exitCode = 1;
  });
}

module.exports = { createGameServer, REVIEW_SECONDS, DISCONNECTED_ROOM_TTL };
