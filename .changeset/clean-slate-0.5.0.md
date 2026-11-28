---
"@boringparts/template": minor
---

升级项目初始化工作流与生成的单仓结构，并将 CLI 运行时基线统一至 Node `>=24.0.0`：

- **一次性多包 `init` 与 `presets` 发现**：通过 `presets` 查看可用预设，使用 `init`（支持多次 `--preset` 与 `--link`）一次性组合单预设或跨技术栈多包工作区；移除增量 `add`、`configure` 子命令及 `.template/`、`TODO.md` 生成。
- **纯净单仓生成结果**：生成的根目录统一配置脚本、任务图与按实际依赖裁剪的工作区依赖目录，存在开发服务子包时自动提供统一根 `"dev": "turbo run dev"`，单命令工具按目标包名自动改名；自动归并开发容器、编辑器配置与 Dependabot 规则，配置冲突时直接报错中止。
- **独立 Cargo 子包、Vike 子包部署与本地存储目录**：`rust-bin` 作为独立 Cargo 子包由 `pnpm` 与 `Turbo` 统一编排；Vike 预设的容器部署镜像与入口脚本留在 `packages/deployment/` 子包内；默认本地数据库目录改为 `.local/`，不再全局忽略业务 `data/` 目录。
- **Node `>=24.0.0` 基线与轻量安装包**：`@boringparts/template` 与 `ts-cli` 预设统一支持 Node `>=24.0.0`；分发安装包无需额外编译器或嵌套压缩包即可直接运行。
