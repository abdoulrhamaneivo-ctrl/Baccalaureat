(() => {
  'use strict';

  const app = document.getElementById('app');
  const STORAGE_KEY = 'petit-bac-multiplayer-session-v1';
  const CAPITALS_CONTINENTS = ['Afrique', 'Amériques', 'Asie', 'Europe', 'Océanie'];
  const CULTURE_CATEGORIES = window.CULTURE_CATEGORIES || ['Histoire', 'Géographie', 'Sciences', 'Arts et culture', 'Sports'];
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
    const gameName = requestedGameType === 'capitales' ? 'Capitales du monde' : requestedGameType === 'culture' ? 'Culture générale' : 'Petit Bac';
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
    const cultureGame = state.gameType === 'culture';
    const gameName = capitalGame ? 'Capitales du monde' : cultureGame ? 'Culture générale' : 'Petit Bac';
    const teamsReady = !state.teamMode || state.teams.every((team) => team.players.some((player) => player.connected));
    const startDisabled = connectedCount < 2 || !teamsReady ? 'disabled' : '';
    const startNotice = connectedCount < 2
      ? 'Attendez qu’au moins une autre personne rejoigne la salle.'
      : !teamsReady ? 'Connectez au moins un joueur dans chaque équipe avant le départ.' : '';
    const teamSettings = `<fieldset class="category-picker team-settings"><legend>Modes de jeu</legend><label class="multi-check"><input type="checkbox" name="teamMode" ${state.teamMode ? 'checked' : ''}><span>Jouer par équipes et cumuler leurs points</span></label><label class="field"><span>Nombre d’équipes</span><select name="teamCount">${[2, 3, 4].map((value) => `<option value="${value}" ${state.teamCount === value ? 'selected' : ''}>${value} équipes</option>`).join('')}</select></label><p class="notice">Les équipes sont équilibrées automatiquement. Chaque joueur peut choisir son équipe dans la salle d’attente.</p><label class="multi-check"><input type="checkbox" name="eliminationMode" ${state.eliminationMode ? 'checked' : ''}><span>Rush par élimination · sans limite de manches</span></label><p class="notice">Le joueur ou l’équipe au score cumulé le plus bas est éliminé à chaque manche. En cas d’égalité au dernier rang, tous les ex æquo sont éliminés ensemble. Si tous sont éliminés, la partie se termine sur une égalité.</p></fieldset>`;
    const teamLobby = state.teamMode ? `<section class="team-lobby"><div class="eyebrow">ÉQUIPES EN PRÉSENCE</div><div class="team-lobby-grid">${state.teams.map((team) => `<div class="team-lobby-card"><strong>${escapeHTML(team.name)} · ${team.score} pts</strong><span>${team.players.map((player) => `${escapeHTML(player.name)}${player.left ? ' · a quitté la partie' : player.connected ? '' : ' · hors ligne'}`).join(', ') || 'En attente d’un joueur'}</span></div>`).join('')}</div><label class="field team-select-field"><span>Choisir mon équipe</span><select id="teamSelect">${state.teams.map((team) => `<option value="${team.id}" ${state.players.find((player) => player.id === state.myPlayerId)?.teamId === team.id ? 'selected' : ''}>${escapeHTML(team.name)}</option>`).join('')}</select></label></section>` : '';
    const categories = CATEGORIES.map((category, index) => `<label class="multi-check"><input type="checkbox" name="category" value="${escapeHTML(category)}" ${config.categories.includes(category) ? 'checked' : ''}><span>${ICONS[index]} ${escapeHTML(category)}</span></label>`).join('');
    const continents = CAPITALS_CONTINENTS.map((continent) => `<label class="multi-check"><input type="checkbox" name="continent" value="${escapeHTML(continent)}" ${(config.continents || CAPITALS_CONTINENTS).includes(continent) ? 'checked' : ''}><span>${escapeHTML(continent)}</span></label>`).join('');
    const questionMode = config.questionMode || 'random';
    const cultureMode = config.mode || 'qcm';
    let settings;
    if (state.isHost && capitalGame) {
      settings = `<form id="configForm" class="card config-card"><div class="eyebrow">RÈGLES DU QUIZ</div><h2>Configuration</h2><div class="config-grid"><label class="field rounds-setting"><span>Nombre de questions</span><select name="rounds">${[5, 10, 15, 20, 30].map((value) => `<option value="${value}" ${config.rounds === value ? 'selected' : ''}>${value} questions</option>`).join('')}</select></label><label class="field"><span>Temps par question</span><select name="duration">${[10, 15, 20, 30].map((value) => `<option value="${value}" ${config.duration === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label><label class="field field-full"><span>Question demandée</span><select name="questionMode"><option value="random" ${questionMode === 'random' ? 'selected' : ''}>Pays ou capitale, au hasard</option><option value="country" ${questionMode === 'country' ? 'selected' : ''}>Toujours le nom du pays</option><option value="capital" ${questionMode === 'capital' ? 'selected' : ''}>Toujours la capitale</option></select></label></div><fieldset class="category-picker"><legend>Continents au tirage</legend><div class="multi-check-grid">${continents}</div></fieldset>${teamSettings}<p class="notice">Un drapeau commun s’affiche pour tous. Chaque bonne réponse rapporte 10 points à chaque joueur qui la trouve.</p><button class="quiet">Enregistrer la configuration</button><button type="button" id="startGame" class="primary wide" ${startDisabled}>Démarrer le quiz</button>${startNotice ? `<p class="notice">${startNotice}</p>` : ''}</form>`;
    } else if (state.isHost && cultureGame) {
      const themes = CULTURE_CATEGORIES.map((category) => `<label class="multi-check"><input type="checkbox" name="cultureCategory" value="${escapeHTML(category)}" ${(config.categories || CULTURE_CATEGORIES).includes(category) ? 'checked' : ''}><span>${escapeHTML(category)}</span></label>`).join('');
      settings = `<form id="configForm" class="card config-card"><div class="eyebrow">RÈGLES DU QUIZ</div><h2>Configuration</h2><div class="config-grid"><label class="field rounds-setting"><span>Nombre de questions</span><select name="rounds">${[5, 10, 15, 20, 30].map((value) => `<option value="${value}" ${config.rounds === value ? 'selected' : ''}>${value} questions</option>`).join('')}</select></label><label class="field"><span>Temps par question</span><select name="duration">${[10, 15, 20, 30].map((value) => `<option value="${value}" ${config.duration === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label><label class="field field-full"><span>Format du jeu</span><select name="cultureMode"><option value="qcm" ${cultureMode === 'qcm' ? 'selected' : ''}>Quiz à choix multiples</option><option value="vrai-faux" ${cultureMode === 'vrai-faux' ? 'selected' : ''}>Vrai ou faux</option></select></label></div><fieldset class="category-picker"><legend>Thèmes au tirage</legend><div class="multi-check-grid">${themes}</div></fieldset>${teamSettings}<p class="notice">Chaque joueur répond aux mêmes questions. Une bonne réponse vaut 10 points ; une explication s’affiche après chaque question.</p><button class="quiet">Enregistrer la configuration</button><button type="button" id="startGame" class="primary wide" ${startDisabled}>Démarrer le quiz</button>${startNotice ? `<p class="notice">${startNotice}</p>` : ''}</form>`;
    } else if (state.isHost) {
      settings = `<form id="configForm" class="card config-card"><div class="eyebrow">RÈGLES DE LA PARTIE</div><h2>Configuration</h2><div class="config-grid"><label class="field rounds-setting"><span>Nombre de manches</span><input name="rounds" type="number" min="1" max="50" step="1" required value="${config.rounds}"></label><label class="field"><span>Durée d’une manche</span><select name="duration">${[30, 60, 90, 120].map((value) => `<option value="${value}" ${config.duration === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label><label class="field field-full pause-setting"><span>Passage à la manche suivante</span><select name="pauseSeconds"><option value="0" ${config.pauseSeconds === 0 ? 'selected' : ''}>Manuel · l’hôte lance la suite</option>${[5, 10, 15, 30].map((value) => `<option value="${value}" ${config.pauseSeconds === value ? 'selected' : ''}>Automatique après ${value} secondes</option>`).join('')}</select></label></div><fieldset class="category-picker"><legend>Catégories</legend><div class="multi-check-grid">${categories}</div></fieldset><div class="config-grid"><label class="field"><span>Choix des lettres</span><select name="letterMode"><option value="random" ${config.letterMode === 'random' ? 'selected' : ''}>Aléatoire, sans répétition</option><option value="host" ${config.letterMode === 'host' ? 'selected' : ''}>Je choisis la première lettre</option></select></label><label class="field"><span>Première lettre</span><input name="firstLetter" maxlength="1" pattern="[A-Za-z]" value="${escapeHTML(config.firstLetter)}" ${config.letterMode === 'host' ? 'required' : ''}></label><label class="field field-full"><span>Lettres à exclure (facultatif)</span><input name="excludedLetters" maxlength="26" value="${escapeHTML(config.excludedLetters)}" placeholder="Ex. K, W, X, Y, Z"></label></div>${teamSettings}<p class="notice">Les réponses valides doivent contenir au moins 3 lettres. ${state.teamMode ? 'En équipe, les coéquipiers qui donnent la même réponse correcte marquent chacun 10 points ; entre équipes, la première équipe à la saisir gagne le doublon.' : 'En individuel, seul le premier joueur qui saisit une réponse identique marque 10 points.'}</p><button class="quiet">Enregistrer la configuration</button><button type="button" id="startGame" class="primary wide" ${startDisabled}>Démarrer la partie</button>${startNotice ? `<p class="notice">${startNotice}</p>` : ''}</form>`;
    } else if (capitalGame) {
      const modeLabel = questionMode === 'country' ? 'Toujours le nom du pays' : questionMode === 'capital' ? 'Toujours la capitale' : 'Pays ou capitale, au hasard';
      settings = `<section class="card config-card"><div class="eyebrow">RÈGLES DU QUIZ</div><h2>Capitales du monde</h2><div class="config-summary"><span>${state.eliminationMode ? 'Rush par élimination · manches sans limite' : `${config.rounds} questions`}</span><span>${config.duration} secondes par question</span><span>${escapeHTML(modeLabel)}</span><span>Continents : ${(config.continents || CAPITALS_CONTINENTS).map(escapeHTML).join(' · ')}</span><span>10 points pour chaque bonne réponse</span></div><p class="notice">L’hôte configurera et démarrera le quiz.</p></section>`;
    } else if (cultureGame) {
      settings = `<section class="card config-card"><div class="eyebrow">RÈGLES DU QUIZ</div><h2>Culture générale</h2><div class="config-summary"><span>${state.eliminationMode ? 'Rush par élimination · manches sans limite' : `${config.rounds} questions`}</span><span>${config.duration} secondes par question</span><span>Format : ${cultureMode === 'vrai-faux' ? 'Vrai ou faux' : 'Choix multiples'}</span><span>Thèmes : ${(config.categories || []).map(escapeHTML).join(' · ')}</span><span>10 points pour chaque bonne réponse</span></div><p class="notice">L’hôte configurera et démarrera le quiz.</p></section>`;
    } else {
      settings = `<section class="card config-card"><div class="eyebrow">RÈGLES DE LA PARTIE</div><h2>Configuration</h2><div class="config-summary"><span>${state.eliminationMode ? 'Rush par élimination · manches sans limite' : `${config.rounds} manches`}</span><span>${config.duration} secondes par manche</span><span>${config.categories.map(escapeHTML).join(' · ')}</span><span>${config.letterMode === 'host' ? `Première lettre : ${escapeHTML(config.firstLetter)}` : 'Lettres aléatoires sans répétition'}</span><span>${state.eliminationMode ? 'Manches automatiques' : config.pauseSeconds === 0 ? 'L’hôte lance chaque nouvelle manche' : `Pause automatique de ${config.pauseSeconds} secondes`}</span></div><p class="notice">L’hôte configurera et démarrera la partie. ${state.teamMode ? 'Les coéquipiers peuvent donner la même réponse : chacun marque ses points. Entre équipes, la première équipe qui saisit cette réponse gagne le doublon.' : 'En individuel, seul le premier joueur qui saisit une réponse identique marque 10 points.'}</p></section>`;
    }
    return shell(`<section class="multi-heading lobby-heading"><div class="eyebrow">SALLE D’ATTENTE · ${escapeHTML(gameName.toUpperCase())}</div><h1>La bande se réunit.</h1><p class="muted">Partagez le code et attendez que tout le monde soit prêt.</p></section><div class="lobby-grid"><section class="card room-card"><div class="eyebrow">CODE DE LA SALLE</div><div class="room-code">${escapeHTML(state.code)}</div><div class="room-actions"><button id="copyCode" class="quiet">Copier le code</button><button id="shareRoom" class="quiet">Partager l’invitation</button></div><div class="section-title player-list-title"><h2>Joueurs</h2><span>${connectedCount} connecté${connectedCount !== 1 ? 's' : ''}</span></div><ul class="multi-player-list">${state.players.map((player) => `<li><span class="status-dot ${player.connected ? 'online' : ''}"></span><strong>${escapeHTML(player.name)}</strong>${player.isHost ? '<small>Hôte</small>' : ''}${player.connected ? '' : '<small>Reconnexion…</small>'}</li>`).join('')}</ul>${teamLobby}</section>${settings}</div>`);
  }

  function rankingMarkup(players) {
    const sorted = [...players].sort((a, b) => (state.eliminationMode ? Number(Number.isInteger(a.eliminatedAt)) - Number(Number.isInteger(b.eliminatedAt)) : 0)
      || b.score - a.score || (a.rank || Number.MAX_SAFE_INTEGER) - (b.rank || Number.MAX_SAFE_INTEGER));
    return sorted.map((player, index) => {
      const rank = index + 1;
      const status = state.eliminationMode && Number.isInteger(player.eliminatedAt) ? `Éliminé · manche ${player.eliminatedAt}` : 'pts';
      return `<div class="rank-row"><span class="position">${rank}</span><strong>${escapeHTML(player.name)}</strong><span class="score">${player.score}</span><small>${status}</small></div>`;
    }).join('');
  }

  function roundProgress(noun, correcting = false) {
    return state.eliminationMode
      ? `RUSH · ${noun} ${state.roundNumber} · ${state.activeCompetitors} EN LICE${correcting ? ' · CORRECTION' : ''}`
      : `${noun} ${state.roundNumber} / ${state.config.rounds}${correcting ? ' · CORRECTION' : ''}`;
  }

  function teamRankingMarkup() {
    return state.teamMode ? `<section class="team-scoreboard"><div class="eyebrow">CLASSEMENT DES ÉQUIPES · POINTS CUMULÉS</div>${rankingMarkup(state.teams)}</section>` : '';
  }

  function roomRankingMarkup(players) {
    return state.teamMode
      ? `${teamRankingMarkup()}<section class="individual-scoreboard"><div class="eyebrow">CLASSEMENT INDIVIDUEL</div>${rankingMarkup(players)}</section>`
      : rankingMarkup(players);
  }

  function playerCountTag(showIndividualScore = false) {
    const currentPlayer = state.players.find((player) => player.id === state.myPlayerId);
    const team = state.teams.find((candidate) => candidate.id === currentPlayer?.teamId);
    return `${state.players.length} joueurs${state.teamMode && team ? ` · ${escapeHTML(team.name)} ${team.score} pts` : ''}${showIndividualScore && currentPlayer ? ` · vous ${currentPlayer.score} pts` : ''}`;
  }

  function renderPlaying() {
    if (state.gameType === 'capitales') {
      const question = state.question;
      return shell(`<div class="multi-game-top"><div><div class="round-label">${roundProgress('QUESTION')}</div><h1>Capitales du monde</h1></div><div class="tag">${playerCountTag()}</div></div><section class="card answer-card capital-card"><p class="capital-prompt">${escapeHTML(question.prompt)}</p><div class="capital-flag-wrap"><img class="capital-flag" src="${escapeHTML(question.flagUrl)}" alt="Drapeau à identifier"></div><div class="multi-play-layout"><aside class="card multi-clock"><div><div class="timer" id="roundCountdown">${state.config.duration}</div><span>secondes restantes</span><div class="progress"><span id="roundProgress"></span></div></div></aside><div class="capital-answer"><label for="capitalAnswer">Votre réponse</label><input id="capitalAnswer" data-answer="0" maxlength="70" autocomplete="off" spellcheck="false" placeholder="Votre réponse…" value="${escapeHTML(state.myAnswers?.[0] || '')}"><p class="notice">Votre réponse est enregistrée au fil de la saisie. Le chrono est commun à toute la salle.</p></div></div></section>`);
    }
    if (state.gameType === 'culture') {
      const question = state.question;
      const selected = String(state.myAnswers?.[0] ?? '');
      const hint = state.myHint
        ? `<p class="culture-hint" role="status">Indice utilisé (−5 pts) : la réponse ${state.myHint.direction === 'first' ? 'commence' : 'se termine'} par « <strong>${escapeHTML(state.myHint.letters)}</strong> ».</p>`
        : `<div class="culture-hint-actions"><button class="quiet" data-culture-hint="first" ${state.canUseHint ? '' : 'disabled'}>3 premières lettres · −5 pts</button><button class="quiet" data-culture-hint="last" ${state.canUseHint ? '' : 'disabled'}>3 dernières lettres · −5 pts</button></div><p class="notice">${state.canUseHint ? 'Un indice coûte 5 points et ne peut être utilisé qu’une fois par question.' : 'Il faut au moins 5 points pour acheter un indice.'}</p>`;
      const options = question.options.map((option, index) => `<button class="culture-option ${selected === String(index) ? 'is-selected' : ''}" data-culture-option="${index}" ${selected !== '' ? 'disabled' : ''}><span class="culture-option-letter">${String.fromCharCode(65 + index)}</span>${escapeHTML(option)}</button>`).join('');
      return shell(`<div class="multi-game-top"><div><div class="round-label">${roundProgress('QUESTION')}</div><h1>${state.config.mode === 'vrai-faux' ? 'Vrai ou faux' : 'Culture générale'}</h1></div><div class="tag">${playerCountTag(true)}</div></div><section class="card answer-card culture-card"><span class="culture-badge">${escapeHTML(question.category)}</span><p class="culture-prompt">${escapeHTML(question.prompt)}</p><div class="multi-play-layout"><aside class="card multi-clock"><div><div class="timer" id="roundCountdown">${state.config.duration}</div><span>secondes restantes</span><div class="progress"><span id="roundProgress"></span></div></div></aside><div class="culture-options">${options}${hint}</div></div><p class="notice">${selected !== '' ? 'Votre réponse est enregistrée.' : 'Choisissez une réponse. Le chrono est commun à toute la salle.'}</p></section>`);
    }
    const fields = state.categories.map((category, index) => `<label class="field"><span>${ICONS[CATEGORIES.indexOf(category)]} ${escapeHTML(category)}</span><input data-answer="${index}" maxlength="70" autocomplete="off" spellcheck="false" placeholder="${escapeHTML(category)} en ${escapeHTML(state.letter)}…" value="${escapeHTML(state.myAnswers?.[index] || '')}"></label>`).join('');
    return shell(`<div class="multi-game-top"><div><div class="round-label">${roundProgress('MANCHE')}</div><h1>À vous de jouer.</h1></div><div class="tag">${playerCountTag()}</div></div><div class="multi-play-layout"><aside class="card multi-clock"><div class="big-letter">${escapeHTML(state.letter)}</div><div><div class="timer" id="roundCountdown">${state.config.duration}</div><span>secondes restantes</span><div class="progress"><span id="roundProgress"></span></div></div></aside><section class="card answer-card"><div class="section-title"><h2>${escapeHTML(state.players.find((player) => player.id === state.myPlayerId)?.name || 'Vos réponses')}</h2><span>${state.categories.length} catégories</span></div><div class="answer-fields multi-answer-fields">${fields}</div><p class="notice">Vos réponses sont enregistrées au fil de la saisie et se verrouillent à la fin du chrono.</p></section></div>`);
  }

  function renderCorrection() {
    if (state.gameType === 'capitales' || state.gameType === 'culture') {
      const question = state.question;
      const responses = (state.roundResults || []).map((player) => {
        const answer = player.answers[0];
        return `<li><strong>${escapeHTML(player.name)}</strong><span>${escapeHTML(answer.word) || '—'}</span><span class="capital-answer-status ${answer.correct ? 'correct' : 'wrong'}">${answer.points} pts</span></li>`;
      }).join('');
      const remaining = Math.max(0, Math.ceil((state.correctionEndsAt - serverNow()) / 1000));
      const reveal = state.gameType === 'culture'
        ? `<span class="culture-badge">${escapeHTML(question.category)}</span><p class="culture-prompt">${escapeHTML(question.prompt)}</p><div class="capital-correct-answer">${escapeHTML(question.answer)}</div>${question.explanation ? `<p class="culture-explanation">${escapeHTML(question.explanation)}</p>` : ''}`
        : `<p class="capital-prompt">${escapeHTML(question.prompt)}</p><div class="capital-flag-wrap"><img class="capital-flag" src="${escapeHTML(question.flagUrl)}" alt="Drapeau du pays demandé" onerror="this.onerror=null;this.replaceWith(document.createTextNode('🏳️'))"></div><div class="eyebrow">${question.kind === 'country' ? 'PAYS' : 'CAPITALE'}</div><div class="capital-correct-answer">${escapeHTML(question.answer)}</div>`;
      return shell(`<div class="multi-game-top"><div><div class="round-label">${roundProgress('QUESTION', true)}</div><h1>La bonne réponse</h1></div><div class="tag">${remaining} s</div></div><div class="results-grid multi-results"><section class="card capital-reveal">${reveal}<ul class="capital-result-list">${responses}</ul><p class="notice">Chaque bonne réponse rapporte 10 points.</p></section><aside class="card multi-ranking"><div class="eyebrow">CLASSEMENT</div>${roomRankingMarkup(state.players)}${state.isHost ? '<button id="finishCorrection" class="primary wide">Continuer</button>' : '<p class="notice">La question suivante arrive automatiquement.</p>'}</aside></div>`);
    }
    const roundsResult = (state.roundResults || []).map((player) => `<details class="card correction-player" ${player.playerId === state.myPlayerId ? 'open' : ''}><summary><span>${escapeHTML(player.name)}</span><strong>${player.roundScore} pts</strong></summary>${player.answers.map((answer, index) => `<div class="answer-row"><span>${escapeHTML(answer.category)}</span><div><strong>${escapeHTML(answer.word) || '—'}</strong><small>${escapeHTML(answer.reason)}</small>${answer.canReview || answer.myVote !== null ? `<small class="review-vote-count">${answer.approvalVotes} pour · ${answer.rejectionVotes} contre · ${answer.requiredVotes} vote(s) requis</small><small>Votre avis : ${answer.myVote === true ? 'validée' : answer.myVote === false ? 'refusée' : 'à donner'}</small>${answer.canReview ? `<button class="review-button" data-review="${escapeHTML(player.playerId)},${index},true">Valider la réponse</button><button class="review-button" data-review="${escapeHTML(player.playerId)},${index},false">Refuser la réponse</button>` : '<small>Votre vote est enregistré.</small>'}` : ''}</div><span class="points ${answer.points ? '' : 'zero'}">${answer.points} pts</span></div>`).join('')}</details>`).join('');
    const remaining = Math.max(0, Math.ceil((state.correctionEndsAt - serverNow()) / 1000));
    return shell(`<div class="multi-game-top"><div><div class="round-label">${roundProgress('MANCHE', true)}</div><h1>Les réponses sont là.</h1></div><div class="tag">${remaining} s pour corriger</div></div><div class="results-grid multi-results"><section>${roundsResult}</section><aside class="card multi-ranking"><div class="eyebrow">CLASSEMENT PROVISOIRE</div>${roomRankingMarkup(state.players)}${state.isHost ? '<button id="finishCorrection" class="primary wide">Terminer la correction</button>' : `<p class="notice">${state.manualNextRound ? 'L’hôte lancera la prochaine manche quand tout le monde sera prêt.' : 'La suite commence automatiquement après la correction.'}</p>`}</aside></div>`);
  }

  function renderBreak() {
    const item = state.gameType === 'petit-bac' ? 'manche' : 'question';
    const manual = state.manualNextRound && state.gameType === 'petit-bac';
    const launch = state.eliminationMode
      ? `<p class="notice rush-notice">${escapeHTML(state.eliminationNotice || 'Le Rush continue jusqu’à la dernière place.')}</p><p class="muted">La prochaine manche commence automatiquement dans</p><div class="break-countdown" id="breakCountdown"></div>`
      : manual ? (state.isHost
      ? '<p class="muted">Quand tout le monde est prêt, lance la prochaine manche.</p><button id="startNextRound" class="primary wide">Lancer la manche suivante</button>'
      : `<p class="notice">En attente de l’hôte (${escapeHTML(state.hostName || 'hôte')}) pour lancer la prochaine manche.</p>`)
      : `<p class="muted">La prochaine ${item} commence automatiquement dans</p><div class="break-countdown" id="breakCountdown"></div>`;
    return shell(`<section class="card break-card"><div class="eyebrow">${state.eliminationMode ? 'RUSH · ' : ''}${item.toUpperCase()} ${state.roundNumber} TERMINÉE</div><h1>${state.eliminationMode ? 'Le Rush continue !' : 'Bien joué !'}</h1>${launch}<div class="card break-ranking"><h2>Classement</h2>${roomRankingMarkup(state.players)}</div></section>`);
  }

  function renderEliminationSpectator() {
    const phase = state.state === 'playing' ? 'La manche est en cours.' : state.state === 'correction' ? 'Les réponses sont en cours de correction.' : 'La prochaine manche se prépare.';
    return shell(`<section class="card break-card elimination-spectator"><div class="eyebrow">RUSH · SPECTATEUR</div><h1>Vous avez été éliminé.</h1><p class="muted">${escapeHTML(state.eliminationNotice || phase)}</p><p>${phase} Vous pouvez suivre les scores jusqu’à la fin de la partie.</p><div class="card break-ranking"><h2>Classement</h2>${rankingMarkup(state.teamMode ? state.teams : state.players)}</div></section>`);
  }

  function renderFinished() {
    const individualRanking = state.finalRanking || state.players;
    const ranking = state.teamMode ? state.teams : individualRanking;
    const gameName = state.gameType === 'capitales' ? 'Capitales du monde' : state.gameType === 'culture' ? 'Culture générale' : 'Petit Bac';
    const item = state.gameType === 'petit-bac' ? 'manches' : 'questions';
    const eliminationDraw = Boolean(state.eliminationMode && state.eliminationDraw);
    const history = state.gameType === 'petit-bac' ? `<section class="card final-round-history"><h2>Vérifier les réponses de chaque manche</h2><p class="notice">Les joueurs peuvent encore signaler une réponse douteuse. Les mêmes votes de correction s’appliquent : 1 vote à deux joueurs, 2 votes à partir de trois.</p>${(state.roundHistory || []).map((round) => `<details class="final-round-card"><summary>Manche ${round.number} · Lettre ${escapeHTML(round.letter)}</summary>${round.players.map((player) => `<details class="correction-player"><summary><span>${escapeHTML(player.name)}</span><strong>${player.roundScore} pts</strong></summary>${player.answers.map((answer, index) => `<div class="answer-row"><span>${escapeHTML(answer.category)}</span><div><strong>${escapeHTML(answer.word) || '—'}</strong><small>${escapeHTML(answer.reason)}</small>${answer.canReview || answer.myVote !== null ? `<small class="review-vote-count">${answer.approvalVotes} pour · ${answer.rejectionVotes} contre · ${answer.requiredVotes} vote(s) requis</small>${answer.myVote === null ? '' : `<small>Votre avis : ${answer.myVote ? 'validée' : 'refusée'}</small>`}${answer.canReview ? `<button class="review-button" data-review="${escapeHTML(player.playerId)},${index},true,${round.number}">Valider la réponse</button><button class="review-button" data-review="${escapeHTML(player.playerId)},${index},false,${round.number}">Refuser la réponse</button>` : ''}` : ''}</div><span class="points ${answer.points ? '' : 'zero'}">${answer.points} pts</span></div>`).join('')}</details>`).join('')}</details>`).join('')}</section>` : '';
    const winnerText = state.teamMode
      ? 'Les points de tous les joueurs de l’équipe sont cumulés.'
      : ranking.length > 1 && ranking[0]?.score === ranking[1]?.score
        ? 'Prend la première place grâce au classement précédent.'
        : 'Remporte la partie. Bien joué !';
    return shell(`<section class="final-board multi-final"><div class="winner"><div class="eyebrow">${state.eliminationMode ? 'RUSH TERMINÉ · ' : ''}${escapeHTML(gameName.toUpperCase())} · ${state.roundsPlayed} ${item.toUpperCase()} TERMINÉES</div><h1>${eliminationDraw ? 'Égalité générale' : escapeHTML(ranking[0]?.name || 'Bien joué !')}</h1><p>${state.eliminationMode ? escapeHTML(state.eliminationNotice || `${ranking[0]?.name || 'Le gagnant'} remporte le Rush.`) : winnerText}</p>${state.teamMode && !eliminationDraw ? `<p class="muted">${ranking[0]?.players.map((player) => escapeHTML(player.name)).join(' · ') || ''}</p>` : ''}<div class="score">${ranking[0]?.score || 0} points${state.teamMode ? ' cumulés' : ''}</div></div><section class="card">${state.teamMode ? '<h2>Classement des équipes</h2>' : '<h2>Classement final</h2>'}${rankingMarkup(ranking)}${state.teamMode ? `<details class="individual-final-ranking"><summary>Voir le classement individuel</summary>${rankingMarkup(individualRanking)}</details>` : ''}${state.isHost ? '<button id="replayGame" class="primary wide">Rejouer avec la même salle</button>' : '<p class="notice">L’hôte peut relancer une partie avec la même salle.</p>'}<button id="leaveGame" class="quiet wide">Retour à l’accueil</button></section>${history}</section>`);
  }

  function renderState() {
    clearInterval(countdown);
    clearInterval(timerSync);
    timerSync = null;
    if (!state) return renderEntry();
    if (state.state === 'lobby') app.innerHTML = renderLobby();
    else if (state.eliminationMode && state.myEliminated && ['playing', 'correction', 'break'].includes(state.state)) app.innerHTML = renderEliminationSpectator();
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
      const gameName = state.gameType === 'capitales' ? 'Capitales du monde' : state.gameType === 'culture' ? 'Culture générale' : 'Petit Bac';
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
    if (state.gameType === 'petit-bac') config.pauseSeconds = Number(form.get('pauseSeconds'));
      if (state.gameType === 'capitales') {
        config.questionMode = String(form.get('questionMode') || 'random');
        config.continents = form.getAll('continent');
      } else if (state.gameType === 'culture') {
        config.categories = form.getAll('cultureCategory');
        config.mode = String(form.get('cultureMode') || 'qcm');
      }
      await runWithButton(configForm.querySelector('button:not([type="button"])'), 'game:configure', {
        config,
        teamMode: form.get('teamMode') === 'on',
        teamCount: Number(form.get('teamCount') || state.teamCount || 2),
        eliminationMode: form.get('eliminationMode') === 'on',
      }, 'Enregistrement…');
    };
    const eliminationToggle = configForm?.querySelector('[name="eliminationMode"]');
    const roundsSetting = configForm?.querySelector('.rounds-setting');
    const pauseSetting = configForm?.querySelector('.pause-setting');
    if (eliminationToggle) {
      if (roundsSetting) roundsSetting.hidden = eliminationToggle.checked;
      if (pauseSetting) pauseSetting.hidden = eliminationToggle.checked;
      eliminationToggle.onchange = () => {
        if (roundsSetting) roundsSetting.hidden = eliminationToggle.checked;
        if (pauseSetting) pauseSetting.hidden = eliminationToggle.checked;
      };
    }
    const teamSelect = document.getElementById('teamSelect');
    if (teamSelect) teamSelect.onchange = () => run('team:choose', { teamId: Number(teamSelect.value) }).catch((error) => {
      const liveError = document.getElementById('liveError');
      if (liveError) liveError.textContent = error.message;
    });
    const startGame = document.getElementById('startGame');
    if (startGame) startGame.onclick = () => runWithButton(startGame, 'game:start', {}, 'Démarrage…');
    const finishCorrection = document.getElementById('finishCorrection');
    if (finishCorrection) finishCorrection.onclick = () => runWithButton(finishCorrection, 'correction:finish', {}, 'Suite…');
    const startNextRound = document.getElementById('startNextRound');
    if (startNextRound) startNextRound.onclick = () => runWithButton(startNextRound, 'round:next', {}, 'Préparation…');
    app.querySelectorAll('[data-culture-hint]').forEach((button) => {
      button.onclick = () => runWithButton(button, 'culture:hint', { direction: button.dataset.cultureHint }, 'Achat de l’indice…');
    });
    app.querySelectorAll('[data-review]').forEach((button) => {
      button.onclick = () => {
        const [playerId, categoryIndex, approved, roundNumber] = button.dataset.review.split(',');
        runWithButton(button, 'correction:approve', { playerId, categoryIndex: Number(categoryIndex), approved: approved === 'true', ...(roundNumber ? { roundNumber: Number(roundNumber) } : {}) }, 'Vote envoyé…');
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
          const answer = { value: input.value, revision, enteredAt: serverNow() };
          answerDrafts.set(categoryIndex, answer);
          answerQueue.set(categoryIndex, answer);
          scheduleAnswerFlush(300);
        });
        input.addEventListener('blur', () => { void flushAnswers(); });
      });
      if (state.gameType === 'culture') {
        app.querySelectorAll('[data-culture-option]').forEach((button) => {
          button.addEventListener('click', () => {
            if (answerQueue.has(0) || state.myAnswers?.[0]) return;
            const revision = Math.max(answerRevisions[0] || 0, state.myAnswerRevisions?.[0] || 0) + 1;
            answerRevisions[0] = revision;
            const answer = { value: button.dataset.cultureOption, revision, enteredAt: serverNow() };
            answerDrafts.set(0, answer);
            answerQueue.set(0, answer);
            app.querySelectorAll('[data-culture-option]').forEach((choice) => {
              choice.disabled = true;
              if (choice === button) choice.classList.add('is-selected');
            });
            const notice = app.querySelector('.culture-card .notice');
            if (notice) notice.textContent = 'Réponse enregistrée. Le chrono continue pour tout le monde.';
            void flushAnswers(true);
          });
        });
      }
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
      if (!endsAt) return;
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
        if (tag) tag.textContent = state.gameType !== 'petit-bac'
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
    { type: 'culture', name: 'Culture générale', item: 'questions' },
  ];

  let homeLeaderboardCache = null;
  let homeLeaderboardRequest = null;

  function renderHomeLeaderboards(games) {
    const target = document.getElementById('homeLeaderboardContent');
    if (!target) return;
    target.innerHTML = ONLINE_GAMES.map(({ type, name }) => {
      const leaders = (games?.[type]?.leaderboard || []).slice(0, 3);
      const rows = leaders.length
        ? leaders.map((player, index) => `<div class="rank-row"><span class="position">${index + 1}</span><strong>${escapeHTML(player.pseudo)}</strong><span class="score">${player.score}</span><small>pts</small></div>`).join('')
        : '<p class="online-stats-empty">Aucun score pour le moment.</p>';
      return `<section class="card home-leaderboard-card"><div class="eyebrow">${escapeHTML(name.toUpperCase())}</div><h3>Top 3</h3>${rows}</section>`;
    }).join('');
  }

  window.loadHomeLeaderboards = async () => {
    const target = document.getElementById('homeLeaderboardContent');
    if (!target) return;
    if (homeLeaderboardCache) renderHomeLeaderboards(homeLeaderboardCache);
    if (homeLeaderboardRequest) return homeLeaderboardRequest;
    homeLeaderboardRequest = (async () => {
      try {
        await ensureConnected();
        const response = await new Promise((resolve, reject) => {
          socket.timeout(8000).emit('stats:get', {}, (error, result) => error ? reject(new Error('Le serveur ne répond pas.')) : resolve(result));
        });
        if (!response?.ok) throw new Error(response?.error || 'Impossible de charger les scores.');
        homeLeaderboardCache = response.games;
        renderHomeLeaderboards(homeLeaderboardCache);
      } catch {
        const current = document.getElementById('homeLeaderboardContent');
        if (current && !homeLeaderboardCache) current.innerHTML = '<p class="online-stats-empty">Scores momentanément indisponibles. <button class="quiet" id="retryHomeLeaderboard">Réessayer</button></p>';
        document.getElementById('retryHomeLeaderboard')?.addEventListener('click', () => {
          homeLeaderboardRequest = null;
          void window.loadHomeLeaderboards?.();
        });
      } finally {
        homeLeaderboardRequest = null;
      }
    })();
    return homeLeaderboardRequest;
  };

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
    requestedGameType = ['capitales', 'culture'].includes(gameType) ? gameType : 'petit-bac';
    if (credentials) resumeSession();
    else renderEntry();
  };

  window.loadHomeLeaderboards?.();
})();
