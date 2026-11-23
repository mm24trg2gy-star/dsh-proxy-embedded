# Changelog

## 0.1.7 — 2026-11-23

第二轮（GPT 复审后）：

- 安全：状态/启动/保存接口只回传掩码链接（`hasLink` + `linkMask`），页面不再显示订阅凭据。
- 安全：POST 必须 `application/json`；Origin 改为完整同源比较（协议+主机+端口）；CSP 增加 `frame-ancestors 'none'`；`kernelPath` 不再接受 API 入参，只能改本地配置。
- 修复：每个内核实例使用独立配置文件（`config-<pid>-<ts>.yaml`），候选失败不会覆盖正在生效的配置。
- 修复：端口扫描有界（1–65535，连续 50 个都占用则明确失败），探针返回后复查实例是否已退出。
- 修复：engine 的 start/stop 串行化，并发调用不再抢端口、抢配置、抢路由。
- 修复：订阅清洗更严——带引号的顶层键也能识别，内联 `rules: [...]` 或清洗后仍残留危险键时直接拒绝，并给出可读原因。
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
