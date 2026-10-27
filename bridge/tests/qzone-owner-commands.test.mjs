import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwnQzoneComment, qzonePostOffset } from '../src/qzone-owner-commands.mjs';

const post = { tid: 'post-1', comments: [{ uin: '123456789', comment_id: '11', replies: [{ uin: '987654321', comment_id: '12' }] }] };

test('reply target is resolved only from the selected own post comment tree', () => {
  assert.deepEqual(resolveOwnQzoneComment(post, '1.1', '1668389572'), {
    tid: 'post-1', commentId: '12', userId: '987654321', selfId: '1668389572'
  });
  assert.equal(resolveOwnQzoneComment(post, '2', '1668389572'), null);
  assert.equal(resolveOwnQzoneComment({ ...post, tid: '' }, '1', '1668389572'), null);
  assert.equal(resolveOwnQzoneComment(post, '1', 'unknown'), null);
});

test('global post index 12 maps to the twelfth list position', () => {
  assert.equal(qzonePostOffset(12), 11);
  assert.equal(qzonePostOffset(110), 109);
  assert.equal(qzonePostOffset(111), null);
});

test('large Qzone ids remain exact strings', () => {
  const target = resolveOwnQzoneComment({ tid: 'post-2', comments: [{ uin: '12345678901234567890', comment_id: '12345678901234567890' }] }, '1', '1668389572');
  assert.equal(target.userId, '12345678901234567890');
  assert.equal(target.commentId, '12345678901234567890');
});

test('reply target requires a numeric comment id and commenter QQ id', () => {
  assert.equal(resolveOwnQzoneComment({ tid: 'post-1', comments: [{ uin: 'nope', comment_id: '11' }] }, '1', '1668389572'), null);
  assert.equal(resolveOwnQzoneComment({ tid: 'post-1', comments: [{ uin: '123456789', comment_id: 'bad' }] }, '1', '1668389572'), null);
});
