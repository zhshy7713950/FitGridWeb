-- CreateTable
CREATE TABLE "market_instruments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "market" VARCHAR(2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "kind" VARCHAR(5) NOT NULL,
    "tencent" VARCHAR(32),
    "yahoo" VARCHAR(32),
    "eastmoney" VARCHAR(40),
    "quote" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_minutes" (
    "instrument_id" UUID NOT NULL,
    "provider" VARCHAR(12) NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(30,10) NOT NULL,
    "high" DECIMAL(30,10) NOT NULL,
    "low" DECIMAL(30,10) NOT NULL,
    "close" DECIMAL(30,10) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_minutes_pkey" PRIMARY KEY ("instrument_id","provider","start")
);

-- CreateTable
CREATE TABLE "market_daily_bases" (
    "instrument_id" UUID NOT NULL,
    "provider" VARCHAR(12) NOT NULL,
    "session_date" VARCHAR(10) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "market_daily_bases_pkey" PRIMARY KEY ("instrument_id","provider","session_date")
);

-- CreateTable
CREATE TABLE "market_scans" (
    "id" VARCHAR(80) NOT NULL,
    "market" VARCHAR(2) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "market_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "condition" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "armed" BOOLEAN NOT NULL DEFAULT true,
    "cursor" TIMESTAMP(3),
    "active_from" TIMESTAMP(3) NOT NULL,
    "continuity_degraded" BOOLEAN NOT NULL DEFAULT false,
    "last_error" VARCHAR(240),
    "last_success" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_alert_channels" (
    "owner_id" UUID NOT NULL,
    "key_cipher" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tested_at" TIMESTAMP(3),
    "last_error" VARCHAR(240),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_alert_channels_pkey" PRIMARY KEY ("owner_id")
);

-- CreateTable
CREATE TABLE "price_alert_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "minute_start" TIMESTAMP(3) NOT NULL,
    "minute_end" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(30,10) NOT NULL,
    "threshold" DECIMAL(30,10) NOT NULL,
    "ma" DECIMAL(30,10),
    "provider" VARCHAR(12) NOT NULL,
    "evidence" JSONB NOT NULL,
    "outbox_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_alert_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "channel_version" INTEGER NOT NULL,
    "batch_end" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "lease_until" TIMESTAMP(3),
    "last_error" VARCHAR(240),
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_alert_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_instruments_code_key" ON "market_instruments"("code");

-- CreateIndex
CREATE INDEX "market_minutes_start_idx" ON "market_minutes"("start");

-- CreateIndex
CREATE INDEX "market_scans_created_at_idx" ON "market_scans"("created_at");

-- CreateIndex
CREATE INDEX "price_alerts_owner_id_enabled_deleted_at_idx" ON "price_alerts"("owner_id", "enabled", "deleted_at");

-- CreateIndex
CREATE INDEX "price_alert_events_owner_id_created_at_idx" ON "price_alert_events"("owner_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "price_alert_events_rule_id_version_minute_start_key" ON "price_alert_events"("rule_id", "version", "minute_start");

-- CreateIndex
CREATE INDEX "price_alert_outbox_owner_id_status_next_attempt_at_idx" ON "price_alert_outbox"("owner_id", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "price_alert_outbox_rule_id_version_batch_end_key" ON "price_alert_outbox"("rule_id", "version", "batch_end");

-- AddForeignKey
ALTER TABLE "market_minutes" ADD CONSTRAINT "market_minutes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "market_instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_daily_bases" ADD CONSTRAINT "market_daily_bases_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "market_instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "market_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_alert_channels" ADD CONSTRAINT "price_alert_channels_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_alert_events" ADD CONSTRAINT "price_alert_events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_alert_events" ADD CONSTRAINT "price_alert_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "price_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_alert_outbox" ADD CONSTRAINT "price_alert_outbox_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_alert_outbox" ADD CONSTRAINT "price_alert_outbox_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "price_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Private alert data uses the same transaction-local owner scope as grid data.
ALTER TABLE "price_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_alert_owner_policy" ON "price_alerts"
  USING ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER TABLE "price_alert_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_alert_channels" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_alert_channel_owner_policy" ON "price_alert_channels"
  USING ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER TABLE "price_alert_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_alert_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_alert_event_owner_policy" ON "price_alert_events"
  USING ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER TABLE "price_alert_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_alert_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_alert_outbox_owner_policy" ON "price_alert_outbox"
  USING ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER TABLE "market_instruments" ADD CONSTRAINT "market_instrument_supported" CHECK
  ((market = 'cn' AND currency = 'CNY') OR (market = 'us' AND currency = 'USD'));
ALTER TABLE "market_instruments" ADD CONSTRAINT "market_instrument_kind" CHECK (kind IN ('stock', 'etf'));
ALTER TABLE "market_minutes" ADD CONSTRAINT "market_minute_ohlc" CHECK
  (open > 0 AND close > 0 AND low > 0 AND high >= GREATEST(open, close, low) AND low <= LEAST(open, close, high) AND "end" = start + INTERVAL '1 minute');
ALTER TABLE "price_alerts" ADD COLUMN "last_evaluation" JSONB;
