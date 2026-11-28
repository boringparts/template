---
"@boringparts/template": minor
---

将 `@boringparts/template` 收敛为纯 Node（`>=24.0.0`）可组合单仓元框架库，剥离全部内置预设、参考包与命令行壳层耦合，外部运行依赖仅保留 `yaml`。

- **显式源上下文与模板快照原语**：提供 `createWorkspaceSourceContext`、`createPackagedSourceContext`、`writeTemplateSnapshot`、`readPnpmWorkspaceCatalog` 与 `validateWorkspacePolicy`，由调用方显式注入模板基准目录，不再通过模块路径猜测宿主仓库或启动 `pnpm` 子进程；目标项目未引用依赖目录时省略空的 `catalog` 字段输出。
- **可组合规划、合成与落盘原语**：保留单一公开入口并暴露 `definePreset`、`summarizePresets`、`planProject`、`buildProjectProjection`、`writeProjectProjection` 与 `bindTemplateCatalog`，以显式传入的 `SourceContext`、`WorkspaceRoot`、`SingletonPackage`、`PresetDefinition` 与 `WorkspacePolicy` 作为核心接缝。
- **精简包交付与声明边界**：移除 `bin` 入口、命令行协议依赖及参考包伪导出剥离逻辑，包级开发运行时锁定 Node `24.0.0`，通过 `tsc` 编译输出纯净 JS 与 `.d.ts` 声明。
