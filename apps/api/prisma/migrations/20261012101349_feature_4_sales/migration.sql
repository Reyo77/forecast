-- CreateTable
CREATE TABLE `SalesImport` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `status` ENUM('PREVIEW', 'QUEUED', 'PROCESSING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PREVIEW',
    `rowCount` INTEGER NOT NULL DEFAULT 0,
    `validRowCount` INTEGER NOT NULL DEFAULT 0,
    `errorCount` INTEGER NOT NULL DEFAULT 0,
    `errors` JSON NULL,
    `previewRows` JSON NULL,
    `importedRows` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `rawCsv` LONGTEXT NULL,
    `createdBy` VARCHAR(191) NULL,
    `committedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SalesImport_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SalesRecord` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `revenueCents` DECIMAL(18, 0) NOT NULL DEFAULT 0,
    `importId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SalesRecord_tenantId_date_idx`(`tenantId`, `date`),
    UNIQUE INDEX `SalesRecord_tenantId_productId_locationId_date_key`(`tenantId`, `productId`, `locationId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SalesImport` ADD CONSTRAINT `SalesImport_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SalesRecord` ADD CONSTRAINT `SalesRecord_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SalesRecord` ADD CONSTRAINT `SalesRecord_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SalesRecord` ADD CONSTRAINT `SalesRecord_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SalesRecord` ADD CONSTRAINT `SalesRecord_importId_fkey` FOREIGN KEY (`importId`) REFERENCES `SalesImport`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
