-- CreateTable
CREATE TABLE `ForecastRun` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `horizonWeeks` INTEGER NOT NULL,
    `method` VARCHAR(191) NOT NULL,
    `filters` JSON NOT NULL,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `seriesTotal` INTEGER NOT NULL DEFAULT 0,
    `seriesDone` INTEGER NOT NULL DEFAULT 0,
    `seriesFailed` INTEGER NOT NULL DEFAULT 0,
    `failures` JSON NULL,
    `asOfWeek` DATE NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `error` TEXT NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ForecastRun_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ForecastResult` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `weekStart` DATE NOT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `lower` DECIMAL(14, 3) NOT NULL,
    `upper` DECIMAL(14, 3) NOT NULL,
    `modelUsed` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ForecastResult_runId_productId_locationId_idx`(`runId`, `productId`, `locationId`),
    INDEX `ForecastResult_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ForecastAccuracy` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `modelUsed` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `holdout` INTEGER NOT NULL DEFAULT 0,
    `mape` DOUBLE NULL,
    `wape` DOUBLE NULL,
    `bias` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ForecastAccuracy_tenantId_idx`(`tenantId`),
    UNIQUE INDEX `ForecastAccuracy_runId_productId_locationId_key`(`runId`, `productId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ForecastOverride` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `weekStart` DATE NOT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `reason` TEXT NOT NULL,
    `userId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ForecastOverride_tenantId_weekStart_idx`(`tenantId`, `weekStart`),
    UNIQUE INDEX `ForecastOverride_tenantId_productId_locationId_weekStart_key`(`tenantId`, `productId`, `locationId`, `weekStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ForecastRun` ADD CONSTRAINT `ForecastRun_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastResult` ADD CONSTRAINT `ForecastResult_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastResult` ADD CONSTRAINT `ForecastResult_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ForecastRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastResult` ADD CONSTRAINT `ForecastResult_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastResult` ADD CONSTRAINT `ForecastResult_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastAccuracy` ADD CONSTRAINT `ForecastAccuracy_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastAccuracy` ADD CONSTRAINT `ForecastAccuracy_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ForecastRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastAccuracy` ADD CONSTRAINT `ForecastAccuracy_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastAccuracy` ADD CONSTRAINT `ForecastAccuracy_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastOverride` ADD CONSTRAINT `ForecastOverride_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastOverride` ADD CONSTRAINT `ForecastOverride_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ForecastOverride` ADD CONSTRAINT `ForecastOverride_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
