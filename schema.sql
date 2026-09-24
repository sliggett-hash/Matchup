-- Match-Up Leaderboard V5
-- Cloudflare D1 schema

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  elapsed_ms INTEGER,
  matches INTEGER NOT NULL DEFAULT 0,
  mistakes INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  raw_score INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  accuracy_multiplier REAL,
  speed_multiplier REAL,
  score INTEGER,
  leaderboard_eligible INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  submitted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  raw_score INTEGER NOT NULL,
  mistakes INTEGER NOT NULL,
  best_streak INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_scores_rank
ON scores(score DESC, elapsed_ms ASC);

CREATE INDEX IF NOT EXISTS idx_scores_expiry
ON scores(expires_at);

CREATE TABLE IF NOT EXISTS daily_champions (
  day_key TEXT PRIMARY KEY,
  score_id INTEGER NOT NULL,
  FOREIGN KEY (score_id) REFERENCES scores(id)
);

CREATE TABLE IF NOT EXISTS all_time_record (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  raw_score INTEGER NOT NULL,
  mistakes INTEGER NOT NULL,
  best_streak INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  achieved_at INTEGER NOT NULL
);
