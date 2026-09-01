CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "user_role" AS ENUM ('member', 'admin');
CREATE TYPE "user_status" AS ENUM ('active', 'disabled');
CREATE TYPE "algorithm_version" AS ENUM ('android-v2.1.0');

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "username" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'member',
    "status" "user_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" UUID NOT NULL,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_digest" CHAR(64) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "grid_trades" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "product_code" VARCHAR(64) NOT NULL,
    "product_name" VARCHAR(120),
    "max_price" DECIMAL(30,10) NOT NULL,
    "min_trade_quantity" DECIMAL(30,10) NOT NULL,
    "gear_amplitude" DECIMAL(30,10) NOT NULL,
    "per_share" DECIMAL(30,10) NOT NULL,
    "keep_share" INTEGER NOT NULL,
    "increase_amplitude" INTEGER NOT NULL,
    "medium_amplitude" INTEGER,
    "big_amplitude" INTEGER,
    "max_amplitude" INTEGER NOT NULL,
    "is_short" BOOLEAN NOT NULL,
    "category" VARCHAR(120),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "algorithm_version" "algorithm_version" NOT NULL DEFAULT 'android-v2.1.0',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grid_trades_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_previews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "token_digest" CHAR(64) NOT NULL,
    "file_digest" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_previews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");
CREATE UNIQUE INDEX "accounts_issuer_account_id_key" ON "accounts"("issuer", "account_id");
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");
CREATE UNIQUE INDEX "invitations_token_digest_key" ON "invitations"("token_digest");
CREATE INDEX "invitations_expires_at_idx" ON "invitations"("expires_at");
CREATE INDEX "grid_trades_owner_id_sort_order_created_at_id_idx" ON "grid_trades"("owner_id", "sort_order", "created_at", "id");
CREATE INDEX "grid_trades_owner_id_product_code_idx" ON "grid_trades"("owner_id", "product_code");
CREATE UNIQUE INDEX "grid_trades_owner_id_product_code_key" ON "grid_trades"("owner_id", "product_code");
CREATE UNIQUE INDEX "import_previews_token_digest_key" ON "import_previews"("token_digest");
CREATE INDEX "import_previews_owner_id_expires_at_idx" ON "import_previews"("owner_id", "expires_at");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_used_by_id_fkey" FOREIGN KEY ("used_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grid_trades" ADD CONSTRAINT "grid_trades_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_previews" ADD CONSTRAINT "import_previews_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "grid_trades" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grid_trades" FORCE ROW LEVEL SECURITY;
CREATE POLICY "grid_trade_owner_policy" ON "grid_trades"
  USING ("owner_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE "import_previews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_previews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_preview_owner_policy" ON "import_previews"
  USING ("owner_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("owner_id" = current_setting('app.current_user_id', true)::uuid);
