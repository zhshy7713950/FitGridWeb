# 股价预警部署与恢复

预警运行在现有 Next.js 进程和 PostgreSQL 内。主机 systemd 每 15 秒唤醒一次私有 tick；行情扫描与重试仍由服务端交易日历、窗口期限、锁和持久状态决定。没有新增容器。低内存配置继续限制 app 640 MiB、db 512 MiB，镜像由发布流水线构建，VPS 只拉取固定 SHA 镜像。

## 升级

先完成一次可解密的备份和隔离恢复演练，再在 VPS 执行：

```sh
sudo /opt/fitgridweb/ops/install-production.sh --upgrade --ref <完整的发布commit-SHA>
sudo nginx -t
sudo systemctl status fitgridweb.service fitgridweb-price-alerts.timer
sudo systemctl list-timers fitgridweb-price-alerts.timer
sudo journalctl -u fitgridweb-price-alerts.service --since '30 minutes ago'
```

安装器保持已有域名、端口和 nginx vhost，更新受管 snippet。`/fitgrid/api/internal` 及其子路径对公网返回 404；tick 仅通过现有 loopback 应用端口访问。不要添加公网触发器或发送接口。

安装器生成并保留 `/etc/fitgridweb/fitgridweb.env` 中两个独立秘密：

- `PRICE_ALERTS_TASK_SECRET`：至少 32 字符的随机 token，负责内部任务认证。
- `NOTIFICATION_ENCRYPTION_KEY`：32 随机字节的 64 位十六进制表示，负责每个用户的 Bark 密钥加密。

环境文件保持 root 私有（600）；它们与认证、owner-reference 秘密分离。秘密进入现有 app 的 Compose 环境，tick 禁用用户 curl 配置，Authorization 通过 curl 标准输入传递，不能放在 URL、命令行或日志中。不要把环境文件或 Bark 密钥发到聊天、工单或 Git。旧安装未配置这两个值时仍可运行网格功能，预警不可用；不要只配置其中一个。丢失或更换通知加密密钥后，需重新配置并测试 Bark 通道。

安装器在迁移前停止计时器并等待正在运行的 oneshot 自然结束，最多等待 135 秒，超时拒绝迁移。只有镜像、迁移、内网/公网健康检查及主机服务启动成功后才启用计时器。失败回滚到旧镜像时保持计时器禁用，数据库采用增量迁移，不逆向删表。`fitgridweb-price-alerts.service` 使用 root 专属的 `/usr/local/libexec/fitgridweb-price-alerts-tick`。计时器在每分钟 00、15、30、45 秒唤醒，精度 1 秒，无随机延迟、无停机补触发。没有已启用规则时唤醒不会激活任何规则。

app、db 的 Docker JSON 日志各限制 10 MiB × 3。此设置在容器重建时生效；它不修改 Docker 全局日志设置。

## Bark 设置与启用

在已登录的「股价预警」通知设置页面录入本人的 Bark 设备密钥并测试。测试成功后再创建或启用规则。新规则默认暂停；通道未就绪不能启用。页面只显示掩码。停用、编辑规则会使旧版本的待发送任务失效。

iPhone 上检查 Bark 的通知权限、声音、专注模式和网络连通性。接收成功须以设备实际收到通知为准，HTTP 接受不等于系统已展示通知。此仓库验证不代替真实 VPS 到 iPhone 的收信验收。

## 均线与产品选择

均线支持2–500个交易日，使用此前N−1个已结束交易日的同来源复权收盘价与当前分钟价格。腾讯日线请求640根，东财请求600根，Yahoo请求5y；缓存最多保留499根。各标的实际可用历史不同，不以请求参数冒充返回数量。

新建（含暂停保存）、修改均线条件或重新启用时先检查日线。主源不足再检查备用源，任何一个可用来源足够即允许；已确认均不足返回HISTORY_INSUFFICIENT并说明根数和最大周期（200个历史收盘价最多支持201日动态均线）。存在来源失败而无法确认时返回HISTORY_UNAVAILABLE，不把网络问题写成历史不足。纯暂停、删除和固定价格规则不依赖此检查。手动预检可在休市运行，不启动分钟采集；休市或未来交易日的预检不会写入运行时日线缓存。

创建页支持按代码或名称检索真实股票/ETF候选。国内不必输入.SH/.SZ，检索结果展示规范代码、名称、交易所和类型，点击确认后再次核对产品身份。指数、不支持的境外市场和未知产品不作为可选择结果。修改查询或市场会撤销旧确认；检索失败时显示错误。

## 临时数据与清理

每日首次正常tick执行清理，停机后恢复时补做；批量删除/清空每批最多1000条，受任务期限约束。临时缓存保留72小时：分钟行情按分钟起点、采集诊断按创建时间、最近价格快照按获取时间、日线快照按fetchedAt。日线每个标的/来源最多保留两个快照，每个有效快照仍包含最多499个历史交易日收盘价，不能将其误删成仅有最近三根日线。

