const AdventureDice = (() => {
  const sides = [2, 4, 6, 8, 10, 12, 20, 100];
  function parse(value) {
    const formula = value.toLowerCase().replace(/\s+/g, '').replace(/−/g, '-');
    const parts = formula.match(/[+-]?(?:\d*d\d+(?:k[hl]\d+)?|\d+)/g);
    if (!parts || formula.length > 120 || parts.join('') !== formula || parts.slice(1).some(part => !/^[+-]/.test(part))) {
      throw new Error('Введи формулу, например 2d20kh1+3 или 2d6+1d4−2');
    }
    let count = 0;
    const terms = parts.map(part => {
      const sign = part.startsWith('-') ? -1 : 1;
      const match = /^[+-]?(\d*)d(\d+)(?:k([hl])(\d+))?$/.exec(part);
      if (!match) {
        const modifier = Number(part);
        if (Math.abs(modifier) > 9999) throw new Error('Модификатор должен быть от −9999 до 9999');
        return { modifier };
      }
      const amount = Number(match[1] || 1), faces = Number(match[2]), keep = Number(match[4] ?? amount);
      count += amount;
      if (!sides.includes(faces) || amount < 1 || count > 100 || keep < 1 || keep > amount) {
        throw new Error('Проверь вид кости, количество (до 100) и число сохраняемых результатов');
      }
      return { amount, faces, keep, highest: match[3] === 'h', sign };
    });
    if (!count) throw new Error('Добавь в формулу хотя бы одну кость');
    return { formula, terms };
  }
  function randomDie(faces) {
    const bytes = new Uint32Array(1), limit = Math.floor(2 ** 32 / faces) * faces;
    do { crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
    return bytes[0] % faces + 1;
  }
  function roll(value, random = randomDie) {
    const { formula, terms } = parse(value);
    let total = 0;
    const groups = terms.map(term => {
      if ('modifier' in term) {
        total += term.modifier;
        return term;
      }
      const { amount, faces, keep, highest, sign } = term;
      const dice = Array.from({ length: amount }, () => ({ value: random(faces), kept: false }));
      const sorted = keep === amount ? dice : [...dice].sort((a, b) => highest ? b.value - a.value : a.value - b.value);
      for (const die of sorted.slice(0, keep)) {
        die.kept = true;
        total += die.value * sign;
      }
      return { faces, dice, sign };
    });
    return { formula, total, groups };
  }
  return { sides, parse, roll };
})();

function createDiceMenu({ onToggle, playSound, toast }) {
  const get = id => document.getElementById(id);
  const form = get('dice-form'), pool = get('dice-pool'), menu = get('dice-menu'), trigger = get('toggle-dice-menu');
  const formula = form.elements.formula, modifier = form.elements.modifier;
  const history = [], counts = new Map();
  const favoriteList = get('dice-favorites');
  const storedKey = 'adventuricon-dice-favorites';
  let favorites = [], manual = false, check = null, count = 0;
  function readFavorites(value) {
    try {
      const stored = JSON.parse(value || '[]');
      if (Array.isArray(stored)) favorites = stored.filter(item => typeof item === 'string' && item.length <= 120).slice(0, 12);
    } catch { /* The menu also works without local storage. */ }
  }
  try { readFavorites(localStorage.getItem(storedKey)); } catch { /* Storage is unavailable. */ }
  window.addEventListener('storage', event => {
    if (event.key !== storedKey) return;
    readFavorites(event.newValue);
    renderFavorites();
  });
  const icons = [
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12',
    'M12 3 3 18l17 2L12 3v14m-9 1 9-1 8 3',
    'm12 2 9 5v10l-9 5-9-5V7l9-5zm0 20V12m-9-5 9 5 9-5',
    'm12 2 9 10-9 10-9-10L12 2zm0 0 4 10-4 10m-9-10h18',
    'm12 2 10 10-10 10-10-10L12 2zm0 0-6 10 6 10 6-10-6-10',
    'm12 2 7 3 3 7-3 7-7 3-7-3-3-7 3-7 7-3zm0 4 6 4-2 7H8l-2-7 6-4zm0-4v4m10 6-4-2m1 9-3-2m-8 0-3 2m-3-7 4-2',
    'm12 2 9 5v10l-9 5-9-5V7l9-5zm0 0 6 7 3 8M3 17l3-8 6-7m-6 7h12l-6 10-6-10m-3 8 9 2 9-2',
    'm8 2 6 6-6 6-6-6 6-6zm8 8 6 6-6 6-6-6 6-6zM8 2v12m8-4v12'
  ];
  const coinNames = { 2: 'Монета d2', 100: 'Процентная кость d100' };
  for (const [index, faces] of AdventureDice.sides.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.faces = faces;
    button.title = coinNames[faces] ?? 'Добавить d' + faces;
    button.setAttribute('aria-label', button.title);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[index]}"/></svg><span>d${faces}</span><output hidden></output>`;
    button.onclick = () => {
      if (manual || check) resetPool();
      if (count >= 100) return toast('В одном броске до 100 костей');
      counts.set(faces, (counts.get(faces) ?? 0) + 1);
      count++;
      update();
    };
    button.oncontextmenu = event => {
      event.preventDefault();
      if (!manual && !check && counts.has(faces)) {
        const amount = counts.get(faces) - 1;
        if (amount) counts.set(faces, amount);
        else counts.delete(faces);
        count--;
        update();
      }
    };
    pool.append(button);
  }
  function resetPool() { counts.clear(); count = 0; manual = false; check = null; }
  function update() {
    modifier.readOnly = manual;
    for (const button of form.querySelectorAll('[data-dice-mod]')) button.disabled = manual;
    if (!manual) {
      const base = check ? '2d20' + check + '1' : [...counts].map(([faces, amount]) => `${amount}d${faces}`).join('+');
      const bonus = Number(modifier.value) || 0;
      formula.value = base && bonus ? base + (bonus > 0 ? '+' : '') + bonus : base;
    }
    for (const button of pool.children) {
      const amount = counts.get(Number(button.dataset.faces)) ?? 0;
      const badge = button.querySelector('output');
      badge.hidden = amount === 0;
      badge.value = amount;
      button.setAttribute('aria-pressed', String(amount > 0));
    }
    for (const button of form.querySelectorAll('[data-dice-check]')) {
      button.setAttribute('aria-pressed', String(button.dataset.diceCheck === check));
    }
  }
  for (const button of form.querySelectorAll('[data-dice-mod]')) {
    button.onclick = () => {
      modifier.value = Math.max(-9999, Math.min(9999, (Number(modifier.value) || 0) + Number(button.dataset.diceMod)));
      update();
    };
  }
  for (const button of form.querySelectorAll('[data-dice-check]')) {
    button.onclick = () => { resetPool(); check = button.dataset.diceCheck; counts.set(20, 2); count = 2; update(); };
  }
  modifier.oninput = update;
  formula.oninput = () => { resetPool(); manual = true; update(); };
  get('dice-reset').onclick = () => { resetPool(); modifier.value = 0; update(); };
  function renderFavorites() {
    favoriteList.hidden = !favorites.length;
    favoriteList.replaceChildren(...favorites.map(value => {
      const group = document.createElement('span'), run = document.createElement('button'), remove = document.createElement('button');
      run.type = remove.type = 'button';
      run.textContent = value;
      run.title = 'Бросить ' + value;
      run.onclick = () => { resetPool(); manual = true; modifier.value = 0; formula.value = value; update(); form.requestSubmit(); };
      remove.dataset.pixelIcon = 'close';
      remove.setAttribute('aria-label', 'Открепить ' + value);
      remove.onclick = () => { favorites = favorites.filter(item => item !== value); saveFavorites(); };
      group.append(run, remove);
      return group;
    }));
  }
  function saveFavorites() {
    try { localStorage.setItem(storedKey, JSON.stringify(favorites)); } catch { /* Favorites remain until close. */ }
    renderFavorites();
  }
  get('save-dice').onclick = () => {
    try {
      const value = AdventureDice.parse(formula.value).formula;
      if (favorites.includes(value)) return;
      if (favorites.length >= 12) return toast('Можно закрепить до 12 формул');
      favorites.push(value);
      saveFavorites();
    } catch (error) { showError(error); }
  };
  function showError(error) { get('dice-result').textContent = error.message; }
  form.onsubmit = event => {
    event.preventDefault();
    let rolled;
    try {
      rolled = AdventureDice.roll(formula.value);
    } catch (error) { return showError(error); }
    playSound();
    const result = get('dice-result'), total = document.createElement('strong'), detail = document.createElement('span');
    total.textContent = rolled.total;
    for (const group of rolled.groups) {
      if (detail.childNodes.length) detail.append(' · ');
      if ('modifier' in group) { detail.append((group.modifier >= 0 ? '+' : '') + group.modifier); continue; }
      detail.append((group.sign < 0 ? '−' : '') + 'd' + group.faces + ' [');
      group.dice.forEach((die, index) => {
        if (index) detail.append(', ');
        if (die.kept) detail.append(String(die.value));
        else {
          const dropped = document.createElement('s');
          dropped.textContent = die.value;
          detail.append(dropped);
        }
      });
      detail.append(']');
    }
    result.replaceChildren(total, detail);
    history.unshift(`${rolled.formula} = ${rolled.total} · ${detail.textContent}`);
    history.length = Math.min(history.length, 20);
    get('dice-log').hidden = false;
    get('dice-history').replaceChildren(...history.map(entry => {
      const line = document.createElement('li');
      line.textContent = entry;
      return line;
    }));
  };
  const trackerButton = get('open-tracker-dice');
  trackerButton.setAttribute('popovertarget', menu.id);
  trackerButton.setAttribute('aria-controls', menu.id);
  trackerButton.setAttribute('aria-expanded', 'false');
  menu.addEventListener('beforetoggle', event => {
    for (const button of [trigger, trackerButton]) button.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.matches(':popover-open')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    menu.hidePopover();
  }, { capture: true });
  menu.addEventListener('toggle', onToggle);
  new ResizeObserver(onToggle).observe(menu);
  trigger.hidden = false;
  renderFavorites();
  update();
}

if (typeof module !== 'undefined') module.exports = AdventureDice;
