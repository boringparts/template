---
"@boringparts/template": minor
---

重构为自举单仓与同构包模型架构，并统一 CLI 的 Node `>=24.0.0` 运行时基线：

- **同构 `Package<TMeta>` 生成模型与一次性多包初始化**：支持 `presets` 与 `init`（含 `--preset <preset[:name[:path]]>` 与 `--link <consumer:provider>`）组合单预设或跨栈多包工作区；移除增量 `add` / `configure` 命令、`.template/` 元数据目录、`TODO.md` 生成、`typescript` 运行时依赖与嵌套内部压缩包。
- **确定性目录自动扫描与就近环境元数据归并**：自动扫描映射参考包常规文件，统一经 `./reference` 导出定位并在实例化时剥离；单条目 `bin` 自动按实例叶名改名，存在含 `dev` 脚本的子包时根包自动生成 `"dev": "turbo run dev"`；`.devcontainer`、`.vscode` 与 Dependabot 元数据在预设侧就近挂载并做冲突快败归并，引擎不感知具体技术栈。
- **参考包自包含与数据目录解禁**：拆分模板工具配置包并收回发布空壳资产；`rust-bin` 携带自身 `Cargo.toml`、`Cargo.lock` 与 `rust-toolchain.toml` 作为独立 Cargo 包由 `pnpm + Turbo` 编排；Vike 生产部署镜像留在 `packages/deployment/` 包内；本地默认 SQLite 目录迁至 `.local/`，取消全局 `data` 目录忽略。
- **Node `>=24.0.0` 基线与隔离产物验收**：公开 `@boringparts/template` CLI 与 `ts-cli` 参考包统一声明支持 Node `>=24.0.0`（内联受限包名校验，卸除 `validate-npm-package-name`），并在锁定的 Node `24.0.0` 下通过隔离打包安装完成 `test:dist` 端到端验收；构建产物直接内联引擎与预设代码并附带静态 `templates/` 资产。
