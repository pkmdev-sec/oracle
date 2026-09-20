/**
 * ORACLE — Context Ranker
 * Ranks predicted context items by relevance using multi-signal scoring.
 * Signals: recency, frequency, semantic similarity, file structure proximity, TF-IDF, project structure.
 */

import { extname, dirname, basename } from 'node:path';

/** Weights for each ranking signal (tunable) */
const DEFAULT_WEIGHTS = {
  predictorScore: 0.25,
  recency:        0.20,
  frequency:      0.15,
  proximity:      0.10,
  fileType:       0.10,
  tfidf:          0.15,
  projectStructure: 0.05,
};

/** File-type importance tiers */
const TYPE_TIERS = {
  high:   new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.rs', '.go']),
  medium: new Set(['.json', '.yaml', '.yml', '.toml', '.md']),
  low:    new Set(['.css', '.scss', '.html', '.svg']),
};

/** Project structure patterns (higher score for important directories) */
const PROJECT_STRUCTURE_PATTERNS = {
  high:   ['src/', 'lib/', 'app/', 'core/', 'api/', 'routes/', 'controllers/'],
  medium: ['components/', 'utils/', 'helpers/', 'models/', 'services/'],
  low:    ['tests/', 'test/', '__tests__/', 'docs/', 'examples/'],
  config: ['config/', 'settings/'],
};

export class ContextRanker {
  /**
   * @param {object} [opts]
   * @param {object} [opts.weights] - override default signal weights
   * @param {Map<string, number>} [opts.accessFrequency] - file access frequency map
   * @param {Map<string, number>} [opts.accessRecency] - file last-access timestamp map
   * @param {string} [opts.activeFile] - currently active file for proximity calculation
   * @param {string[]} [opts.allFiles] - all project files for TF-IDF calculation
   * @param {string[]} [opts.keywords] - keywords from prompt for TF-IDF
   */
  constructor(opts = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
    this.accessFrequency = opts.accessFrequency || new Map();
    this.accessRecency = opts.accessRecency || new Map();
    this.activeFile = opts.activeFile || '';
    this.allFiles = opts.allFiles || [];
    this.keywords = opts.keywords || [];
    // Document frequency map for TF-IDF: keyword → number of files containing it
    this.documentFrequency = new Map();
  }

  /**
   * Compute normalized recency score for a file.
   * @param {string} file
   * @returns {number} 0-1
   */
  recencyScore(file) {
    const lastAccess = this.accessRecency.get(file);
    if (!lastAccess) return 0;
    const age = Date.now() - lastAccess;
    const maxAge = 3600_000; // 1 hour window
    return Math.max(0, 1 - age / maxAge);
  }

  /**
   * Compute normalized frequency score for a file.
   * @param {string} file
   * @returns {number} 0-1
   */
  frequencyScore(file) {
    const freq = this.accessFrequency.get(file) || 0;
    if (freq === 0) return 0;

    // Iterate to find max instead of spreading (avoids RangeError on large Maps)
    let maxFreq = 1;
    for (const value of this.accessFrequency.values()) {
      if (value > maxFreq) maxFreq = value;
    }

    return freq / maxFreq;
  }

