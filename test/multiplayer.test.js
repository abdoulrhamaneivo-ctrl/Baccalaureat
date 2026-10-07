'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { CATEGORIES, assess } = require('../dist/data.js');
const { calculateRoundScores, DEFAULT_CONFIG, DEFAULT_CAPITALS_CONFIG, WORLD_COUNTRIES, validateConfig, validateCapitalsConfig } = require('../server/game-rules.js');
const { createStatsStore } = require('../server/stats-store.js');
const { createGameServer } = require('../server.js');

const players = (...ids) => ids.map((id) => ({ id }));
const score = (words, letter = 'M') => calculateRoundScores(players(...Object.keys(words)), words, {}, ['Animal'], letter);

test('multiplayer scoring awards ten points to distinct correct answers', () => {
  const result = score({ a: ['Mouton'], b: ['Moustique'] });
  assert.equal(result.a.total, 10);
  assert.equal(result.b.total, 10);
});

test('identical correct answers give zero to every player who used them', () => {
  const result = score({ a: ['Mouton'], b: ['Mouton'] });
  assert.equal(result.a.total, 0);
  assert.equal(result.b.total, 0);
});

test('a unique answer still scores when other players share a different answer', () => {
  const result = score({ a: ['Mouton'], b: ['Mouton'], c: ['Moustique'] });
  assert.equal(result.a.total, 0);
  assert.equal(result.b.total, 0);
  assert.equal(result.c.total, 10);
});

test('answer comparison ignores case, accents, and surrounding spaces', () => {
  const result = score({ a: [' Éléphant '], b: ['elephant'] }, 'E');
  assert.equal(result.a.total, 0);
  assert.equal(result.b.total, 0);
  assert.equal(result.a.answers[0].duplicate, true);
});

test('incorrect and empty answers score zero', () => {
  const result = score({ a: ['Chat'], b: [''] });
  assert.equal(result.a.total, 0);
  assert.equal(result.b.total, 0);
});

test('empty and one-character answers cannot be reviewed or score points', () => {
  assert.equal(assess('', 0, 'M').eligible, false);
  assert.equal(assess('M', 0, 'M').eligible, false);
  assert.equal(score({ a: ['M'] }).a.total, 0);
});

test('host configuration is validated and preserves the shared categories', () => {
  const checked = validateConfig({ ...DEFAULT_CONFIG, letterMode: 'host', firstLetter: 'm', categories: ['Animal'] });
  assert.deepEqual(checked.value.categories, ['Animal']);
  assert.equal(checked.value.firstLetter, 'M');
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, categories: ['Unknown'] }).error);
});

test('capital quiz configuration validates the question mode and selected continents', () => {
  const checked = validateCapitalsConfig({ ...DEFAULT_CAPITALS_CONFIG, rounds: 15, duration: 20, questionMode: 'capital', continents: ['Afrique', 'Europe'] });
  assert.equal(checked.value.questionMode, 'capital');
  assert.deepEqual(checked.value.continents, ['Afrique', 'Europe']);
  assert.ok(validateCapitalsConfig({ ...DEFAULT_CAPITALS_CONFIG, continents: [] }).error);
  assert.ok(validateCapitalsConfig({ ...DEFAULT_CAPITALS_CONFIG, questionMode: 'planet' }).error);
});

test('persistent statistics rank points separately for each game and keep match history', async () => {
  const stats = createStatsStore();
  await stats.recordMatch({ id: 'one', gameType: 'petit-bac', completedAt: 100, roundsPlayed: 3, players: [{ pseudo: 'Éloi', score: 20 }, { pseudo: 'Mina', score: 10 }] });
  await stats.recordMatch({ id: 'one', gameType: 'petit-bac', completedAt: 100, roundsPlayed: 3, players: [{ pseudo: 'Éloi', score: 20 }, { pseudo: 'Mina', score: 10 }] });
  await stats.recordMatch({ id: 'two', gameType: 'capitales', completedAt: 200, roundsPlayed: 5, players: [{ pseudo: 'Éloi', score: 30 }] });
  const overview = await stats.getOverview();
  assert.equal(overview['petit-bac'].leaderboard[0].pseudo, 'Éloi');
  assert.equal(overview['petit-bac'].leaderboard[0].score, 20);
  assert.equal(overview['petit-bac'].history.length, 1);
  assert.equal(overview.capitales.leaderboard[0].score, 30);
  assert.equal(overview.capitales.history[0].id, 'two');
});

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
  });
}

