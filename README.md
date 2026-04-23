# CBT-I 睡眠日记 · 多用户 Web 应用

一个基于 **CBT-I（失眠的认知行为疗法）** 设计的睡眠日记系统：

- 多用户：每人一个独立账号 + bcrypt 密码哈希 + JWT 会话
- 每个用户的数据保存在 **独立 JSON 文件**（你说的"记忆文件"）中
- 录入：上床时间、入睡时间、夜间醒来次数、夜醒总时长、最终醒来、离床时间、备注
- 自动计算：**TIB / TST / SOL / SE**
- 区间汇总：最近 7 / 14 / 30 / 90 天
- 可视化：Chart.js 折线图 + 柱状图（SE 趋势、TST 趋势、SOL/WASO 趋势、周均堆叠）

---

## 项目结构

```
cbti-sleep-diary/
├── package.json
├── server.js                # Express 后端（鉴权 + 文件存储 + REST API）
├── ecosystem.config.js      # PM2 进程管理配置
├── public/
│   ├── login.html           # 登录/注册页
│   ├── login.js
│   ├── app.html             # 主应用页
│   ├── app.js               # 录入 + 计算 + Chart.js
│   └── style.css            # 共享样式
├── data/                    # 运行后自动创建（已被 gitignore）
│   ├── users.json           # 全部账号 + bcrypt 密码哈希
│   ├── .jwt-secret          # 自动生成的 JWT 密钥（也可用环境变量覆盖）
│   └── diaries/
│       ├── alice.json       # 每个用户独立一个文件
│       └── bob.json
└── index.html               # （旧）单机离线版本，仍可用
```

---

## 一、本地启动（5 秒上手）

