-- Public, rebuildable product/source discovery cache, independent of user grid parameters.
CREATE TABLE research_products (
  code VARCHAR(32) PRIMARY KEY,
  product JSONB NOT NULL,
  evidence TEXT NOT NULL,
  evidence_url TEXT,
  checked_at TIMESTAMP(3) NOT NULL,
  retry_at TIMESTAMP(3)
);

ALTER TABLE market_instruments DROP CONSTRAINT market_instrument_kind;
ALTER TABLE market_instruments ADD CONSTRAINT market_instrument_kind CHECK (kind IN ('stock','etf','lof','reit'));
