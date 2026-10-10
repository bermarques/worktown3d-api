-- CreateTable
CREATE TABLE "profiles" (
    "user_id" TEXT NOT NULL,
    "login_key" TEXT,
    "character" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_login_key_key" ON "profiles"("login_key");

