import type {
  SettingsSchemaService,
} from '@deepseek-ai/dsh-client-ui-settings/client'

/** 暴露给 Models 存储和展示组件的纯 schema 回调。 */
export type SettingsSchemaOperations = Pick<
  SettingsSchemaService,
  'rehydrate' | 'validate' | 'nodeAtPath' | 'getPath' | 'hasPath' | 'setPath' | 'deletePath'
>

/**
 * 把 Cordis 服务身份隐藏在已绑定 schema 回调之后。
 * @param service - apply 上下文中可用、由 settings 拥有的 schema 服务。
 * @returns 无法向 React 组件暴露服务上下文的回调。
 */
export function createSettingsSchemaOperations(service: SettingsSchemaService): SettingsSchemaOperations {
  return {
    rehydrate: serialized => service.rehydrate(serialized),
    validate: (schema, draft) => service.validate(schema, draft),
    nodeAtPath: (root, path) => service.nodeAtPath(root, path),
    getPath: (value, path) => service.getPath(value, path),
    hasPath: (value, path) => service.hasPath(value, path),
    setPath: (root, path, value) => service.setPath(root, path, value),
    deletePath: (root, path) => service.deletePath(root, path),
  }
}
