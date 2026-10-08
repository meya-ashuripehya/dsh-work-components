/**
 * 工作组件入口：注册表 + 共享解析 + 运行时管理。
 * @see ../../docs/component-module.md
 */
export {
  SOURCE_TEXT, resolveUv, resolveUvx, findUv, findUvx, resolveNode, resolveNpm,
  chromeArgs, godotArgs, FIGMA_OFFICIAL_URL, IS_WIN, NOT_INSTALLED, OFF,
  managedEntry, managedNpmEntry, stdio, http, npmLaunch, installNpmTool,
} from './shared.mjs'
export { pluginRoot } from './shared.mjs'
export {
  COMPONENTS, MODULES, APPS, PROBES, componentById,
  CONTRIBUTE_REPO, CONTRIBUTE_COMPARE_URL, contributeInfo, discoverLocalComponents, localComponentsDir,
  disposeLocalComponents,
} from './registry.mjs'
export { createComponentManager } from './manager.mjs'
