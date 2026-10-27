import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('new groups default off, legacy groups migrate once, and changes reload across processes', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'group-interjection-test-'));
  const file = path.join(temp, 'settings.json');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  process.env.DSH_GROUP_INTERJECTION_SETTINGS_FILE = file;
  const moduleUrl = new URL('../src/group-interjection-settings.mjs', import.meta.url).href;
  const settings = await import(`${moduleUrl}?test=${Date.now()}`);
  t.after(() => delete process.env.DSH_GROUP_INTERJECTION_SETTINGS_FILE);

  settings.initializeGroupInterjectionSettings({ existingGroupIds: ['12345', '23456'], legacyDisabledGroupIds: ['23456'] });
  assert.equal(settings.isGroupInterjectionEnabled('12345'), true);
  assert.equal(settings.isGroupInterjectionEnabled('23456'), false);
  assert.equal(settings.isGroupInterjectionEnabled('34567'), false);

  settings.initializeGroupInterjectionSettings({ existingGroupIds: ['34567'] });
  assert.equal(settings.isGroupInterjectionEnabled('34567'), false, 'subsequent startups must not enable newly allowed groups');

  const { collectExistingGroupIds } = settings;
  const allowGroupIds = [];
  const sessionsDoc = { sessions: { 'group:45678': 'session-a' } };
  const socialDoc = { conversations: { 'group:56789': {} } };
  const fromQqBot = collectExistingGroupIds({ allowGroupIds, sessions: sessionsDoc,
    conversations: socialDoc });
  const fromBridge = collectExistingGroupIds({ allowGroupIds, sessions: sessionsDoc.sessions,
    conversations: new Map(Object.entries(socialDoc.conversations)) });
  assert.deepEqual(fromQqBot, ['45678', '56789']);
  assert.deepEqual(fromBridge, fromQqBot, 'both processes must seed from the same persisted group snapshot');

  const secondFile = path.join(temp, 'settings-reverse.json');
  process.env.DSH_GROUP_INTERJECTION_SETTINGS_FILE = secondFile;
  const reverseSettings = await import(`${moduleUrl}?reverse=${Date.now()}`);
  reverseSettings.initializeGroupInterjectionSettings({ existingGroupIds: fromBridge });
  reverseSettings.initializeGroupInterjectionSettings({ existingGroupIds: fromQqBot });
  assert.equal(reverseSettings.isGroupInterjectionEnabled('45678'), true);
  assert.equal(reverseSettings.isGroupInterjectionEnabled('56789'), true);
  assert.equal(reverseSettings.isGroupInterjectionEnabled('67890'), false);
  process.env.DSH_GROUP_INTERJECTION_SETTINGS_FILE = path.join(temp, 'settings-forward.json');
  const forwardSettings = await import(`${moduleUrl}?forward=${Date.now()}`);
  forwardSettings.initializeGroupInterjectionSettings({ existingGroupIds: fromQqBot });
  forwardSettings.initializeGroupInterjectionSettings({ existingGroupIds: fromBridge });
  assert.equal(forwardSettings.isGroupInterjectionEnabled('45678'), true);
  assert.equal(forwardSettings.isGroupInterjectionEnabled('56789'), true);
  assert.equal(forwardSettings.isGroupInterjectionEnabled('67890'), false);
  process.env.DSH_GROUP_INTERJECTION_SETTINGS_FILE = file;

  const external = JSON.parse(readFileSync(file, 'utf8'));
  external.groups['12345'] = false;
  writeFileSync(file, JSON.stringify(external));
  assert.equal(settings.isGroupInterjectionEnabled('12345'), false, 'another bridge process should observe the setting change');
  settings.setGroupInterjectionEnabled('34567', true);
  assert.equal(settings.isGroupInterjectionEnabled('34567'), true);
});
