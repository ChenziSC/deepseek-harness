/**
 * use-sync-external-store 1.2.0 的本地类型。该包没有随附类型，离线环境也无法取得
 * DefinitelyTyped 包。这里只镜像 shim 的 with-selector 构建，因为本包只消费该入口。
 */
declare module 'use-sync-external-store/shim/with-selector.js' {
  export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: undefined | null | (() => Snapshot),
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: (a: Selection, b: Selection) => boolean,
  ): Selection
}
