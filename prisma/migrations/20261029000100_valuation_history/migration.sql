-- Public research histories are independent of user grids and short-lived alert caches.
CREATE TABLE research_series (
  key VARCHAR(160) PRIMARY KEY,
  definition JSONB NOT NULL,
  cursor VARCHAR(10),
  complete BOOLEAN NOT NULL DEFAULT false,
  checked_at TIMESTAMP(3),
  last_attempt_at TIMESTAMP(3),
  retry_at TIMESTAMP(3),
  lease_token UUID,
  lease_until TIMESTAMP(3),
  failures INTEGER NOT NULL DEFAULT 0,
  error VARCHAR(240),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE research_observations (
  series_key VARCHAR(160) NOT NULL REFERENCES research_series(key) ON DELETE RESTRICT ON UPDATE CASCADE,
  date VARCHAR(10) NOT NULL,
  revision INTEGER NOT NULL,
  value DECIMAL(30,10),
  quality VARCHAR(16) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  raw JSONB NOT NULL,
  first_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_published_at TIMESTAMP(3),
  PRIMARY KEY(series_key,date,revision)
);
