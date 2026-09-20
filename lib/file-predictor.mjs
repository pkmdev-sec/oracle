/**
 * ORACLE — File Predictor
 * Predicts which files will be needed based on prompt content and session history.
 * Uses keyword extraction, path pattern matching, co-occurrence analysis, git-blame,
 * recent access frequency, and import graph analysis.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename, relative } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** File extensions relevant to code context */
const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.json', '.yaml', '.yml', '.toml', '.md', '.sh', '.zsh',
  '.css', '.scss', '.html', '.vue', '.svelte',
]);

/** Sensitive dotfiles to exclude from predictions */
const EXCLUDED_DOTFILES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.env.test',
  '.DS_Store', '.git', '.gitignore', '.npmrc', '.yarnrc',
  '.aws', '.ssh', 'credentials', 'secrets',
]);

/** Additional gitignore-like patterns to exclude */
const GITIGNORE_PATTERNS = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.vscode',
  '.idea',
]);

/** Keyword-to-path pattern mappings for common project structures */
const KEYWORD_PATTERNS = {
  test:       ['tests/', 'test/', '__tests__/', '*.test.*', '*.spec.*'],
  config:     ['*.config.*', '.env*', 'settings.*', 'config/'],
  api:        ['api/', 'routes/', 'endpoints/', 'controllers/'],
  model:      ['models/', 'schema/', 'entities/', 'types/'],
  component:  ['components/', 'views/', 'pages/', 'screens/'],
  hook:       ['hooks/', '.claude/hooks/', '.hooks/'],
  style:      ['styles/', '*.css', '*.scss', '*.styled.*'],
  util:       ['utils/', 'helpers/', 'lib/', 'shared/'],
  migration:  ['migrations/', 'migrate/', 'db/'],
  deploy:     ['Dockerfile', 'docker-compose*', '.github/', 'ci/'],
  auth:       ['auth/', 'middleware/auth*', 'login*', 'session*'],
  database:   ['db/', 'database/', 'prisma/', 'knex*', 'sequelize*'],
  readme:     ['README*', 'CHANGELOG*', 'docs/'],
  package:    ['package.json', 'Cargo.toml', 'go.mod', 'requirements.txt'],
};

export class FilePredictor {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir - project root to scan
   * @param {number} [opts.maxDepth=6] - max directory depth to scan
   * @param {number} [opts.maxResults=20] - max files to return per prediction
   * @param {Map<string,string[]>} [opts.coOccurrenceMap] - learned co-occurrence data
   * @param {Map<string,number>} [opts.accessFrequency] - file access frequency tracking
   * @param {Map<string,{file:string,imports:string[]}>} [opts.importGraph] - import dependency graph
   */
  constructor({ rootDir, maxDepth = 6, maxResults = 20, coOccurrenceMap = new Map(), accessFrequency = new Map(), importGraph = new Map() }) {
    this.rootDir = rootDir;
    this.maxDepth = maxDepth;
    this.maxResults = maxResults;
    this.coOccurrenceMap = coOccurrenceMap;
    this.accessFrequency = accessFrequency;
    this.importGraph = importGraph;
    /** @type {string[]|null} */
    this._fileCache = null;
    this._fileCacheTime = 0;
    this._cacheTTL = 30_000; // 30s
    /** @type {Map<string,number>|null} git-blame recency cache */
    this._gitBlameCache = null;
    this._gitBlameCacheTime = 0;
  }

  /**
   * Recursively collect all relevant file paths under rootDir.
   * Uses parallel scanning with concurrency limit for performance.
   * @returns {Promise<string[]>}
   */
  async _scanFiles(dir = this.rootDir, depth = 0) {
    if (depth > this.maxDepth) return [];
    const results = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    // Separate directories and files for parallel processing
    const directories = [];
    const files = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.claude') continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;

      if (entry.isDirectory()) {
        directories.push(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        // Check if it's a code file OR a non-excluded dotfile
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(relative(this.rootDir, fullPath));
        } else if (entry.name.startsWith('.') && !EXCLUDED_DOTFILES.has(entry.name) && !GITIGNORE_PATTERNS.has(entry.name)) {
          files.push(relative(this.rootDir, fullPath));
        }
      }
    }

    results.push(...files);

    // Parallel subdirectory scanning with concurrency limit (FIXED: was sequential)
    const CONCURRENCY_LIMIT = 5;
    for (let i = 0; i < directories.length; i += CONCURRENCY_LIMIT) {
      const batch = directories.slice(i, i + CONCURRENCY_LIMIT);
      const subResults = await Promise.all(
        batch.map(subDir => this._scanFiles(subDir, depth + 1))
      );
      for (const subResult of subResults) {
        results.push(...subResult);
      }
    }

