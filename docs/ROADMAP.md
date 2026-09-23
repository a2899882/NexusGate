# 路线图

## v0.1 — 可运行技术预览（已完成）

- 集中设备与客户管理
- 多入口到单出口的批量线路编排
- VLESS Reality Vision / SS 2022 / VMess WS 入口适配器
- SS 2022 / SS AES-128-GCM 出口传输适配器
- 流量、到期和滚动 IP 限制
- 一键安装、Agent 注册、备份恢复与自动 HTTPS

## v0.2 — 统一维护与容灾（已完成）

- 默认明亮/暗色双主题与重新设计的中文 UI
- 设备、客户、线路编辑和运行中线路安全重建
- 单机直连节点、IPv6/双栈
- VLESS Reality、VLESS WS、SS 2022 AES-256、SS AES-256-GCM、SOCKS5
- Reality 常用目标预设与按协议动态表单
- Agent 重装自动对账、任务租约重试、失败项修复
- Debian/Ubuntu/RHEL systemd 与 Alpine OpenRC Agent
- 管理员账号密码修改、`ng` 完整运维菜单和冷备迁移流程

## v0.4 — 订阅、诊断与 TLS（已完成）

- Agent 心跳与 Xray 启动故障隔离；首次心跳验证、`ng-agent doctor`、部署前在线检查
- 紧凑管理列表与本地二维码；Mihomo 智能分流和 Surge 兼容节点输出
- VLESS WS TLS：节点域名、证书签发或导入、自动续签钩子和下发前验证

## v0.6 — AnyTLS 双核心入口（测试阶段）

- sing-box 独立服务及 `with_v2ray_api` 构建安装器
- AnyTLS 直连、AnyTLS → VLESS TCP / SS2022 等转发及客户端订阅
- TLS 证书校验与续签、独立双向计数和经认证来源 IP 观察
- Xray 与 sing-box 分别下发及失败回滚，原资源保留

## 后续：节点协议、凭据和规模

- 一设备一凭据、设备撤销与换机流程
- 可编辑的自定义订阅模板
- Hysteria2 和 AnyTLS 的真实客户端兼容性与跨发行版压力测试
- VLESS XHTTP/gRPC、Trojan、TUIC 等协议适配器
- Xray/sing-box Release 校验和验证与分批升级
- 控制面敏感字段静态加密

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