要求：**Node.js ≥ 18**（[下载](https://nodejs.org/)）。

```bash
cd cbti-sleep-diary
npm install
npm start
```

打开浏览器访问 [http://localhost:3000](http://localhost:3000)，先注册一个账号即可。

---

## 二、部署到腾讯云（完整流程）

### 1. 购买服务器

- 推荐 **轻量应用服务器（Lighthouse）** 或最低配 **CVM**：1 核 2G、Ubuntu 22.04 LTS。
- 在控制台 → "防火墙/安全组" → 放通 **22**（SSH）、**80**、**443**、**3000** 端口。

### 2. SSH 登录服务器并安装 Node.js

```bash
ssh ubuntu@<你的公网IP>

# 安装 Node 18（用 NodeSource 源最稳）
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

node -v   # v18.x.x
```

### 3. 拷贝代码 & 安装依赖

```bash
sudo mkdir -p /opt/cbti && sudo chown $USER:$USER /opt/cbti
cd /opt/cbti

# 方式 A：用 scp 从本机上传
# （在本机执行）
# scp -r ./cbti-sleep-diary/* ubuntu@<公网IP>:/opt/cbti/

# 方式 B：直接用 git clone（如果你已推到 GitHub/Gitee）
# git clone <你的仓库> .

npm install --production
```

### 4. 启动 & 开机自启（PM2）

```bash
sudo npm install -g pm2

# 强烈建议先设置一个高强度的 JWT 密钥（写到 ecosystem.config.js 的 env 里
# 或用下面的方式直接传入），并在所有用户都注册完后关闭注册
JWT_SECRET=$(openssl rand -hex 32) ALLOW_REGISTER=true pm2 start ecosystem.config.js

pm2 save                     # 保存当前进程列表
pm2 startup                  # 输出一行 sudo 命令，照着复制粘贴执行
```

测试一下：

```bash
curl http://localhost:3000/api/config
# {"allowRegister":true}
```

此时浏览器访问 `http://<公网IP>:3000` 应该能看到登录页。

### 5.（可选但推荐）配 Nginx 反代 + HTTPS

让用户用 `https://your-domain.com` 访问，而不是裸暴露 3000 端口。

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/cbti
```

写入：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用并申请免费证书：

```bash
sudo ln -s /etc/nginx/sites-available/cbti /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 申请 Let's Encrypt 证书
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

完成后访问 `https://your-domain.com` 即可，证书 90 天自动续期。

> ⚠️ 启用 HTTPS 后建议把 PM2 的环境变量改成 `NODE_ENV=production`，
> 这样 Cookie 会自动带上 `Secure` 标志，更安全。`ecosystem.config.js` 已默认这样设置。

### 6. 关闭注册（让账号只能由管理员手工开通）

注册完所有要用的账号后，在 `ecosystem.config.js` 里把 `ALLOW_REGISTER` 改为 `'false'`：

```bash
pm2 restart cbti-sleep-diary --update-env
```

要新增账号时，把它改回 `'true'`，对方注册完再关掉即可。
（如果你希望我加一个"管理员后台手动添加账号"的页面，直接说一声。）

### 7. 备份数据

只需打包 `data/` 目录即可：

```bash
# 在服务器上每天定时备份到 /backup
sudo mkdir -p /backup
echo "0 3 * * * tar -czf /backup/cbti-\$(date +\\%F).tar.gz /opt/cbti/data" | sudo crontab -
```

或者每个用户在前端点 **"导出 JSON"** 自助下载。

---

## 三、使用说明（给最终用户）

1. **每天早上起床后 5–10 分钟内**填写前一晚的睡眠。**不要在白天补记**，也**不要看时钟**——CBT-I 明确反对夜间反复看时间，所有时间都填"估计值"即可。
2. 时间用 **24 小时制**。跨过午夜系统会自动处理（比如 23:30 上床 → 06:45 起床 = 7h15m）。
3. 关键指标含义：

  | 缩写       | 含义     | 计算                             |
  | -------- | ------ | ------------------------------ |
  | **TIB**  | 在床时间   | 离床时间 − 上床时间                    |
  | **SOL**  | 入睡潜伏期  | 入睡时间 − 上床时间                    |
  | **WASO** | 夜间清醒时长 | 你估的总分钟数                        |
  | **TST**  | 总睡眠时间  | TIB − SOL − WASO − (离床 − 最终醒来) |
  | **SE**   | 睡眠效率   | TST ÷ TIB × 100% **目标 ≥ 85%**  |

4. **结合 CBT-I 调整**（连续记 1–2 周后开始）：
  - 平均 SE ≥ 85–90%：把"在床时间"**延长 15 分钟**
  - 平均 SE 80–85%：保持
  - 平均 SE < 80%：把"在床时间"**缩短 15 分钟**（但通常不少于 5h）
  - 同时执行刺激控制：只在困倦时上床、床只用于睡眠、卧床 15–20 分钟未睡着就起来、固定起床时间、白天不补觉。

> 以上是一般原则，具体睡眠限制方案建议在持证心理治疗师或睡眠医学专科医生指导下进行。

---

## 四、API 速查


| 方法       | 路径                     | 说明                                 |
| -------- | ---------------------- | ---------------------------------- |
| `GET`    | `/api/config`          | 是否允许注册                             |
| `POST`   | `/api/register`        | `{username, password}`             |
| `POST`   | `/api/login`           | `{username, password}`             |
| `POST`   | `/api/logout`          | —                                  |
| `POST`   | `/api/change-password` | `{oldPassword, newPassword}`       |
| `GET`    | `/api/me`              | 当前登录用户                             |
| `GET`    | `/api/entries`         | 全部记录（可选 `?from=YYYY-MM-DD&to=...`） |
| `PUT`    | `/api/entries/:date`   | 新增 / 更新某天                          |
| `DELETE` | `/api/entries/:date`   | 删除某天                               |
| `GET`    | `/api/export`          | 下载该用户全部数据 JSON                     |


所有 `/api/`*（除注册/登录/config）都需要登录；鉴权通过 httpOnly Cookie `cbti_token`（JWT）。

---

## 五、安全说明

- 密码用 **bcrypt** 哈希（`bcryptjs` 纯 JS 实现，无原生编译，腾讯云轻量服务器开箱即用）
- 会话用 **JWT + httpOnly Cookie**，前端 JS 拿不到 token，可有效降低 XSS 影响
- **JWT 密钥** 优先从环境变量 `JWT_SECRET` 读取，否则首次启动随机生成 `data/.jwt-secret`（权限 `0600`）
- 登录失败做了简单的内存级 brute-force 限速（同 IP+用户名 5 分钟 10 次）
- 用户名严格限制为 `[a-zA-Z0-9_-]{3,32}`，避免任何路径注入风险
- 文件写入使用 **临时文件 + rename** 的原子模式，避免崩溃造成数据损坏

---

## 六、关于"自动绘制图表"

应用顶部范围切换（7 / 14 / 30 / 90 天）会立刻刷新四张图：

1. **每日 SE 折线**：含 85% 目标参考线，点位按 SE 区间染色（绿/黄/红）
2. **每日 TST 折线**：直观看你睡了多久
3. **每日 SOL / WASO 双折线**：入睡潜伏 vs 夜间清醒
4. **每周平均堆叠柱状**：上半段是 TST、上面灰色阴影是"醒着的在床时间"，看清 SE 怎么"漏"出去的

如果你还想要：

- 日历热力图（GitHub 风格的"睡眠效率日历"）
- 主观评分（情绪 / 精力）相关性散点图
- 工作日 vs 周末对比柱状图

告诉我，我继续加。