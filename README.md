# dsh-proxy-embedded

DSH 插件：**自带 mihomo 内核**，粘贴一个订阅链接就能起代理，DSH 的出站请求（包括 `web_fetch`）自动走它——不用再单独开 Clash。

> 与 `dsh-outbound-proxy`、`dsh-web-fetch-proxy` 的区别：那些插件都要求「本机已经有代理在跑」，本插件把缺的那一半补上——**自己起内核**。

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
dsh plugin --profile desktop add link:E:\dsh\proxy-embedded
```

装完重启 DSH。

## 使用（第一版：手动）

两种方式：

**1. 配置文件**

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

**2. HTTP 接口**（本机回环，仅 loopback 可访问）

```bash
# 导入并启动
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api \
  -H "content-type: application/json" \
  -d '{"action":"start","link":"https://你的订阅地址"}'

# 状态
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api -d '{"action":"status"}'

# 停止
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api -d '{"action":"stop"}'

# 保存配置（下次启动自动用）
curl -X POST http://127.0.0.1:<DSH端口>/proxy-embedded/api \
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
- 代理链接含凭据，保存在本机 `~/.dsh/proxy-embedded/config.json`，请勿分享
- 内核失败不影响 DSH 启动（fail-open）
- `deepseek.com` 等域名默认直连，不会因为代理挂了而断会话

## 路线图

- [x] 第一版：手动导入、起内核、装路由
- [ ] 第二版：启动自动起 + 失败自动重试 + 设置页
- [ ] 内核自动下载（多镜像）
- [ ] 节点延迟测速与自动选择

## 致谢

路由安装与宿主模块锚定解析的思路参考了 [dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy)（MIT, © 2026 Tong317）。

## License

MIT
