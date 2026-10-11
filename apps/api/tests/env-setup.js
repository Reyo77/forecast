// Runs before every test file. Tests always use the test database, never the dev one.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
