import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshArtistUrl } from '../lib/artist.mjs';

const session = { artist: '麻园诗人', siteQuery: '麻园诗人', page: 2, size: 20, platform: 'kuwo' };
const candidate = { songid: 'chosen', name: '昆明', artist: '麻园诗人', time: 'old', sign: 'old' };

test('expired artist result refreshes the same page and selected song ID', async () => {
  const calls = [];
  const refreshed = await refreshArtistUrl({
    session, candidate, quality: 'flac',
    search: async (query, options) => {
      calls.push({ kind: 'search', query, options });
      return { list: [
        { songid: 'new-first', name: '另一首', artist: '麻园诗人', sign: 'other', minfo: [] },
        { songid: 'chosen', name: '昆明', artist: '麻园诗人', time: 'fresh', sign: 'fresh',
          minfo: [{ format: 'flac', bitrate: '2000' }] },
      ] };
    },
    resolve: async (options) => {
      calls.push({ kind: 'resolve', options });
      return { url: 'https://cdn.example/song.flac' };
    },
  });
  assert.equal(refreshed.candidate.songid, 'chosen');
  assert.equal(refreshed.candidate.sign, 'fresh');
  assert.equal(refreshed.info.url, 'https://cdn.example/song.flac');
  assert.deepEqual(calls[0], { kind: 'search', query: '麻园诗人',
    options: { platform: 'kuwo', page: 2, size: 20, allowCache: false } });
  assert.equal(calls[1].options.songid, 'chosen');
  assert.equal(calls[1].options.sign, 'fresh');
});

test('refresh refuses to substitute another song when the selected ID is gone', async () => {
  await assert.rejects(refreshArtistUrl({
    session, candidate, quality: 'flac',
    search: async () => ({ list: [{ songid: 'different', name: '昆明', artist: '麻园诗人' }] }),
    resolve: async () => { throw new Error('must not resolve a different song'); },
  }), /原候选已不在/);
});
