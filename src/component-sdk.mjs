/**
 * Component SDK for local components (local-components/<id>/index.mjs).
 *
 * Built to lib/component-sdk.mjs. Local components run in the forked loader worker
 * (lib/local-loader-worker.mjs), which maps these specifiers onto this file:
 *   - `dsh-work-components/sdk` (preferred), and
 *   - the legacy repo-relative imports `…/src/components/shared.mjs`, `…/src/tools.mjs`,
 *     `…/src/connect-lib.mjs` when the file is not there (the published package has no src/).
 * Everything here is the same helper surface a bundled component gets from those three modules.
 */
export * from './components/shared.mjs'
export * from './tools.mjs'
export * from './connect-lib.mjs'
