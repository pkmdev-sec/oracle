/**
 * ORACLE — Context Preloader
 * Pre-fetches and caches predicted context files for rapid injection.
 * Manages an in-memory LRU cache with disk persistence.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/** Enhanced LRU cache implementation with eviction tracking */
class LRUCache {
  /**
   * @param {number} maxSize - max number of entries
   */
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    /** @type {Map<string, {content: string, loadedAt: number, size: number}>} */
    this.cache = new Map();
    this.evictionCount = 0;
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.evictionCount++;
      }
    }
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  keys() {
    return [...this.cache.keys()];
  }

  entries() {
    return [...this.cache.entries()];
  }

  getEvictionCount() {
    return this.evictionCount;
  }

  resetEvictionCount() {
    this.evictionCount = 0;
  }
}

export class Preloader {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir - project root for resolving file paths
   * @param {number} [opts.cacheSize=100] - max cached files (configurable)
   * @param {number} [opts.maxFileSize=100000] - max file size in bytes to cache
   * @param {string} [opts.persistPath] - path to persist cache metadata
   * @param {boolean} [opts.enablePrefetch=true] - enable prefetch scheduling
   */
  constructor({ rootDir, cacheSize = 100, maxFileSize = 100_000, persistPath = null, enablePrefetch = true }) {
    this.rootDir = rootDir;
    this.cacheSize = cacheSize; // Store for reconfiguration
    this.maxFileSize = maxFileSize;
    this.persistPath = persistPath || join(rootDir, '.oracle', 'cache-meta.json');
    this.cache = new LRUCache(cacheSize);
    this.enablePrefetch = enablePrefetch;
    this.prefetchQueue = []; // Queue of files to prefetch
    this.prefetchTimer = null;
    this.stats = {
      hits: 0,
      misses: 0,
      preloads: 0,
      evictions: 0,
      errors: 0,
      prefetches: 0,
    };
  }

  /**
   * Pre-fetch a list of predicted files into cache.
   * @param {Array<{file: string, score: number}>} predictions
   * @returns {Promise<{loaded: string[], skipped: string[], errors: string[]}>}
   */
  async preload(predictions) {
    try {
      if (!Array.isArray(predictions)) {
        throw new Error('Invalid predictions: must be an array');
      }

      const loaded = [];
      const skipped = [];
      const errors = [];

      const tasks = predictions.map(async ({ file }) => {
        // Skip if already cached and fresh
        const cached = this.cache.get(file);
        if (cached && (Date.now() - cached.loadedAt) < 60_000) {
          skipped.push(file);
          return;
        }

        try {
          const fullPath = join(this.rootDir, file);
          const fileStat = await stat(fullPath);

          if (fileStat.size > this.maxFileSize) {
            skipped.push(file);
            return;
          }

          const content = await readFile(fullPath, 'utf-8');
          this.cache.set(file, {
            content,
            loadedAt: Date.now(),
            size: fileStat.size,
          });
          loaded.push(file);
          this.stats.preloads++;
        } catch (err) {
          errors.push(file);
          this.stats.errors++;
        }
      });

      await Promise.all(tasks);
      return { loaded, skipped, errors };
    } catch (err) {
      console.error('Preloader.preload error:', err);
      throw err;
    }
  }

  /**
   * Get cached content for a file.
   * @param {string} file
   * @returns {{content: string, size: number} | null}
   */
  get(file) {
    const entry = this.cache.get(file);
    if (entry) {
      this.stats.hits++;
      return { content: entry.content, size: entry.size };
    }
    this.stats.misses++;
    return null;
  }

  /**
   * Get multiple files' content, returning only those in cache.
   * @param {string[]} files
   * @returns {Array<{file: string, content: string, size: number}>}
   */
  getMany(files) {
    const results = [];
    for (const file of files) {
      const entry = this.get(file);
      if (entry) {
        results.push({ file, ...entry });
      }
    }
    return results;
  }

