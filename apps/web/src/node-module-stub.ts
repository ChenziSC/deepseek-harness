/**
 * 浏览器中的 `node:module` 替代实现。按既定 loader 路径不会调用
 * `createRequire`；如果此前提失效，则明确抛错。
 */

/** 会抛错的 node:module createRequire 替代实现；浏览器启动流程不会到达这里。 */
export const createRequire = (): never => {
  throw new Error('node:module is not available in the browser')
}

/** 为 vendored loader 仅类型导入的 LoadHookContext 提供擦除后的同名类型。 */
export type LoadHookContext = never
