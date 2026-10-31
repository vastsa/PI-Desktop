# 11. 插件存储隔离

> **翻译说明：** 本页对应 [英文源规格](/spec/07-plugins/11-plugin-storage-isolation)，代码与字段保持原文。

## 1. 所有权与目录

Rust host-core 持有 registry、受管安装目录和所有 SQLite 访问；Electron Main 插件代理持有
插件设置文件与运行时记录。插件使用公开 API，不能获取宿主数据库句柄。
数据根目录属于相应宿主实例，不能硬编码 `~/.pi-desktop` 或重新读取全局覆盖变量寻找其他实例目录。
开发代码保留在加载的源码目录。

```text
<dataRoot>/plugins/
├── registry.json
├── installed/<plugin-id>/
├── data/<plugin-id>/
│   └── settings.json
├── logs/                    # legacy per-plugin log location
├── cache/download/
├── cache/backup/<plugin-id>/<version>/
└── market/
    ├── catalog.json
    └── packages/
```

## 2. Registry

`plugins/registry.json` 记录安装/开发/市场条目、启用状态、激活范围、授权、路径、版本、更新偏好与来源。
该文件由宿主读写，不是插件 API，插件不应直接修改。它用于重启恢复；运行时加载和服务状态只是投影。

## 3. 私有设置与文件

`pi.plugin.getDataPath()` 仅返回调用插件的私有目录。`getSettings()` 合并清单默认值与
`settings.json`，`setSettings(partial)` 合并补丁，当前实现不把这些设置存入 SQLite `kv`。
主题变量使用宿主管理的保留设置命名空间，应通过 `pi.themes.setVariables` 更新，不能自行覆盖。

设置是普通 JSON，不是机密存储，生成字段拒绝 `secret: true`。API key 留在宿主密钥库；
独立的 `provider.oauth` 回调只能取得自己的 OAuth 凭证，没有通用插件机密读写 API。

## 4. 文件与进程信任

`pi.fs.*` 操作已声明的工作区或用户选择范围，不是通用私有数据文件 API。
根目录来自工具调用会话或相应视图/工作区；代理拒绝宿主保留目录、受保护凭证和越界符号链接。

这些是**宿主代理 API** 保证。插件 Node 入口仍能以用户 OS 权限访问原始文件和网络 API，
私有目录是命名空间，不是操作系统沙盒。受信任的 `renderer.extension` 也共享宿主文档。
隔离面板/视图没有 Node 集成，preload 不开放宿主数据库。

## 5. 会话、用量、协作

`session.read` 只返回工具调用会话的有界模型上下文；`session.read.own` / `update.own` /
`delete.own` 仅操作自己导入的会话。`session.autoTitle` 提供首轮摘要与比较更新，`usage.read`
只有已完成轮次事实而无正文。这些独立权限都不是数据库通行证。

`desktop.control` 协作网关注入来源调用身份，持久账本留在 host-core。私有 JSON 不能充当授权、
宿主会话 id 或账本。网关不暴露 SQLite、任意 Electron IPC 或 MCP bearer token。

## 6. 日志与清理

在 Settings → Info → Logs 按插件 id 筛选。运行时写入分类应用日志，不承诺每插件一个实时
`plugins/logs/<id>.log`。不要记录凭证或正文。

卸载默认删除 registry 行、受管代码、私有数据与旧式插件日志，保留开发源码，拒绝内置 id。
没有保留数据选项。禁用和重载撤销运行时资源，但保留设置与私有文件。

## 7. 实现与验收依据

- `crates/host-core/src/plugins/registry.rs`：路径、登记与卸载
- `apps/desktop/electron/main/plugin-runtime.ts`：设置、私有路径、范围
- `apps/desktop/electron/main/plugin-session-scope.ts`：调用所有权
- 通过现有测试验证重启恢复、默认值与补丁、跨插件拒绝、路径范围、拒绝列表和卸载清理。
- 备份与可移植配置另有宿主契约，该布局不保证导出任意插件私有文件。
