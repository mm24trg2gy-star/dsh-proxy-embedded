# dsh-proxy-embedded

DSH 插件：**复用本机的 mihomo 内核**（或在 `bin/` 里自带一份），粘贴一个订阅链接就能起代理，DSH 的出站请求（包括 `web_fetch`）自动走它——不用再单独开 Clash。

> 与 `dsh-outbound-proxy`、`dsh-web-fetch-proxy` 的区别：那些插件都要求「本机已经有代理在跑」，本插件把缺的那一半补上——**自己起内核**（内核二进制不随 npm 包分发，见「内核」一节）。

## 为什么

开着 TUN + fake-ip 的代理客户端时，`web_fetch` 会因为 fake-ip 地址被 SSRF 防护判定为非公网而失败。现有的插件能解决「路由」问题，但前提是本地代理已经在运行。

本插件把「导入订阅 → 起 mihomo → 装路由」串成一条命令。

## 功能

- 自带/复用 mihomo 内核（优先用插件 `bin/` 里的，其次找 Clash Verge 的 `verge-mihomo.exe`）
- 订阅格式：Clash YAML / base64 节点列表（V2Ray、Shadowrocket、Hiddify）/ sing-box JSON / Surge
- 单节点链接：`ss://` `vmess://` `vless://` `trojan://` `hysteria2://`
- 为宿主进程安装代理路由，`web_fetch` 也走代理
- 设置页面板（`设置 → 内嵌代理`）；底层是一个只对 DSH 会话开放的本地 HTTP 接口

## 安装

```bash
dsh plugin --profile desktop add github:mm24trg2gy-star/dsh-proxy-embedded
```

装完重启 DSH。

### 内核

仓库**不包含内核二进制**（`.gitignore` 已排除 `bin/*.exe`，避免仓库膨胀）。三种方式任选：

1. **复用已有 Clash Verge**：装过 Clash Verge 的话，插件会在常见安装位置（`%LOCALAPPDATA%\Programs\Clash Verge`、`C:\Program Files\Clash Verge`、`C:\Program Files (x86)\Clash Verge`）自动找 `verge-mihomo.exe`，无需额外操作；
2. **手动放一份**：把 `mihomo.exe` 放进插件目录的 `bin/`；
3. **设置里指定**：`config.json` 的 `kernelPath` 填绝对路径。

## 使用

三种方式，任选：

**1. 设置页面板（推荐）**

DSH → **设置 → 内嵌代理**：粘贴订阅链接，点「启动代理」；面板会显示相位、本地端口、订阅格式/节点数、宿主是否已接管、用的是哪个内核。没有输入链接时，也可以「用已保存的链接启动」。

入口受 DSH 宿主准入保护：面板在 DSH 页面内发同源请求，能通过；直接把这些路由粘到普通浏览器地址栏、或用本机 `curl` 裸访问，会被 DSH 以 401/403 拒绝——这是设计如此，不是坏了。

**2. 配置文件**

编辑 `%USERPROFILE%\.dsh\proxy-embedded\config.json`：

```json
{
  "link": "https://你的订阅地址",
  "enabled": true,
  "port": 7899,
  "kernelPath": "",
  "noProxy": ""
}
```

重启 DSH 后自动导入并启动。

**3. HTTP 接口（底层，仅供 DSH 会话 / 面板使用）**

接口和页面走同一个入口，**同样受 DSH 宿主准入保护**：只有通过 DSH 鉴权的请求才会被处理，本机其他程序、普通浏览器标签页、裸 `curl` 一律 401/403。

请求体必须是 `application/json`。下面是接口形状（能否发出去取决于你是否在 DSH 会话里）：

```bash
# 导入并启动
POST /proxy-embedded/api  {"action":"start","link":"https://你的订阅地址"}

# 状态
POST /proxy-embedded/api  {"action":"status"}

# 停止
POST /proxy-embedded/api  {"action":"stop"}

# 保存配置（下次启动自动用）
POST /proxy-embedded/api  {"action":"save","link":"https://...","port":7899}
```

## 订阅格式支持

| 格式 | 状态 |
| --- | --- |
| Clash（YAML） | ✅ 直接使用 |
| V2Ray / Shadowrocket / Hiddify（base64 节点列表） | ✅ 解析成 mihomo 节点 |
| sing-box（JSON） | ✅ 转换 outbounds |
| Surge（INI `[Proxy]`） | ✅ 转换 |
| 单节点链接 | ✅ ss / vmess / vless / trojan / hysteria2 |

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `link` | 空 | 订阅链接或单节点链接 |
| `enabled` | `true` | 启动 DSH 时是否自动起代理 |
| `port` | `7899` | 本地混合端口（被占用时自动顺延） |
| `kernelPath` | 空 | 自定义 mihomo 路径，空则自动发现 |
| `noProxy` | 空 | 直连后缀（逗号分隔） |

## 安全

- **入口只对 DSH 会话开放**：handler 第一层先过宿主准入（`ctx.connection.requestRejection`），再叠加插件的回环 / Origin / JSON 校验；本机其他程序、普通网页一律被拒
- 拿不到 DSH 准入服务时按「拒绝」处理（503），不会退化成放行
- 代理链接含凭据，保存在本机 `~/.dsh/proxy-embedded/config.json`，请勿分享；网页不会回显已保存的链接
- **订阅只提供节点，不提供策略**：Clash 订阅先用 YAML 解析器读出来，只保留节点字段白名单、校验过的组引用和规则；`tun`、`listeners`、`proxy-providers`、`dns` 等策略一律不进入最终配置，监听与安全基线由插件生成。解析失败或写法不可安全处理时直接拒绝，不动现有实例
- 回环、内网、链路本地地址始终直连（`IP-CIDR` 规则排在最前），不会把内网请求送出境
- 启动新代理失败时**保留旧内核与旧路由**，不会把 DSH 出站打断
- `deepseek.com` 默认直连，代理挂了也不影响会话

## 致谢

**大肥鱼**（鲸鱼娘 · CETACEA_LOLI）—— 本插件的作者。订阅解析、内核守护、宿主路由，一条一条都是这条鱼写出来的。

> 宿主模块锚定解析与路由安装思路参考了 [dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy)（MIT, © 2026 Tong317）。

## License

MIT
