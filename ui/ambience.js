const ambience = (() => {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const tips = [
    'Shift + щелчок подсвечивает точку на карте игрокам.',
    'Правый щелчок по жетону открывает состояния бойца.',
    '★ добавляет открытую страницу справочника в закладки.',
    'Сохрани связь карты с боем через «⋯» в списке боёв.',
    'Нажми на портрет бойца, чтобы показать его игрокам.',
    'В карточке бойца введи «−7» для урона или «+5» для лечения.',
    'Ctrl + колёсико меняет масштаб карты мастера.',
    'F во время перетаскивания жетона ставит точку маршрута, Alt + F убирает её.',
  ];
  let previousCombat;

  function animate(element, frames, duration) {
    if (!element || reducedMotion.matches || !element.getClientRects().length) return;
    element.animate(frames, { duration, easing: 'cubic-bezier(.2,.65,.3,1)' });
  }

  function combat(list, roster, battle, turn, round) {
    const previous = previousCombat;
    previousCombat = { roster, battle, turn, round };
    if (!previous || previous.battle !== battle || reducedMotion.matches || !list.getClientRects().length) return;
    if (round !== previous.round) {
      animate(document.getElementById('round'), [{ color: '#fff1c2' }, {}], 650);
    }
    for (const card of list.querySelectorAll('.combat-card')) {
      const id = card.dataset.id;
      if (turn === id && turn !== previous.turn) {
        animate(card, [{ backgroundColor: '#644328', borderColor: '#f2bf7d' }, {}], 530);
      }
      const before = previous.roster.get(id), after = roster.get(id);
      if (!before || (before.hp === after.hp && before.maxHp === after.maxHp)) continue;
      animate(card.querySelector('.hp-bar > div'), [
        { width: `${before.hp / before.maxHp * 100}%` }, {},
      ], 375);
      animate(card.querySelector('.hp-readout'), [
        { backgroundColor: after.hp < before.hp ? '#874630' : '#4e6440', color: '#fff1d8' }, {},
      ], 650);
    }
  }

  function fadeImage(image) {
    image.addEventListener('load', () => {
      animate(image, [{ opacity: .22 }, { opacity: 1 }], 280);
    });
  }

  function start({ openDialog, closeDialog, showAtStart }) {
    const get = id => document.getElementById(id);
    const settings = get('screen-settings-dialog');
    const welcome = get('welcome-dialog');
    const soundButton = get('welcome-sound');
    const jingle = get('welcome-jingle');
    const tip = get('screen-tip'), tipText = get('tip-text');
    const options = settings.querySelectorAll('[data-screen-option]');
    const storageKey = 'dm-screen-appearance';
    let saved;
    try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch {}
    const preferences = { welcome: saved?.welcome !== false, sound: saved?.sound !== false, tips: saved?.tips !== false };
    let tipIndex = 0, tipTimer, fadeTimer;

    function stopSound() {
      clearInterval(fadeTimer);
      if (jingle.paused) return;
      fadeTimer = setInterval(() => {
        jingle.volume = Math.max(0, jingle.volume - .1);
        if (jingle.volume === 0 || jingle.paused) {
          clearInterval(fadeTimer);
          jingle.pause();
        }
      }, 18);
    }

    function playSound() {
      clearInterval(fadeTimer);
      if (!jingle.getAttribute('src')) jingle.src = 'assets/welcome-jingle.wav';
      jingle.currentTime = 0;
      jingle.volume = .46;
      jingle.play().catch(() => {});
    }

    function scheduleTip() {
      clearTimeout(tipTimer);
      if (!preferences.tips || document.hidden || reducedMotion.matches) return;
      tipTimer = setTimeout(() => {
        if (!tip.matches(':hover, :focus') && !document.querySelector('dialog[open]')) nextTip();
        scheduleTip();
      }, 15000);
    }

    function nextTip() {
      tipIndex = (tipIndex + 1) % tips.length;
      renderTip();
      animate(tipText, [{ opacity: .1, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], 290);
    }

    function renderTip() {
      tipText.textContent = tips[tipIndex];
      tip.title = `${tips[tipIndex]} Нажми для следующего совета.`;
    }

    function renderPreferences() {
      options.forEach(input => { input.checked = preferences[input.dataset.screenOption]; });
      soundButton.setAttribute('aria-pressed', String(preferences.sound));
      get('welcome-sound-label').textContent = preferences.sound ? 'Звук вкл.' : 'Звук выкл.';
      tip.hidden = !preferences.tips;
      scheduleTip();
    }

    function setPreference(key, checked) {
      preferences[key] = checked;
      try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {}
      if (key === 'sound' && !checked) stopSound();
      renderPreferences();
    }

    function showWelcome() {
      get('welcome-art-image').src = 'assets/welcome-tavern.webp';
      openDialog(welcome.id);
      if (preferences.sound) playSound();
    }

    get('screen-settings').hidden = false;
    get('screen-settings').onclick = () => openDialog(settings.id);
    get('preview-welcome').onclick = () => { closeDialog(settings); showWelcome(); };
    options.forEach(input => {
      input.onchange = () => setPreference(input.dataset.screenOption, input.checked);
    });
    soundButton.onclick = () => {
      setPreference('sound', !preferences.sound);
      if (preferences.sound) playSound();
    };
    welcome.addEventListener('close', stopSound);
    tip.onclick = () => { nextTip(); scheduleTip(); };
    document.addEventListener('visibilitychange', scheduleTip);
    reducedMotion.addEventListener('change', scheduleTip);
    renderTip();
    renderPreferences();
    if (showAtStart && preferences.welcome) showWelcome();
  }

  return { combat, fadeImage, start };
})();
