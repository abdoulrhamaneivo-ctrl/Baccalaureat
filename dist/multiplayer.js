(() => {
  'use strict';

  const app = document.getElementById('app');
  const STORAGE_KEY = 'petit-bac-multiplayer-session-v1';
  const CAPITALS_CONTINENTS = ['Afrique', 'Amériques', 'Asie', 'Europe', 'Océanie'];
  let socket = null;
  let state = null;
  let requestedGameType = 'petit-bac';
  let credentials = readCredentials();
  let sessionActive = false;
  let hadConnection = false;
  let countdown = null;
  let timerSync = null;
  let timerSyncInFlight = false;
  let timerSyncAttempt = 0;
  let answerContext = null;
  let answerDrafts = new Map();
  let answerQueue = new Map();
  let answerRevisions = [];
  let answerFlushTimer = null;
  let answerFlushInFlight = null;
  let answerRetryDelay = 500;
  let clockSyncTimer = null;
  let serverClockSynced = false;
  let reconnecting = false;
  let socketScriptPromise = null;
  let serverClockOffset = 0;
  const socketPath = window.PETIT_BAC_SOCKET_PATH || '/socket.io';
  const socketUrl = String(window.PETIT_BAC_SOCKET_URL || '').replace(/\/+$/, '');

  function setState(nextState) {
    const nextContext = nextState?.state === 'playing' && nextState.code
      ? `${nextState.code}:${nextState.roundNumber}`
      : null;
    if (nextState?.code && answerContext && !answerContext.startsWith(`${nextState.code}:`)) {
      resetAnswerDrafts();
    }
    if (nextContext && nextContext !== answerContext) {
      resetAnswerDrafts();
      answerContext = nextContext;
      answerRevisions = [...(nextState.myAnswerRevisions || [])];
    } else if (nextContext) {
      const serverRevisions = nextState.myAnswerRevisions || [];
      nextState.myAnswers = [...(nextState.myAnswers || [])];
      for (let index = 0; index < nextState.myAnswers.length; index += 1) {
        const serverRevision = Number(serverRevisions[index] || 0);
        answerRevisions[index] = Math.max(answerRevisions[index] || 0, serverRevision);
        const draft = answerDrafts.get(index);
        if (draft && draft.revision > serverRevision) nextState.myAnswers[index] = draft.value;
        else if (draft) answerDrafts.delete(index);
      }
    }
    state = nextState;
    if (!serverClockSynced && Number.isFinite(nextState?.serverNow)) serverClockOffset = nextState.serverNow - Date.now();
  }

  function resetAnswerDrafts() {
    clearTimeout(answerFlushTimer);
    answerFlushTimer = null;
    answerDrafts.clear();
    answerQueue.clear();
    answerRevisions = [];
    answerContext = null;
  }

  function scheduleAnswerFlush(delay = 300) {
    clearTimeout(answerFlushTimer);
    answerFlushTimer = setTimeout(() => { void flushAnswers(); }, delay);
  }

  function flushAnswers(drain = false) {
    clearTimeout(answerFlushTimer);
    answerFlushTimer = null;
    if (!socket?.connected) return Promise.resolve(false);
    if (answerFlushInFlight) {
      const pending = answerFlushInFlight;
      return drain ? pending.then((result) => answerQueue.size ? flushAnswers(false) : result) : pending;
    }
    if (!answerQueue.size) return Promise.resolve(true);

    const context = answerContext;
    const batch = [...answerQueue.entries()].map(([categoryIndex, answer]) => ({ categoryIndex, ...answer }));
    for (const answer of batch) {
      if (answerQueue.get(answer.categoryIndex)?.revision === answer.revision) answerQueue.delete(answer.categoryIndex);
    }

    answerFlushInFlight = new Promise((resolve) => {
      socket.timeout(8000).emit('answers:update', { answers: batch }, (error, response) => {
        if (context === answerContext) {
          if (error || !response?.ok) {
            const expired = response?.error?.includes('écoulé') || response?.error?.includes('verrouillées');
            for (const answer of batch) {
              const newerQueued = answerQueue.get(answer.categoryIndex);
              if (!expired && (!newerQueued || newerQueued.revision < answer.revision)) {
                answerQueue.set(answer.categoryIndex, answer);
              }
              if (expired) answerDrafts.delete(answer.categoryIndex);
            }
          } else {
            answerRetryDelay = 500;
            for (const answer of batch) {
              const serverRevision = Number(response.revisions?.[answer.categoryIndex] ?? answer.revision);
              answerRevisions[answer.categoryIndex] = Math.max(answerRevisions[answer.categoryIndex] || 0, serverRevision);
              const draft = answerDrafts.get(answer.categoryIndex);
              if (draft && draft.revision <= serverRevision) {
                answerDrafts.delete(answer.categoryIndex);
                const input = app.querySelector(`[data-answer="${answer.categoryIndex}"]`);
                if (input && serverRevision > answer.revision && !answerQueue.has(answer.categoryIndex)) {
                  input.value = response.values?.[answer.categoryIndex] || '';
                }
              }
            }
          }
        }
        answerFlushInFlight = null;
        resolve(Boolean(response?.ok));
        if (answerQueue.size && !error && response?.ok) scheduleAnswerFlush(80);
        if (answerQueue.size && error && socket?.connected) {
          scheduleAnswerFlush(answerRetryDelay);
          answerRetryDelay = Math.min(3000, answerRetryDelay * 2);
        }
        const liveError = document.getElementById('liveError');
        if (liveError && response?.error && !response.error.includes('écoulé')) liveError.textContent = response.error;
      });
    });
    const pending = answerFlushInFlight;
    return drain ? pending.then((result) => answerQueue.size ? flushAnswers(false) : result) : pending;
  }

  function serverNow() { return Date.now() + serverClockOffset; }

  function syncServerClock() {
    if (!socket?.connected) return;
    const sentAt = Date.now();
    socket.timeout(4000).emit('time:sync', {}, (_error, response) => {
      const receivedAt = Date.now();
      if (!Number.isFinite(response?.serverNow)) return;
      serverClockOffset = response.serverNow - ((sentAt + receivedAt) / 2);
      serverClockSynced = true;
    });
  }

  function requestTimerProgress() {
    if (timerSync || !state?.isHost) return;
    const sync = () => {
      if (!state || !['playing', 'correction', 'break'].includes(state.state)) {
        clearInterval(timerSync);
        timerSync = null;
        return;
      }
      if (!socket?.connected || timerSyncInFlight) return;
      timerSyncInFlight = true;
      const attempt = ++timerSyncAttempt;
      socket.timeout(5000).emit('game:sync', {}, () => {
        if (attempt === timerSyncAttempt) timerSyncInFlight = false;
      });
    };
    sync();
    timerSync = setInterval(sync, 1000);
  }

  function readCredentials() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return saved && typeof saved.code === 'string' && typeof saved.token === 'string' ? saved : null;
    } catch (_) { return null; }
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function saveCredentials(next) {
    credentials = next;
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  }

  function ensureSocketLibrary() {
    if (window.io) return Promise.resolve();
    if (socketScriptPromise) return socketScriptPromise;
    socketScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${socketUrl}${socketPath}/socket.io.js`;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Le serveur temps réel est introuvable à cette adresse.'));
      document.head.append(script);
    });
    return socketScriptPromise;
  }

  function createSocket() {
    const options = {
      path: socketPath,
      addTrailingSlash: false,
      transports: ['websocket'],
      upgrade: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      timeout: 8000,
    };
    socket = socketUrl ? window.io(socketUrl, options) : window.io(options);
    socket.on('connect', () => {
      syncServerClock();
      clearInterval(clockSyncTimer);
      clockSyncTimer = setInterval(syncServerClock, 60000);
      if (hadConnection && sessionActive && credentials) {
        reconnecting = true;
        run('session:resume', credentials).then(() => flushAnswers()).finally(() => { reconnecting = false; });
      }
      hadConnection = true;
      const status = document.getElementById('connectionStatus');
      if (status) status.textContent = 'Connecté';
    });
    socket.on('game:state', (nextState) => {
      setState(nextState);
      renderState();
    });
    socket.on('disconnect', () => {
      clearInterval(clockSyncTimer);
      clockSyncTimer = null;
      timerSyncAttempt += 1;
      timerSyncInFlight = false;
      const status = document.getElementById('connectionStatus');
      if (status) status.textContent = 'Connexion interrompue · reconnexion en cours…';
    });
    socket.on('connect_error', () => {
      const status = document.getElementById('connectionStatus');
      if (status) status.textContent = 'Serveur indisponible · nouvelle tentative…';
    });
  }

  async function ensureConnected() {
    await ensureSocketLibrary();
    if (!socket) createSocket();
    if (socket.connected) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Le serveur ne répond pas. Réessayez dans un instant.')); }, 10000);
      const connected = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Impossible de joindre le serveur de partie.')); };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('connect', connected);
        socket.off('connect_error', failed);
      };
      socket.once('connect', connected);
      socket.once('connect_error', failed);
      socket.connect();
    });
  }

  async function run(event, payload = {}) {
    const liveError = document.getElementById('liveError');
    if (liveError) liveError.textContent = '';
    try {
      await ensureConnected();
      const response = await new Promise((resolve, reject) => {
        socket.timeout(6000).emit(event, payload, (error, result) => {
          if (error) reject(new Error('Le serveur n’a pas répondu à temps.'));
          else resolve(result);
        });
      });
      if (!response?.ok) throw new Error(response?.error || 'La demande n’a pas abouti.');
      if (response.code && response.token) saveCredentials({ code: response.code, token: response.token });
      if (response.state) setState(response.state);
      sessionActive = true;
      renderState();
      return response;
    } catch (error) {
      const target = document.getElementById('liveError');
      if (target) target.textContent = error.message;
      else renderEntry(error.message);
      throw error;
    }
  }

  function runWithButton(button, event, payload = {}, busyLabel = 'En cours…') {
    if (!button || button.disabled) return Promise.resolve();
    const originalLabel = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyLabel;
    return run(event, payload).catch(() => {}).finally(() => {
      if (!button.isConnected) return;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalLabel;
    });
  }

  function quietlyRun(event, payload) {
    run(event, payload).catch(() => {});
  }

  function shell(content) {
    const connectionLabel = socket?.connected ? 'Connecté' : 'Connexion au serveur…';
    const hostLabel = state?.hostName ? ` · Hôte : ${escapeHTML(state.hostName)}` : '';
    return `<div class="multi-shell"><div class="multi-toolbar"><button id="backHome" class="quiet">← Accueil</button><span id="connectionStatus" class="connection-status">${connectionLabel}${hostLabel}</span></div><div id="liveError" class="error live-error" role="alert"></div>${content}</div>`;
  }

  function renderEntry(error = '') {
    clearInterval(countdown);
    clearInterval(timerSync);
    timerSync = null;
    resetAnswerDrafts();
    state = null;
    const requestedCode = new URLSearchParams(location.search).get('room') || '';
    const gameName = requestedGameType === 'capitales' ? 'Capitales du monde' : 'Petit Bac';
    app.innerHTML = shell(`<section class="multi-heading"><div class="eyebrow">${escapeHTML(gameName.toUpperCase())} · CHACUN SUR SON APPAREIL</div><h1>Jouez ensemble,<br>où que vous soyez.</h1><p class="muted">Créez une salle pour inviter vos amis, ou rejoignez-les avec leur code.</p></section><div class="multi-entry-grid"><form id="createForm" class="card"><div class="eyebrow">VOUS ORGANISEZ</div><h2>Créer une salle de ${escapeHTML(gameName)}</h2><label class="field"><span>Votre pseudo</span><input name="name" maxlength="24" required autocomplete="nickname" placeholder="Ex. Abdoul"></label><button class="primary wide">Créer ma salle</button></form><form id="joinForm" class="card"><div class="eyebrow">ON VOUS A INVITÉ</div><h2>Rejoindre une salle</h2><label class="field"><span>Code de la salle</span><input name="code" maxlength="6" required autocomplete="off" autocapitalize="characters" placeholder="ABCD42" value="${escapeHTML(requestedCode)}"></label><label class="field"><span>Votre pseudo</span><input name="name" maxlength="24" required autocomplete="nickname" placeholder="Ex. Fatou"></label><button class="primary wide">Rejoindre la partie</button></form></div>${error ? `<p class="error entry-error" role="alert">${escapeHTML(error)}</p>` : ''}<p class="notice multi-footnote">Jusqu’à 20 joueurs par salle. Chacun répond sur son appareil et le serveur synchronise les questions.</p>`);
    document.getElementById('backHome').onclick = () => window.showHome?.();
    document.getElementById('createForm').onsubmit = async (event) => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get('name');
      await runWithButton(event.currentTarget.querySelector('button'), 'room:create', { name, gameType: requestedGameType }, 'Création…');
    };
    document.getElementById('joinForm').onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await runWithButton(event.currentTarget.querySelector('button'), 'room:join', { code: form.get('code'), name: form.get('name') }, 'Connexion…');
    };
  }

  function renderLobby() {
    const config = state.config;
    const connectedCount = state.players.filter((player) => player.connected).length;
    const capitalGame = state.gameType === 'capitales';
    const gameName = capitalGame ? 'Capitales du monde' : 'Petit Bac';
    const categories = CATEGORIES.map((category, index) => `<label class="multi-check"><input type="checkbox" name="category" value="${escapeHTML(category)}" ${config.categories.includes(category) ? 'checked' : ''}><span>${ICONS[index]} ${escapeHTML(category)}</span></label>`).join('');
    const continents = CAPITALS_CONTINENTS.map((continent) => `<label class="multi-check"><input type="checkbox" name="continent" value="${escapeHTML(continent)}" ${(config.continents || CAPITALS_CONTINENTS).includes(continent) ? 'checked' : ''}><span>${escapeHTML(continent)}</span></label>`).join('');
    const questionMode = config.questionMode || 'random';
    let settings;
    if (state.isHost && capitalGame) {
      settings = `<form id="configForm" class="card config-card"><div class="eyebrow">RÈGLES DU QUIZ</div><h2>Configuration</h2><div class="config-grid"><label class="field"><span>Nombre de questions</span><select name="rounds">${[5, 10, 15, 20, 30].map((value) => `<option value="${value}" ${config.rounds === value ? 'selected' : ''}>${value} questions</option>`).join('')}</select></label><label class="field"><span>Temps par question</span><select name="duration">${[10, 15, 20, 30].map((value) => `<option value="${value}" ${config.duration === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label><label class="field field-full"><span>Question demandée</span><select name="questionMode"><option value="random" ${questionMode === 'random' ? 'selected' : ''}>Pays ou capitale, au hasard</option><option value="country" ${questionMode === 'country' ? 'selected' : ''}>Toujours le nom du pays</option><option value="capital" ${questionMode === 'capital' ? 'selected' : ''}>Toujours la capitale</option></select></label></div><fieldset class="category-picker"><legend>Continents au tirage</legend><div class="multi-check-grid">${continents}</div></fieldset><p class="notice">Un drapeau commun s’affiche pour tous. Chaque bonne réponse rapporte 10 points à chaque joueur qui la trouve.</p><button class="quiet">Enregistrer la configuration</button><button type="button" id="startGame" class="primary wide" ${connectedCount < 2 ? 'disabled' : ''}>Démarrer le quiz</button>${connectedCount < 2 ? '<p class="notice">Attendez qu’au moins une autre personne rejoigne la salle.</p>' : ''}</form>`;
    } else if (state.isHost) {
      settings = `<form id="configForm" class="card config-card"><div class="eyebrow">RÈGLES DE LA PARTIE</div><h2>Configuration</h2><div class="config-grid"><label class="field"><span>Nombre de manches</span><input name="rounds" type="number" min="1" max="50" step="1" required value="${config.rounds}"></label><label class="field"><span>Durée d’une manche</span><select name="duration">${[30, 60, 90, 120].map((value) => `<option value="${value}" ${config.duration === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label></div><fieldset class="category-picker"><legend>Catégories</legend><div class="multi-check-grid">${categories}</div></fieldset><div class="config-grid"><label class="field"><span>Choix des lettres</span><select name="letterMode"><option value="random" ${config.letterMode === 'random' ? 'selected' : ''}>Aléatoire, sans répétition</option><option value="host" ${config.letterMode === 'host' ? 'selected' : ''}>Je choisis la première lettre</option></select></label><label class="field"><span>Première lettre</span><input name="firstLetter" maxlength="1" pattern="[A-Za-z]" value="${escapeHTML(config.firstLetter)}" ${config.letterMode === 'host' ? 'required' : ''}></label><label class="field field-full"><span>Lettres à exclure (facultatif)</span><input name="excludedLetters" maxlength="26" value="${escapeHTML(config.excludedLetters)}" placeholder="Ex. K, W, X, Y, Z"></label></div><p class="notice">Après la première lettre choisie, les lettres suivantes sont tirées au hasard. Les réponses correctes identiques valent 0 point pour tous leurs auteurs.</p><button class="quiet">Enregistrer la configuration</button><button type="button" id="startGame" class="primary wide" ${connectedCount < 2 ? 'disabled' : ''}>Démarrer la partie</button>${connectedCount < 2 ? '<p class="notice">Attendez qu’au moins une autre personne rejoigne la salle.</p>' : ''}</form>`;
    } else if (capitalGame) {
      const modeLabel = questionMode === 'country' ? 'Toujours le nom du pays' : questionMode === 'capital' ? 'Toujours la capitale' : 'Pays ou capitale, au hasard';
      settings = `<section class="card config-card"><div class="eyebrow">RÈGLES DU QUIZ</div><h2>Capitales du monde</h2><div class="config-summary"><span>${config.rounds} questions</span><span>${config.duration} secondes par question</span><span>${escapeHTML(modeLabel)}</span><span>Continents : ${(config.continents || CAPITALS_CONTINENTS).map(escapeHTML).join(' · ')}</span><span>10 points pour chaque bonne réponse</span></div><p class="notice">L’hôte configurera et démarrera le quiz.</p></section>`;
    } else {
      settings = `<section class="card config-card"><div class="eyebrow">RÈGLES DE LA PARTIE</div><h2>Configuration</h2><div class="config-summary"><span>${config.rounds} manches</span><span>${config.duration} secondes par manche</span><span>${config.categories.map(escapeHTML).join(' · ')}</span><span>${config.letterMode === 'host' ? `Première lettre : ${escapeHTML(config.firstLetter)}` : 'Lettres aléatoires sans répétition'}</span><span>Pause de ${config.pauseSeconds} secondes entre les manches</span></div><p class="notice">L’hôte configurera et démarrera la partie. En multijoueur, une réponse correcte identique vaut 0 point pour tous ceux qui l’ont donnée.</p></section>`;
    }
    return shell(`<section class="multi-heading lobby-heading"><div class="eyebrow">SALLE D’ATTENTE · ${escapeHTML(gameName.toUpperCase())}</div><h1>La bande se réunit.</h1><p class="muted">Partagez le code et attendez que tout le monde soit prêt.</p></section><div class="lobby-grid"><section class="card room-card"><div class="eyebrow">CODE DE LA SALLE</div><div class="room-code">${escapeHTML(state.code)}</div><div class="room-actions"><button id="copyCode" class="quiet">Copier le code</button><button id="shareRoom" class="quiet">Partager l’invitation</button></div><div class="section-title player-list-title"><h2>Joueurs</h2><span>${connectedCount} connecté${connectedCount !== 1 ? 's' : ''}</span></div><ul class="multi-player-list">${state.players.map((player) => `<li><span class="status-dot ${player.connected ? 'online' : ''}"></span><strong>${escapeHTML(player.name)}</strong>${player.isHost ? '<small>Hôte</small>' : ''}${player.connected ? '' : '<small>Reconnexion…</small>'}</li>`).join('')}</ul></section>${settings}</div>`);
  }

  function rankingMarkup(players) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    let lastScore = null;
    let rank = 0;
    return sorted.map((player, index) => {
      if (lastScore !== player.score) rank = index + 1;
      lastScore = player.score;
      return `<div class="rank-row"><span class="position">${rank}</span><strong>${escapeHTML(player.name)}</strong><span class="score">${player.score}</span><small>pts</small></div>`;
    }).join('');
  }

  function renderPlaying() {
    if (state.gameType === 'capitales') {
      const question = state.question;
      return shell(`<div class="multi-game-top"><div><div class="round-label">QUESTION ${state.roundNumber} / ${state.config.rounds}</div><h1>Capitales du monde</h1></div><div class="tag">${state.players.length} joueurs</div></div><section class="card answer-card capital-card"><p class="capital-prompt">${escapeHTML(question.prompt)}</p><div class="capital-flag-wrap"><img class="capital-flag" src="${escapeHTML(question.flagUrl)}" alt="Drapeau à identifier"></div><div class="multi-play-layout"><aside class="card multi-clock"><div><div class="timer" id="roundCountdown">${state.config.duration}</div><span>secondes restantes</span><div class="progress"><span id="roundProgress"></span></div></div></aside><div class="capital-answer"><label for="capitalAnswer">Votre réponse</label><input id="capitalAnswer" data-answer="0" maxlength="70" autocomplete="off" spellcheck="false" placeholder="Votre réponse…" value="${escapeHTML(state.myAnswers?.[0] || '')}"><p class="notice">Votre réponse est enregistrée au fil de la saisie. Le chrono est commun à toute la salle.</p></div></div></section>`);
    }
    const fields = state.categories.map((category, index) => `<label class="field"><span>${ICONS[CATEGORIES.indexOf(category)]} ${escapeHTML(category)}</span><input data-answer="${index}" maxlength="70" autocomplete="off" spellcheck="false" placeholder="${escapeHTML(category)} en ${escapeHTML(state.letter)}…" value="${escapeHTML(state.myAnswers?.[index] || '')}"></label>`).join('');
    return shell(`<div class="multi-game-top"><div><div class="round-label">MANCHE ${state.roundNumber} / ${state.config.rounds}</div><h1>À vous de jouer.</h1></div><div class="tag">${state.players.length} joueurs</div></div><div class="multi-play-layout"><aside class="card multi-clock"><div class="big-letter">${escapeHTML(state.letter)}</div><div><div class="timer" id="roundCountdown">${state.config.duration}</div><span>secondes restantes</span><div class="progress"><span id="roundProgress"></span></div></div></aside><section class="card answer-card"><div class="section-title"><h2>${escapeHTML(state.players.find((player) => player.id === state.myPlayerId)?.name || 'Vos réponses')}</h2><span>${state.categories.length} catégories</span></div><div class="answer-fields multi-answer-fields">${fields}</div><p class="notice">Vos réponses sont enregistrées au fil de la saisie et se verrouillent à la fin du chrono.</p></section></div>`);
  }

  function renderCorrection() {
    if (state.gameType === 'capitales') {
      const question = state.question;
      const responses = (state.roundResults || []).map((player) => {
        const answer = player.answers[0];
        return `<li><strong>${escapeHTML(player.name)}</strong><span>${escapeHTML(answer.word) || '—'}</span><span class="capital-answer-status ${answer.correct ? 'correct' : 'wrong'}">${answer.points} pts</span></li>`;
      }).join('');
      const remaining = Math.max(0, Math.ceil((state.correctionEndsAt - serverNow()) / 1000));
      return shell(`<div class="multi-game-top"><div><div class="round-label">QUESTION ${state.roundNumber} / ${state.config.rounds} · CORRECTION</div><h1>La bonne réponse</h1></div><div class="tag">${remaining} s</div></div><div class="results-grid multi-results"><section class="card capital-reveal"><p class="capital-prompt">${escapeHTML(question.prompt)}</p><div class="capital-flag-wrap"><img class="capital-flag" src="${escapeHTML(question.flagUrl)}" alt="Drapeau du pays demandé"></div><div class="eyebrow">${question.kind === 'country' ? 'PAYS' : 'CAPITALE'}</div><div class="capital-correct-answer">${escapeHTML(question.answer)}</div><ul class="capital-result-list">${responses}</ul><p class="notice">Chaque bonne réponse rapporte 10 points.</p></section><aside class="card multi-ranking"><div class="eyebrow">CLASSEMENT</div>${rankingMarkup(state.players)}${state.isHost ? '<button id="finishCorrection" class="primary wide">Continuer</button>' : '<p class="notice">La question suivante arrive automatiquement.</p>'}</aside></div>`);
    }
    const roundsResult = (state.roundResults || []).map((player) => `<details class="card correction-player" ${player.playerId === state.myPlayerId ? 'open' : ''}><summary><span>${escapeHTML(player.name)}</span><strong>${player.roundScore} pts</strong></summary>${player.answers.map((answer, index) => `<div class="answer-row"><span>${escapeHTML(answer.category)}</span><div><strong>${escapeHTML(answer.word) || '—'}</strong><small>${escapeHTML(answer.reason)}</small>${answer.canReview || answer.myVote !== null ? `<small class="review-vote-count">${answer.approvalVotes} pour · ${answer.rejectionVotes} contre · ${answer.requiredVotes} vote(s) requis</small><small>Votre avis : ${answer.myVote === true ? 'validée' : answer.myVote === false ? 'refusée' : 'à donner'}</small>${answer.canReview ? `<button class="review-button" data-review="${escapeHTML(player.playerId)},${index},true">Valider la réponse</button><button class="review-button" data-review="${escapeHTML(player.playerId)},${index},false">Refuser la réponse</button>` : '<small>Votre vote est enregistré.</small>'}` : ''}</div><span class="points ${answer.points ? '' : 'zero'}">${answer.points} pts</span></div>`).join('')}</details>`).join('');
    const remaining = Math.max(0, Math.ceil((state.correctionEndsAt - serverNow()) / 1000));
    return shell(`<div class="multi-game-top"><div><div class="round-label">MANCHE ${state.roundNumber} / ${state.config.rounds} · CORRECTION</div><h1>Les réponses sont là.</h1></div><div class="tag">${remaining} s pour corriger</div></div><div class="results-grid multi-results"><section>${roundsResult}</section><aside class="card multi-ranking"><div class="eyebrow">CLASSEMENT PROVISOIRE</div>${rankingMarkup(state.players)}${state.isHost ? '<button id="finishCorrection" class="primary wide">Terminer la correction</button>' : '<p class="notice">La suite commence automatiquement après la correction.</p>'}</aside></div>`);
  }

  function renderBreak() {
    const item = state.gameType === 'capitales' ? 'question' : 'manche';
    return shell(`<section class="card break-card"><div class="eyebrow">${item.toUpperCase()} ${state.roundNumber} TERMINÉE</div><h1>Bien joué !</h1><p class="muted">La prochaine ${item} commence automatiquement dans</p><div class="break-countdown" id="breakCountdown"></div><div class="card break-ranking"><h2>Classement</h2>${rankingMarkup(state.players)}</div></section>`);
  }

  function renderFinished() {
    const ranking = state.finalRanking || state.players;
    const gameName = state.gameType === 'capitales' ? 'Capitales du monde' : 'Petit Bac';
    const item = state.gameType === 'capitales' ? 'questions' : 'manches';
    return shell(`<section class="final-board multi-final"><div class="winner"><div class="eyebrow">${escapeHTML(gameName.toUpperCase())} · ${state.roundsPlayed} ${item.toUpperCase()} TERMINÉES</div><h1>${escapeHTML(ranking[0]?.name || 'Bien joué !')}</h1><p>${ranking.length > 1 && ranking[0]?.score === ranking[1]?.score ? 'Premiers ex æquo. Bien joué !' : 'Remporte la partie. Bien joué !'}</p><div class="score">${ranking[0]?.score || 0} points</div></div><section class="card"><h2>Classement final</h2>${rankingMarkup(ranking)}${state.isHost ? '<button id="replayGame" class="primary wide">Rejouer avec la même salle</button>' : '<p class="notice">L’hôte peut relancer une partie avec la même salle.</p>'}<button id="leaveGame" class="quiet wide">Retour à l’accueil</button></section></section>`);
  }

  function renderState() {
    clearInterval(countdown);
    clearInterval(timerSync);
    timerSync = null;
    if (!state) return renderEntry();
    if (state.state === 'lobby') app.innerHTML = renderLobby();
    else if (state.state === 'playing') app.innerHTML = renderPlaying();
    else if (state.state === 'correction') app.innerHTML = renderCorrection();
    else if (state.state === 'break') app.innerHTML = renderBreak();
    else if (state.state === 'finished') app.innerHTML = renderFinished();
    else return renderEntry('État de partie inconnu.');

    document.getElementById('backHome').onclick = leaveToHome;
    const copyCode = document.getElementById('copyCode');
    if (copyCode) copyCode.onclick = async () => {
      try { await navigator.clipboard.writeText(state.code); copyCode.textContent = 'Code copié !'; }
      catch (_) { copyCode.textContent = `Code : ${state.code}`; }
    };
    const share = document.getElementById('shareRoom');
    if (share) share.onclick = async () => {
      const url = new URL(location.href);
      url.searchParams.set('room', state.code);
      const gameName = state.gameType === 'capitales' ? 'Capitales du monde' : 'Petit Bac';
      const shareData = { title: `Rejoins ma partie de ${gameName}`, text: `Code de salle : ${state.code}`, url: url.toString() };
      try { if (navigator.share) await navigator.share(shareData); else { await navigator.clipboard.writeText(`${shareData.text} — ${shareData.url}`); share.textContent = 'Invitation copiée !'; } }
      catch (_) { /* The share sheet can be dismissed without an error message. */ }
    };
    const configForm = document.getElementById('configForm');
    if (configForm) configForm.onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(configForm);
      const config = {
        rounds: Number(form.get('rounds')),
        duration: Number(form.get('duration')),
        categories: form.getAll('category'),
        letterMode: form.get('letterMode'),
        firstLetter: String(form.get('firstLetter') || '').toUpperCase(),
        excludedLetters: String(form.get('excludedLetters') || '').toUpperCase(),
      };
      if (state.gameType === 'capitales') {
        config.questionMode = String(form.get('questionMode') || 'random');
        config.continents = form.getAll('continent');
      }
      await runWithButton(configForm.querySelector('button:not([type="button"])'), 'game:configure', { config }, 'Enregistrement…');
    };
    const startGame = document.getElementById('startGame');
    if (startGame) startGame.onclick = () => runWithButton(startGame, 'game:start', {}, 'Démarrage…');
    const finishCorrection = document.getElementById('finishCorrection');
    if (finishCorrection) finishCorrection.onclick = () => runWithButton(finishCorrection, 'correction:finish', {}, 'Suite…');
    app.querySelectorAll('[data-review]').forEach((button) => {
      button.onclick = () => {
        const [playerId, categoryIndex, approved] = button.dataset.review.split(',');
        runWithButton(button, 'correction:approve', { playerId, categoryIndex: Number(categoryIndex), approved: approved === 'true' }, 'Vote envoyé…');
      };
    });
    const replay = document.getElementById('replayGame');
    if (replay) replay.onclick = () => runWithButton(replay, 'game:replay', {}, 'Préparation…');
    const leave = document.getElementById('leaveGame');
    if (leave) leave.onclick = leaveToHome;

    if (state.state === 'playing') {
      let timerSyncRequested = false;
      app.querySelectorAll('[data-answer]').forEach((input) => {
        input.addEventListener('input', () => {
          const categoryIndex = Number(input.dataset.answer);
          const revision = Math.max(answerRevisions[categoryIndex] || 0, state.myAnswerRevisions?.[categoryIndex] || 0) + 1;
          answerRevisions[categoryIndex] = revision;
          const answer = { value: input.value, revision };
          answerDrafts.set(categoryIndex, answer);
          answerQueue.set(categoryIndex, answer);
          scheduleAnswerFlush(300);
        });
        input.addEventListener('blur', () => { void flushAnswers(); });
      });
      const endsAt = state.roundEndsAt;
      const durationMs = state.config.duration * 1000;
      const tickRound = () => {
        const leftMs = Math.max(0, endsAt - serverNow());
        const clock = document.getElementById('roundCountdown');
        const bar = document.getElementById('roundProgress');
        if (clock) { clock.textContent = Math.ceil(leftMs / 1000); clock.classList.toggle('low', leftMs <= 10000); }
        if (bar) bar.style.width = `${Math.max(0, Math.min(100, (leftMs / durationMs) * 100))}%`;
        if (leftMs <= 0 && !timerSyncRequested) {
          timerSyncRequested = true;
          void flushAnswers(true).finally(requestTimerProgress);
        }
      };
      tickRound();
      countdown = setInterval(tickRound, 150);
    } else if (state.state === 'break') {
      const endsAt = state.breakEndsAt;
      const tickBreak = () => {
        const node = document.getElementById('breakCountdown');
        const leftMs = Math.max(0, endsAt - serverNow());
        if (node) node.textContent = Math.ceil(leftMs / 1000);
        if (leftMs <= 0) requestTimerProgress();
      };
      tickBreak();
      countdown = setInterval(tickBreak, 200);
    } else if (state.state === 'correction') {
      const endsAt = state.correctionEndsAt;
      countdown = setInterval(() => {
        const leftMs = Math.max(0, endsAt - serverNow());
        const tag = document.querySelector('.multi-game-top .tag');
        if (tag) tag.textContent = state.gameType === 'capitales'
          ? `${Math.ceil(leftMs / 1000)} s`
          : `${Math.ceil(leftMs / 1000)} s pour corriger`;
        if (leftMs <= 0) requestTimerProgress();
      }, 250);
    }
  }

  async function leaveToHome() {
    try { if (credentials && socket?.connected && state) await new Promise((resolve) => socket.emit('room:leave', {}, () => resolve())); }
    finally {
      resetAnswerDrafts();
      saveCredentials(null);
      sessionActive = false;
      state = null;
      if (socket) { socket.disconnect(); socket = null; }
      window.showHome?.();
    }
  }

  async function resumeSession() {
    if (!credentials) return renderEntry();
    app.innerHTML = `<section class="card ready"><div class="eyebrow">REPRISE DE LA PARTIE</div><h1>On vous retrouve…</h1><p class="muted">Salle ${escapeHTML(credentials.code)}</p><div class="multi-spinner"></div></section>`;
    try {
      await run('session:resume', credentials);
    } catch (error) {
      saveCredentials(null);
      sessionActive = false;
      renderEntry(error.message);
    }
  }

  const ONLINE_GAMES = [
    { type: 'petit-bac', name: 'Petit Bac', item: 'manches' },
    { type: 'capitales', name: 'Capitales du monde', item: 'questions' },
  ];

  function renderOnlineStats(games) {
    const cards = ONLINE_GAMES.map(({ type, name, item }) => {
      const data = games?.[type] || { leaderboard: [], history: [] };
      const leaders = data.leaderboard.length
        ? data.leaderboard.map((player, index) => `<div class="rank-row"><span class="position">${index + 1}</span><strong>${escapeHTML(player.pseudo)}</strong><span class="score">${player.score}</span><small>pts</small></div>`).join('')
        : '<p class="online-stats-empty">Aucune partie terminée pour le moment.</p>';
      const history = data.history.length
        ? data.history.slice(0, 10).map((match) => {
          const ranking = [...match.players].sort((left, right) => right.score - left.score);
          const winner = ranking[0];
          const date = new Date(match.completedAt);
          const dateLabel = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
          const winnerLabel = winner ? `${winner.pseudo} · ${winner.score} pts` : 'Partie terminée';
          return `<li><strong>${escapeHTML(winnerLabel)}</strong><span>${escapeHTML(dateLabel)} · ${match.roundsPlayed} ${item}</span></li>`;
        }).join('')
        : '<li class="online-stats-empty">Aucun historique disponible.</li>';
      return `<section class="card online-stats-card"><div class="eyebrow">${escapeHTML(name.toUpperCase())}</div><h2>Top 10 · points cumulés</h2>${leaders}<h2>Parties récentes</h2><ul class="online-history">${history}</ul></section>`;
    }).join('');
    app.innerHTML = shell(`<section class="multi-heading"><div class="eyebrow">JEU EN GROUPE</div><h1>Scores et parties récentes</h1><p class="muted">Les classements additionnent les points gagnés sous chaque pseudo.</p></section><div class="online-stats-grid">${cards}</div>`);
    document.getElementById('backHome').onclick = () => window.showHome?.();
  }

  window.showMultiplayerStats = async () => {
    app.innerHTML = `<section class="card ready"><div class="eyebrow">CLASSEMENTS</div><h1>Chargement des scores…</h1><div class="multi-spinner"></div></section>`;
    try {
      await ensureConnected();
      const response = await new Promise((resolve, reject) => {
        socket.timeout(8000).emit('stats:get', {}, (error, result) => error ? reject(new Error('Le serveur ne répond pas.')) : resolve(result));
      });
      if (!response?.ok) throw new Error(response?.error || 'Impossible de charger les scores.');
      renderOnlineStats(response.games);
    } catch (error) {
      app.innerHTML = shell(`<section class="card ready"><div class="eyebrow">CLASSEMENTS</div><h1>Scores indisponibles</h1><p class="error">${escapeHTML(error.message)}</p><button id="retryOnlineStats" class="primary">Réessayer</button></section>`);
      document.getElementById('backHome').onclick = () => window.showHome?.();
      document.getElementById('retryOnlineStats').onclick = () => window.showMultiplayerStats();
    }
  };

  window.startMultiplayer = (gameType = 'petit-bac') => {
    requestedGameType = gameType === 'capitales' ? 'capitales' : 'petit-bac';
    if (credentials) resumeSession();
    else renderEntry();
  };
})();
