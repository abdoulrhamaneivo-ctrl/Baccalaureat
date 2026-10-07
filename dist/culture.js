(() => {
  'use strict';
  const app = document.getElementById('app');
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let rounds = 10;
  let duration = 20;
  let categories = [...CULTURE_CATEGORIES];
  let questions = [];
  let index = 0;
  let score = 0;
  let picked = null;
  let deadline = 0;
  let timer = null;
  let history = [];

  function shell(content) {
    return `<div class="culture-session"><div class="multi-toolbar"><button id="cultureHome" class="quiet">← Accueil</button><span class="connection-status">Solo · Culture générale</span></div>${content}</div>`;
  }
  function stopTimer() { clearInterval(timer); timer = null; }
  function homeButton() {
    document.getElementById('cultureHome')?.addEventListener('click', () => { stopTimer(); window.showHome?.(); });
  }
  function setup() {
    stopTimer();
    const themeOptions = CULTURE_CATEGORIES.map((category) => `<label class="multi-check"><input type="checkbox" name="cultureCategory" value="${escapeHTML(category)}" ${categories.includes(category) ? 'checked' : ''}><span>${escapeHTML(category)}</span></label>`).join('');
    app.innerHTML = shell(`<section class="card config-card"><div class="eyebrow">QUIZ SOLO</div><h1>Culture générale</h1><p class="muted">Choisissez les thèmes, puis répondez avant la fin du chrono.</p><form id="cultureConfig"><div class="config-grid"><label class="field"><span>Nombre de questions</span><select name="rounds">${[5, 10, 15, 20, 30].map((value) => `<option value="${value}" ${rounds === value ? 'selected' : ''}>${value} questions</option>`).join('')}</select></label><label class="field"><span>Temps par question</span><select name="duration">${[10, 15, 20, 30].map((value) => `<option value="${value}" ${duration === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label></div><fieldset class="category-picker"><legend>Thèmes au tirage</legend><div class="multi-check-grid">${themeOptions}</div></fieldset><p id="cultureConfigError" class="error" role="alert"></p><button class="primary wide">Lancer le quiz</button></form></section>`);
    homeButton();
    document.getElementById('cultureConfig').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const chosen = form.getAll('cultureCategory');
      if (!chosen.length) { document.getElementById('cultureConfigError').textContent = 'Choisissez au moins un thème.'; return; }
      rounds = Number(form.get('rounds'));
      duration = Number(form.get('duration'));
      categories = chosen;
      const pool = CULTURE_QUESTIONS.filter((question) => categories.includes(question.category));
      questions = [];
      while (questions.length < rounds) {
        const available = pool.filter((question) => !questions.includes(question));
        const batch = available.length ? available : pool;
        questions.push(batch[Math.floor(Math.random() * batch.length)]);
      }
      index = 0; score = 0; picked = null; history = [];
      showQuestion();
    });
  }
  function showQuestion() {
    stopTimer();
    if (index >= questions.length) return showFinal();
    picked = null;
    const question = questions[index];
    app.innerHTML = shell(`<div class="culture-top"><div><div class="round-label">QUESTION ${index + 1} / ${questions.length}</div><h1>Culture générale</h1></div><div class="capital-meta"><span id="cultureTimer" class="capital-timer">${duration}</span> s restantes</div></div><section class="card culture-card"><span class="culture-badge">${escapeHTML(question.category)}</span><h2 class="culture-prompt">${escapeHTML(question.prompt)}</h2><div class="culture-options">${question.options.map((option, optionIndex) => `<button class="culture-option" data-option="${optionIndex}"><span class="culture-option-letter">${String.fromCharCode(65 + optionIndex)}</span>${escapeHTML(option)}</button>`).join('')}</div><div class="progress culture-progress"><span id="cultureProgress"></span></div><p class="notice">10 points pour chaque bonne réponse.</p></section>`);
    homeButton();
    app.querySelectorAll('[data-option]').forEach((button) => button.addEventListener('click', () => answer(Number(button.dataset.option))));
    deadline = Date.now() + duration * 1000;
    timer = setInterval(() => {
      const remainingMs = Math.max(0, deadline - Date.now());
      const remaining = Math.ceil(remainingMs / 1000);
      const clock = document.getElementById('cultureTimer');
      if (clock) { clock.textContent = remaining; clock.classList.toggle('low', remaining <= 5); }
      const bar = document.getElementById('cultureProgress');
      if (bar) bar.style.width = `${Math.max(0, remainingMs / (duration * 1000) * 100)}%`;
      if (!remaining) answer(-1);
    }, 100);
  }
  function answer(optionIndex) {
    if (picked !== null || !document.querySelector('.culture-card')) return;
    picked = optionIndex;
    stopTimer();
    const question = questions[index];
    const correct = optionIndex === question.answer;
    if (correct) score += 10;
    history.push({ question, optionIndex, correct });
    app.querySelectorAll('[data-option]').forEach((button) => {
      const value = Number(button.dataset.option);
      button.disabled = true;
      if (value === question.answer) button.classList.add('is-correct');
      else if (value === optionIndex) button.classList.add('is-wrong');
    });
    const status = document.createElement('p');
    status.className = `culture-answer-status ${correct ? 'correct' : 'wrong'}`;
    status.textContent = correct ? 'Bonne réponse · +10 points' : optionIndex < 0 ? `Temps écoulé · Réponse : ${question.options[question.answer]}` : `La bonne réponse : ${question.options[question.answer]}`;
    document.querySelector('.culture-card').append(status);
    const next = document.createElement('button');
    next.className = 'primary wide culture-next';
    next.textContent = index + 1 === questions.length ? 'Voir mon résultat' : 'Question suivante';
    next.addEventListener('click', () => { index += 1; showQuestion(); });
    document.querySelector('.culture-card').append(next);
  }
  function showFinal() {
    stopTimer();
    const rows = history.map(({ question, optionIndex, correct }, questionIndex) => `<div class="culture-history-row"><span class="round-label">${questionIndex + 1}. ${escapeHTML(question.category)}</span><strong>${escapeHTML(question.prompt)}</strong><small>${correct ? 'Bonne réponse' : `Votre réponse : ${optionIndex < 0 ? 'sans réponse' : escapeHTML(question.options[optionIndex])} · Réponse : ${escapeHTML(question.options[question.answer])}`}</small></div>`).join('');
    app.innerHTML = shell(`<section class="card culture-final"><div class="eyebrow">QUIZ TERMINÉ · ${questions.length} QUESTIONS</div><h1>Bien joué !</h1><div class="capital-end-score">${score} / ${questions.length * 10}</div><p class="muted">${score / 10} bonne${score === 10 ? '' : 's'} réponse${score === 10 ? '' : 's'} sur ${questions.length}.</p><div class="culture-history">${rows}</div><button id="replayCulture" class="primary wide">Rejouer avec ces réglages</button><button id="newCulture" class="quiet wide">Changer les réglages</button></section>`);
    homeButton();
    document.getElementById('replayCulture').addEventListener('click', () => {
      const pool = CULTURE_QUESTIONS.filter((question) => categories.includes(question.category));
      questions = Array.from({ length: rounds }, () => pool[Math.floor(Math.random() * pool.length)]);
      index = 0; score = 0; history = []; showQuestion();
    });
    document.getElementById('newCulture').addEventListener('click', setup);
  }
  window.startCultureSolo = setup;
})();
