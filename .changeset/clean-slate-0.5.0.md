---
"@boringparts/template": minor
---

清场重构为 18 包自举单仓与纯净参考包架构：

- 收敛为 `presets` 与一次性多包 `init` 命令，支持通过可重复的 `--preset <preset[:name[:path]]>` 与 `--link <consumer:provider>` 组合单包预设或跨栈多包拓扑。
- 彻底移除初始化后的增量 `add` / `configure` 命令、`.template/` 元数据目录、`TODO.md` 生成、`typescript` 运行时依赖与嵌套内部压缩包。
- 通过封闭双通道接缝从受检纯净参考包直接合成目标项目，在常规构建中内联私有引擎与预设声明并附带静态 `templates/` 资产。
