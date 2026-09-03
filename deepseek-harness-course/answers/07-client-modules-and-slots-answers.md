# 第 7 课参考答案：动态 Client Module 与 Slot 页面组合

[返回第 7 课](../07-client-modules-and-slots.md)

## L7-C1

Module Manifest 解决本次部署有哪些浏览器 Bundle、它们的外部依赖以及加载顺序；Client Plugin 在代码到达后把服务、事件和 UI 贡献注册到浏览器 Cordis 生命周期；Slot 定义页面骨架允许哪些组件以 single/list/chain/keyed 关系进入。把三者合并会让网络装载、运行时依赖和页面布局互相耦合。Pi Extension 与 Claude Command 更接近产品内注册入口，DSH 额外解决了 Host 部署差异如何动态决定浏览器代码与页面组合。

## L7-Q1

> 为什么 Client Module 的同步 `require()` 不能等待尚未下载的依赖？Host 因此必须承担什么责任？

### 参考答案

同步 `require()` 只能返回已经定义和执行完成的模块，不能暂停当前工厂等待未来网络下载，否则它的调用契约就变成异步并引入重入问题。Host 必须验证 Module Manifest 的依赖图，先安排并加载 Provider Bundle，再激活依赖它的 Consumer；缺失、循环或顺序错误应在加载阶段明确失败。客户端下载结束后，`require()` 才只是确定性的同步读取。

## L7-Q2

> 后端 Cordis `inject` 和浏览器 Module Manifest 的依赖排序有什么相同点和不同点？

### 参考答案

两者都把依赖显式化，目标都是防止 Consumer 在 Provider 不可用时运行。区别在于阶段和对象：Module Manifest 由 Host 在网络加载阶段安排 JavaScript Bundle 的外部依赖顺序；Cordis `inject` 在模块代码已经可用后，根据服务是否出现在当前 Context/Scope 决定插件激活和失活。前者解决代码可装载性，后者解决运行时服务生命周期。

## L7-Q3

> 为什么附件、Plan、模型选择不应该全部直接写进 `ui-conversation` 的中央组件？

### 参考答案

中央组件若直接导入每种功能，会同时拥有附件状态、Plan 规则、模型配置和未来所有交互，形成不断扩大的条件分支，也无法按部署组合功能。`ui-conversation` 应只定义页面骨架和命名 Slot；各功能插件注册自己的组件、领域服务和 disposer。这样缺少某个插件时页面仍成立，新功能无需修改中央组件，Scope、排序和卸载也由 Slot Runtime 统一处理。

## L7-Q4

> `single`、`list`、`chain`、`keyed` 四类 Slot 分别适合表达什么关系？

### 参考答案

`single` 表达一个位置最多有一个实现，例如唯一主视图；`list` 表达多个贡献按顺序共同出现，例如工具栏项或 Tab；`chain` 表达多个候选按 Selector/Priority 接管同一区域，未命中时落到 Fallback，例如 Question 或 Approval 接管 Composer；`keyed` 按业务 Key 选择 Renderer，例如不同 Conversation Node 类型由各自插件渲染。类型选择描述的是组合关系，不只是容器样式。

## L7-Q5

> 插件卸载时如果只卸载业务服务、不撤销 Slot 和 Renderer，会产生哪些错误？

### 参考答案

页面仍可能展示已失效的 Tab、按钮或 Composer 接管项，并在点击后调用已经卸载的服务。旧 keyed Renderer 可能继续处理新事件，HMR 后还会与新版重复；Locale、Selector 和排序注册也可能累积。UI 表现将与后端实际能力不一致，甚至暴露本应随 Scope 撤销的操作。因此 Module、Slot、Renderer 和字典注册都必须由同一插件 effect 拥有并在卸载时撤销。
