# 路线图

## v0.1 — 可运行技术预览

- 集中服务器与客户管理
- 多中转到单落地的批量链路编排
- VLESS Reality Vision / SS 2022 / VMess WS 入口适配器
- SS 2022 / SS AES-128-GCM 落地传输适配器
- 流量、到期和滚动 IP 限制
- 一键安装、Agent 注册、备份恢复与自动 HTTPS

## v0.2 — 可迁移生产测试

- 一设备一凭据、设备撤销与换机流程
- Clash/Mihomo、sing-box、V2Ray、Shadowrocket 订阅和多格式二维码
- User-Agent 自动返回客户端格式
- 链路健康探测、自动切换与落地池
- 编辑链路的差异更新，不需要先整条停用
- 强制 Xray Release 校验和验证
- 控制面敏感字段静态加密

## v0.3 — 协议与规模

- Trojan、VLESS XHTTP/gRPC、Hysteria2、TUIC、WireGuard 适配器
- 单入口多落地的加权、延迟优选和故障转移
- PostgreSQL 存储、分页、批量标签与批量策略
- 多管理员 RBAC、操作审批和 API Token
- Agent 滚动升级与配置版本回退

## v1.0 — 稳定版

- 双向 TLS Agent 通信
- 高可用控制面
- 完整迁移工具、版本兼容策略和安全审计
- 经过压力测试的千级客户与百级服务器运行基线
