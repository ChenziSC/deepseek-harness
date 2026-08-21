/**
 * 平台单例模块表。shell 只会把这些实体共享到冻结模块表；通过 fetch 获得的
 * bundle 使用 loader 的 require，严格针对这组实体解析 externals。键来自平台
 * 常量模块（{@link ./platform.ts}，同时也是 tsdown 客户端 externals 的唯一
 * 真源）；值保持为 shell 静态导入，确保所有 bundle 看到同一个实例。
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformModule } from './platform.ts'

/**
 * 创建启动时交给模块 loader 的静态表。
 * @returns 模块说明符到导出实体的映射；每个平台模块对应一项。
 */
export function getStaticModules(): Record<string, unknown> {
  // satisfies 固定了投影约定：如果 PLATFORM_MODULES 新增模块但这里没有对应
  // 静态导入（或反之），编译会直接失败，而不会拖到运行时才出现 require 缺失。
  return {
    'react': React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
    '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
  } satisfies Record<PlatformModule, unknown>
}