  /**
   * Build context string from cached files for injection.
   * @param {Array<{file: string, score: number}>} ranked
   * @param {object} [opts]
   * @param {number} [opts.maxTotalSize=80000] - max total chars for context
   * @returns {string}
   */
  buildContextString(ranked, opts = {}) {
    try {
      if (!Array.isArray(ranked)) {
        throw new Error('Invalid ranked: must be an array');
      }
      const { maxTotalSize = 80_000 } = opts;
      const parts = [];
      let totalSize = 0;

      for (const { file } of ranked) {
        const entry = this.cache.get(file);
        if (!entry) continue;
        if (totalSize + entry.size > maxTotalSize) continue;

        parts.push(`--- ${file} ---\n${entry.content}`);
        totalSize += entry.size;
      }

      return parts.join('\n\n');
    } catch (err) {
      console.error('Preloader.buildContextString error:', err);
      return '';
    }
  }

  /**
   * Persist cache metadata to disk.
   * @returns {Promise<void>}
   */
  async persistMetadata() {
    try {
      const meta = {
        timestamp: Date.now(),
        stats: this.stats,
        files: this.cache.keys(),
      };

      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(meta, null, 2));
    } catch (err) {
      // Non-critical failure, log but don't throw
      console.warn('Preloader.persistMetadata warning:', err.message);
    }
  }

  /**
   * Get cache statistics with hit rate, miss rate, and eviction count.
   * @returns {object}
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0
      ? (this.stats.hits / total * 100).toFixed(1)
      : '0.0';
    const missRate = total > 0
      ? (this.stats.misses / total * 100).toFixed(1)
      : '0.0';

    // Get evictions from cache
    this.stats.evictions = this.cache.getEvictionCount();

    return {
      ...this.stats,
      cacheSize: this.cache.size,
      maxCacheSize: this.cacheSize,
      hitRate: `${hitRate}%`,
      missRate: `${missRate}%`,
    };
  }

  /**
   * Reconfigure cache size (useful for dynamic adjustment).
   * @param {number} newSize
   */
  setCacheSize(newSize) {
    if (newSize < 1) throw new Error('Cache size must be at least 1');
    this.cacheSize = newSize;
    // Create new cache with new size and migrate existing entries
    const oldEntries = this.cache.entries();
    this.cache = new LRUCache(newSize);
    for (const [key, value] of oldEntries.slice(-newSize)) {
      this.cache.set(key, value);
    }
  }

  /**
   * Schedule prefetch for predicted files (runs in background).
   * @param {Array<{file: string, score: number}>} predictions
   */
  schedulePrefetch(predictions) {
    if (!this.enablePrefetch) return;

    // Add to prefetch queue
    this.prefetchQueue = predictions
      .filter(p => !this.cache.has(p.file))
      .slice(0, 20); // Limit queue size

    // Start prefetch timer if not already running
    if (!this.prefetchTimer && this.prefetchQueue.length > 0) {
      this.prefetchTimer = setTimeout(() => this._processPrefetchQueue(), 100);
    }
  }

  /**
   * Process the prefetch queue in background.
   * @private
   */
  async _processPrefetchQueue() {
    while (this.prefetchQueue.length > 0) {
      const item = this.prefetchQueue.shift();
      try {
        const fullPath = join(this.rootDir, item.file);
        const fileStat = await stat(fullPath);

        if (fileStat.size > this.maxFileSize) continue;

        const content = await readFile(fullPath, 'utf-8');
        this.cache.set(item.file, {
          content,
          loadedAt: Date.now(),
          size: fileStat.size,
        });
        this.stats.prefetches++;
      } catch {
        // Silently fail for prefetch
      }

      // Yield control between files
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.prefetchTimer = null;
  }

  /** Clear all cached data. */
  clear() {
    this.cache.clear();
    this.prefetchQueue = [];
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
    this.stats = { hits: 0, misses: 0, preloads: 0, evictions: 0, errors: 0, prefetches: 0 };
  }

  /**
   * Get detailed cache statistics including per-file metadata.
   * @returns {object}
   */
  getCacheStats() {
    try {
      const entries = this.cache.entries();
      const fileDetails = entries.map(([file, data]) => ({
        file,
        size: data.size,
        loadedAt: data.loadedAt,
        ageMs: Date.now() - data.loadedAt
      }));

      // Sort by most recently loaded
      fileDetails.sort((a, b) => b.loadedAt - a.loadedAt);

      const totalSize = fileDetails.reduce((sum, item) => sum + item.size, 0);
      const avgSize = fileDetails.length > 0 ? Math.round(totalSize / fileDetails.length) : 0;

      const total = this.stats.hits + this.stats.misses;
      const hitRate = total > 0
        ? (this.stats.hits / total * 100).toFixed(1)
        : '0.0';

      return {
        summary: {
          cacheSize: this.cache.size,
          maxCacheSize: this.cacheSize,
          totalBytes: totalSize,
          avgFileSize: avgSize,
          hitRate: `${hitRate}%`,
          hits: this.stats.hits,
          misses: this.stats.misses,
          preloads: this.stats.preloads,
          evictions: this.cache.getEvictionCount(),
          errors: this.stats.errors,
          prefetches: this.stats.prefetches
        },
        files: fileDetails
      };
    } catch (err) {
      console.error('Preloader.getCacheStats error:', err);
      return { summary: {}, files: [] };
    }
  }

  /**
   * Clear entries older than the specified age.
   * @param {number} maxAgeMs - maximum age in milliseconds
   * @returns {number} - number of entries cleared
   */
  clearStaleEntries(maxAgeMs) {
    try {
      if (typeof maxAgeMs !== 'number' || maxAgeMs <= 0) {
        throw new Error('Invalid maxAgeMs: must be a positive number');
      }

      const now = Date.now();
      const entries = this.cache.entries();
      let cleared = 0;

      for (const [file, data] of entries) {
        const age = now - data.loadedAt;
        if (age > maxAgeMs) {
          this.cache.delete(file);
          cleared++;
        }
      }

      return cleared;
    } catch (err) {
      console.error('Preloader.clearStaleEntries error:', err);
      return 0;
    }
  }

  /**
   * Pre-populate cache with specific files (warm cache).
   * @param {string[]} filePaths - array of file paths to warm
   * @returns {Promise<{loaded: string[], skipped: string[], errors: string[]}>}
   */
  async warmCache(filePaths) {
    if (!Array.isArray(filePaths)) {
      return { loaded: [], skipped: [], errors: [] };
    }

    try {
      const loaded = [];
      const skipped = [];
      const errors = [];

      for (const file of filePaths) {
        // Skip if already cached and fresh
        const cached = this.cache.get(file);
        if (cached && (Date.now() - cached.loadedAt) < 60_000) {
          skipped.push(file);
          continue;
        }

        try {
          const fullPath = join(this.rootDir, file);
          const fileStat = await stat(fullPath);

          if (fileStat.size > this.maxFileSize) {
            skipped.push(file);
            continue;
          }

          const content = await readFile(fullPath, 'utf-8');
          this.cache.set(file, {
            content,
            loadedAt: Date.now(),
            size: fileStat.size,
          });
          loaded.push(file);
          this.stats.preloads++;
        } catch (err) {
          errors.push(file);
          this.stats.errors++;
        }
      }

      return { loaded, skipped, errors };
    } catch (err) {
      console.error('Preloader.warmCache error:', err);
      throw err;
    }
  }

  /**
   * Export list of cached files with metadata as manifest.
   * @returns {object}
   */
  exportCacheManifest() {
    try {
      const entries = this.cache.entries();
      const manifest = {
        timestamp: Date.now(),
        version: '1.0',
        stats: this.getStats(),
        files: entries.map(([file, data]) => ({
          path: file,
          size: data.size,
          loadedAt: data.loadedAt,
          ageMs: Date.now() - data.loadedAt
        }))
      };

      return manifest;
    } catch (err) {
      console.error('Preloader.exportCacheManifest error:', err);
      return {
        timestamp: Date.now(),
        version: '1.0',
        stats: {},
        files: []
      };
    }
  }
}

export { LRUCache };
export default Preloader;
