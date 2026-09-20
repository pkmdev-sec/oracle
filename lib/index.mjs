/**
 * ORACLE — Predictive Context Pre-loader
 * Main entry point. Orchestrates prediction, ranking, preloading, and learning.
 */

import { FilePredictor } from './file-predictor.mjs';
import { ContextRanker } from './context-ranker.mjs';
import { Preloader } from './preloader.mjs';
import { PatternLearner } from './pattern-learner.mjs';
import { join } from 'node:path';

const BANNER = `
\x1b[38;2;139;92;246m╔══════════════════════════════════════════════════════════╗
║                                                          ║
║      🔮  ░█▀█░█▀▄░█▀█░█▀▀░█░░░█▀▀                      ║
║          ░█░█░█▀▄░█▀█░█░░░█░░░█▀▀                       ║
║          ░▀▀▀░▀░▀░▀░▀░▀▀▀░▀▀▀░▀▀▀                       ║
║                                                          ║
║\x1b[38;2;100;60;200m    ╌╌╌ PREDICTIVE CONTEXT PRE-LOADER ╌╌╌\x1b[38;2;139;92;246m              ║
║                                                          ║
║\x1b[38;2;168;130;255m    ◈ Predict files before you need them                 \x1b[38;2;139;92;246m║
║\x1b[38;2;168;130;255m    ◈ Rank context by multi-signal relevance             \x1b[38;2;139;92;246m║
║\x1b[38;2;168;130;255m    ◈ Pre-fetch & cache for instant injection            \x1b[38;2;139;92;246m║
║\x1b[38;2;168;130;255m    ◈ Learn from sessions to improve over time           \x1b[38;2;139;92;246m║
║                                                          ║
╚══════════════════════════════════════════════════════════╝\x1b[0m`;

export class Oracle {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir - project root
   * @param {string} [opts.dataDir] - learning data directory
   */
  constructor({ rootDir, dataDir = null }) {
    this.rootDir = rootDir;
    this.dataDir = dataDir || join(rootDir, '.oracle');

    this.learner = new PatternLearner({ dataDir: this.dataDir });
    this.predictor = new FilePredictor({
      rootDir,
      coOccurrenceMap: this.learner.buildCoOccurrenceMap(),
    });
    this.ranker = new ContextRanker();
    this.preloader = new Preloader({ rootDir });

    /** @type {string[]} */
    this.promptHistory = [];
  }

  /** Display startup banner */
  static banner() {
    console.log(BANNER);
  }

  /**
   * Initialize Oracle — load learned patterns.
   * @returns {Promise<void>}
   */
  async init() {
    await this.learner.load();
    this.predictor.coOccurrenceMap = this.learner.buildCoOccurrenceMap();
  }

  /**
   * Full prediction pipeline for a user prompt.
   * @param {string} prompt
   * @returns {Promise<{context: string, files: Array<{file: string, score: number}>, stats: object}>}
   */
  async predictContext(prompt) {
    this.promptHistory.push(prompt);

    // 1. Predict files
    const predictions = await this.predictor.predict(prompt, this.promptHistory);

    // 2. Merge with learned suggestions
    const learnedSuggestions = this.learner.suggest(prompt);
    const merged = this._mergePredictions(predictions, learnedSuggestions);

    // 3. Rank
    const ranked = this.ranker.rank(merged);

    // 4. Preload
    await this.preloader.preload(ranked);

    // 5. Build context string
    const context = this.preloader.buildContextString(ranked);

    return {
      context,
      files: ranked,
      stats: this.preloader.getStats(),
    };
  }

  /**
   * Merge predictor results with learned suggestions.
   * @param {Array<{file: string, score: number}>} predictions
   * @param {Array<{file: string, confidence: number}>} learned
   * @returns {Array<{file: string, score: number}>}
   */
  _mergePredictions(predictions, learned) {
    const merged = new Map();
    for (const p of predictions) {
      merged.set(p.file, p.score);
    }
    for (const l of learned) {
      const existing = merged.get(l.file) || 0;
      merged.set(l.file, existing + l.confidence * 10);
    }
    return [...merged.entries()].map(([file, score]) => ({ file, score }));
  }

  /**
   * Record feedback about which files were actually used.
   * @param {string} prompt
   * @param {string[]} predictedFiles
   * @param {string[]} usedFiles
   */
  async recordFeedback(prompt, predictedFiles, usedFiles) {
    this.learner.recordSession(prompt, predictedFiles, usedFiles);
    await this.learner.save();
    // Refresh co-occurrence map
    this.predictor.coOccurrenceMap = this.learner.buildCoOccurrenceMap();
  }

  /**
   * Get learning metrics.
   * @returns {object}
   */
  getMetrics() {
    return {
      learning: this.learner.getMetrics(),
      cache: this.preloader.getStats(),
    };
  }
}

export { FilePredictor, ContextRanker, Preloader, PatternLearner };
export default Oracle;
