# ORACLE Diagrams

## Data Flow Diagram

```
                         USER PROMPT
                              │
                              ▼
                    ┌───────────────────┐
                    │  oracle-preload   │
                    │    (Python Hook)  │
                    │  UserPromptSubmit │
                    └────────┬──────────┘
                             │
                    ┌────────▼──────────┐
                    │  Extract Keywords │
                    │  Extract Paths    │
                    └────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌──────────────┐
     │  Keyword   │  │   Path     │  │  Learned     │
     │  Matching  │  │  Matching  │  │  Patterns    │
     └─────┬──────┘  └─────┬──────┘  └──────┬───────┘
           │               │                │
           └───────┬───────┘                │
                   │                        │
                   ▼                        ▼
          ┌──────────────┐        ┌──────────────┐
          │  Prediction  │◀───────│  Learned     │
          │   Scoring    │        │  Suggestions │
          └──────┬───────┘        └──────────────┘
                 │
                 ▼
        ┌────────────────┐
        │ Context Ranker │
        │ ┌────────────┐ │
        │ │ Recency    │ │
        │ │ Frequency  │ │
        │ │ Proximity  │ │
        │ │ File Type  │ │
        │ │ Pred Score │ │
        │ └────────────┘ │
        └───────┬────────┘
                │
                ▼
       ┌────────────────┐
       │   Preloader    │
       │  ┌──────────┐  │
       │  │ LRU Cache│  │
       │  └──────────┘  │
       └───────┬────────┘
               │
               ▼
    ┌─────────────────────┐
    │  Context Injection  │
    │  (prefix to prompt) │
    └─────────────────────┘
```

## Learning Feedback Loop

```
    Session Start
         │
         ▼
    ┌──────────┐     ┌──────────────────┐
    │  Predict │────▶│ Predicted Files   │
    │  Files   │     │ [a.ts, b.ts, ...]│
    └──────────┘     └────────┬─────────┘
                              │
                     ┌────────▼────────┐
                     │  User Session   │
                     │  (works on code)│
                     └────────┬────────┘
                              │
                     ┌────────▼─────────┐
                     │ Actually Used    │
                     │ [a.ts, c.ts, ...]│
                     └────────┬─────────┘
                              │
                     ┌────────▼────────┐
                     │ Record Feedback │
                     │ accuracy/recall │
                     └────────┬────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │   Keyword →  │ │   File Co-   │ │   Session    │
    │  File Map    │ │  Occurrence  │ │   Records    │
    │   Update     │ │    Update    │ │   (decay)    │
    └──────────────┘ └──────────────┘ └──────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              │
                     ┌────────▼────────┐
                     │  Save to Disk   │
                     │ patterns.json   │
                     └────────┬────────┘
                              │
                     ┌────────▼────────┐
                     │ Next Prediction │
                     │ Uses Learned    │
                     │ Patterns        │
                     └─────────────────┘
```

## Scoring Breakdown

```
    File Score Computation
    ══════════════════════

    ┌─────────────────────────────────────────────────────┐
    │                                                     │
    │  Predictor Score (35%)  ████████████████░░░░░░░░░░  │
    │  ├─ Filename match      +10                         │
    │  ├─ Path match          +5                          │
    │  ├─ Pattern group       +3                          │
    │  ├─ Co-occurrence       +8                          │
    │  └─ Explicit mention    +50                         │
    │                                                     │
    │  Recency (25%)          ██████████████░░░░░░░░░░░░  │
    │  └─ 1-hour decay window                             │
    │                                                     │
    │  Frequency (20%)        ██████████░░░░░░░░░░░░░░░░  │
    │  └─ Normalized to max frequency                     │
    │                                                     │
    │  Proximity (10%)        ██████░░░░░░░░░░░░░░░░░░░░  │
    │  └─ Shared directory depth                          │
    │                                                     │
    │  File Type (10%)        ██████░░░░░░░░░░░░░░░░░░░░  │
    │  └─ Code=1.0 Config=0.6 Asset=0.3                   │
    │                                                     │
    │  ═══════════════════════════════════════════         │
    │  Final Score = Σ(signal × weight)                   │
    │                                                     │
    └─────────────────────────────────────────────────────┘
```

## Cache Architecture

```
    ┌─────────────────────────────────────────┐
    │            LRU Cache (in-memory)        │
    │                                         │
    │  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐   │
    │  │ MRU │──│     │──│     │──│ LRU │   │
    │  │file1│  │file2│  │file3│  │file4│   │
    │  └─────┘  └─────┘  └─────┘  └─────┘   │
    │     ▲                          │        │
    │     │ access                   │ evict  │
    │     │ moves to front           ▼        │
    │                           ┌─────────┐   │
    │                           │ removed │   │
    │                           └─────────┘   │
    ├─────────────────────────────────────────┤
    │  Stats: hits | misses | preloads        │
    │  Hit Rate: hits / (hits + misses)       │
    ├─────────────────────────────────────────┤
    │  Disk: .oracle/cache-meta.json          │
    │  (metadata only, not file contents)     │
    └─────────────────────────────────────────┘
```
