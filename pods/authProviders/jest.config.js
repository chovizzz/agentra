// Workspace packages are consumed from source: none of them are built when a single
// package's tests run, and their `main` points at a `lib/` that does not exist yet.
const fromSource = (pkg, path) => [`^@hcengineering/${pkg}$`, `<rootDir>/../../${path}/src/index.ts`]

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  roots: ['./src'],
  coverageReporters: ['text-summary', 'html'],
  moduleNameMapper: Object.fromEntries([
    fromSource('core', 'foundations/core/packages/core'),
    fromSource('platform', 'foundations/core/packages/platform'),
    fromSource('analytics', 'foundations/core/packages/analytics'),
    fromSource('measurements', 'foundations/core/packages/measurements'),
    fromSource('account', 'server/account'),
    fromSource('account-client', 'foundations/core/packages/account-client')
  ])
}