    return results;
  }

  /**
   * Get file list with caching.
   * @returns {Promise<string[]>}
   */
  async getFiles() {
    try {
      const now = Date.now();
      if (this._fileCache && (now - this._fileCacheTime) < this._cacheTTL) {
        return this._fileCache;
      }
      this._fileCache = await this._scanFiles();
      this._fileCacheTime = now;
      return this._fileCache;
    } catch (err) {
      console.error('FilePredictor.getFiles error:', err);
      return this._fileCache || [];
    }
  }

  /**
   * Get git-blame recency scores for all files (newer commits = higher score).
   * Returns a Map of file → recency score (0-1, where 1 is most recent).
   * @returns {Promise<Map<string,number>>}
   */
  async _getGitBlameRecency() {
    try {
      const now = Date.now();
      // Cache git-blame results for 5 minutes
      if (this._gitBlameCache && (now - this._gitBlameCacheTime) < 300_000) {
        return this._gitBlameCache;
      }

      const recencyMap = new Map();

      // Check if we're in a git repository
      try {
        await execAsync('git rev-parse --is-inside-work-tree', { cwd: this.rootDir });
      } catch {
        // Not a git repo, return empty map
        this._gitBlameCache = recencyMap;
        this._gitBlameCacheTime = now;
        return recencyMap;
      }

      const files = await this.getFiles();
      const maxAge = 365 * 24 * 60 * 60; // 1 year in seconds

      // Process files in batches for efficiency
      const BATCH_SIZE = 10;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (file) => {
          try {
            const fullPath = join(this.rootDir, file);
            // Get last commit timestamp for this file
            const { stdout } = await execAsync(
              `git log -1 --format=%ct "${file}"`,
              { cwd: this.rootDir, timeout: 5000 }
            );
            const timestamp = parseInt(stdout.trim(), 10);
            if (timestamp && !isNaN(timestamp)) {
              const age = Math.floor(Date.now() / 1000) - timestamp;
              const recency = Math.max(0, 1 - age / maxAge);
              recencyMap.set(file, recency);
            }
          } catch {
            // File not in git or error, skip
          }
        }));
      }

      this._gitBlameCache = recencyMap;
      this._gitBlameCacheTime = now;
      return recencyMap;
    } catch (err) {
      console.error('FilePredictor._getGitBlameRecency error:', err);
      return new Map();
    }
  }

  /**
   * Build import graph from code files.
   * Extracts import/require statements to understand file dependencies.
   * @param {string} content - file content
   * @param {string} file - file path
   * @returns {string[]} - array of imported file paths
   */
  _extractImports(content, file) {
    try {
      const imports = [];

      // ES6 imports: import ... from '...'
      const es6ImportRegex = /import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g;
      let match;
      while ((match = es6ImportRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      // CommonJS require: require('...')
      const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      // Dynamic imports: import('...')
      const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = dynamicImportRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      return [...new Set(imports)]; // Deduplicate
    } catch (err) {
      console.error('FilePredictor._extractImports error:', err);
      return [];
    }
  }

  /**
   * Record a file access for frequency tracking.
   * @param {string} file
   */
  recordAccess(file) {
    this.accessFrequency.set(file, (this.accessFrequency.get(file) || 0) + 1);
  }

  /**
   * Extract meaningful keywords from a prompt string.
   * @param {string} prompt
   * @returns {string[]}
   */
  extractKeywords(prompt) {
    try {
      if (typeof prompt !== 'string') return [];
      const normalized = prompt.toLowerCase();
      const words = normalized.match(/[a-z][a-z0-9_.-]+/g) || [];
      // Deduplicate, filter noise
      const stopWords = new Set([
        'the', 'and', 'for', 'this', 'that', 'with', 'from', 'are', 'was',
        'will', 'can', 'has', 'have', 'been', 'not', 'but', 'all', 'any',
        'each', 'its', 'you', 'your', 'how', 'what', 'when', 'where', 'which',
        'just', 'also', 'into', 'some', 'than', 'then', 'them', 'they',
        'make', 'sure', 'please', 'help', 'want', 'need', 'like', 'use',
      ]);
      return [...new Set(words)].filter(w => w.length > 2 && !stopWords.has(w));
    } catch (err) {
      console.error('FilePredictor.extractKeywords error:', err);
      return [];
    }
  }

  /**
   * Extract file paths or partial paths mentioned in the prompt.
   * @param {string} prompt
   * @returns {string[]}
   */
  extractExplicitPaths(prompt) {
    const pathPattern = /(?:^|\s|["'`(])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,6})(?:["'`)\s]|$)/g;
    const matches = [];
    let m;
    while ((m = pathPattern.exec(prompt)) !== null) {
      matches.push(m[1]);
    }
    return matches;
  }

  /**
   * Score a file path against extracted keywords with enhanced scoring.
   * @param {string} filePath
   * @param {string[]} keywords
   * @param {Map<string,number>} [gitBlameRecency] - git-blame recency scores
   * @returns {number}
   */
  scoreFile(filePath, keywords, gitBlameRecency = null) {
    let score = 0;
    const lowerPath = filePath.toLowerCase();
    const fileName = basename(filePath).toLowerCase();

    for (const kw of keywords) {
      // Exact filename match
      if (fileName.includes(kw)) {
        score += 10;
      }
      // Path segment match
      else if (lowerPath.includes(kw)) {
        score += 5;
      }

      // Check keyword pattern groups
      for (const [patternKey, patterns] of Object.entries(KEYWORD_PATTERNS)) {
        if (kw.includes(patternKey) || patternKey.includes(kw)) {
          for (const pat of patterns) {
            const cleaned = pat.replace(/\*/g, '');
            if (lowerPath.includes(cleaned.toLowerCase())) {
              score += 3;
            }
          }
        }
      }
    }

    // Co-occurrence bonus: if this file co-occurs with keywords in learned data
    for (const kw of keywords) {
      const coFiles = this.coOccurrenceMap.get(kw) || [];
      if (coFiles.includes(filePath)) {
        score += 8;
      }
    }

    // Git-blame recency bonus (0-10 points based on how recently modified)
    if (gitBlameRecency && gitBlameRecency.has(filePath)) {
      score += gitBlameRecency.get(filePath) * 10;
    }

    // Access frequency bonus (0-5 points based on how often accessed)
    if (this.accessFrequency.has(filePath)) {
      const freq = this.accessFrequency.get(filePath);
      const maxFreq = Math.max(...this.accessFrequency.values(), 1);
      score += (freq / maxFreq) * 5;
    }

    // Import graph bonus: if any predicted file imports this one
    if (this.importGraph.size > 0) {
      for (const [importerFile, data] of this.importGraph.entries()) {
        if (data.imports && data.imports.some(imp => filePath.includes(imp) || imp.includes(basename(filePath, extname(filePath))))) {
          score += 6;
        }
      }
    }

    return score;
  }

  /**
   * Predict which files are likely needed for a given prompt.
   * Enhanced with git-blame recency, access frequency, and import graph analysis.
   * @param {string} prompt - the user's prompt
   * @param {string[]} [history=[]] - previous prompts in session
   * @returns {Promise<Array<{file: string, score: number}>>}
   */
  async predict(prompt, history = []) {
    try {
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('Invalid prompt: must be a non-empty string');
      }
      if (!Array.isArray(history)) {
        throw new Error('Invalid history: must be an array');
      }

      const files = await this.getFiles();
      const keywords = this.extractKeywords(prompt);
      const explicitPaths = this.extractExplicitPaths(prompt);

      // Get git-blame recency scores
      const gitBlameRecency = await this._getGitBlameRecency();

      // Also extract keywords from recent history (weighted lower)
      const historyKeywords = history
        .slice(-3)
        .flatMap(h => this.extractKeywords(h));

      const scored = [];
      for (const file of files) {
        let score = this.scoreFile(file, keywords, gitBlameRecency);

        // Explicit path mentions get max boost
        for (const ep of explicitPaths) {
          if (file.includes(ep) || file.endsWith(ep)) {
            score += 50;
          }
        }

        // History keywords get partial weight
        score += this.scoreFile(file, historyKeywords, gitBlameRecency) * 0.3;

        // Import graph boost: if file A is predicted and imports file B, boost B
        if (this.importGraph.has(file)) {
          const imports = this.importGraph.get(file).imports || [];
          for (const imp of imports) {
            // Check if any other file matches this import
            const matchingFile = files.find(f => f.includes(imp) || imp.includes(basename(f, extname(f))));
            if (matchingFile) {
              // Find or create entry for the imported file
              const existing = scored.find(s => s.file === matchingFile);
              if (existing) {
                existing.score += 7; // Boost imported files
              }
            }
          }
        }

        if (score > 0) {
          scored.push({ file, score });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, this.maxResults);
    } catch (err) {
      console.error('FilePredictor.predict error:', err);
      throw err;
    }
  }

  /** Invalidate internal file cache and git-blame cache. */
  invalidateCache() {
    this._fileCache = null;
    this._fileCacheTime = 0;
    this._gitBlameCache = null;
    this._gitBlameCacheTime = 0;
  }
}

export default FilePredictor;
