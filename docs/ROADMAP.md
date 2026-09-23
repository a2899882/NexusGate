# 路线图

## v0.1 — 可运行技术预览（已完成）

- 集中设备与客户管理
- 多入口到单出口的批量线路编排
- VLESS Reality Vision / SS 2022 / VMess WS 入口适配器
- SS 2022 / SS AES-128-GCM 出口传输适配器
- 流量、到期和滚动 IP 限制
- 一键安装、Agent 注册、备份恢复与自动 HTTPS

## v0.2 — 统一维护与容灾（当前版本）

- 默认明亮/暗色双主题与重新设计的中文 UI
- 设备、客户、线路编辑和运行中线路安全重建
- 单机直连节点、IPv6/双栈
- VLESS Reality、VLESS WS、SS 2022 AES-256、SS AES-256-GCM、SOCKS5
- Reality 常用目标预设与按协议动态表单
- Agent 重装自动对账、任务租约重试、失败项修复
- Debian/Ubuntu/RHEL systemd 与 Alpine OpenRC Agent
- 管理员账号密码修改、`ng` 完整运维菜单和冷备迁移流程

## v0.3 — 订阅与协议引擎

- 一设备一凭据、设备撤销与换机流程
- Surge 输出模板、自定义订阅模板和本地生成的二维码（Base64、Clash/Mihomo、sing-box JSON 已提供）
- sing-box 引擎及 AnyTLS、Hysteria2 适配器
- 节点域名/证书资产管理及 VLESS WS TLS
- VLESS XHTTP/gRPC、Trojan、TUIC 等协议适配器
- Xray/sing-box Release 校验和验证与分批升级
- 控制面敏感字段静态加密

## v0.4 — 调度与规模

- 出口池、延迟/可用性探测、加权分流与故障转移
- PostgreSQL 存储、分页、批量标签和批量策略
- 多管理员 RBAC、操作审批和 API Token
- Agent 版本看板、滚动升级、配置版本回退
- 告警 Webhook、邮件/即时通信通知

## v1.0 — 稳定版

- 双向 TLS Agent 通信
- 可验证的高可用控制面部署方式
- 完整迁移工具、版本兼容策略和安全审计
- 经过压力测试的千级客户与百级设备运行基线
