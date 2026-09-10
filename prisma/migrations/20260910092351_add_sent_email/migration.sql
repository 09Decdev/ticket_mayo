-- CreateTable
CREATE TABLE "SentEmail" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SentEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SentEmail_jobId_emailHash_key" ON "SentEmail"("jobId", "emailHash");
