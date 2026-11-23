# Changelog

## 0.1.6 — 2026-11-23

安全与正确性修复（来自一轮代码评审）：

- 安全：Clash 订阅里的策略块不再原样执行。`tun`、`listeners`、`proxy-providers`、`rule-providers`、`dns`、`external-controller`、`bind-address` 等顶层块整段删除，`allow-lan`/`ipv6`/`mode`/`log-level` 强制回写安全基线。
- 安全：回环、内网、链路本地地址固定直连（`IP-CIDR` 规则排在最前），`deepseek.com` 也直连。
- 修复：`buildConfig` 生成的 YAML 缺 `- `，导致 base64 节点列表 / sing-box / Surge / 单节点四种格式全部无法启动；同时补了节点补名与去重。
- 修复：端口顺延后配置里的端口与实际监听不一致，现在先定端口再写 YAML。
- 修复：重启失败不再先杀旧内核，新链路就绪后才替换；失败时旧路由原样保留。
- 新增：网页设置页（`GET /proxy-embedded/api`），可直接粘贴订阅链接启动/停止，不回显已保存链接。
- 修复：`package.json` 删掉指向不存在文件的 `./client` 导出；补 `icon` 字段，`files` 包含 `docs/icon.png`。
- 新增：`test/config.test.js`，覆盖 YAML 结构、节点补名去重、订阅策略清洗。

## 0.1.5 — 2026-11-16

- 修复：内核路径探测改用环境变量，去掉作者本机的 `D:\Clash Verge\...`。
- 补 `repository` / `homepage` / `bugs` 字段。
