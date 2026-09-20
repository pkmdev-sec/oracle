# ORACLE Architecture

## System Overview

ORACLE operates as a predictive pipeline that intercepts user prompts, predicts which files will be needed, and injects relevant context before the AI processes the request.

## Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ORACLE Prediction Pipeline                       │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐  │
│  │  Prompt   │───▶│  File    │───▶│ Context  │───▶│  Preloader   │  │
│  │  Input    │    │Predictor │    │  Ranker  │    │  (LRU Cache) │  │
│  └──────────┘    └────┬─────┘    └────┬─────┘    └──────┬───────┘  │
│                       │               │                  │          │
│                       ▼               ▲                  ▼          │
│                  ┌─────────┐          │           ┌────────────┐   │
│                  │ Pattern │──────────┘           │  Context   │   │
│                  │ Learner │                      │  Injection │   │
│                  └─────────┘                      └────────────┘   │
│                       │                                             │
│                       ▼                                             │
│                  ┌─────────┐                                        │
│                  │  Disk   │                                        │
│                  │Patterns │                                        │
│                  └─────────┘                                        │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Responsibilities

### FilePredictor (`file-predictor.mjs`)

**Purpose**: Score project files against prompt signals.

**Inputs**:
- User prompt text
- Session prompt history (last 3 prompts)
- Co-occurrence map from Pattern Learner

**Processing**:
1. Scans project directory tree (cached, 30s TTL)
2. Extracts keywords from prompt (stop-word filtered)
3. Extracts explicit file path mentions
4. Scores each file using:
   - Filename keyword match (+10)
   - Path segment match (+5)
   - Keyword pattern group match (+3)
   - Co-occurrence bonus (+8)
   - Explicit mention bonus (+50)
   - History keyword bonus (×0.3 weight)

**Output**: Sorted list of `{file, score}` capped at `maxResults`

### ContextRanker (`context-ranker.mjs`)

**Purpose**: Multi-signal re-ranking of predicted files.

**Signals** (configurable weights):
| Signal | Default Weight | Description |
|--------|---------------|-------------|
| Predictor Score | 0.35 | Normalized prediction confidence |
| Recency | 0.25 | Time since last access (1-hour window) |
| Frequency | 0.20 | Access count normalized to max |
| Proximity | 0.10 | Shared directory depth with active file |
| File Type | 0.10 | Code=1.0, Config=0.6, Assets=0.3 |

**Token Budget**: Selects top items within a configurable token budget (default 50K tokens).

### Preloader (`preloader.mjs`)

**Purpose**: Cache file contents for instant injection.

**Components**:
- **LRU Cache**: In-memory, configurable max entries (default 100)
- **File Loading**: Async parallel fetch with size limits (100KB default)
- **Cache Freshness**: 60-second staleness window
- **Disk Persistence**: Cache metadata saved for analytics

**Stats Tracked**: hits, misses, preloads, evictions, errors, hit rate

### PatternLearner (`pattern-learner.mjs`)

**Purpose**: Learn and improve predictions over time.

**Data Structures**:
- **Session Records**: prompt + predicted files + actually used files + accuracy/recall
- **Keyword→File Map**: weighted associations learned from actual usage
- **Co-occurrence Map**: files that appear together in sessions

**Learning Loop**:
1. Record session feedback (predicted vs. actual files)
2. Update keyword→file associations
3. Build co-occurrence graph
4. Export updated co-occurrence map to FilePredictor
5. Apply exponential decay (0.95) to weight recent sessions higher

**Persistence**: JSON at `{dataDir}/patterns.json`

## Hook Integration

### oracle-preload.py (UserPromptSubmit)

The Python hook acts as a standalone prediction engine that:

1. Reads hook input (prompt + cwd) from stdin
2. Scans the project directory
3. Extracts keywords and scores files
4. Merges with learned patterns from disk
5. Builds context string from file contents
6. Outputs Claude Code `UserPromptSubmit` JSON with `additionalContext`

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[ORACLE] Predicted context ..."
  }
}
```
