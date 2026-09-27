# 06. 插件打包

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/06-plugin-packaging) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

定义插件的打包、分发和安装方式，确保跨机器的可重复性。

## 2. 包格式

### 2. 1 目录包（development/local）
包含 `manifest.json` 的普通目录。

### 2. 2 分发包（推荐）
扩展名：`.piplug`（本质上是一个 zip）

```text
demo.hello-0.1.0.piplug
└─ (zip)
 ├─ manifest.json
 ├─ main.js
 ├─ renderer/...
 ├─ skills/...
 ├─ themes/...
 └─ checksums.json # optional, in-package manifest
```

> 在实施过程中，可能首先支持 `.zip`，但在产品级别，所有内容都被标识为 `.piplug`。

## 3. 包内限制

1.根必须包含`manifest.json`
2. 不允许使用绝对路径符号链接
3. 不允许路径遍历（`../`）
4、单个包解压后默认最大大小（建议50MB，可配置）
5.最大文件数（建议2000，可配置）

## 4. checksums.json （可选但推荐）

```json
{
 "algorithm": "sha256",
 "files": {
 "manifest.json": "hex...",
 "main.js": "hex..."
 }
}
```

主机可以在安装时验证。

## 5. 安装流程

```text
select package/dir
 → verify archive safety
 → extract to temp
 → validate manifest + files
 → permission review UX
 → move to installed/<id>
 → registry write
 → optional auto enable
```

失败时，清理 temp 并不要留下半安装的目录。

## 6. 版本控制和覆盖

- 安装具有相同 ID 的新版本：升级
- 升级前将旧版本备份到`cache/backup/<id>/<version>`
- 升级失败回滚（P2）

语义：
- `install`：id不存在
- `upgrade`：id 存在并且版本较新
- `reinstall`：强制重新安装相同版本

## 7. 卸载和清理

删除：
- `plugins/installed/<id>`
- 注册表项

可选择删除：
- `plugins/data/<id>`
- 插件日志

## 8. 开发包

开发加载不经过`.piplug`打包；相反：

```text
Load Development Plugin → choose directory → validate → register(source=dev)
```

## 9. 构建建议（开发人员）

最低规格：

- 来源可以是 TypeScript
- 分发前编译为可直接加载的 js/html/css
- 不要依赖主机当场运行 `npm install`（MVP 不支持在安装时拉取依赖项）

如果插件需要第三方库：
- 自己将它们捆绑到插件目录中

## 10. 验收

1.可以从目录安装
2. 可以从 `.piplug` / `.zip` 安装（实施期间的每个里程碑）
3. 坏包无法安装且不留任何残留
4.升级后id不变，新版本生效


## 11. 实施情况

在 host-core + 桌面 shell 中实现：

1.通过`plugins.installFromPath`目录安装
2. `.piplug` / 通过 `plugins.installFromPackage` 存储压缩的 zip 安装
3. 市场下载安装重复使用相同的软件包安装程序
4. 在提交 `plugins/installed/<id>` 之前强制执行遍历/符号链接/大小/文件计数保护
