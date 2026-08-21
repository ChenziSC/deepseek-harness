/**
 * 文件/Session Reference 插件的 Node half。作为纯 UI 插件，空 apply 用于让插件出现在
 * Host cordis.yml / Loader 中；Browser half 通过 exports["./client"] 发布，并由
 * package.json 的 `dsh.client` 声明发现。
 */

/** Host 插件主体；本数据源插件没有 Host 侧行为。 */
export function apply(): void {}
