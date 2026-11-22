# 变更记录

## 0.4.0

### Minor Changes

- 公开 CLI（`@ykdz/template`）与生成的 TypeScript CLI 参考包升级至 `@ykdz/cli-contract@0.5.0`：按命令通过 `define.outputModes` 声明 `structured`（默认）与 `text`（`--output text`）模式；启用原生 `--schema`（v5 目录、摘要及 `input` / `success` / `failures` / `wire` 分片）并声明可重放示例；结构化结果与用法错误统一为 v3 信封；移除旧 `schema` 子命令与 `--output-format` 选项。
- 全仓代码注释、日志、CLI 帮助与输出、报错诊断、预设元数据、工作流步骤名及测试描述统一为英文（保留用户可见产品界面、产品说明文档及测试中的中文样本）。
- 升级工具链与依赖基线至 Node.js `26.13.1`、pnpm `12.21.0`、Rust `1.100.0`，同步更新依赖目录（含 `telefunc` `0.3.1`、`@vikejs/hono` `0.4.1` 路由注册顺序适配、`vitest` / `@vitest/browser-playwright` `5.1.1`、`execa` `10.2.1`、`srvx` `1.0.8` 等）、开发容器 `docker-outside-of-docker` `1.10.2` 及工作流 `pnpm/setup` `v3.2.0`。

### Patch Changes

- 生成仓库的类型感知 lint 改用 tsrs。修改上游类型或根 Oxc 配置后，相关包会重新检查；在干净工作区运行 Vike 的 lint 时会先构建所需的类型声明。
- 生成的 Vue-Hono 仓库将根目录的联合端到端测试纳入轻层静态检查。

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
