import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../state');
const SETTINGS_PATH = path.resolve(process.env.DSH_GROUP_INTERJECTION_SETTINGS_FILE || path.join(STATE_DIR, 'group-interjection-settings.json'));
let settings;

function mapKeys(value) {
  if (value instanceof Map) return [...value.keys()].map(String);
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value);
  return [];
}

export function collectExistingGroupIds({ allowGroupIds = [], sessions = {}, conversations = {} } = {}) {
  const ids = new Set(allowGroupIds.map(String));
  const sessionMap = sessions?.sessions ?? sessions;
  const conversationMap = conversations?.conversations ?? conversations;
  for (const key of [...mapKeys(sessionMap), ...mapKeys(conversationMap)]) {
    const match = /^group:(\d{5,20})$/.exec(key);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}

function load() {
  try {
    const current = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    if (current && typeof current.groups === 'object' && !Array.isArray(current.groups)) settings = current;
    else settings = { version: 1, groups: {} };
  } catch { settings = { version: 1, groups: {} }; }
  return settings;
}

function save() {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings ?? load(), null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, SETTINGS_PATH);
}

export function initializeGroupInterjectionSettings({ existingGroupIds = [], legacyDisabledGroupIds = [] } = {}) {
  const current = load();
  if (current.migrationComplete !== true) {
    const disabled = new Set(legacyDisabledGroupIds.map(String));
    for (const id of existingGroupIds) {
      const key = String(id);
      if (/^\d{5,20}$/.test(key) && !(key in current.groups)) current.groups[key] = !disabled.has(key);
    }
    for (const id of disabled) {
      if (/^\d{5,20}$/.test(id)) current.groups[id] = false;
    }
    current.migrationComplete = true;
    save();
  }
}

export function isGroupInterjectionEnabled(groupId) {
  const id = String(groupId);
  return load().groups[id] === true;
}

export function groupInterjectionSettingsSnapshot() {
  return { ...load().groups };
}

export function setGroupInterjectionSettings(groupIds, disabledGroupIds) {
  const current = load();
  const disabled = new Set(disabledGroupIds.map(String));
  for (const groupId of groupIds) {
    const id = String(groupId);
    if (/^\d{5,20}$/.test(id)) current.groups[id] = !disabled.has(id);
  }
  save();
}

export function setGroupInterjectionEnabled(groupId, enabled) {
  const id = String(groupId);
  if (!/^\d{5,20}$/.test(id) || typeof enabled !== 'boolean') throw new Error('invalid group interjection setting');
  load().groups[id] = enabled;
  save();
  return enabled;
}

export function closeGroupInterjectionSettingsForTests() { settings = undefined; }
