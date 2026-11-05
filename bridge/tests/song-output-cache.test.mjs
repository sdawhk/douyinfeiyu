import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findCachedSongInPlaylist, listCachedSongPlaylist, loadAutoSongOutput, loadExistingSongOutput,
  loadSongOutput, loadSongOutputById, saveSongOutput } from '../src/song-output-cache.mjs';

test('an existing song reuses a verified cache across punctuation aliases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'song-alias-cache-'));
  try {
    const original = { query: '雨爱（司凤版）', mode: 'ai', candidate: 1,
      startSeconds: 30, seconds: 60, voiceVariant: 'rvc:0:clear-v4' };
    const audio = Buffer.alloc(2048, 7);
    const saved = saveSongOutput(original, audio, { root });
    const alias = { ...original, query: '雨爱司风版' };
    assert.equal(loadSongOutput(alias, { root }), null);
    assert.equal(loadExistingSongOutput(alias, { root })?.audio.equals(audio), true);
    assert.equal(loadExistingSongOutput({ ...alias, seconds: 30 }, { root }), null);
    assert.equal(loadExistingSongOutput({ ...alias, voiceVariant: 'rvc:1:clear-v4' }, { root }), null);
    assert.equal(loadExistingSongOutput({ ...alias, sourceIdentity: 'https://example.test/other' }, { root }), null);
    await writeFile(path.join(root, `${saved.id}.mp3`), Buffer.alloc(2048, 8));
    assert.equal(loadExistingSongOutput(alias, { root }), null, 'damaged audio must not be sent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auto-pitch cache reuses any detected shift under the current profile but never manual variants', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'song-auto-cache-'));
  try {
    const options = { query: '夜曲', mode: 'ai', candidate: 1, startSeconds: 30, seconds: 30 };
    const autoAudio = Buffer.alloc(2048, 5);
    saveSongOutput({ ...options, title: '夜曲', pitchMode: 'auto', pitch: 5, voiceVariant: 'rvc:5:clear-v5' }, autoAudio, { root });
    assert.equal(loadAutoSongOutput(options, { root, profile: 'clear-v5' })?.audio.equals(autoAudio), true);
    assert.equal(loadAutoSongOutput(options, { root, profile: 'clear-v4' }), null);
    saveSongOutput({ ...options, query: '晴天', title: '晴天', pitchMode: 'manual', pitch: 5,
      voiceVariant: 'rvc:5:clear-v5' }, Buffer.alloc(2048, 6), { root });
    assert.equal(loadAutoSongOutput({ ...options, query: '晴天' }, { root, profile: 'clear-v5' }), null,
      'manual pitch output must not satisfy an auto request');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('playlist exposes verified long cached songs and ignores old previews or damaged audio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'song-playlist-cache-'));
  try {
    const base = { query: '雨爱（司凤版）', title: '司凤版雨爱', mode: 'ai', candidate: 1,
      startSeconds: 30, voiceVariant: 'rvc:0:clear-v4' };
    saveSongOutput({ ...base, seconds: 30 }, Buffer.alloc(2048, 1), { root });
    const long = saveSongOutput({ ...base, seconds: 60 }, Buffer.alloc(2048, 2), { root });
    saveSongOutput({ ...base, query: '原唱样本', mode: 'original', seconds: 60 }, Buffer.alloc(2048, 3), { root });
    const full = saveSongOutput({ ...base, query: '好日子', title: '好日子', startSeconds: 0, seconds: 60,
      sourceIdentity: 'source:full', segmentIndex: 0 }, Buffer.alloc(2048, 4), { root });
    saveSongOutput({ ...base, query: '好日子', title: '好日子', startSeconds: 60, seconds: 60,
      sourceIdentity: 'source:full', segmentIndex: 1 }, Buffer.alloc(2048, 5), { root });
    const damaged = saveSongOutput({ ...base, query: '损坏歌曲', title: '损坏歌曲', seconds: 60 }, Buffer.alloc(2048, 6), { root });
    await writeFile(path.join(root, `${damaged.id}.mp3`), Buffer.alloc(2048, 9));
    const songs = listCachedSongPlaylist({ root });
    assert.deepEqual(songs.map((song) => song.query).sort(), ['好日子', '雨爱（司凤版）']);
    assert.equal(findCachedSongInPlaylist('雨爱司风版', { root })?.id, long.id);
    assert.equal(loadSongOutputById(full.id, { root })?.audio[0], 4);
    assert.equal(loadSongOutputById(damaged.id, { root }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
