import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePokeNotice, choosePokeReply } from '../src/poke-interaction.mjs';

const self = '2427256325';

test('only a poke targeting the bot is identified as a direct poke', () => {
  const base = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    self_id: 2427256325, group_id: 839367702, user_id: 1581449421 };
  assert.deepEqual(normalizePokeNotice({ ...base, target_id: 2427256325 }, self), {
    senderId: '1581449421', targetId: self, targetIsSelf: true, isGroup: true, chatId: '839367702'
  });
  assert.equal(normalizePokeNotice({ ...base, target_id: 1668389572 }, self)?.targetIsSelf, false);
  assert.equal(normalizePokeNotice({ ...base, user_id: 2427256325, target_id: 1581449421 }, self), null);
});

test('private pokes are routed to the peer and replies use configured lines', () => {
  const poke = normalizePokeNotice({ post_type: 'notice', sub_type: 'poke',
    self_id: 2427256325, sender_id: 1668389572, target_id: 2427256325 }, self);
  assert.equal(poke.chatId, '1668389572');
  assert.equal(poke.isGroup, false);
  assert.equal(choosePokeReply('第一句\n第二句', () => 0.99), '第二句');
});
