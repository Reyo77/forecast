-- CreateTable
CREATE TABLE `Scenario` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `baseForecastRunId` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'RUNNING', 'READY', 'FAILED') NOT NULL DEFAULT 'DRAFT',
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Scenario_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScenarioLever` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `scenarioId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `target` JSON NOT NULL,
    `params` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ScenarioLever_scenarioId_idx`(`scenarioId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScenarioRun` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `scenarioId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `levers` JSON NOT NULL,
    `kpis` JSON NULL,
    `atRisk` JSON NULL,
    `totals` JSON NULL,
    `plannedOrders` JSON NULL,
    `error` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ScenarioRun_scenarioId_createdAt_idx`(`scenarioId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScenarioResult` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `scenarioRunId` VARCHAR(191) NOT NULL,
    `variant` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `weekStart` DATE NOT NULL,
    `demand` DECIMAL(14, 3) NOT NULL,
    `receipts` DECIMAL(14, 3) NOT NULL,
    `projectedOnHand` DECIMAL(14, 3) NOT NULL,
    `shortage` DECIMAL(14, 3) NOT NULL,

    INDEX `ScenarioResult_scenarioRunId_variant_productId_locationId_idx`(`scenarioRunId`, `variant`, `productId`, `locationId`),
    INDEX `ScenarioResult_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Scenario` ADD CONSTRAINT `Scenario_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Scenario` ADD CONSTRAINT `Scenario_baseForecastRunId_fkey` FOREIGN KEY (`baseForecastRunId`) REFERENCES `ForecastRun`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScenarioLever` ADD CONSTRAINT `ScenarioLever_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScenarioLever` ADD CONSTRAINT `ScenarioLever_scenarioId_fkey` FOREIGN KEY (`scenarioId`) REFERENCES `Scenario`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScenarioRun` ADD CONSTRAINT `ScenarioRun_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScenarioRun` ADD CONSTRAINT `ScenarioRun_scenarioId_fkey` FOREIGN KEY (`scenarioId`) REFERENCES `Scenario`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScenarioResult` ADD CONSTRAINT `ScenarioResult_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScenarioResult` ADD CONSTRAINT `ScenarioResult_scenarioRunId_fkey` FOREIGN KEY (`scenarioRunId`) REFERENCES `ScenarioRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