  /**
   * Compute directory proximity score between file and active file.
   * @param {string} file
   * @returns {number} 0-1
   */
  proximityScore(file) {
    if (!this.activeFile) return 0;
    const dir1 = dirname(file).split('/');
    const dir2 = dirname(this.activeFile).split('/');
    let common = 0;
    for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
      if (dir1[i] === dir2[i]) common++;
      else break;
    }
    const maxLen = Math.max(dir1.length, dir2.length, 1);
    return common / maxLen;
  }

  /**
   * Compute file-type importance score.
   * @param {string} file
   * @returns {number} 0-1
   */
  fileTypeScore(file) {
    const ext = extname(file).toLowerCase();
    if (TYPE_TIERS.high.has(ext)) return 1.0;
    if (TYPE_TIERS.medium.has(ext)) return 0.6;
    if (TYPE_TIERS.low.has(ext)) return 0.3;
    return 0.1;
  }

  /**
   * Compute TF-IDF score for a file based on keywords.
   * Term Frequency (TF): how often keyword appears in file path
   * Inverse Document Frequency (IDF): log(total files / files containing keyword)
   * @param {string} file
   * @returns {number} 0-1
   */
  tfidfScore(file) {
    if (this.keywords.length === 0 || this.allFiles.length === 0) return 0;

    const lowerFile = file.toLowerCase();
    let totalScore = 0;

    for (const keyword of this.keywords) {
      const lowerKeyword = keyword.toLowerCase();

      // Term Frequency: count keyword occurrences in file path
      const regex = new RegExp(lowerKeyword, 'g');
      const matches = lowerFile.match(regex);
      const tf = matches ? matches.length : 0;

      if (tf === 0) continue;

      // Inverse Document Frequency: count how many files contain this keyword
      let df = this.documentFrequency.get(lowerKeyword);
      if (df === undefined) {
        df = this.allFiles.filter(f => f.toLowerCase().includes(lowerKeyword)).length;
        this.documentFrequency.set(lowerKeyword, df);
      }

      if (df === 0) continue;

      const idf = Math.log(this.allFiles.length / df);
      totalScore += tf * idf;
    }

    // Normalize by number of keywords
    return Math.min(1.0, totalScore / this.keywords.length);
  }

  /**
   * Compute project structure awareness score.
   * Files in important directories (src/, lib/, api/) score higher.
   * @param {string} file
   * @returns {number} 0-1
   */
  projectStructureScore(file) {
    const lowerFile = file.toLowerCase();

    // Check high-priority patterns
    for (const pattern of PROJECT_STRUCTURE_PATTERNS.high) {
      if (lowerFile.includes(pattern.toLowerCase())) return 1.0;
    }

    // Check medium-priority patterns
    for (const pattern of PROJECT_STRUCTURE_PATTERNS.medium) {
      if (lowerFile.includes(pattern.toLowerCase())) return 0.7;
    }

    // Check config patterns
    for (const pattern of PROJECT_STRUCTURE_PATTERNS.config) {
      if (lowerFile.includes(pattern.toLowerCase())) return 0.6;
    }

    // Check low-priority patterns
    for (const pattern of PROJECT_STRUCTURE_PATTERNS.low) {
      if (lowerFile.includes(pattern.toLowerCase())) return 0.4;
    }

    return 0.3; // Default for other files
  }

  /**
   * Rank a list of predicted files with their scores.
   * Enhanced with TF-IDF and project structure awareness.
   * @param {Array<{file: string, score: number}>} predictions - from FilePredictor
   * @returns {Array<{file: string, score: number, signals: object}>}
   */
  rank(predictions) {
    try {
      if (!Array.isArray(predictions)) {
        throw new Error('Invalid predictions: must be an array');
      }
      if (!predictions.length) return [];

      // Normalize predictor scores
      let maxPredScore = 1;
      for (const p of predictions) {
        if (p.score > maxPredScore) maxPredScore = p.score;
      }

      const ranked = predictions.map(({ file, score }) => {
        const signals = {
          predictorScore:    score / maxPredScore,
          recency:           this.recencyScore(file),
          frequency:         this.frequencyScore(file),
          proximity:         this.proximityScore(file),
          fileType:          this.fileTypeScore(file),
          tfidf:             this.tfidfScore(file),
          projectStructure:  this.projectStructureScore(file),
        };

        const finalScore = Object.entries(this.weights).reduce((sum, [key, weight]) => {
          return sum + (signals[key] || 0) * weight;
        }, 0);

        return { file, score: finalScore, signals };
      });

      ranked.sort((a, b) => b.score - a.score);
      return ranked;
    } catch (err) {
      console.error('ContextRanker.rank error:', err);
      throw err;
    }
  }

  /**
   * Select top-N context items within a token budget.
   * @param {Array<{file: string, score: number}>} ranked
   * @param {object} [opts]
   * @param {number} [opts.maxItems=10]
   * @param {number} [opts.maxTokenBudget=50000]
   * @param {Map<string, number>} [opts.fileSizes] - approximate token counts per file
   * @returns {Array<{file: string, score: number}>}
   */
  selectWithinBudget(ranked, opts = {}) {
    try {
      if (!Array.isArray(ranked)) {
        throw new Error('Invalid ranked: must be an array');
      }
      const { maxItems = 10, maxTokenBudget = 50000, fileSizes = new Map() } = opts;
      const selected = [];
      let tokenCount = 0;

      for (const item of ranked) {
        if (selected.length >= maxItems) break;
        const tokens = fileSizes.get(item.file) || 500; // default estimate
        if (tokenCount + tokens > maxTokenBudget) continue;
        selected.push(item);
        tokenCount += tokens;
      }

      return selected;
    } catch (err) {
      console.error('ContextRanker.selectWithinBudget error:', err);
      throw err;
    }
  }

  /**
   * Record a file access for frequency/recency tracking.
   * @param {string} file
   */
  recordAccess(file) {
    this.accessFrequency.set(file, (this.accessFrequency.get(file) || 0) + 1);
    this.accessRecency.set(file, Date.now());
  }

  /**
   * Update the active file.
   * @param {string} file
   */
  setActiveFile(file) {
    this.activeFile = file;
  }

  /**
   * Update keywords for TF-IDF calculation.
   * @param {string[]} keywords
   */
  setKeywords(keywords) {
    this.keywords = keywords;
    this.documentFrequency.clear(); // Clear cache when keywords change
  }

  /**
   * Update all files list for TF-IDF calculation.
   * @param {string[]} files
   */
  setAllFiles(files) {
    this.allFiles = files;
    this.documentFrequency.clear(); // Clear cache when file list changes
  }
}

export default ContextRanker;
