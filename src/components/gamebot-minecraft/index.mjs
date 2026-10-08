/** 游戏组件：gamebot-minecraft（共享 GameBot body，MCP 仅暴露 minecraft）。实现见 ../gamebot/index.mjs。 */
import { createGameModule } from '../gamebot/index.mjs'

const mod = createGameModule('minecraft')

export const id = mod.id
export const app = mod.app
export const meta = mod.meta
export const component = mod.component
export const probe = mod.probe

export default component
