/**
 * Tests for ORACLE Preloader
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Preloader, LRUCache } from '../lib/preloader.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('LRUCache', () => {
  it('should store and retrieve values', () => {
    const cache = new LRUCache(5);
    cache.set('a', { content: 'hello', loadedAt: Date.now(), size: 5 });
    assert.ok(cache.has('a'));
    assert.equal(cache.get('a').content, 'hello');
  });

  it('should evict oldest entry when full', () => {
    const cache = new LRUCache(2);
    cache.set('a', { content: '1', loadedAt: Date.now(), size: 1 });
    cache.set('b', { content: '2', loadedAt: Date.now(), size: 1 });
    cache.set('c', { content: '3', loadedAt: Date.now(), size: 1 });
    assert.ok(!cache.has('a'));
    assert.ok(cache.has('b'));
    assert.ok(cache.has('c'));
  });

  it('should update LRU order on get', () => {
    const cache = new LRUCache(2);
    cache.set('a', { content: '1', loadedAt: Date.now(), size: 1 });
    cache.set('b', { content: '2', loadedAt: Date.now(), size: 1 });
    cache.get('a'); // Touch 'a' making it recent
    cache.set('c', { content: '3', loadedAt: Date.now(), size: 1 });
    assert.ok(cache.has('a')); // 'a' should survive
    assert.ok(!cache.has('b')); // 'b' should be evicted
  });

  it('should support delete', () => {
    const cache = new LRUCache(5);
    cache.set('a', { content: '1', loadedAt: Date.now(), size: 1 });
    cache.delete('a');
    assert.ok(!cache.has('a'));
  });

  it('should support clear', () => {
    const cache = new LRUCache(5);
    cache.set('a', { content: '1', loadedAt: Date.now(), size: 1 });
    cache.set('b', { content: '2', loadedAt: Date.now(), size: 1 });
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it('should report correct size', () => {
    const cache = new LRUCache(5);
    cache.set('a', { content: '1', loadedAt: Date.now(), size: 1 });
    cache.set('b', { content: '2', loadedAt: Date.now(), size: 1 });
    assert.equal(cache.size, 2);
  });
});

describe('Preloader', () => {
  let tempDir;
  let preloader;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oracle-preload-test-'));
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'app.ts'), 'const app = "hello world";');
    await writeFile(join(tempDir, 'src', 'utils.ts'), 'export function add(a, b) { return a + b; }');
    await writeFile(join(tempDir, 'config.json'), '{"key": "value"}');

    preloader = new Preloader({ rootDir: tempDir, cacheSize: 50 });
  });

  describe('preload', () => {
    it('should load predicted files into cache', async () => {
      const result = await preloader.preload([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 8 },
      ]);
      assert.ok(result.loaded.includes('src/app.ts'));
      assert.ok(result.loaded.includes('src/utils.ts'));
      assert.equal(result.errors.length, 0);
    });

    it('should skip non-existent files', async () => {
      const result = await preloader.preload([
        { file: 'nonexistent.ts', score: 5 },
      ]);
      assert.ok(result.errors.includes('nonexistent.ts'));
    });

    it('should skip files over max size', async () => {
      const smallPreloader = new Preloader({ rootDir: tempDir, maxFileSize: 5 });
      const result = await smallPreloader.preload([
        { file: 'src/app.ts', score: 10 },
      ]);
      assert.ok(result.skipped.includes('src/app.ts'));
    });

    it('should skip already-cached fresh files', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      const result = await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      assert.ok(result.skipped.includes('src/app.ts'));
    });
  });

  describe('get', () => {
    it('should return cached content', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      const entry = preloader.get('src/app.ts');
      assert.ok(entry);
      assert.ok(entry.content.includes('hello world'));
    });

    it('should return null for uncached files', () => {
      assert.equal(preloader.get('missing.ts'), null);
    });

    it('should track hits and misses', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      preloader.get('src/app.ts');
      preloader.get('missing.ts');
      assert.equal(preloader.stats.hits, 1);
      assert.equal(preloader.stats.misses, 1);
    });
  });

  describe('getMany', () => {
    it('should return multiple cached files', async () => {
      await preloader.preload([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 8 },
      ]);
      const results = preloader.getMany(['src/app.ts', 'src/utils.ts', 'missing.ts']);
      assert.equal(results.length, 2);
    });
  });

  describe('buildContextString', () => {
    it('should build context from cached files', async () => {
      await preloader.preload([
        { file: 'src/app.ts', score: 10 },
        { file: 'config.json', score: 5 },
      ]);
      const ctx = preloader.buildContextString([
        { file: 'src/app.ts', score: 10 },
        { file: 'config.json', score: 5 },
      ]);
      assert.ok(ctx.includes('--- src/app.ts ---'));
      assert.ok(ctx.includes('hello world'));
      assert.ok(ctx.includes('--- config.json ---'));
    });

    it('should respect maxTotalSize', async () => {
      await preloader.preload([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 8 },
      ]);
      const ctx = preloader.buildContextString(
        [{ file: 'src/app.ts', score: 10 }, { file: 'src/utils.ts', score: 8 }],
        { maxTotalSize: 30 }
      );
      // Should include first file but may skip second due to size
      assert.ok(ctx.includes('src/app.ts'));
    });
  });

  describe('getStats', () => {
    it('should return stats with hit rate', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      preloader.get('src/app.ts');
      preloader.get('missing.ts');
      const stats = preloader.getStats();
      assert.equal(stats.hitRate, '50.0%');
      assert.equal(stats.preloads, 1);
    });
  });

  describe('persistMetadata', () => {
    it('should persist without error', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      await preloader.persistMetadata();
      // Should not throw
    });
  });

  describe('clear', () => {
    it('should clear cache and stats', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      preloader.clear();
      assert.equal(preloader.cache.size, 0);
      assert.equal(preloader.stats.preloads, 0);
    });
  });

  describe('configurable cache size', () => {
    it('should respect initial cache size', () => {
      const smallPreloader = new Preloader({ rootDir: tempDir, cacheSize: 2 });
      assert.equal(smallPreloader.cache.maxSize, 2);
    });

    it('should allow reconfiguring cache size', async () => {
      const dynamicPreloader = new Preloader({ rootDir: tempDir, cacheSize: 5 });
      await dynamicPreloader.preload([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 9 },
      ]);

      dynamicPreloader.setCacheSize(10);
      assert.equal(dynamicPreloader.cache.maxSize, 10);
      // Existing entries should be preserved
      assert.ok(dynamicPreloader.cache.has('src/app.ts'));
    });

    it('should migrate entries when shrinking cache', async () => {
      const shrinkPreloader = new Preloader({ rootDir: tempDir, cacheSize: 10 });
      await shrinkPreloader.preload([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 9 },
      ]);

      shrinkPreloader.setCacheSize(1);
      assert.equal(shrinkPreloader.cache.maxSize, 1);
      // Should keep most recent entry
      assert.ok(shrinkPreloader.cache.size <= 1);
    });

    it('should throw on invalid cache size', () => {
      const preloader = new Preloader({ rootDir: tempDir });
      assert.throws(() => preloader.setCacheSize(0));
      assert.throws(() => preloader.setCacheSize(-1));
    });
  });

  describe('prefetch scheduling', () => {
    it('should schedule prefetch for predicted files', async () => {
      const prefetchPreloader = new Preloader({ rootDir: tempDir, enablePrefetch: true });

      prefetchPreloader.schedulePrefetch([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 8 },
      ]);

      assert.ok(prefetchPreloader.prefetchQueue.length > 0);
    });

    it('should not prefetch when disabled', () => {
      const noPrefetchPreloader = new Preloader({ rootDir: tempDir, enablePrefetch: false });

      noPrefetchPreloader.schedulePrefetch([
        { file: 'src/app.ts', score: 10 },
      ]);

      assert.equal(noPrefetchPreloader.prefetchQueue.length, 0);
    });

    it('should not prefetch already cached files', async () => {
      const prefetchPreloader = new Preloader({ rootDir: tempDir, enablePrefetch: true });
      await prefetchPreloader.preload([{ file: 'src/app.ts', score: 10 }]);

      prefetchPreloader.schedulePrefetch([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 8 },
      ]);

      // Should only queue files not already cached
      assert.ok(!prefetchPreloader.prefetchQueue.some(p => p.file === 'src/app.ts'));
    });

    it('should limit prefetch queue size', () => {
      const prefetchPreloader = new Preloader({ rootDir: tempDir, enablePrefetch: true });

      const manyPredictions = Array.from({ length: 50 }, (_, i) => ({
        file: `file${i}.ts`,
        score: 10 - i,
      }));

      prefetchPreloader.schedulePrefetch(manyPredictions);
      assert.ok(prefetchPreloader.prefetchQueue.length <= 20);
    });
  });

  describe('cache statistics', () => {
    it('should track hit rate', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);

      preloader.get('src/app.ts'); // hit
      preloader.get('missing.ts'); // miss
      preloader.get('src/app.ts'); // hit

      const stats = preloader.getStats();
      assert.equal(stats.hits, 2);
      assert.equal(stats.misses, 1);
      assert.equal(stats.hitRate, '66.7%');
    });

    it('should track miss rate', async () => {
      preloader.get('missing1.ts');
      preloader.get('missing2.ts');

      const stats = preloader.getStats();
      assert.equal(stats.missRate, '100.0%');
    });

    it('should track eviction count', async () => {
      const smallPreloader = new Preloader({ rootDir: tempDir, cacheSize: 2 });

      await smallPreloader.preload([
        { file: 'src/app.ts', score: 10 },
        { file: 'src/utils.ts', score: 9 },
        { file: 'config.json', score: 8 }, // Should trigger eviction
      ]);

      const stats = smallPreloader.getStats();
      assert.ok(stats.evictions > 0);
    });

    it('should include cache size info', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);

      const stats = preloader.getStats();
      assert.ok('cacheSize' in stats);
      assert.ok('maxCacheSize' in stats);
      assert.equal(stats.cacheSize, 1);
    });

    it('should track prefetch count', async () => {
      const prefetchPreloader = new Preloader({ rootDir: tempDir, enablePrefetch: true });

      prefetchPreloader.schedulePrefetch([
        { file: 'src/app.ts', score: 10 },
      ]);

      // Wait for prefetch to process
      await new Promise(resolve => setTimeout(resolve, 200));

      const stats = prefetchPreloader.getStats();
      assert.ok('prefetches' in stats);
    });
  });

  describe('cache warming', () => {
    it('should warm cache with recent files', async () => {
      const recentFiles = ['src/app.ts', 'src/utils.ts'];
      await preloader.warmCache(recentFiles);

      assert.ok(preloader.cache.has('src/app.ts'));
      assert.ok(preloader.cache.has('src/utils.ts'));
    });

    it('should skip already cached files', async () => {
      await preloader.preload([{ file: 'src/app.ts', score: 10 }]);
      const initialPreloads = preloader.stats.preloads;

      await preloader.warmCache(['src/app.ts', 'src/utils.ts']);

      // Should only increment for new file
      assert.ok(preloader.stats.preloads > initialPreloads);
    });

    it('should limit warming to reasonable number', async () => {
      const manyFiles = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);

      await preloader.warmCache(manyFiles);

      // Should warm max 10 files
      assert.ok(preloader.cache.size <= 10);
    });

    it('should handle non-array input gracefully', async () => {
      await preloader.warmCache(null);
      await preloader.warmCache(undefined);
      // Should not throw
    });

    it('should skip files that cannot be read', async () => {
      await preloader.warmCache(['nonexistent.ts', 'src/app.ts']);

      // Should successfully cache the existing file
      assert.ok(preloader.cache.has('src/app.ts'));
    });
  });
});
