-- Prisma migrate dev needs to create a shadow database.
GRANT ALL PRIVILEGES ON *.* TO 'supplycast'@'%';
FLUSH PRIVILEGES;
