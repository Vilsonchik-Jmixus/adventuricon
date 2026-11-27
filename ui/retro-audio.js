function createRetroAudio() {
  const { ambientIds, conditions } = SoundLibrary;
  const loops = new Set(ambientIds);
  const playing = new Map(), fading = new Map(), buffers = new Map();
  const voices = new Set();
  let context, gain, ambientGain, ambientVolume = 1, preferences = SoundLibrary.preferenceDefaults;
  const rate = 12000;
  // Each voice is a short chip-synth envelope with an optional sample-and-hold noise channel.
  const pulse = (start, length, wave, from, to, volume, interval = 0) => ({ start, length, wave, from, to, volume, interval });
  const arpeggio = (notes, tempo, wave, volume) => notes.map((frequency, i) =>
    pulse(i * tempo, tempo * 1.22, wave, frequency, frequency, volume));
  const p = pulse;
  const recipes = {
    fire: [p(0,.48,'noise',1350,520,.46), p(.04,.43,'triangle',210,84,.38)],
    ice: [...arpeggio([784,1175,1568,1047],.083,'pulse',.24), p(0,.34,'noise',3350,2000,.28)],
    thunder: [p(0,.49,'square',135,39,.4,.095), p(.04,.42,'noise',850,180,.44)],
    sword: [p(0,.15,'noise',4300,530,.33), p(.035,.37,'pulse',1470,570,.34), p(.048,.29,'triangle',2410,1060,.2)],
    shot: [p(0,.14,'noise',4200,450,.7), p(0,.18,'square',170,55,.3)],
    blunt: [p(0,.19,'triangle',176,45,.55), p(0,.13,'noise',830,260,.36)],
    bow: [p(0,.16,'pulse',360,112,.38), p(.07,.22,'noise',3900,1600,.26)],
    blast: [p(0,.75,'noise',1900,90,.49), p(0,.66,'triangle',147,36,.46)],
    heal: arpeggio([523,659,784,1047,1319],.096,'triangle',.52),
    portal: [p(0,.64,'pulse',105,560,.32,.064), p(.28,.53,'triangle',620,190,.32)],
    door: [p(0,.48,'pulse',98,218,.34,.068), p(.19,.46,'noise',610,135,.3), p(.58,.12,'triangle',145,59,.3)],
    coins: arpeggio([988,1976,1319,2637],.058,'pulse',.27),
    monster: [p(0,.71,'saw',156,62,.38,.096), p(.02,.64,'noise',702,210,.35)],
    bell: [p(0,.82,'triangle',587,584,.5), p(0,.67,'pulse',1175,1171,.22), p(.01,.35,'triangle',1735,1735,.13)],
    trap: [...arpeggio([175,233,124,392],.062,'square',.23), p(.13,.16,'noise',760,430,.33)],
    water: [p(0,.29,'noise',3220,960,.5), ...arpeggio([392,294,220],.092,'triangle',.22)],
    step: [p(0,.11,'noise',960,375,.38), p(.01,.13,'triangle',111,60,.29)],
    armor: [p(0,.135,'noise',1580,510,.41), p(.025,.21,'pulse',895,487,.24), p(.07,.15,'triangle',1270,990,.24)],
    fly: [p(0,.29,'noise',1410,620,.31), p(0,.27,'triangle',104,69,.18,.12)],
    slither: [p(0,.28,'noise',2100,990,.31,.072), p(.05,.21,'triangle',95,65,.17)],
    click: [p(0,.019,'noise',3500,1650,.20), p(.003,.027,'noise',950,380,.14)],
    dice: Array.from({ length: 7 }, (_, i) => p(i * .04 + i * i * .003,.08,'noise',2100 - 145 * i,670,.38 - .026 * i))
  };
  const gestures = [
    [349,262,165], [440,466,247,131], [330,277,220], [880,659,466], [294,175,147],
    [860,120,85], [166,208,262], [220,185,156,123], [760,312,210], [190,247,175,207],
    [523,698,659,988], [659,587,466,330], [392,392,196], [233,174,116], [262,311,220]
  ];
  conditions.forEach((id, i) => {
    const wave = ['triangle', 'pulse', 'square'][i % 3];
    recipes[id] = [...arpeggio(gestures[i], .082, wave, .32), p(0,.12,'noise',730 + i * 87,200,.18)];
  });

  function wave(type, phase) {
    const fraction = phase % 1;
    if (type === 'triangle') return 1 - 4 * Math.abs(fraction - .5);
    if (type === 'saw') return fraction * 2 - 1;
    return fraction < (type === 'pulse' ? .26 : .5) ? 1 : -1;
  }
  function synthesize(id) {
    const parts = recipes[id] || [];
    const length = loops.has(id) ? 4 : Math.max(...parts.map(part => part.start + part.length), .1) + .02;
    const buffer = context.createBuffer(1, Math.ceil(length * rate), rate);
    const samples = buffer.getChannelData(0);
    const attack = id === 'click' ? .0012 : .009;
    let seed = 17;
    const noise = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2147483648 - 1;
    };
    for (const part of parts) {
      let phase = 0, value = noise();
      const start = Math.round(part.start * rate), count = Math.round(part.length * rate);
      for (let n = 0; n < count; n++) {
        const time = n / rate, progress = n / count;
        const envelope = Math.min(1, time / attack) * (1 - progress) ** 1.32;
        const rhythm = part.interval ? .48 + .52 * Math.abs(Math.sin(Math.PI * time / part.interval)) : 1;
        const previous = phase;
        phase += (part.from * (part.to / part.from) ** progress) / rate;
        if (Math.floor(previous) !== Math.floor(phase)) value = noise();
        samples[start + n] += (part.wave === 'noise' ? value : wave(part.wave, phase)) * envelope * rhythm * part.volume;
      }
    }
    if (loops.has(id)) {
      let grain = 0, nextCrackle = 0, crackle = 0;
      const ambient = {
        rain: (_, angle) => (noise() * .17 + grain * .12) * (.82 + Math.sin(angle * 3) * .18),
        campfire: () => grain * .1 + noise() * crackle,
        wind: (time, angle) => grain * (.14 + .11 * Math.sin(angle)) + wave('triangle', time * 46) * .04,
        dungeon: (time, angle) => wave('triangle', time * 55) * .09 + grain * (.055 + .05 * Math.sin(angle * 2))
      }[id];
      for (let n = 0; n < samples.length; n++) {
        const time = n / rate, angle = 2 * Math.PI * time / length;
        if (n % 9 === 0) grain = noise();
        if (n >= nextCrackle) {
          crackle = .16 + Math.abs(noise()) * .25;
          nextCrackle = n + 580 + Math.floor(Math.abs(noise()) * 3100);
        }
        crackle *= .991;
        const edge = Math.min(1, time * 12, (length - time) * 12);
        samples[n] = ambient(time, angle) * edge;
      }
    }
    for (let n = 0; n < samples.length; n++) samples[n] = Math.round(Math.max(-1, Math.min(1, samples[n])) * 127) / 127;
    return buffer;
  }
  function stop(id, fade = 0) {
    const voice = playing.get(id);
    if (!voice) return;
    playing.delete(id);
    if (fade && voice.level.gain.setTargetAtTime) {
      fading.get(id)?.source.stop();
      fading.set(id, voice);
      voice.level.gain.setTargetAtTime(0, context.currentTime, fade / 4);
      voice.source.stop(context.currentTime + fade);
    } else voice.source.stop();
  }
  function apply(next) {
    preferences = next;
    if (gain) gain.gain.value = preferences.enabled ? preferences.volume : 0;
    if (!preferences.enabled) {
      for (const id of playing.keys()) stop(id);
      for (const voice of fading.values()) voice.source.stop();
      fading.clear();
    }
  }
  function play(id, category, toggle = false, fade = 0) {
    if (toggle && playing.has(id)) { stop(id); return false; }
    if (playing.has(id)) return true;
    if (!preferences.enabled || category && !preferences[category] ||
        !Object.hasOwn(recipes, id) && !loops.has(id)) return false;
    fading.get(id)?.source.stop();
    if (!context) {
      context = new AudioContext();
      gain = context.createGain();
      gain.connect(context.destination);
      ambientGain = context.createGain();
      ambientGain.gain.value = ambientVolume;
      ambientGain.connect(gain);
      apply(preferences);
    }
    if (context.state === 'suspended') context.resume().catch(() => {});
    if (!buffers.has(id)) buffers.set(id, synthesize(id));
    if (voices.size >= 14) {
      const oldest = [...voices].find(voice => !voice.loop);
      if (oldest) { voices.delete(oldest); oldest.stop(); }
    }
    const source = context.createBufferSource();
    source.buffer = buffers.get(id);
    source.loop = loops.has(id);
    let level;
    if (source.loop) {
      level = context.createGain();
      level.gain.value = fade ? 0 : 1;
      if (fade) level.gain.setTargetAtTime(1, context.currentTime, fade / 4);
      source.connect(level);
      level.connect(ambientGain);
      playing.set(id, { source, level });
    } else source.connect(gain);
    voices.add(source);
    source.onended = () => {
      if (fading.get(id)?.source === source) fading.delete(id);
      voices.delete(source);
      source.disconnect();
      level?.disconnect();
    };
    source.start();
    return source.loop;
  }
  function setAmbience({ loops: selected, ambientVolume: volume }) {
    ambientVolume = volume;
    if (ambientGain) {
      ambientGain.gain.cancelScheduledValues(context.currentTime);
      ambientGain.gain.setTargetAtTime(volume, context.currentTime, .06);
    }
    for (const id of playing.keys()) if (!selected.includes(id)) stop(id, .28);
    return selected.filter(id => play(id, null, false, .28));
  }
  return { play, apply, stop, setAmbience };
}