终态通知队列按acceptedAt（无该值则expiresAt）超过72小时清理，pending/sending保留。已存入提醒事件的投递证据不随队列删除。有效规则、产品引用、通知密钥和账号不删除；提醒历史仍保留30天、全站最多十万条，软删规则仍30天清理。过期价格只清空quote，不删除标的或规则。

## 便携备份与恢复

管理页面与 `ops/backup-portable.sh` 继续使用独立密码加密的 `.fitgridbackup`，加密封装不变。新导出版本为 `4.0.0`：原来的七个 canonical CSV 加上 `market_instruments.csv`、`price_alerts.csv`、`price_alert_events.csv`。标的只导出规则引用的记录；保留规则、软删除状态与事件证据。manifest 记录 `marketInstruments`、`priceAlerts`、`priceAlertEvents` 数量。文件名白名单、校验和、数量、canonical CSV framing 及解密/展开大小上限都必须通过检查。

不包含分钟行情、日线基数、扫描缓存、Bark 通道/密钥和通知队列。恢复后所有规则为暂停、armed=true、cursor=NULL，active_from 为恢复时刻，连续性降级及上次错误/成功/评估状态清空；事件 outbox_id=NULL，只保留历史，不重发。用户重新配置并测试通道后，逐条主动启用规则。

新恢复器同时接受 `3.0.0` 和 `4.0.0`。v3 没有预警文件，恢复后的新增表为空；旧恢复器不能读取 v4，因此升级回滚时必须保留新版备份与恢复脚本。网格和 Android JSON 格式不变。

生产恢复通过管理页面完成检查、预览与二次确认。维护栅栏建立后，worker 把恢复前的计时器状态保存到 root 私有状态目录中的 `alert-timer-state.json`（600，绑定恢复任务），再停止计时器并等待 oneshot，之后停 app、断开运行角色连接、制作回滚快照并切换数据库。该记录不包含秘密，也不写入网页状态。停止任务失败会保留维护状态，不继续改库。

成功恢复、恢复失败但旧库回滚健康、快照失败但原库和 app 健康这三条路径，都会先完成内网/公网健康检查、移除维护栅栏，再自动恢复原先处于运行状态的计时器。worker 重启后使用持久记录继续处理，并在恢复计时器前重新检查健康状态。原先由管理员停止的计时器保持停止；需要改变这一人为状态时，再由管理员确认健康后执行：

```sh
sudo systemctl start fitgridweb-price-alerts.timer
sudo systemctl status fitgridweb-price-alerts.timer
```

自动或手动启动计时器都不会启用恢复的规则，也不会恢复 Bark 密钥或发送队列。健康检查失败、需要人工介入或计时器启动失败时保持停止；启动失败以 `ALERT_TIMER_START_FAILED` 进入可见的维护/人工介入状态，不会报告正常成功。检查维护任务状态及 `journalctl -u fitgridweb-maintenance.service -u fitgridweb-price-alerts.service`，先排除故障并核对数据库与 app，不要直接删除维护栅栏或 root 私有恢复意图记录来绕过处理。

`ops/restore.sh` 是旧的服务器密钥快照隔离恢复工具，只接受明确指定的非生产数据库，不能替代生产便携备份流程。

## 回滚应用镜像

记录旧的完整 SHA 镜像。先停任务，再在 root 环境文件中只改 `APP_IMAGE` 为旧的不可变镜像（不要打印环境内容）：

```sh
sudo systemctl disable --now fitgridweb-price-alerts.timer
sudo systemctl stop fitgridweb-price-alerts.service
sudoedit /etc/fitgridweb/fitgridweb.env
sudo docker compose --project-name fitgridweb --env-file /etc/fitgridweb/fitgridweb.env -f /opt/fitgridweb/docker-compose.yml -f /opt/fitgridweb/docker-compose.low-memory.yml pull app
sudo docker compose --project-name fitgridweb --env-file /etc/fitgridweb/fitgridweb.env -f /opt/fitgridweb/docker-compose.yml -f /opt/fitgridweb/docker-compose.low-memory.yml up --no-build -d --wait app
```

检查原有 `/fitgrid/api/v1/health` 的内网与公网 HTTPS 地址。保留增量表、新版备份脚本和密钥；不执行反向 DDL、`down -v` 或磁盘清理来回滚。旧镜像不提供预警能力，计时器保持禁用。再次升级到预警版本并通过健康检查后，由安装器重新启用。

## 发布验收边界

本地脚本替身测试覆盖安装、密钥处理、nginx 检查/失败回滚、维护停止顺序和恶意备份拒绝；真实 PostgreSQL 隔离库测试覆盖规则/事件精确恢复、秘密与队列不恢复、v3/v4 兼容。systemd 的真实 Linux 调度精度、VPS 内存峰值、交易所完整时段、美国股票/ETF 免费行情覆盖及 iPhone Bark 接收仍需在目标环境验收后才可标记通过。观察现有 app/数据库容器内存与日志，并验证 50 标的/250 规则负载下无 OOM；不要提高限制来掩盖问题。
