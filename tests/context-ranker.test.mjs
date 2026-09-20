/**
 * Tests for ORACLE ContextRanker
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContextRanker } from '../lib/context-ranker.mjs';

describe('ContextRanker', () => {
  let ranker;

  beforeEach(() => {
    ranker = new ContextRanker({
      activeFile: 'src/components/App.tsx',
      accessFrequency: new Map([
        ['src/utils/helpers.ts', 5],
        ['src/components/App.tsx', 10],
        ['config/db.json', 2],
      ]),
      accessRecency: new Map([
        ['src/utils/helpers.ts', Date.now() - 60_000],
        ['src/components/App.tsx', Date.now()],
        ['config/db.json', Date.now() - 3600_000],
      ]),
    });
  });

  describe('recencyScore', () => {
    it('should give higher score to recently accessed files', () => {
      const recentScore = ranker.recencyScore('src/components/App.tsx');
      const oldScore = ranker.recencyScore('config/db.json');
      assert.ok(recentScore > oldScore);
    });

    it('should return 0 for unknown files', () => {
      assert.equal(ranker.recencyScore('unknown/file.ts'), 0);
    });

    it('should return close to 1 for just-accessed files', () => {
      const score = ranker.recencyScore('src/components/App.tsx');
      assert.ok(score > 0.9);
    });
  });

  describe('frequencyScore', () => {
    it('should give higher score to frequently accessed files', () => {
      const highFreq = ranker.frequencyScore('src/components/App.tsx');
      const lowFreq = ranker.frequencyScore('config/db.json');
      assert.ok(highFreq > lowFreq);
    });

    it('should return 0 for unknown files', () => {
      assert.equal(ranker.frequencyScore('unknown/file.ts'), 0);
    });

    it('should return 1 for the most frequent file', () => {
      assert.equal(ranker.frequencyScore('src/components/App.tsx'), 1);
    });
  });

  describe('proximityScore', () => {
    it('should give higher score to files near active file', () => {
      const nearScore = ranker.proximityScore('src/components/Button.tsx');
      const farScore = ranker.proximityScore('api/routes/users.ts');
      assert.ok(nearScore > farScore);
    });

    it('should return 0 when no active file', () => {
      const noActiveRanker = new ContextRanker();
      assert.equal(noActiveRanker.proximityScore('any/file.ts'), 0);
    });
  });

  describe('fileTypeScore', () => {
    it('should score TypeScript/JS files highest', () => {
      const tsScore = ranker.fileTypeScore('file.ts');
      const cssScore = ranker.fileTypeScore('file.css');
      assert.ok(tsScore > cssScore);
    });

    it('should score JSON/YAML as medium', () => {
      const jsonScore = ranker.fileTypeScore('config.json');
      assert.ok(jsonScore > 0.3 && jsonScore <= 0.7);
    });

    it('should give low score to unknown types', () => {
      const score = ranker.fileTypeScore('file.xyz');
      assert.ok(score < 0.3);
    });
  });

  describe('rank', () => {
    it('should rank predictions by combined score', () => {
      const predictions = [
        { file: 'src/components/App.tsx', score: 10 },
        { file: 'src/utils/helpers.ts', score: 8 },
        { file: 'config/db.json', score: 5 },
      ];

      const ranked = ranker.rank(predictions);
      assert.equal(ranked.length, 3);
      // Should be sorted descending
      for (let i = 1; i < ranked.length; i++) {
        assert.ok(ranked[i - 1].score >= ranked[i].score);
      }
    });

    it('should include signal details', () => {
      const ranked = ranker.rank([{ file: 'src/components/App.tsx', score: 10 }]);
      assert.ok(ranked[0].signals);
      assert.ok('predictorScore' in ranked[0].signals);
      assert.ok('recency' in ranked[0].signals);
      assert.ok('frequency' in ranked[0].signals);
      assert.ok('proximity' in ranked[0].signals);
      assert.ok('fileType' in ranked[0].signals);
    });

    it('should handle empty predictions', () => {
      const ranked = ranker.rank([]);
      assert.deepEqual(ranked, []);
    });
  });

  describe('selectWithinBudget', () => {
    it('should limit by maxItems', () => {
      const ranked = [
        { file: 'a.ts', score: 0.9 },
        { file: 'b.ts', score: 0.8 },
        { file: 'c.ts', score: 0.7 },
      ];
      const selected = ranker.selectWithinBudget(ranked, { maxItems: 2 });
      assert.equal(selected.length, 2);
    });

    it('should respect token budget', () => {
      const ranked = [
        { file: 'a.ts', score: 0.9 },
        { file: 'b.ts', score: 0.8 },
      ];
      const fileSizes = new Map([['a.ts', 40000], ['b.ts', 40000]]);
      const selected = ranker.selectWithinBudget(ranked, {
        maxTokenBudget: 50000,
        fileSizes,
      });
      assert.equal(selected.length, 1);
    });
  });

  describe('recordAccess', () => {
    it('should update frequency and recency', () => {
      ranker.recordAccess('new/file.ts');
      assert.equal(ranker.accessFrequency.get('new/file.ts'), 1);
      assert.ok(ranker.accessRecency.has('new/file.ts'));
    });

    it('should increment frequency on multiple accesses', () => {
      ranker.recordAccess('new/file.ts');
      ranker.recordAccess('new/file.ts');
      assert.equal(ranker.accessFrequency.get('new/file.ts'), 2);
    });
  });

  describe('setActiveFile', () => {
    it('should update active file', () => {
      ranker.setActiveFile('new/active.ts');
      assert.equal(ranker.activeFile, 'new/active.ts');
    });
  });

  describe('TF-IDF scoring', () => {
    it('should compute TF-IDF score based on keywords', () => {
      const rankerWithKeywords = new ContextRanker({
        keywords: ['auth', 'login'],
        allFiles: [
          'src/auth/login.ts',
          'src/auth/middleware.ts',
          'src/components/Button.tsx',
          'src/utils/helpers.ts',
        ],
      });

      const authScore = rankerWithKeywords.tfidfScore('src/auth/login.ts');
      const buttonScore = rankerWithKeywords.tfidfScore('src/components/Button.tsx');

      // File with auth and login should score higher than button
      assert.ok(authScore > buttonScore);
    });

    it('should return 0 when no keywords', () => {
      const rankerNoKeywords = new ContextRanker({ allFiles: ['a.ts', 'b.ts'] });
      assert.equal(rankerNoKeywords.tfidfScore('a.ts'), 0);
    });

    it('should return 0 when no files', () => {
      const rankerNoFiles = new ContextRanker({ keywords: ['test'] });
      assert.equal(rankerNoFiles.tfidfScore('a.ts'), 0);
    });

    it('should weight rare keywords higher (IDF)', () => {
      const rankerTFIDF = new ContextRanker({
        keywords: ['rare', 'common'],
        allFiles: [
          'src/rare/file.ts', // Contains 'rare' (rare keyword)
          'src/common/a.ts',  // Contains 'common'
          'src/common/b.ts',  // Contains 'common'
          'src/common/c.ts',  // Contains 'common'
        ],
      });

      // The rare keyword should contribute more to the score
      const rareScore = rankerTFIDF.tfidfScore('src/rare/file.ts');
      assert.ok(rareScore > 0);
    });
  });

  describe('project structure awareness', () => {
    it('should score src/ files highest', () => {
      const srcScore = ranker.projectStructureScore('src/components/App.tsx');
      const testScore = ranker.projectStructureScore('tests/app.test.ts');
      assert.ok(srcScore > testScore);
    });

    it('should score lib/ and api/ files high', () => {
      const libScore = ranker.projectStructureScore('lib/utils.ts');
      const apiScore = ranker.projectStructureScore('api/routes/users.ts');
      assert.ok(libScore >= 0.9);
      assert.ok(apiScore >= 0.9);
    });

    it('should score test files lower', () => {
      const testScore = ranker.projectStructureScore('tests/unit/test.ts');
      assert.ok(testScore < 0.5);
    });

    it('should score config files medium', () => {
      const configScore = ranker.projectStructureScore('config/database.json');
      assert.ok(configScore >= 0.5 && configScore < 0.7);
    });

    it('should give default score to other files', () => {
      const otherScore = ranker.projectStructureScore('random/file.ts');
      assert.ok(otherScore > 0 && otherScore < 0.5);
    });
  });

  describe('setKeywords', () => {
    it('should update keywords', () => {
      ranker.setKeywords(['test', 'keywords']);
      assert.deepEqual(ranker.keywords, ['test', 'keywords']);
    });

    it('should clear document frequency cache', () => {
      ranker.documentFrequency.set('old', 5);
      ranker.setKeywords(['new']);
      assert.equal(ranker.documentFrequency.size, 0);
    });
  });

  describe('setAllFiles', () => {
    it('should update all files list', () => {
      ranker.setAllFiles(['a.ts', 'b.ts']);
      assert.deepEqual(ranker.allFiles, ['a.ts', 'b.ts']);
    });

    it('should clear document frequency cache', () => {
      ranker.documentFrequency.set('old', 5);
      ranker.setAllFiles(['new.ts']);
      assert.equal(ranker.documentFrequency.size, 0);
    });
  });

  describe('integrated ranking with new features', () => {
    it('should include TF-IDF and project structure in ranking', () => {
      const enhancedRanker = new ContextRanker({
        keywords: ['auth', 'middleware'],
        allFiles: [
          'src/auth/middleware.ts',
          'tests/auth.test.ts',
          'docs/auth.md',
        ],
        activeFile: 'src/auth/middleware.ts',
      });

      const predictions = [
        { file: 'src/auth/middleware.ts', score: 10 },
        { file: 'tests/auth.test.ts', score: 8 },
        { file: 'docs/auth.md', score: 6 },
      ];

      const ranked = enhancedRanker.rank(predictions);

      // Check that new signals are present
      assert.ok('tfidf' in ranked[0].signals);
      assert.ok('projectStructure' in ranked[0].signals);

      // src/ file should rank highest due to structure bonus
      assert.equal(ranked[0].file, 'src/auth/middleware.ts');
    });
  });
});
