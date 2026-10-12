-- CreateTable
CREATE TABLE `AiInsight` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `refKey` VARCHAR(191) NOT NULL,
    `promptVersion` VARCHAR(191) NOT NULL,
    `result` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AiInsight_tenantId_kind_refKey_key`(`tenantId`, `kind`, `refKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AiInsight` ADD CONSTRAINT `AiInsight_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
