# EasyNote 灾难恢复

[简体中文](DISASTER_RECOVERY.md) | [English](DISASTER_RECOVERY.en.md)

## 备份方式

| 类型 | 包含内容 | 适用场景 |
| --- | --- | --- |
| 网页「导出 ZIP」 | 当前笔记、回收站与引用文件 | 笔记迁移与日常归档 |
| 网页「导出草稿」 | 本机未同步草稿与已缓存引用文件 | 离线抢救本机内容 |
| `backup.sh` | 完整 D1 数据与全部 `ready` 状态的 R2 对象 | 账号级完整灾难恢复 |

所有 `--remote` 维护命令均在交互式终端隐藏读取 Cloudflare API Token（需要目标账号的 `Workers Scripts (Edit)`、`D1 (Edit)` 与 `Workers R2 Storage (Edit)` 权限），资源标识保存在 `wrangler.deploy.json`。

## 创建备份

```bash
bash backup.sh --remote              # 生产灾备（可用 --output DIR 指定目录）
bash backup.sh --local               # 本地开发数据备份
```

脚本导出全部 D1 业务表 SQL（恢复时自动重建 FTS5 索引），按 `<user_id>/<file_id>` 下载 R2 对象并逐个校验大小与 SHA-256，生成带校验清单的 `manifest.json`（目录权限为仅当前用户可读写，建议离线加密保存）。

## 恢复预检与执行

先准备全新的空 D1 数据库与私有 R2 桶，并配置对应的 `wrangler.deploy.json`，再执行预检与恢复：

```bash
bash restore.sh /path/to/easynote-backup --remote --check   # 只读校验清单、哈希与空目标状态
bash restore.sh /path/to/easynote-backup --remote           # 建表、恢复 R2 对象并导入 D1 数据
```

恢复完成后：

1. 运行 `bash reset-password.sh --remote` 重置密码。
2. 重新创建所需的 AI 令牌。
3. 登录网页抽查笔记、版本历史、图片与附件，随后生成一份新灾备并执行 `--check`。

## 恢复演练

建议在正式上线前使用临时 D1、私有 R2 桶与临时 Worker 完成一次完整恢复演练：预检备份 → 执行恢复 → 核对 D1 表记录数、R2 对象数量及抽样文件 → 清理临时资源。
