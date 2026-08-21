/**
 * 官方浏览器 Brand 插件的 Node half。空 apply 为 Loader 提供 Host 侧行，Browser half
 * 则通过 `exports["./client"]` 发布。
 */

/** Host 插件主体；本包只贡献浏览器展示。 */
export function apply(): void {}
