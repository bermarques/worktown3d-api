-- Baseline: the tables the API created on startup before it used Prisma.
-- "IF NOT EXISTS" lets `prisma migrate deploy` adopt databases that already have them, with no manual baselining.

-- CreateTable
CREATE TABLE IF NOT EXISTS "accounts" (
    "user_id" TEXT NOT NULL,
    "login" TEXT,
    "customer_id" TEXT,
    "subscription_id" TEXT,
    "status" TEXT,
    "renews_at" BIGINT,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "workspaces" (
    "org_key" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "owner_login" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("org_key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "stripe_events" (
    "id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "org_settings" (
    "org_key" TEXT NOT NULL,
    "floors" JSONB,
    "links" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("org_key")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "accounts_customer_idx" ON "accounts"("customer_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspaces_owner_idx" ON "workspaces"("owner_id");