function waitForState(socket, expectedState) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('game:state', onState);
      reject(new Error(`Timed out waiting for ${expectedState}`));
    }, 4000);
    const onState = (state) => {
      if (state.state !== expectedState) return;
      clearTimeout(timeout);
      socket.off('game:state', onState);
      resolve(state);
    };
    socket.on('game:state', onState);
  });
}

function createFakeClock() {
  let current = 1_000_000;
  let nextId = 1;
  const timers = [];
  return {
    now: () => current,
    setTimeout(callback, delay) {
      const timer = { id: nextId++, at: current + delay, callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    advance(delay) {
      current += delay;
      while (true) {
        const next = timers.filter((timer) => !timer.cancelled && timer.at <= current).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.cancelled = true;
        next.callback();
      }
    },
    jump(delay) { current += delay; },
  };
}

test('room, host controls, and round timing are shared by separate clients', async (t) => {
  const clock = createFakeClock();
  const game = createGameServer({ port: 0, host: '127.0.0.1', now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const address = await game.listen();
  const host = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  let guest = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  t.after(async () => {
    host.disconnect();
    guest.disconnect();
    await game.close();
  });
  await Promise.all([waitForConnect(host), waitForConnect(guest)]);
  assert.equal((await request(host, 'time:sync', {})).serverNow, clock.now());

  const created = await request(host, 'room:create', { name: 'Abdoul' });
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  const joined = await request(guest, 'room:join', { code: created.code, name: 'Fatou' });
  assert.equal(joined.ok, true);
  const reconnectedGuest = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  t.after(() => reconnectedGuest.disconnect());
  await waitForConnect(reconnectedGuest);
  const resumed = await request(reconnectedGuest, 'session:resume', { code: joined.code, token: joined.token });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.myPlayerId, joined.token);
  guest.disconnect();
  guest = reconnectedGuest;
  assert.equal((await request(guest, 'game:configure', { config: DEFAULT_CONFIG })).ok, false);
  assert.equal((await request(host, 'game:configure', { config: { ...DEFAULT_CONFIG, rounds: 2, duration: 30, letterMode: 'host', firstLetter: 'M', excludedLetters: 'ABCDEFGHIJKLNOPQRSTUVWXYZ', categories: ['Animal'] } })).ok, true);

  const hostPlaying = waitForState(host, 'playing');
  const guestPlaying = waitForState(guest, 'playing');
  assert.equal((await request(host, 'game:start')).ok, true);
  const [hostState, guestState] = await Promise.all([hostPlaying, guestPlaying]);
  assert.equal(hostState.letter, 'M');
  assert.equal(guestState.letter, hostState.letter);
  assert.equal(guestState.roundEndsAt, hostState.roundEndsAt);
  assert.deepEqual(hostState.myAnswers, ['']);
  assert.deepEqual(guestState.myAnswers, ['']);

  const firstSave = await request(host, 'answers:update', { answers: [{ categoryIndex: 0, value: 'Moufflon', revision: 2 }] });
  assert.equal(firstSave.ok, true);
  const staleSave = await request(host, 'answers:update', { answers: [{ categoryIndex: 0, value: 'Maison', revision: 1 }] });
  assert.equal(staleSave.values[0], 'Moufflon');
  assert.equal((await request(guest, 'answer:update', { categoryIndex: 0, value: 'Mouton' })).ok, true);
  const hostCorrection = waitForState(host, 'correction');
  const guestCorrection = waitForState(guest, 'correction');
  clock.jump(30_000);
  assert.equal((await request(host, 'game:sync', {})).ok, true);
  const [hostResults, guestResults] = await Promise.all([hostCorrection, guestCorrection]);
  assert.equal(hostResults.roundResults[0].roundScore, 0);
  assert.equal(guestResults.roundResults[1].roundScore, 10);
  assert.equal(hostResults.roundResults[0].answers[0].requiredVotes, 1);
  assert.equal((await request(host, 'correction:approve', { playerId: hostState.myPlayerId, categoryIndex: 0, approved: true })).ok, false);
  const corrected = await request(guest, 'correction:approve', { playerId: hostState.myPlayerId, categoryIndex: 0, approved: true });
  assert.equal(corrected.state.roundResults[0].roundScore, 10);
  assert.equal(corrected.state.roundResults[1].roundScore, 10);
  assert.equal((await request(guest, 'correction:approve', { playerId: hostState.myPlayerId, categoryIndex: 0, approved: true })).ok, false);

  const hostBreak = waitForState(host, 'break');
  const guestBreak = waitForState(guest, 'break');
  clock.advance(20_000);
  const [hostBreakState, guestBreakState] = await Promise.all([hostBreak, guestBreak]);
  assert.equal(assess('Moufflon', 5, 'M').points, 10);
  assert.equal(hostBreakState.breakEndsAt - clock.now(), 10_000);
  assert.equal(guestBreakState.breakEndsAt, hostBreakState.breakEndsAt);

  const nextHostRound = waitForState(host, 'playing');
  const nextGuestRound = waitForState(guest, 'playing');
  clock.advance(10_000);
  const [secondHostRound, secondGuestRound] = await Promise.all([nextHostRound, nextGuestRound]);
  assert.equal(secondHostRound.roundNumber, 2);
  assert.equal(secondGuestRound.letter, secondHostRound.letter);
  assert.equal((await request(host, 'answer:update', { categoryIndex: 0, value: 'Mouton' })).ok, true);
  assert.equal((await request(guest, 'answer:update', { categoryIndex: 0, value: 'Moustique' })).ok, true);
  const finalHost = waitForState(host, 'finished');
  const finalGuest = waitForState(guest, 'finished');
  const finalHostCorrection = waitForState(host, 'correction');
  const finalGuestCorrection = waitForState(guest, 'correction');
  clock.advance(30_000);
  await Promise.all([finalHostCorrection, finalGuestCorrection]);
  clock.advance(20_000);
  const [hostFinal, guestFinal] = await Promise.all([finalHost, finalGuest]);
  assert.equal(hostFinal.finalRanking[0].score, 20);
  assert.equal(guestFinal.finalRanking[1].score, 20);
  const overview = await request(host, 'stats:get', {});
  assert.equal(overview.games['petit-bac'].history.length, 1);
  assert.equal(overview.games['petit-bac'].leaderboard[0].score, 20);
});

test('capital quiz applies its selected continent and question type for every player', async (t) => {
  const clock = createFakeClock();
  const game = createGameServer({ port: 0, host: '127.0.0.1', now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const address = await game.listen();
  const host = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  const guest = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  t.after(async () => {
    host.disconnect();
    guest.disconnect();
    await game.close();
  });
  await Promise.all([waitForConnect(host), waitForConnect(guest)]);
  const created = await request(host, 'room:create', { name: 'Nora', gameType: 'capitales' });
  assert.equal((await request(guest, 'room:join', { code: created.code, name: 'Mina' })).ok, true);
  assert.equal((await request(host, 'game:configure', { config: { ...DEFAULT_CAPITALS_CONFIG, rounds: 5, duration: 10, questionMode: 'capital', continents: ['Afrique'] } })).ok, true);
  const hostPlaying = waitForState(host, 'playing');
  const guestPlaying = waitForState(guest, 'playing');
  assert.equal((await request(host, 'game:start')).ok, true);
  const [hostState, guestState] = await Promise.all([hostPlaying, guestPlaying]);
  assert.equal(hostState.question.kind, 'capital');
  assert.equal(guestState.question.flagCode, hostState.question.flagCode);
  const country = WORLD_COUNTRIES.find((entry) => entry.code === hostState.question.flagCode);
  assert.equal(country.continent, 'Afrique');
  await Promise.all([
    request(host, 'answer:update', { categoryIndex: 0, value: country.capitals[0] }),
    request(guest, 'answer:update', { categoryIndex: 0, value: country.capitals[0] }),
  ]);
  const hostCorrection = waitForState(host, 'correction');
  const guestCorrection = waitForState(guest, 'correction');
  clock.jump(10_000);
  await request(host, 'game:sync', {});
  const [hostResult, guestResult] = await Promise.all([hostCorrection, guestCorrection]);
  assert.equal(hostResult.roundResults[0].roundScore, 10);
  assert.equal(guestResult.roundResults[1].roundScore, 10);
});

test('Petit Bac corrections require two distinct reviewers in a room of three', async (t) => {
  const clock = createFakeClock();
  const game = createGameServer({ port: 0, host: '127.0.0.1', now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const address = await game.listen();
  const host = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  const firstReviewer = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  const secondReviewer = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
  t.after(async () => {
    host.disconnect();
    firstReviewer.disconnect();
    secondReviewer.disconnect();
    await game.close();
  });
  await Promise.all([waitForConnect(host), waitForConnect(firstReviewer), waitForConnect(secondReviewer)]);
  const created = await request(host, 'room:create', { name: 'Nora' });
  await request(firstReviewer, 'room:join', { code: created.code, name: 'Mina' });
  await request(secondReviewer, 'room:join', { code: created.code, name: 'Idriss' });
  const config = { ...DEFAULT_CONFIG, rounds: 1, duration: 30, categories: ['Animal'], letterMode: 'host', firstLetter: 'M', excludedLetters: 'ABCDEFGHIJKLNOPQRSTUVWXYZ' };
  assert.equal((await request(host, 'game:configure', { config })).ok, true);
  const hostPlaying = waitForState(host, 'playing');
  const firstPlaying = waitForState(firstReviewer, 'playing');
  const secondPlaying = waitForState(secondReviewer, 'playing');
  await request(host, 'game:start');
  const [hostState, firstState, secondState] = await Promise.all([hostPlaying, firstPlaying, secondPlaying]);
  await request(host, 'answer:update', { categoryIndex: 0, value: 'Mouflon' });
  const correction = waitForState(host, 'correction');
  const firstCorrection = waitForState(firstReviewer, 'correction');
  const secondCorrection = waitForState(secondReviewer, 'correction');
  clock.jump(30_000);
  await request(firstReviewer, 'game:sync', {});
  const [hostResult, firstResult, secondResult] = await Promise.all([correction, firstCorrection, secondCorrection]);
  assert.equal(firstResult.roundResults[0].answers[0].requiredVotes, 2);
  assert.equal((await request(firstReviewer, 'correction:approve', { playerId: hostState.myPlayerId, categoryIndex: 0, approved: true })).state.roundResults[0].roundScore, 0);
  assert.equal((await request(firstReviewer, 'correction:approve', { playerId: hostState.myPlayerId, categoryIndex: 0, approved: true })).ok, false);
  const accepted = await request(secondReviewer, 'correction:approve', { playerId: hostState.myPlayerId, categoryIndex: 0, approved: true });
  assert.equal(accepted.state.roundResults[0].roundScore, 10);
  assert.equal(accepted.state.roundResults[0].answers[0].approvalVotes, 2);
  assert.equal(firstState.question, undefined);
  assert.equal(secondState.question, undefined);
  assert.equal(hostResult.roundResults[0].roundScore, 0);
});

test('a Render-style process restart restores rooms from asynchronous Redis checkpoints', async (t) => {
  const data = new Map();
  const checkpointRedis = {
    async set(key, value) { data.set(key, value); return 'OK'; },
    async del(key) { return data.delete(key) ? 1 : 0; },
    async scan(_cursor, _match, pattern) { return ['0', [...data.keys()].filter((key) => key.startsWith(pattern.replace('*', '')))]; },
    async mget(...keys) { return keys.map((key) => data.get(key) || null); },
  };
  let firstServer = createGameServer({ port: 0, host: '127.0.0.1', checkpointRedis, checkpointDelayMs: 20 });
  const firstAddress = await firstServer.listen();
  const host = connect(`http://127.0.0.1:${firstAddress.port}`, { transports: ['websocket'], forceNew: true });
  let secondServer;
  let returningPlayer;
  t.after(async () => {
    host.disconnect();
    returningPlayer?.disconnect();
    if (secondServer) await secondServer.close();
    if (firstServer) await firstServer.close();
  });
  await waitForConnect(host);
  const created = await request(host, 'room:create', { name: 'Aminata' });
  await firstServer.close();
  firstServer = null;

  secondServer = createGameServer({ port: 0, host: '127.0.0.1', checkpointRedis, checkpointDelayMs: 20 });
  assert.equal(await secondServer.restoreRooms(), 1);
  const secondAddress = await secondServer.listen();
  returningPlayer = connect(`http://127.0.0.1:${secondAddress.port}`, { transports: ['websocket'], forceNew: true });
  await waitForConnect(returningPlayer);
  const resumed = await request(returningPlayer, 'session:resume', { code: created.code, token: created.token });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.code, created.code);
  assert.equal(resumed.state.players[0].name, 'Aminata');
});
