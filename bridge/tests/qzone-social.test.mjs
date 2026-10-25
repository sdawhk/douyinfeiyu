import test from 'node:test';
import assert from 'node:assert/strict';
import { plainQzoneText, qzoneCommentKey, qzoneFeedKey, qzonePostsWithComments } from '../src/qzone-social.mjs';

test('Qzone text extraction removes markup and decodes common escaped text', () => {
  assert.equal(plainQzoneText('<div>今天 &amp; 明天<br>都好</div><script>ignore()</script>'), '今天 & 明天 都好');
  assert.equal(plainQzoneText('&#x9C7C;\\u9C7C\\x21'), '鱼鱼!');
});

test('own Qzone scan rejects a stale response without comment data', () => {
  assert.throws(() => qzonePostsWithComments({ msglist: [{ tid: 'post-1', comment_num: 1 }] }), /comments/);
  assert.deepEqual(qzonePostsWithComments({ msglist: [{ tid: 'post-1', comments: [] }] }), [{ tid: 'post-1', comments: [] }]);
});

test('Qzone feed and comment keys require stable identifiers', () => {
  assert.equal(qzoneFeedKey({ uin: 1668389572, key: 'feed-1', time: 123 }), '1668389572:feed-1:123');
  assert.equal(qzoneFeedKey({ uin: 'bad', key: 'feed-1' }), '');
  assert.equal(qzoneCommentKey('post-1', { comment_id: 'c-1', uin: '3356141621' }), 'post-1:c-1:3356141621');
  assert.equal(qzoneCommentKey('post-1', { comment_id: '', uin: '3356141621' }), '');
});
