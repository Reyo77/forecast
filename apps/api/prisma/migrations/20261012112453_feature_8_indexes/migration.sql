-- CreateIndex
CREATE INDEX `ForecastAccuracy_runId_wape_idx` ON `ForecastAccuracy`(`runId`, `wape`);

-- CreateIndex
CREATE INDEX `OpenOrder_tenantId_productId_idx` ON `OpenOrder`(`tenantId`, `productId`);

-- CreateIndex
CREATE INDEX `Product_tenantId_isActive_idx` ON `Product`(`tenantId`, `isActive`);

-- CreateIndex
CREATE INDEX `SalesRecord_tenantId_productId_date_idx` ON `SalesRecord`(`tenantId`, `productId`, `date`);

-- CreateIndex
CREATE INDEX `SalesRecord_tenantId_locationId_idx` ON `SalesRecord`(`tenantId`, `locationId`);
