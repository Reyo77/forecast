-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `externalRef` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Invoice_externalRef_key` ON `Invoice`(`externalRef`);
