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
- 本地 HTTP 接口，方便 AI/脚本手动触发

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

**1. 网页（推荐）**

DSH 启动后，浏览器打开：

```
http://127.0.0.1:<DSH端口>/proxy-embedded/api
```

粘贴订阅链接，点「启动」即可；页面还会显示状态，点「停止」可撤下代理。页面由插件自己提供，只监听回环。

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

**3. HTTP 接口**（本机回环，仅 loopback 可访问）

```bash
# 导入并启动
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api \
  -H "content-type: application/json" \
  -d '{"action":"start","link":"https://你的订阅地址"}'

# 状态
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api -H 'content-type: application/json' -d '{"action":"status"}'

# 停止
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api -H 'content-type: application/json' -d '{"action":"stop"}'

# 保存配置（下次启动自动用）
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api \
  -H "content-type: application/json" \
  -d '{"action":"save","link":"https://...","port":7899}'
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

- 只用本机回环接口，拒绝跨站请求
- 代理链接含凭据，保存在本机 `~/.dsh/proxy-embedded/config.json`，请勿分享；网页不会回显已保存的链接
- **订阅只提供节点，不提供策略**：Clash 订阅里的 `tun`、`listeners`、`proxy-providers`、`dns`、`external-controller` 等顶层块会被整段删除，`allow-lan`/`ipv6`/`mode` 强制回写安全基线
- 回环、内网、链路本地地址始终直连（`IP-CIDR` 规则排在最前），不会把内网请求送出境
- 启动新代理失败时**保留旧内核与旧路由**，不会把 DSH 出站打断
- `deepseek.com` 默认直连，代理挂了也不影响会话

## 致谢

**大肥鱼**（鲸鱼娘 · CETACEA_LOLI）—— 本插件的作者。订阅解析、内核守护、宿主路由，一条一条都是这条鱼写出来的。

> 宿主模块锚定解析与路由安装思路参考了 [dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy)（MIT, © 2026 Tong317）。

## License

MIT
