# 06. 插件打包

> **翻译说明：** 本页对应 [英文源规格](/spec/07-plugins/06-plugin-packaging)，代码与字段保持原文。

## 1. 格式与所有权

开发加载直接引用根目录有 `manifest.json` 的本地文件夹，不复制源码。
安装目录和市场包由 Rust host-core 管理，桌面运行时在清单与授权审核后才加载入口。

`.piplug` 是 **store-only ZIP（压缩方法 0）**。安装器也读取这种 `.zip`，
但拒绝通用 ZIP 工具默认生成的 deflate 条目。使用 `pi-plugin pack` 或 Agent 的 `PluginPack`。

## 2. 包内容

devkit 把清单写在包根目录。包含可执行 JavaScript、HTML/CSS、技能、渲染器模块与引用资源。
安装器能发现根目录或下一层目录的清单，但推荐使用 devkit 的根目录格式。

普通包不会自动安装依赖或编译 TypeScript，应自行打包依赖；`node_modules` 不进入包。
Agent 扩展有独立 TypeScript 加载器，显式导入 pi 扩展另有受限的 registry-only npm 准备流程，
详见 [16-trusted-extensions.md](16-trusted-extensions.md)，两者都不代表普通安装会运行任意安装脚本。

## 3. 上限与排除项

| 表面 | 当前规则 |
|---|---|
| 包内容 | 最多 2,000 文件、50 MiB；市场下载字节另有同类上限 |
| 路径 | 拒绝穿越和符号链接；引用入口必须在插件目录内，主题资源的独立声明机制除外 |
| devkit 遍历跳过 | `.git`、`node_modules` 目录 |
| devkit 打包还排除 | 根 `dist/`、`.env`、`.env.*`、`.npmrc`、`*.pem`、`*.key` |
| 凭证排除 | 警告列出跳过路径，不能代替秘密扫描 |
| 归档编码 | store-only 条目，按确定的 code-unit 顺序生成并打印 SHA-256 |

`check` 检查编写与包约束，区分阻断错误和建议警告，`pack` 拒绝错误。
通过检查不代表入口可执行、已获授权、兼容所有宿主或通过中心审核，发布前仍需安装实际包验证。

## 4. 完整性

市场安装必须校验目录或 resolve 提供的 SHA-256，有声明大小时也核对大小。
不匹配返回 `PLUGIN_INTEGRITY` 并停止安装。本地目录没有下载摘要。
`checksums.json` 不是当前安装器校验的逐文件协议，随包携带它不会增加信任门。
签名尚在规划中，发布者徽章是目录元数据。

## 5. 安装与升级

宿主在 `plugins/cache/download` 暂存输入，检查归档与清单引用，计算权限差异，
写入 `plugins/installed/<id>`，保存 registry，并按授权和选项启用。市场下载复用该安装器。

已有 id 的版本不同即报告升级，本地安装不要求一定更新；市场版本选择另行比较。
替换前将原代码备份到 `plugins/cache/backup/<id>/<version>`。
备份不等于保证每种后续 I/O 或加载失败都能事务回滚，不能宣传为无条件自动回滚。

升级保留 id 与私有数据，新增权限需审核，自动更新不能静默扩权。
更新策略见 [08-plugin-signing-updates.md](08-plugin-signing-updates.md)。

## 6. 卸载

运行时先停止插件并撤销贡献。host-core 默认删除 registry 行、受管代码、私有数据和旧式插件日志文件。
开发源码目录保留。内置插件即使被市场版本更新也不能卸载，应使用禁用。
当前没有保留数据开关，也没有卸载生命周期回调。

## 7. CLI 与发布交接

完成仓库常规配置后，从 PI-Desktop 仓库根目录运行：

```bash
pnpm pi-plugin check ../my-plugin
pnpm pi-plugin pack ../my-plugin
pnpm pi-plugin publish ../my-plugin --channel stable
```

`publish` 仅生成本地 `.piplug` 与 `.submission.json`，不会上传，记录仓库/ref/commit/path 与制品摘要/大小。
需要带 `origin` 的 Git 仓库，拒绝带凭证的 remote；有改动时拒绝，除非显式 `--allow-dirty`。
打包先于干净工作区检查，应先忽略 `dist/`。推荐 HEAD 上有 tag；`--ref` 不会改变记录的 HEAD commit，
也不能让脏工作区变得可复现。中心独立解析并核验来源。

## 8. 实现依据

- `packages/plugin-devkit/src/{check,walk,pack,publish,cli}.ts` 及测试
- `crates/host-core/src/plugins/{install,manifest,validation,registry}.rs`
- [发布流程](../../plugin-development.md#9-check-pack-and-install)
