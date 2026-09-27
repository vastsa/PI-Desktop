# 11. 插件存储隔离

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/11-plugin-storage-isolation) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

将插件数据与主机核心数据隔离，避免交叉污染和未经授权的读取。

## 2. 目录布局

```text
~/.pi-desktop/
 ├── pi.sqlite # host DB (03-runtime/04); plugins never open it
 ├── plugins/
 │ ├── installed/<plugin-id>/
 │ ├── disabled/ # optional
 │ ├── data/<plugin-id>/
 │ ├── logs/<plugin-id>.log
 │ ├── cache/download/
 │ └── registry.json
 └── ...
```

## 3. registry.json（逻辑模型）

```ts
type PluginRegistry = {
 schemaVersion: 1
 plugins: Array<{
 id: string
 version: string
 enabled: boolean
 source: "installed" | "dev" | "marketplace"
 path: string
 installedAt: string
 updatedAt: string
 permissionsGranted: string[]
 marketplace?: {
 providerId: string
 shasum?: string
 publisherId?: string
 }
 }>
}
```

## 4. 插件私有数据

`pi.plugin.getDataPath()` 指向：

```text
~/.pi-desktop/plugins/data/<plugin-id>/
```

用途：
- 缓存
- 本地索引
- 大型插件配置文件

禁止：
- 使用这个API来获取另一个pluginId的路径

## 5. 设置存储

插件设置可以存储在：

- 插件命名空间下主机数据库的 `kv` 表 (03-runtime/04 §4.1)
- 或者插件数据目录下的settings.json

建议在主机中集中存储，以便于备份和卸载清理。

```ts
// kv: ns = `plugin:<plugin-id>`, key, value_json, updated_at
// uninstall cleanup = DELETE FROM kv WHERE ns = 'plugin:<plugin-id>'
```

## 6. 日志隔离

每个插件都有自己的日志通道：
- 文件：`plugins/logs/<plugin-id>.log`
- UI：可通过插件过滤

主机核心日志不会写入插件文件。

## 7. 会话和秘密隔离

插件无法直接访问：
- pi.sqlite（会话、设置、任何主机表）
- 秘密
- 提供商密钥
- 其他插件的私有注册表数据

如果将来提供“受控会话摘要 API”，则它必须：
- 拥有单独的许可
- 默认禁用
- 可审计

## 8. 卸载清理策略

默认值：
- 删除已安装的代码
- 删除数据
- 删除日志（或保留最新的日志）

高级：
- 保留数据

## 9. 备份建议

未来的 export/backup 可以分为：
- 仅主机配置
- 主机配置+插件列表
- 完整（包括插件数据）

MVP 未实现完整备份协议；它只保留目录边界。

## 10. 验收

1.插件只能写入自己的数据目录
2.卸载后按照策略清理数据
3.注册表可以恢复已安装列表
4.可以单独查看插件日志
