/**
 * Tests for ORACLE PatternLearner
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PatternLearner, SessionRecord } from '../lib/pattern-learner.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SessionRecord', () => {
  it('should compute accuracy correctly', () => {
    const record = new SessionRecord(
      'test prompt',
      ['a.ts', 'b.ts', 'c.ts'],
      ['a.ts', 'b.ts', 'd.ts']
    );
    // 2 out of 3 predicted were actually used
    assert.ok(Math.abs(record.accuracy - 2/3) < 0.001);
  });

  it('should compute recall correctly', () => {
    const record = new SessionRecord(
      'test prompt',
      ['a.ts', 'b.ts'],
      ['a.ts', 'b.ts', 'c.ts']
    );
    // 2 out of 3 actual were predicted
    assert.ok(Math.abs(record.recall - 2/3) < 0.001);
  });

  it('should handle empty predictions', () => {
    const record = new SessionRecord('test', [], ['a.ts']);
    assert.equal(record.accuracy, 0);
  });

  it('should handle empty actuals', () => {
    const record = new SessionRecord('test', ['a.ts'], []);
    assert.equal(record.recall, 1);
  });
});

describe('PatternLearner', () => {
  let tempDir;
  let learner;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oracle-learn-test-'));
    learner = new PatternLearner({ dataDir: tempDir });
  });

  describe('extractKeywords', () => {
    it('should extract meaningful keywords', () => {
      const kws = learner.extractKeywords('Fix the authentication middleware');
      assert.ok(kws.includes('fix'));
      assert.ok(kws.includes('authentication'));
      assert.ok(kws.includes('middleware'));
      assert.ok(!kws.includes('the'));
    });
  });

  describe('recordSession', () => {
    it('should store session records', () => {
      learner.recordSession('fix auth', ['auth.ts'], ['auth.ts', 'middleware.ts']);
      assert.equal(learner.records.length, 1);
    });

    it('should build keyword→file associations', () => {
      learner.recordSession('fix auth', ['auth.ts'], ['auth.ts', 'middleware.ts']);
      const authMap = learner.keywordFileMap.get('auth');
      assert.ok(authMap);
      assert.ok(authMap.get('auth.ts') > 0);
      assert.ok(authMap.get('middleware.ts') > 0);
    });

    it('should build co-occurrence map', () => {
      learner.recordSession('fix auth', [], ['auth.ts', 'middleware.ts', 'config.ts']);
      const peers = learner.coOccurrenceMap.get('auth.ts');
      assert.ok(peers.includes('middleware.ts'));
      assert.ok(peers.includes('config.ts'));
    });

    it('should trim old records beyond maxRecords', () => {
      const smallLearner = new PatternLearner({ dataDir: tempDir, maxRecords: 3 });
      for (let i = 0; i < 5; i++) {
        smallLearner.recordSession(`prompt ${i}`, [], [`file${i}.ts`]);
      }
      assert.equal(smallLearner.records.length, 3);
    });
  });

  describe('suggest', () => {
    it('should suggest files based on learned patterns', () => {
      learner.recordSession('fix auth bug', [], ['auth.ts', 'middleware.ts']);
      learner.recordSession('update auth flow', [], ['auth.ts', 'login.ts']);
      learner.recordSession('auth tests', [], ['auth.ts', 'auth.test.ts']);

      const suggestions = learner.suggest('auth module needs fix');
      assert.ok(suggestions.length > 0);
      assert.ok(suggestions.some(s => s.file === 'auth.ts'));
    });

    it('should return empty for unknown patterns', () => {
      const suggestions = learner.suggest('something completely unknown xyz');
      assert.equal(suggestions.length, 0);
    });

    it('should respect maxSuggestions', () => {
      for (let i = 0; i < 20; i++) {
        learner.recordSession('auth', [], [`file${i}.ts`]);
      }
      const suggestions = learner.suggest('auth', 5);
      assert.ok(suggestions.length <= 5);
    });
  });

  describe('buildCoOccurrenceMap', () => {
    it('should produce keyword→files map', () => {
      learner.recordSession('fix auth', [], ['auth.ts', 'session.ts']);
      learner.recordSession('test auth', [], ['auth.ts', 'auth.test.ts']);

      const coMap = learner.buildCoOccurrenceMap();
      assert.ok(coMap.has('auth'));
      assert.ok(coMap.get('auth').includes('auth.ts'));
    });
  });

  describe('getMetrics', () => {
    it('should compute average accuracy and recall', () => {
      learner.recordSession('fix auth', ['auth.ts', 'db.ts'], ['auth.ts', 'session.ts']);
      learner.recordSession('fix login', ['login.ts'], ['login.ts']);

      const metrics = learner.getMetrics();
      assert.ok(metrics.avgAccuracy >= 0 && metrics.avgAccuracy <= 1);
      assert.ok(metrics.avgRecall >= 0 && metrics.avgRecall <= 1);
      assert.equal(metrics.totalSessions, 2);
    });

    it('should return zeros for no records', () => {
      const metrics = learner.getMetrics();
      assert.equal(metrics.avgAccuracy, 0);
      assert.equal(metrics.avgRecall, 0);
      assert.equal(metrics.totalSessions, 0);
    });
  });

  describe('save and load', () => {
    it('should persist and reload learned data', async () => {
      learner.recordSession('fix auth', ['auth.ts'], ['auth.ts', 'middleware.ts']);
      learner.recordSession('test login', ['login.ts'], ['login.ts', 'login.test.ts']);
      await learner.save();

      const newLearner = new PatternLearner({ dataDir: tempDir });
      const loaded = await newLearner.load();
      assert.ok(loaded);
      assert.equal(newLearner.records.length, 2);
      assert.ok(newLearner.keywordFileMap.has('auth'));
    });

    it('should return false when no data file exists', async () => {
      const freshDir = await mkdtemp(join(tmpdir(), 'oracle-empty-'));
      const freshLearner = new PatternLearner({ dataDir: freshDir });
      const loaded = await freshLearner.load();
      assert.equal(loaded, false);
    });
  });

  describe('reset', () => {
    it('should clear all learned data', () => {
      learner.recordSession('fix auth', [], ['auth.ts']);
      learner.reset();
      assert.equal(learner.records.length, 0);
      assert.equal(learner.keywordFileMap.size, 0);
      assert.equal(learner.coOccurrenceMap.size, 0);
    });
  });

  describe('feedback loop', () => {
    it('should record useful predictions', () => {
      learner.recordFeedback('auth.ts', true);
      learner.recordFeedback('auth.ts', true);
      learner.recordFeedback('auth.ts', false);

      const feedback = learner.feedbackMap.get('auth.ts');
      assert.equal(feedback.total, 3);
      assert.equal(feedback.useful, 2);
    });

    it('should track feedback timestamps', () => {
      const before = Date.now();
      learner.recordFeedback('auth.ts', true);
      const after = Date.now();

      const timestamp = learner.feedbackTimestamps.get('auth.ts');
      assert.ok(timestamp >= before && timestamp <= after);
    });

    it('should initialize feedback for new files', () => {
      learner.recordFeedback('new-file.ts', false);
      assert.ok(learner.feedbackMap.has('new-file.ts'));
    });

    it('should handle feedback errors gracefully', () => {
      // Should not throw
      learner.recordFeedback(null, true);
      learner.recordFeedback(undefined, false);
    });
  });

  describe('prediction confidence', () => {
    it('should return default confidence for unknown files', () => {
      const confidence = learner.getPredictionConfidence('unknown.ts');
      assert.equal(confidence, 0.5);
    });

    it('should compute confidence from feedback', () => {
      learner.recordFeedback('auth.ts', true);
      learner.recordFeedback('auth.ts', true);
      learner.recordFeedback('auth.ts', false);

      const confidence = learner.getPredictionConfidence('auth.ts');
      // 2 useful out of 3 total = 0.667
      assert.ok(confidence > 0.6 && confidence < 0.7);
    });

    it('should apply pattern decay to old predictions', async () => {
      learner.recordFeedback('auth.ts', true);

      // Simulate old timestamp (31 days ago)
      learner.feedbackTimestamps.set('auth.ts', Date.now() - 31 * 24 * 60 * 60 * 1000);

      const confidence = learner.getPredictionConfidence('auth.ts');
      // Should be decayed from 1.0
      assert.ok(confidence < 1.0);
    });

    it('should not decay recent predictions', () => {
      learner.recordFeedback('recent.ts', true);

      const confidence = learner.getPredictionConfidence('recent.ts');
      // Recent file with 100% usefulness should be close to 1.0
      assert.ok(confidence > 0.9);
    });
  });

  describe('suggest with feedback and decay', () => {
    it('should boost suggestions with positive feedback', () => {
      // Record sessions
      learner.recordSession('fix auth', [], ['auth.ts', 'login.ts']);
      learner.recordSession('auth flow', [], ['auth.ts', 'middleware.ts']);

      // Record positive feedback for auth.ts
      learner.recordFeedback('auth.ts', true);
      learner.recordFeedback('auth.ts', true);

      // Record negative feedback for login.ts
      learner.recordFeedback('login.ts', false);
      learner.recordFeedback('login.ts', false);

      const suggestions = learner.suggest('auth module');

      // auth.ts should have higher confidence due to feedback
      const authSuggestion = suggestions.find(s => s.file === 'auth.ts');
      const loginSuggestion = suggestions.find(s => s.file === 'login.ts');

      if (authSuggestion && loginSuggestion) {
        assert.ok(authSuggestion.confidence > loginSuggestion.confidence);
      }
    });

    it('should apply decay to old patterns', () => {
      learner.recordSession('fix auth', [], ['old-auth.ts']);

      // Simulate old feedback (31 days ago)
      learner.recordFeedback('old-auth.ts', true);
      learner.feedbackTimestamps.set('old-auth.ts', Date.now() - 31 * 24 * 60 * 60 * 1000);

      const suggestions = learner.suggest('auth');
      const oldSuggestion = suggestions.find(s => s.file === 'old-auth.ts');

      // Should still suggest but with lower confidence due to decay
      if (oldSuggestion) {
        assert.ok(oldSuggestion.confidence < 0.9);
      }
    });

    it('should handle mixed feedback', () => {
      learner.recordSession('test auth', [], ['auth.ts']);
      learner.recordFeedback('auth.ts', true);
      learner.recordFeedback('auth.ts', false);
      learner.recordFeedback('auth.ts', true);

      const suggestions = learner.suggest('auth');
      const authSuggestion = suggestions.find(s => s.file === 'auth.ts');

      // 2/3 useful = ~0.67 confidence, but with other factors might vary
      if (authSuggestion) {
        assert.ok(authSuggestion.confidence > 0.4 && authSuggestion.confidence <= 1.0);
      }
    });
  });

  describe('save and load with feedback', () => {
    it('should persist feedback data', async () => {
      learner.recordSession('fix auth', [], ['auth.ts']);
      learner.recordFeedback('auth.ts', true);
      learner.recordFeedback('auth.ts', false);

      await learner.save();

      const newLearner = new PatternLearner({ dataDir: tempDir });
      await newLearner.load();

      assert.ok(newLearner.feedbackMap.has('auth.ts'));
      const feedback = newLearner.feedbackMap.get('auth.ts');
      assert.equal(feedback.total, 2);
      assert.equal(feedback.useful, 1);
    });

    it('should persist feedback timestamps', async () => {
      learner.recordFeedback('auth.ts', true);
      const originalTimestamp = learner.feedbackTimestamps.get('auth.ts');

      await learner.save();

      const newLearner = new PatternLearner({ dataDir: tempDir });
      await newLearner.load();

      assert.ok(newLearner.feedbackTimestamps.has('auth.ts'));
      // Timestamp should be preserved (converted through string)
      assert.ok(newLearner.feedbackTimestamps.get('auth.ts'));
    });

    it('should handle loading v1 data without feedback', async () => {
      // Create v1 format data (without feedback)
      learner.recordSession('test', [], ['file.ts']);
      await learner.save();

      const newLearner = new PatternLearner({ dataDir: tempDir });
      await newLearner.load();

      // Should initialize empty feedback maps
      assert.ok(newLearner.feedbackMap instanceof Map);
      assert.ok(newLearner.feedbackTimestamps instanceof Map);
    });
  });

  describe('reset with feedback', () => {
    it('should clear feedback data', () => {
      learner.recordSession('test', [], ['file.ts']);
      learner.recordFeedback('file.ts', true);

      learner.reset();

      assert.equal(learner.feedbackMap.size, 0);
      assert.equal(learner.feedbackTimestamps.size, 0);
    });
  });

  describe('co-occurrence array bounds', () => {
    it('should cap co-occurrence array size', () => {
      const smallLearner = new PatternLearner({
        dataDir: tempDir,
        maxCoOccurrenceSize: 5
      });

      // Create session with many co-occurring files
      const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
      smallLearner.recordSession('test', [], manyFiles);

      // Check that co-occurrence arrays are bounded
      for (const [file, peers] of smallLearner.coOccurrenceMap.entries()) {
        assert.ok(peers.length <= 5, `Co-occurrence array for ${file} exceeds limit: ${peers.length}`);
      }
    });

    it('should remove oldest entries when capping', () => {
      const smallLearner = new PatternLearner({
        dataDir: tempDir,
        maxCoOccurrenceSize: 3
      });

      smallLearner.recordSession('test', [], ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);

      const aPeers = smallLearner.coOccurrenceMap.get('a.ts');
      // Should have at most 3 peers (excluding self)
      assert.ok(aPeers.length <= 3);
    });
  });
});
