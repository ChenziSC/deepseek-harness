/**
 * Web 应用入口：对 shell 库做一层轻量启动包装。loader 持有、模块表播种、
 * AppRoot 门控和插件装配全部位于 @deepseek-ai/dsh-client-web；本文件只负责
 * 查找挂载点。
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
void new AppWebEntry(el).run()
