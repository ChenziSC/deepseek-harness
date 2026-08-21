/** 统一 `@` 数据源的 `reference` namespace 词典。 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件拥有的词典 namespace。 */
export const NS = 'reference'

/** 简体中文词典，也是键集合的事实来源。 */
export const zh = {
  'section.files': '文件与文件夹',
  'section.sessions': 'Session 对话',
  'candidate.file': '文件',
  'candidate.folder': '文件夹',
  'candidate.session': 'Session',
  'candidate.noCwd': '（无工作目录）',
} satisfies Record<string, string>

/** Reference namespace 的键 union。 */
export type ReferenceKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 统一 `@` Reference 菜单的文案。 */
    reference: ReferenceKey
  }
}

/** 英语词典；对照中文键集合检查完整性。 */
export const en = {
  'section.files': 'Files & folders',
  'section.sessions': 'Session conversations',
  'candidate.file': 'File',
  'candidate.folder': 'Folder',
  'candidate.session': 'Session',
  'candidate.noCwd': '(no cwd)',
} satisfies Record<ReferenceKey, string>
