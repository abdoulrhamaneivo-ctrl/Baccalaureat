(() => {
  'use strict';
  const app = document.getElementById('app');
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let rounds = 10;
  let duration = 20;
  let categories = [...CULTURE_CATEGORIES];
  let mode = 'qcm';
  let questions = [];
  let index = 0;
  let score = 0;
  let picked = null;
  let deadline = 0;
  let timer = null;
  let history = [];
  let reviewingErrors = false;
  let questionHint = null;

  function currentPool() {
    const source = mode === 'vrai-faux' ? CULTURE_TRUE_FALSE_QUESTIONS : CULTURE_QUESTIONS;
    return source.filter((question) => categories.includes(question.category));
  }
  function drawQuestions(pool, amount) {
    const result = [];
    let available = [];
    while (result.length < amount && pool.length) {
      if (!available.length) {
        available = pool.filter((question) => question.id !== result.at(-1)?.id);
        if (!available.length) available = [...pool];
      }
      const previousCategory = result.at(-1)?.category;
      const varied = available.filter((question) => question.category !== previousCategory);
      const choices = varied.length ? varied : available;
      const question = choices[Math.floor(Math.random() * choices.length)];
      available.splice(available.indexOf(question), 1);
      result.push(question);
    }
    return result;
  }
  function quizTitle() { return mode === 'vrai-faux' ? 'Vrai ou faux' : 'Culture générale'; }

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
    app.innerHTML = shell(`<section class="card config-card"><div class="eyebrow">QUIZ SOLO</div><h1>Culture générale</h1><p class="muted">Côte d’Ivoire, Afrique, histoire du monde et sujets contemporains. Chaque réponse est suivie d’une explication.</p><form id="cultureConfig"><div class="config-grid"><label class="field"><span>Nombre de questions</span><select name="rounds">${[5, 10, 15, 20, 30].map((value) => `<option value="${value}" ${rounds === value ? 'selected' : ''}>${value} questions</option>`).join('')}</select></label><label class="field"><span>Temps par question</span><select name="duration">${[10, 15, 20, 30].map((value) => `<option value="${value}" ${duration === value ? 'selected' : ''}>${value} secondes</option>`).join('')}</select></label><label class="field field-full"><span>Format du jeu</span><select name="cultureMode"><option value="qcm" ${mode === 'qcm' ? 'selected' : ''}>Quiz à choix multiples</option><option value="vrai-faux" ${mode === 'vrai-faux' ? 'selected' : ''}>Vrai ou faux</option></select></label></div><fieldset class="category-picker"><legend>Thèmes au tirage</legend><div class="multi-check-grid">${themeOptions}</div></fieldset><p id="cultureConfigError" class="error" role="alert"></p><button class="primary wide">Lancer le quiz</button></form></section>`);
    homeButton();
    document.getElementById('cultureConfig').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const chosen = form.getAll('cultureCategory');
      if (!chosen.length) { document.getElementById('cultureConfigError').textContent = 'Choisissez au moins un thème.'; return; }
      rounds = Number(form.get('rounds'));
      duration = Number(form.get('duration'));
      categories = chosen;
      mode = String(form.get('cultureMode') || 'qcm');
      const pool = currentPool();
      if (!pool.length) { document.getElementById('cultureConfigError').textContent = 'Aucune question n’est disponible pour ce format et ces thèmes.'; return; }
      questions = drawQuestions(pool, rounds);
      index = 0; score = 0; picked = null; history = []; reviewingErrors = false;
      showQuestion();
    });
  }
  function showQuestion() {
    stopTimer();
    if (index >= questions.length) return showFinal();
    picked = null;
    questionHint = null;
    const question = questions[index];
    app.innerHTML = shell(`<div class="culture-top"><div><div class="round-label">QUESTION ${index + 1} / ${questions.length}${reviewingErrors ? ' · RÉVISION' : ''}</div><h1>${quizTitle()}</h1></div><div class="capital-meta"><span id="cultureTimer" class="capital-timer">${duration}</span> s restantes <span class="tag">${score} pts</span></div></div><section class="card culture-card"><span class="culture-badge">${escapeHTML(question.category)}</span><h2 class="culture-prompt">${escapeHTML(question.prompt)}</h2><div class="culture-options">${question.options.map((option, optionIndex) => `<button class="culture-option" data-option="${optionIndex}"><span class="culture-option-letter">${String.fromCharCode(65 + optionIndex)}</span>${escapeHTML(option)}</button>`).join('')}</div><div class="culture-hint-actions"><button type="button" class="quiet" data-culture-hint="first" ${score >= 5 ? '' : 'disabled'}>3 premières lettres · −5 pts</button><button type="button" class="quiet" data-culture-hint="last" ${score >= 5 ? '' : 'disabled'}>3 dernières lettres · −5 pts</button></div><p id="cultureHintResult" class="culture-hint" role="status"></p><div class="progress culture-progress"><span id="cultureProgress"></span></div><p class="notice">10 points par bonne réponse. Un indice coûte 5 points et s’utilise une fois par question.${score < 5 ? ' Il faut au moins 5 points pour en prendre un.' : ''}</p></section>`);
    homeButton();
    app.querySelectorAll('[data-option]').forEach((button) => button.addEventListener('click', () => answer(Number(button.dataset.option))));
    app.querySelectorAll('[data-culture-hint]').forEach((button) => button.addEventListener('click', () => useHint(button.dataset.cultureHint)));
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
  function useHint(direction) {
    if (picked !== null || questionHint || score < 5) return;
    const answer = Array.from(String(questions[index].options[questions[index].answer] || ''));
    const letters = direction === 'first' ? answer.slice(0, 3).join('') : answer.slice(-3).join('');
    questionHint = { direction, letters };
    score -= 5;
    app.querySelectorAll('[data-culture-hint]').forEach((button) => { button.disabled = true; });
    const output = document.getElementById('cultureHintResult');
    if (output) output.innerHTML = `Indice utilisé (−5 pts) : la réponse ${direction === 'first' ? 'commence' : 'se termine'} par « <strong>${escapeHTML(letters)}</strong> ».`;
    const scoreTag = document.querySelector('.culture-top .tag');
    if (scoreTag) scoreTag.textContent = `${score} pts`;
  }
  function answer(optionIndex) {
    if (picked !== null || !document.querySelector('.culture-card')) return;
    picked = optionIndex;
    stopTimer();
    const question = questions[index];
    const correct = optionIndex === question.answer;
    if (correct) score += 10;
    history.push({ question, optionIndex, correct, hint: questionHint });
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
    if (question.explanation) {
      const explanation = document.createElement('p');
      explanation.className = 'culture-explanation';
      explanation.textContent = `À retenir : ${question.explanation}`;
      document.querySelector('.culture-card').append(explanation);
    }
    const next = document.createElement('button');
    next.className = 'primary wide culture-next';
    next.textContent = index + 1 === questions.length ? 'Voir mon résultat' : 'Question suivante';
    next.addEventListener('click', () => { index += 1; showQuestion(); });
    document.querySelector('.culture-card').append(next);
  }
  function showFinal() {
    stopTimer();
    const correctCount = history.filter((entry) => entry.correct).length;
    const rows = history.map(({ question, optionIndex, correct, hint }, questionIndex) => `<div class="culture-history-row"><span class="round-label">${questionIndex + 1}. ${escapeHTML(question.category)}</span><strong>${escapeHTML(question.prompt)}</strong><small>${correct ? 'Bonne réponse' : `Votre réponse : ${optionIndex < 0 ? 'sans réponse' : escapeHTML(question.options[optionIndex])} · Réponse : ${escapeHTML(question.options[question.answer])}`}${hint ? ` · Indice utilisé (−5 pts)` : ''}</small>${question.explanation ? `<small class="culture-explanation">À retenir : ${escapeHTML(question.explanation)}</small>` : ''}</div>`).join('');
    const errorsAvailable = !reviewingErrors && history.some((entry) => !entry.correct);
    app.innerHTML = shell(`<section class="card culture-final"><div class="eyebrow">${reviewingErrors ? 'RÉVISION TERMINÉE' : `QUIZ TERMINÉ · ${questions.length} QUESTIONS`}</div><h1>Bien joué !</h1><div class="capital-end-score">${score} / ${questions.length * 10}</div><p class="muted">${correctCount} bonne${correctCount === 1 ? '' : 's'} réponse${correctCount === 1 ? '' : 's'} sur ${questions.length}. Les indices utilisés sont déduits du score.</p><div class="culture-history">${rows}</div>${errorsAvailable ? '<button id="reviewWrong" class="primary wide">Réviser mes erreurs</button>' : ''}<button id="replayCulture" class="${errorsAvailable ? 'quiet' : 'primary'} wide">Rejouer avec ces réglages</button><button id="newCulture" class="quiet wide">Changer les réglages</button></section>`);
    homeButton();
    document.getElementById('replayCulture').addEventListener('click', () => {
      questions = drawQuestions(currentPool(), rounds);
      index = 0; score = 0; history = []; reviewingErrors = false; showQuestion();
    });
    document.getElementById('reviewWrong')?.addEventListener('click', () => {
      questions = history.filter((entry) => !entry.correct).map((entry) => entry.question);
      index = 0; score = 0; history = []; reviewingErrors = true; showQuestion();
    });
    document.getElementById('newCulture').addEventListener('click', setup);
  }
  window.startCultureSolo = setup;
})();
