/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 30000,
  maxWorkers: 1, // all suites share one test database
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  globalSetup: '<rootDir>/tests/global-setup.js',
  setupFiles: ['<rootDir>/tests/env-setup.js'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/db/client.ts'],
  coverageThreshold: { global: { lines: 80 } },
};
