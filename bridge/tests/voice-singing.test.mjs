import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeTtsEndpoint, synthesizeEdgeSpeech } from '../src/edge-tts.mjs';
import { parseSingCommand, generateSong, downloadSong } from '../src/singing.mjs';

test('Edge TTS uses the selected Worker speech endpoint and returns QQ record data', async () => {
  let request;
  const file = await synthesizeEdgeSpeech('你好', { url: 'https://tts.wangwangit.com/', voice: 'zh-CN-XiaoyiNeural' }, async (url, options) => {
    request = { url, ...options };
    return new Response(Buffer.from('mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  });
  assert.equal(request.url, 'https://tts.wangwangit.com/v1/audio/speech');
  assert.deepEqual(JSON.parse(request.body), { input: '你好', voice: 'zh-CN-XiaoyiNeural', speed: 1, pitch: '0', style: 'general' });
  assert.equal(file, 'base64://bXAz');
  assert.throws(() => edgeTtsEndpoint({ url: 'http://elsewhere.example' }));
});

test('singing generates one song and polls for its URL', async () => {
  const requests = [];
  const song = await generateSong('海边的夏天', { apiKey: 'test-key' }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      return Response.json(requests.length === 1 ? { id: 'task-1' }
        : { status: 'succeeded', choices: [{ url: 'https://cdn.mureka.ai/song.mp3', duration: 28000 }] });
    }, wait: async () => {}
  });
  assert.deepEqual(song, { url: 'https://cdn.mureka.ai/song.mp3', taskId: 'task-1', durationMs: 28000 });
  assert.equal(JSON.parse(requests[0].body).n, 1);
  assert.match(JSON.parse(requests[0].body).prompt, /海边的夏天/);
  assert.equal(requests[1].url, 'https://api.mureka.ai/v1/song/query/task-1');
  assert.equal(parseSingCommand('/唱歌 海边的夏天'), '海边的夏天');
  assert.equal(parseSingCommand('给我唱首歌'), '即兴原创短歌');
  assert.equal(parseSingCommand('唱一首原创歌曲：海边的夏天'), '海边的夏天');
  assert.equal(parseSingCommand('我想听你唱歌'), '即兴原创短歌');
  assert.equal(parseSingCommand('聊天唱歌很好玩'), null);
});

test('song download rejects unrelated hosts', async () => {
  await assert.rejects(downloadSong('https://example.com/song.mp3'));
  const bytes = await downloadSong('https://cdn.mureka.ai/song.mp3', {
    fetchImpl: async () => new Response(Buffer.from('song'), { status: 200 })
  });
  assert.equal(bytes.toString(), 'song');
});
