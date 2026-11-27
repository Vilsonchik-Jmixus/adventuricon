const { randomUUID } = require('node:crypto');
const { pads, stockProfile, catalogSound } = require('../ui/sound-library.js');

const slots = new Set(pads.map(([id]) => id));
const padAsset = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.mp3$/i;
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
function sanitizeSlot(value, categories) {
  const sound = catalogSound(value?.sound);
  const asset = typeof value?.asset === 'string' && padAsset.test(value.asset) ? value.asset : null;
  return {
    name: clean(value?.name, 52),
    sound: asset ? null : sound?.id ?? null,
    asset, sourceName: asset ? clean(value.sourceName, 120) : '',
    category: categories.includes(value?.category) ? value.category : '',
    loop: typeof value?.loop === 'boolean' ? value.loop : sound?.loop === true,
  };
}
function normalizeProfiles(value, categories) {
  const profiles = [];
  const ids = new Set();
  for (const item of Array.isArray(value.profiles) ? value.profiles.slice(0, 17) : []) {
    if (!item || typeof item.id !== 'string' || !/^(standard|[0-9a-f-]{36})$/.test(item.id) || ids.has(item.id)) continue;
    ids.add(item.id);
    profiles.push({
      id: item.id, name: clean(item.name, 52) || (item.id === stockProfile.id ? stockProfile.name : 'Саундпад'),
      slots: Object.fromEntries(Object.entries(item.slots ?? {}).filter(([key]) => slots.has(key))
        .map(([key, slot]) => [key, sanitizeSlot(slot, categories)])),
    });
  }
  if (!ids.has(stockProfile.id)) profiles.unshift(stockProfile);
  const selectedProfile = ids.has(value.selectedProfile) ? value.selectedProfile : stockProfile.id;
  return { profiles, selectedProfile };
}
function editProfile(preferences, action) {
  const { profiles, selectedProfile, categories } = preferences;
  const profile = profiles.find(item => item.id === action.id);
  if (action.type === 'create') {
    const name = clean(action.name, 52);
    if (!name || profiles.length >= 17) throw new Error('Введи название. Можно создать до 16 своих саундпадов.');
    const id = randomUUID();
    return { ...preferences, profiles: [...profiles, { id, name, slots: {} }], selectedProfile: id };
  }
  if (!profile) throw new Error('Саундпад уже удалён');
  if (action.type === 'select') return { ...preferences, selectedProfile: profile.id };
  if (action.type === 'remove' && profile.id !== stockProfile.id) {
    return { ...preferences, profiles: profiles.filter(item => item !== profile),
      selectedProfile: selectedProfile === profile.id ? stockProfile.id : selectedProfile };
  }
  const replace = next => ({ ...preferences, profiles: profiles.map(item => item === profile ? next : item) });
  if (action.type === 'rename' && clean(action.name, 52)) return replace({ ...profile, name: clean(action.name, 52) });
  if (action.type === 'save' && slots.has(action.slot)) {
    return replace({ ...profile, slots: { ...profile.slots, [action.slot]: sanitizeSlot(action.value, categories) } });
  }
  throw new Error('Действие с саундпадом недоступно');
}
module.exports = { padAsset, sanitizeSlot, normalizeProfiles, editProfile };
