# 变更记录

## 0.5.0

### Minor Changes

- 将 `@boringparts/template` 收敛为纯 Node（`>=24.0.0`）可组合单仓元框架库，剥离全部内置预设、参考包与命令行壳层耦合，外部运行依赖仅保留 `yaml`。

  - **显式源上下文与模板快照原语**：提供 `createWorkspaceSourceContext`、`createPackagedSourceContext`、`writeTemplateSnapshot`、`readPnpmWorkspaceCatalog` 与 `validateWorkspacePolicy`，由调用方显式注入模板基准目录，不再通过模块路径猜测宿主仓库或启动 `pnpm` 子进程；生成的 `pnpm-workspace.yaml` 支持 `minimumReleaseAgeExclude` 通配模式按需裁剪、顶层属性间空行分隔，并在未引用依赖目录时省略空的 `catalog` 字段输出。
  - **可组合规划、合成与落盘原语**：保留单一公开入口并暴露 `definePreset`、`summarizePresets`、`planProject`、`buildProjectProjection`、`writeProjectProjection` 与 `bindTemplateCatalog`，以显式传入的 `SourceContext`、`WorkspaceRoot`、`SingletonPackage`、`PresetDefinition` 与 `WorkspacePolicy` 作为核心接缝。
  - **精简包交付与声明边界**：移除 `bin` 入口、命令行协议依赖及参考包伪导出剥离逻辑，包级开发运行时锁定 Node `24.0.0`，通过 `tsc` 编译输出纯净 JS 与 `.d.ts` 声明。

## 0.4.0

### Minor Changes

- 公开 CLI 与默认内容套件迁至 `@boringparts` 命名空间：公开包更名为 `@boringparts/template`（命令仍为 `template`），仓库地址、包元数据、内部工作区包、内容身份命名空间与验证容器标签同步切换。
- 公开 CLI 与 `ts-cli` 预设升级至 `@boringparts/cli-contract@0.7.0`：支持原生 `--schema` v6 契约发现、0.7.0 帮助文案模板、`structured`（默认）与 `text`（`--output text`）双输出模式，以及 v3 结构化结果与用法错误信封；移除旧 `schema` 子命令与 `--output-format` 选项；生成工作区根配置按实际选用的依赖过滤投影 `minimumReleaseAgeExclude`。
- 仓库根与生成项目根改用 `devEngines.runtime`（锁定 Node.js `26.13.1`、`onFail: "download"`）作为 Node.js 工具链唯一真源；工作流改由 `pnpm/setup`（`node-version-file: false`）直接读取根清单，并移除非 CLI 子包冗余的 `engines.node`。
- 拆分为 `ts-lib` 与 `node-lib` 两套库预设并细化包角色链接边界：`ts-lib` 保持平台中立（纯 ES2024 构建类型隔离，移除 `#/*` 子路径别名并改用相对 `.ts` 扩展名重写，通过包名自引用分别验证源码 `test` 与构建产物 `test:dist`）；新增 `node-lib` 预设（声明 `engines.node` `>=24.0.0`、包级 `devEngines.runtime` `24.0.0` 及按需投影 `catalog:node-24`）；默认包角色扩展至 6 类，在规划阶段阻止浏览器应用与平台中立库链接 Node 专属库。
- 全仓代码注释、日志、CLI 帮助与输出、报错诊断、预设元数据、工作流步骤名及测试描述统一为英文（保留用户可见产品界面、产品说明文档及测试中的中文样本）。
- 升级工具链与依赖基线至 Node.js `26.13.1`、pnpm `12.21.0`、Rust `1.100.0`，同步更新依赖目录（含 `telefunc` `0.3.1`、`@vikejs/hono` `0.4.1` 路由注册顺序适配、`vitest` / `@vitest/browser-playwright` `5.1.1`、`execa` `10.2.1`、`srvx` `1.0.8` 等）、开发容器 `docker-outside-of-docker` `1.10.2` 及工作流 `pnpm/setup` `v3.2.0`。

### Patch Changes

- 生成仓库的类型感知 lint 改用 tsrs。修改上游类型或根 Oxc 配置后，相关包会重新检查；在干净工作区运行 Vike 的 lint 时会先构建所需的类型声明。
- 生成的 Vue-Hono 仓库将根目录的联合端到端测试纳入轻层静态检查。
- 生成仓库与作者仓的开发容器在安装全局 Turbo 时固定使用 catalog 锁定的精确版本，避免容器构建触发 GitHub API 匿名限流（HTTP 403）。

## 0.3.1

### Patch Changes

- 生成仓库的开发容器预装全局 Turbo，首次安装依赖前即可运行 `turbo ls`。项目依赖安装后，命令自动使用项目锁定的 Turbo 版本。
- 生成的 `AGENTS.md` 引导代理从仓库根目录运行 `turbo ls` 查看工作区包结构。

## 0.3.0

### Minor Changes

- Require Node.js 26.13 or newer and resolve pnpm from each project's `packageManager` declaration. Fix global pnpm executable lookup in development containers for both `root` and `node` users.

## 0.2.0

- 仓库校验及生成的 TypeScript 库、CLI 统一采用 Zod 4，移除 Valibot、专用 JSON Schema 转换包与适配层。
- CLI 导出的 schema 使用 Zod 原生投影：解析后默认存在的字段标为输出必需字段，输出对象明确拒绝额外属性；领域规则、命令、退出码及持久数据版本保持现有约定。
- 升级 oxlint、oxfmt、Rust、Vike、Vite 和 Drizzle，同步生成模板的依赖快照与工具链配置。

## 0.1.0

- 分离默认内容套件与通用生成、归档和验证能力，统一默认预设的正式生成与安装链路。
- 完善 CLI 初始化、增量加包及根配置合成，保留现存项目的合法定制并在冲突时避免写入。
- 将 CLI 模板清单转换留在作者侧，生成项目仅保留命令名和版本读取逻辑，清理无用发布目录与作者侧测试。

- 固定原生 Changesets 发布配置与手动发布工作流，生成包默认保持私有。
- 完善 CLI 归档，使其包含生成所需的库产物和类型声明，并通过安装后的 CLI 验收。
