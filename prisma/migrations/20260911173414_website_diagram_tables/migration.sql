-- CreateTable
CREATE TABLE "DiagramSnapshot" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "data" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "generatedById" TEXT,

    CONSTRAINT "DiagramSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagramNodeMeta" (
    "id" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "displayName" TEXT,
    "sectionLabel" TEXT,
    "statusOverride" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "DiagramNodeMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagramPlannedPage" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "plannedRoute" TEXT,
    "section" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "DiagramPlannedPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiagramNodeMeta_route_key" ON "DiagramNodeMeta"("route");
