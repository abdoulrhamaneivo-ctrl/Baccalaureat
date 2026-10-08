(() => {
  'use strict';

  const app = document.getElementById('app');
  const continents = ['Afrique', 'Amériques', 'Asie', 'Europe', 'Océanie'];
  let questionsPerGame = 10;
  let secondsPerQuestion = 20;
  let questionMode = 'random';
  let selectedContinents = [...continents];
  let questions = [];
  let questionIndex = 0;
  let score = 0;
  let history = [];
  let deadline = 0;
  let timer = null;
  let nextTimer = null;

  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/œ/gi, 'oe').replace(/æ/gi, 'ae').toLowerCase().replace(/[^a-z0-9]/g, '');
  const isCorrect = (answer, question) => {
    const candidates = question.kind === 'country' ? question.country.names : question.country.capitals;
    return candidates.some((candidate) => normalize(candidate) === normalize(answer));
  };

  function chooseQuestions() {
    const pool = WORLD_COUNTRIES.filter((country) => selectedContinents.includes(country.continent));
    const chosen = [];
    const used = new Set();
    while (chosen.length < questionsPerGame && pool.length) {
      let choices = pool.filter((country) => !used.has(country.code));
      if (!choices.length) {
        const previous = chosen.at(-1)?.country.code;
        used.clear();
        choices = pool.filter((country) => country.code !== previous);
      }
      const country = choices[Math.floor(Math.random() * choices.length)];
      chosen.push(country);
      used.add(country.code);
    }
    return chosen.map((country) => ({ country, kind: questionMode === 'random' ? (Math.random() < 0.5 ? 'country' : 'capital') : questionMode }));
  }

  function shell(content) {
    return `<div class="capital-session"><div class="multi-toolbar"><button id="capitalHome" class="quiet">← Accueil</button><span class="connection-status">Solo · Capitales du monde</span></div>${content}</div>`;
  }

  function clearTimers() {
    clearInterval(timer);
    clearInterval(nextTimer);
  }

  function showSetup() {
    clearTimers();
    const continentChoices = continents.map((continent) => `<label class="multi-check"><input type="checkbox" name="continent" value="${escapeHTML(continent)}" ${selectedContinents.includes(continent) ? 'checked' : ''}><span>${escapeHTML(continent)}</span></label>`).join('');
    app.innerHTML = shell(`<section class="card config-card"><div class="eyebrow">QUIZ SOLO</div><h1>Personnaliser la partie</h1><form id="soloCapitalsConfig"><div class="config-grid"><label class="field"><span>Nombre de questions</span><select name="rounds">${[5, 10, 15, 20, 30].map((value) => `<option value="${value}" ${questionsPerGame === value ? 'selected' : ''}>${value} questions</option>`).join('')}</select></label><label class="field"><span>Temps par question</span><select name="duration">${[10, 15, 20, 30].map((value) => `<option value="${value}" ${secondsPerQuestion === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label><label class="field field-full"><span>Question demandée</span><select name="questionMode"><option value="random" ${questionMode === 'random' ? 'selected' : ''}>Pays ou capitale, au hasard</option><option value="country" ${questionMode === 'country' ? 'selected' : ''}>Toujours le nom du pays</option><option value="capital" ${questionMode === 'capital' ? 'selected' : ''}>Toujours la capitale</option></select></label></div><fieldset class="category-picker"><legend>Continents au tirage</legend><div class="multi-check-grid">${continentChoices}</div></fieldset><p id="soloCapitalConfigError" class="error" role="alert"></p><button class="primary wide">Lancer le quiz</button></form></section>`);
    document.getElementById('capitalHome').onclick = () => window.showHome?.();
    document.getElementById('soloCapitalsConfig').onsubmit = (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const chosen = form.getAll('continent');
      if (!chosen.length) {
        document.getElementById('soloCapitalConfigError').textContent = 'Choisissez au moins un continent.';
        return;
      }
      questionsPerGame = Number(form.get('rounds'));
      secondsPerQuestion = Number(form.get('duration'));
      questionMode = String(form.get('questionMode') || 'random');
      selectedContinents = chosen;
      startGame();
    };
  }

  function startGame() {
    clearTimers();
    questions = chooseQuestions();
    questionIndex = 0;
    score = 0;
    history = [];
    showQuestion();
  }

  function showQuestion() {
    clearTimers();
    if (questionIndex >= questions.length) return showFinal();
    const question = questions[questionIndex];
    const prompt = question.kind === 'country' ? 'Quel est le nom de ce pays ?' : `Quelle est la capitale de ${question.country.name} ?`;
    const flagCode = question.country.code;
    app.innerHTML = shell(`<div class="capital-top"><div><div class="round-label">QUESTION ${questionIndex + 1} / ${questions.length}</div><h1>Capitales du monde</h1></div><div class="capital-meta"><span id="soloCapitalTimer" class="capital-timer">${secondsPerQuestion}</span> s restantes</div></div><section class="card capital-card"><p class="capital-prompt">${escapeHTML(prompt)}</p><div class="capital-flag-wrap"><img class="capital-flag" src="/flags/${escapeHTML(flagCode)}.svg" alt="Drapeau à identifier" onerror="this.onerror=null;this.replaceWith(document.createTextNode('🏳️'))"></div><form class="capital-answer" id="soloCapitalForm"><label for="soloCapitalAnswer">Votre réponse</label><input id="soloCapitalAnswer" name="answer" maxlength="70" autocomplete="off" spellcheck="false" placeholder="Votre réponse…"><button class="primary">Valider ma réponse</button></form><p class="notice">10 points pour chaque bonne réponse. Vous avez ${secondsPerQuestion} secondes.</p></section>`);
    document.getElementById('capitalHome').onclick = () => { clearTimers(); window.showHome?.(); };
    document.getElementById('soloCapitalForm').onsubmit = (event) => {
      event.preventDefault();
      answerQuestion(new FormData(event.currentTarget).get('answer'));
    };
    document.getElementById('soloCapitalAnswer').focus();
    deadline = Date.now() + secondsPerQuestion * 1000;
    timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const clock = document.getElementById('soloCapitalTimer');
      if (clock) { clock.textContent = remaining; clock.classList.toggle('low', remaining <= 5); }
      if (!remaining) answerQuestion('');
    }, 100);
  }

  function answerQuestion(value) {
    if (!document.getElementById('soloCapitalForm')) return;
    clearInterval(timer);
    const question = questions[questionIndex];
    const answer = String(value || '').trim();
    const correct = isCorrect(answer, question);
    if (correct) score += 10;
    const expected = question.kind === 'country' ? question.country.name : question.country.capital;
    history.push({ question, answer, correct, expected });
    const flagCode = question.country.code;
    app.innerHTML = shell(`<section class="card capital-reveal"><div class="round-label">QUESTION ${questionIndex + 1} / ${questions.length}</div><p class="capital-reveal-status">${correct ? 'Bonne réponse !' : 'La bonne réponse était'}</p><div class="capital-flag-wrap"><img class="capital-flag" src="/flags/${escapeHTML(flagCode)}.svg" alt="Drapeau de ${escapeHTML(question.country.name)}" onerror="this.onerror=null;this.replaceWith(document.createTextNode('🏳️'))"></div><div class="eyebrow">${question.kind === 'country' ? 'PAYS' : 'CAPITALE'}</div><div class="capital-correct-answer">${escapeHTML(expected)}</div><p class="muted">${answer ? `Votre réponse : ${escapeHTML(answer)}` : 'Aucune réponse'}</p><p><strong>${correct ? '+10' : '0'} points</strong> · Total : ${score}</p><div class="capital-countdown" id="soloNextCountdown">3</div><p class="notice">Question suivante automatiquement dans 3 secondes.</p></section>`);
    document.getElementById('capitalHome').onclick = () => { clearTimers(); window.showHome?.(); };
    let remaining = 3;
    nextTimer = setInterval(() => {
      remaining -= 1;
      const node = document.getElementById('soloNextCountdown');
      if (node) node.textContent = Math.max(0, remaining);
      if (remaining <= 0) { clearInterval(nextTimer); questionIndex += 1; showQuestion(); }
    }, 1000);
  }

  function showFinal() {
    clearTimers();
    const rows = history.map(({ question, answer, correct, expected }) => `<div class="capital-recent"><span><img class="capital-small-flag" src="/flags/${escapeHTML(question.country.code)}.svg" alt="" onerror="this.onerror=null;this.replaceWith(document.createTextNode('🏳️'))">${escapeHTML(question.kind === 'country' ? question.country.name : question.country.capital)}</span><small>${correct ? 'Bonne réponse' : `${escapeHTML(answer) || 'Sans réponse'} · ${escapeHTML(expected)}`}</small></div>`).join('');
    app.innerHTML = shell(`<section class="card capital-reveal"><div class="eyebrow">QUIZ TERMINÉ · ${questions.length} QUESTIONS</div><h1>Bien joué !</h1><div class="capital-end-score">${score} / ${questions.length * 10}</div><p class="muted">${score === questions.length * 10 ? 'Parcours parfait !' : `${score / 10} bonne${score === 10 ? '' : 's'} réponse${score === 10 ? '' : 's'} sur ${questions.length}.`}</p><div class="capital-player-results">${rows}</div><button id="replayCapitalsSolo" class="primary wide">Rejouer</button><button id="homeCapitalsSolo" class="quiet wide">Accueil</button></section>`);
    document.getElementById('capitalHome').onclick = () => { clearTimers(); window.showHome?.(); };
    document.getElementById('replayCapitalsSolo').onclick = startGame;
    document.getElementById('homeCapitalsSolo').onclick = () => window.showHome?.();
  }

  window.startCapitalsSolo = showSetup;
})();
