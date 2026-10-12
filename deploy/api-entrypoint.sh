#!/bin/sh
# Apply pending migrations, make sure the Super Admin exists, then start the API.
set -e
cd /app/apps/api
npx prisma migrate deploy
node dist/seed.js
exec node dist/server.js
