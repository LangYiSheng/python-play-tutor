# 安装、启动与排查

## 目录课程包操作

将包含 `manifest.yaml` 的课程包目录放入 `data/course/`，例如 `data/course/python-town-chapter1/manifest.yaml`。设置 `REBORN_COURSE_EXCHANGE_DIR` 指向宿主机该目录，Compose内挂载到 `/app/data/course`。后台课程包页刷新列表、预览差异、确认导入。导出完成后页面显示 `data/course/export-<班级ID>-<安全课程名>-<北京时间>-<随机串>/`，可在相同班级再次选择。

当前ZIP上传关闭。历史ZIP离线校验工具保留，但新运行流程直接使用目录。迁移已有交换目录时应保留 `imports/`，使未过期预览仍可应用。交换目录包含私有答案和素材，不能由Web静态服务公开。

本手册维护安装、更新、内容交换与排查方法，不描述任何个人环境的运行状态。产品能力见[产品说明](product.md)，包格式见[内容规范](content-authoring.md)。

## 环境与数据隔离

- 容器部署使用 Docker Engine / Docker Desktop 与 Compose v2。本机开发使用 Python 3.12 或 3.13、Node.js 22；依赖分别来自 `backend/requirements.lock` 、`frontend/package-lock.json`和`admin/package-lock.json`。
- 开发仓库使用 `main`，Git操作见[仓库与开发分支](#仓库与开发分支)。开发和验收不得复用其他项目或生产的数据库、数据卷、对象存储前缀与凭据。
- 每个开发、演示或验收环境使用独立的 Compose 项目名、端口、数据库与存储。下文基础环境统一为 `pythontopia-reborn`，并显式传入环境文件。
- 同一环境的启动、更新、导入、查看日志和停止，始终使用同一组 `--env-file`、`-p` 和 `-f` 参数。启用了开发工具或转换器的环境，后续更新也要保留对应 override / profile。
- 环境文件、凭据、数据库备份、截图与 trace 放在忽略目录，不提交 Git。不要输出含凭据的完整 Compose 配置或数据库连接串。
- 更新已有数据库前，备份该环境的数据库与私有文件存储，并确认恢复方法。日常停止用 `stop`；不要用 `down -v`、删除卷或清空账号来完成升级、排查或验收。

下列 Compose 命令从仓库根目录执行；本机 Python 命令从 `backend` 执行，游戏npm / Playwright命令从`frontend`执行，后台命令从`admin`执行。

## Compose 首次启动、更新与停止

学生端 `npm run dev` / `npm run build` 的前置脚本从锁定的 `pyodide@0.27.7` 复制核心运行文件及许可到忽略的 `frontend/public/python-runtime/0.27.7/`，构建后随 Web 分发。浏览器无需访问外部 CDN；Nginx/Vite 仅为该公开静态路径提供跨源读取。不要给 `/api` 放开此设置。运行器实测使用独立 Vite 测试地址设置 `PYTHON_RUNNER_DEV_URL`，再执行 `frontend/e2e/pythonRunner.spec.ts`；本地静态文件准备并不代表所有第三方 Python 包已安装。

### Python 补全数据

`frontend/public/python-completions/` 由 `frontend/scripts/generate-python-completions.py` 用 Python 3.12 生成：模块名来自 `sys.stdlib_module_names`，成员、签名和首行说明来自 `inspect`，前端在输入 `模块.` 时按模块懒加载，不手改生成的 JSON。脚本跳过 Windows-only 模块；优先在与 Pyodide 一致的 Linux 3.12 环境重跑并提交生成物，Windows 3.12 可用于常规标准库。升级 Pyodide 或 Python 后重跑；该数据只服务编辑器提示，不改变沙箱、判题或第三方包安装限制。

### 首次启动

首次创建 `deploy/.env` 时，从 `deploy/.env.example` 复制，已有文件则保留。设置两个独立随机值 `REBORN_DB_PASSWORD` 和 `REBORN_GO_JUDGE_AUTH_TOKEN`；推荐分别使用32字节的十六进制随机值，避免数据库 URL 中的特殊字符。首次管理员按下文配置。AI和可选转换器未配置时保留空值。

```powershell
if (-not (Test-Path -LiteralPath deploy/.env)) { Copy-Item deploy/.env.example deploy/.env }
```

基础配置默认只绑定本机：Web 为 `15174`，API 为 `18081`。端口已被占用时，在新环境文件中设置其他端口，并使用新的项目名，不停止其他环境。

```powershell
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml up --build -d --wait
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml ps
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml logs --tail 100 api web
Invoke-RestMethod http://127.0.0.1:15174/api/health
```

默认入口为 `http://127.0.0.1:15174/world`，直接 API 为 `http://127.0.0.1:18081/api/health`。`/api/health` 会执行数据库 `SELECT 1`，只证明 API 和数据库连通；还要通过浏览器确认登录、世界加载、授权材料和所需外部服务。不要将 Web 返回200等同于媒体、AI或判题就绪。

`backend/Dockerfile` 的启动顺序为：`alembic upgrade head` → Uvicorn；lifespan仍做必要管理员初始化。镜像只包含程序、迁移和世界资源，不内嵌课程JSON/YAML，也不在启动时seed。空库可以启动，课程内容通过下面的显式导入准备；重建或重启不会覆盖后台当前内容。基础Compose固定为生产模式。

仓库根的 `./dev.ps1`、`./dev.sh` 是使用 `deploy/.env` 和基础 Compose 启动的简写；需要独立项目或 override 时，使用显式 Compose 命令。

### 首次管理员与后续教师账号

首次部署在环境文件设置 `REBORN_ADMIN_STUDENT_ID`（1–32位数字，保留前导零）、`REBORN_ADMIN_PASSWORD`（8–200位且不能等于工号）和可选 `REBORN_ADMIN_NAME`（默认“管理员”）。没有公开默认账号或密码。API完成迁移后，在启动阶段创建首个管理员；多个PostgreSQL进程通过事务锁串行检查。已存在管理员时跳过初始化，修改环境变量或重启都不会覆盖其密码。成功创建后可清空环境文件中的管理员密码；已有账号使用界面改密。全空配置不会创建管理员，部分配置或学号被其他角色占用则启动报错，不会提升已有学生权限。

学生使用学号登录并在“设置 → 账户”改密。教师和管理员使用工号登录，在工作台左下角的账号菜单改密。新设密码至少8位，修改后其他登录失效。

教师在“学生账号”上传UTF-8 CSV / `.xlsx`名册，核对预览后导入。表格仅一张工作表，首行为“学号、姓名”，最多500人/2MB；Excel学号必须用文本单元格，拒绝公式。初始密码为本人学号，首次登录必须修改。新生学号至少8位；历史短学号重置时，由管理员设置临时密码。重复导入本班已有学生跳过，不覆盖姓名/密码；已有正式学生按学号与姓名绑定本班并保留原密码。可选择学生批量重置密码为各自学号（撤销全部旧会话、强制再次改密）或移出当前班级（保留账号、其他班级、历史记录）。

管理员可在后台“教师管理”中创建教师账号。初始密码留空时使用工号；工号不足8位时需要自设密码。教师首次登录后须修改。也可使用以下命令创建教师。先在当前终端安全注入仅用于创建账号的 `REBORN_TEACHER_PASSWORD` 环境变量，至少8字符；不要将密码写进命令、文档或 Git。再创建自己的教师账号：

```powershell
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml exec -e REBORN_TEACHER_PASSWORD api python -m app.cli provision-user --student-id 900001 --name 教师 --role teacher --password-env REBORN_TEACHER_PASSWORD
```

命令拒绝已占用的工号。该命令用于后续教师或管理员增补（管理员用 `--role admin`）；首次管理员优先使用上述启动变量。本机 API 可直接执行同一命令。用后清除临时密码环境变量。学生账号通过教师名册导入。

后台权限端到端用例 `admin/e2e/staff-workbench.spec.ts` 使用隔离环境的 `E2E_ADMIN_STUDENT_ID` 和 `E2E_ADMIN_PASSWORD`，会创建专用教师、学生和班级以验证正式删除后的数据保留。

### 更新与停止

从邮箱账号升级前先备份数据库与私有文件。学号迁移保留历史用户和学习数据，撤销旧会话并移除邮箱字段；不会自动编造学号或清空账号。需要保留的历史账号先通过可信名册核对用户ID，再分配真实学号（只能分配给尚未设置学号的账号）：

```powershell
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml exec api python -m app.cli assign-student-id --user-id 1 --student-id 00123456
```

以上数字仅为格式示例。教师和管理员可用 `provision-user --student-id` 创建账号；登录标识使用1至32位数字字符串并保留前导零。迁移后如需回退使用升级前备份；没有邮箱兼容登录。清空本地预览账号必须单独明确环境与关联记录范围，不能将测试清理加入迁移或seed。

代码、YAML或前端构建配置变化后，重建相关镜像并启动。API 中的 YAML 来自构建时复制，`start` 旧容器或只刷新网页不会加载工作区修改。

```powershell
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml up --build -d api web
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml stop
```

`stop` 保留账号、学习记录、成绩及数据库/存储卷。修改 `shared/world/world.json` 等 API/Web 共同使用的地图配置时，同时重建 API 和 Web。

## 本机开发

### 后端

在仓库根先创建忽略的 `.tmp` 目录，选用独立数据库和存储。以下 PowerShell 示例使用仅供轻量开发的 SQLite，不会连接已有 Compose 数据库：

```powershell
New-Item -ItemType Directory -Force .tmp
$rebornRepo = (Get-Location).Path
$rebornLocalName = 'reborn-local-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$env:REBORN_DATABASE_URL = 'sqlite:///' + (Join-Path $rebornRepo ".tmp/$rebornLocalName.db").Replace('\', '/')
$env:REBORN_STORAGE_ROOT = Join-Path $rebornRepo ".tmp/$rebornLocalName-storage"
$env:REBORN_ENV = 'development'
Set-Location backend
python -m venv .venv
./.venv/Scripts/Activate.ps1
python -m pip install -r requirements.lock  # 仅准备或更新依赖时执行
python -m alembic upgrade head
# 首次演示环境按下文显式导入课程，空库也可直接启动。
python -m uvicorn app.main:app --host 127.0.0.1 --port 18081
```

首次创建环境才生成新名称；记录并保留这组数据库/存储配置，后续启动复用同一环境，不重复生成名称造成存档看似消失，也不指向归档中的旧库。已有虚拟环境可直接激活并按锁文件安装。Linux/macOS 用 `source .venv/bin/activate` 激活。生产必须使用独立 PostgreSQL；SQLite 不覆盖 PostgreSQL 的行锁和并发语义。

本机开发要使用容器 PostgreSQL 时，另准备带独立数据库密码和判题token的忽略环境文件 `.tmp/native.env`（Compose解析完整配置仍要求两者），可只启动独立项目的数据库：

```powershell
docker compose --env-file .tmp/native.env -p pythontopia-reborn-native -f deploy/compose.yml -f deploy/local-db.yml up -d db
```

该 override 只将数据库绑定在 `127.0.0.1:15433`。将本机 API 的 `REBORN_DATABASE_URL` 设置为该独立库的 `postgresql+psycopg://` 连接；不要同时让另一套 API 使用它，也不要把数据库密码写入示例源码。

### 前端

另开终端，进入 `frontend`：

```powershell
npm ci
npm run dev -- --host 127.0.0.1 --port 15174
```

显式使用 `15174` 可与默认 CORS、Playwright 地址一致。`vite.config.ts` 未覆盖时的端口是 `5178`，`/api` 默认代理至 `http://127.0.0.1:18081`；不同 API 地址通过启动终端的 `API_PROXY` 设置。直接跨域调用 API 时同步配置 `REBORN_CORS_ORIGINS`。

另开终端在`admin`执行`npm ci`和`npm run dev -- --host 127.0.0.1`，默认5179；游戏Vite将`/teacher`代理到该入口（ADMIN_PROXY可覆盖）。直接打开游戏同域的`/teacher/`，不要在游戏正在验收时重新安装依赖。

教师时间显示默认 `Asia/Shanghai`。本机后台在`admin/.env.local`设置`VITE_TIME_ZONE`，容器使用 `REBORN_TIME_ZONE` 构建参数；修改后重启开发前端或重建 Web。使用 IANA 时区名，服务端公开时间戳带 UTC 偏移。

## YAML、媒体导入与数据库迁移

### 讲稿与配音随包迁移

使用新版服务重新导出课程，已有导出目录不会自动补入后来生成的讲稿或音频。完整复制包含narrations和assets/index.jsonl的目录到目标data/course，双方服务均须支持此格式扩展。刷新、预览逐页讲稿与配音差异后确认导入；不必复制数据库、API凭据或narrations私有存储目录。草稿保留待审，已有有效音频导入即可播放，无需配置TTS重新生成。

有正在执行的讲稿/配音任务时先等待完成，异常中断任务先按合成管理流程核查。遇到音频缺失或哈希不符，修复源文件后重新导出，不能绕过校验。导入预览后若再次审校或合成，重新预览；无数据库结构迁移，已有未应用预览需重新生成。升级不重置数据，旧包缺少narrations表示未提供讲稿，不清空目标已保存讲稿。

### 复制导出课程到其他服务器

在课程包页导出后，完整复制 `data/course/export-…/` 文件夹到目标服务器实际挂载的 `data/course/` 下，保留manifest、课程定义、私有答案和assets媒体的相对路径。支持改文件夹名；不要只复制manifest，也不需要复制数据库、账号、学生进度、环境文件或包外导出凭据。目标服务器应使用支持当前格式 4 及 origin 字段的代码。

后台刷新课程包列表，选择目标班级，预览差异后确认导入。所有教师及管理员共用同一列表，均可导入，仅管理员可删除origin=exported的包；导入后各班课程独立。默认包origin缺省或为supplied，始终受保护。origin是开发人员管理服务器目录时使用的来源声明，不是签名或本机所有权凭据。

### 格式 4 课程导入班级

课程包不纳入 Git 或镜像。将编写完成的 格式 4 解压目录放入私有 data/course，在教师后台选择班级、预览目录包，核对差异后确认导入。新引擎明确拒绝旧格式，不提供 app.seed、convert_legacy_course、migrate_classroom_courses 或旧来源 initialize 接口。


### 私有交换区

Compose将`${REBORN_COURSE_EXCHANGE_DIR:-../data/course}`绑定到API的`/app/data/course`，由REBORN_COURSE_EXCHANGE_ROOT指向。Linux部署需预先创建所选宿主目录并允许API用户UID/GID10001写入；仅调整明确的交换目录权限，不递归改动数据库或其他卷。Windows Docker Desktop按共享目录权限处理。data/不入Git，Docker上下文也排除它。

imports/保存有效期24小时的导入预览目录；残留历史ZIP仅按原到期清理规则回收，不再支持应用。API启动后立即尝试清理，此后每10分钟检查一次，每轮处理最多100个已完成或过期预览；清理副本后保留数据库回执，重复导入请求仍返回原结果。无数据库引用的随机名imports副本及course-catalog/apply/preview/export工作目录在超过24小时后清理。正式导出目录、共享课程包和私有媒体继续保留。清理与导入、预览、导出共用进程间排他锁，忙碌时清理跳过本轮，失败记录日志并在后续周期重试。多API进程需共用支持文件锁的同一交换目录。数据库、媒体与需要保留的交换包分别备份。

### 把一个 ZIP 包变成可选课程包

ZIP 上传入口已关闭，已有ZIP不会被选包列表列出。手上只有 ZIP 时，在服务器上显式解压到交换目录即可（解压后的顶层必须直接包含 `manifest.yaml`）：

```bash
cd /opt/pythontopia/shared/data/course          # 换成你的 REBORN_COURSE_EXCHANGE_DIR
mkdir my-course && python -m zipfile -e /path/to/my-course.zip my-course
test -f my-course/manifest.yaml && echo READY     # 顶层没有 manifest.yaml 说明多套了一层目录
```

然后在后台刷新课程包列表就能选择它。注意两点：一是解压后目录里含私有答案，不要放到任何 Web 静态目录；二是旧预览超过 24 小时后不能激活，必须重新走一次目录预览。


### 数据库结构升级

升级到章节任务点前，先备份数据库并在副本上验证。迁移清除旧编排、活动及学生存档和作答成绩，保留课程、账号、名册、资料媒体、讲稿、知识点与题库；已有资料默认选读。回退需要恢复迁移前备份。

操作目标始终使用 `python -m alembic upgrade head`，不要复制历史记录中的迁移 ID。既有升级链包含需要在线读取数据的迁移，不能以离线 `--sql` 输出替代实际升级。升级失败先看日志和备份，不手工修改 `alembic_version`，不盲目 downgrade 或新建空库掩盖问题。

在新的独立验收数据库验证结构迁移；重复课程导入使用测试包和同一稳定 package_id，不能指向演示库：

```powershell
python -m alembic upgrade head
python -m alembic upgrade head
python -m alembic check
```

上述命令会修改所选数据库，执行前必须确认连接的是验收库。对已有学生数据的升级另核对账号、班级关系、任务事件、阅读记录、提交与成绩保留情况；内容合并类迁移不能假定可自动还原，恢复依赖升级前备份。

## 开发工具

普通学生的“开发工具”位于现有小镇菜单，由服务端授权。API 必须同时设置 `REBORN_ENV=development` 与 `REBORN_DEV_TOOLS=1` 才注册普通重置路由。教师从后台“进入小镇”取得本班的独立体验存档，其专用重置能力按身份和班级授权，使用单独接口。

需要此工具的独立开发环境显式叠加 override：

```powershell
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml -f deploy/compose.dev-tools.yml up --build -d
```

“重新开始当前班级”需用户再次确认，仅删除当前登录学生在所选已加入班级的任务、剧情、世界标记/位置、阅读、练习、测验和成绩。保留账号、成员关系、其他班级/学生、课程内容及发布安排；服务端助教会话、调用审计和预算保留，客户端恢复指针断开。操作没有自动撤销入口。

存在未完成或状态待确认的判题、仍在回复的助教调用时返回409，须等待完成或按既有流程对账。启用工具不等于执行重置；自动化验收只用新建隔离账号，不重置真实演示账号。

## 可选服务与配置

图书馆资料助教与活动助教共用下列模型配置和预算。升级到资料级会话结构前备份当前库和私有存储；执行head迁移即可，无需新建Activity、重新导入资料或重置账号。没有凭据时图书管理员入口仍保留，但真实显示不可用。

基础Compose显式传入服务所需环境配置（见 `deploy/.env.example`）；在 `deploy/.env` 里填值即生效，留空则用代码内默认。仍不在 Compose 里的两个键：`REBORN_CORS_ORIGINS`（生产同源，仅供分离源开发）与 `REBORN_CONVERTER_IMAGE`（API 直连 Docker 的另一种模式；Compose 用 `converter` 服务，配 `REBORN_CONVERTER_URL/TOKEN`）。需要额外的自定义变量时再用私有 Compose override。所有凭据只在后端配置，不进入前端构建。

### AI助教

配置 `REBORN_AI_API_KEY`、`REBORN_AI_MODEL`，按供应商需要设置 `REBORN_AI_BASE_URL`。未配置时主动提问明确返回不可用，世界、对白、翻页、概念题和进度继续工作。只有授权活动内学生主动提问才创建 `create_agent` 请求，普通操作必须保持零模型调用。

DeepSeek配置示例：在实际Compose使用的私有环境文件中设置模型、地址与密钥，模型标识以供应商实际提供的服务为准。密钥不写进源码或课程包。

```dotenv
REBORN_AI_BASE_URL=https://api.deepseek.com
REBORN_AI_MODEL=deepseek-flash
REBORN_AI_REASONING_EFFORT=none
REBORN_AI_API_KEY=
```

可选 `REBORN_AI_REASONING_EFFORT` 仅在非空时传给 Chat Completions；此配置用 `none` 关闭思考，适配现有短回复预算，其他供应商按其支持值配置或留空。官方 DeepSeek 的输出上限通过请求体 `max_tokens` 发送，避免 SDK 自动改名为 OpenAI 的 `max_completion_tokens`；仍受课程上限约束。手填 Key 后，需要重建 API 容器以重新读取环境变量，单纯 `restart` 不会加载新变量：

```powershell
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml up -d --no-deps api
```

以上模型连接环境配置仅在尚未保存后台全站模型设置时生效。管理员可在「全站设置 → 学生助教」填写 API 地址、模型和密钥，保存后无需重启。保存不调用模型，点击「测试已保存连接」才发一次短请求。缺 Key 时显示不可用。

默认每次提问最多6次助教模型调用、12次工具调用、120秒，回复最多2048 tokens，累计请求预算262144 tokens；最多另加一次摘要调用，计入实际额度。每日默认每名学生跨班共用12次提问和120000 tokens，每班全体学生共用100次提问和1200000 tokens。管理员可在学生助教设置保存每名学生的提问次数上限，下一次提问立即按新上限校验，当日已用次数仍计入额度。尚未保存该字段时读取 `REBORN_AI_USER_DAILY_REQUESTS`，未设置时使用12次。每日额度以 UTC 零点为起点，实际可用请求预算还受每日剩余额度限制。默认应用上下文上限32768、压缩触发24576，须根据供应商模型容量调整；未知模型使用保守估算。显式设置的 `REBORN_AI_REQUEST_TOKEN_RESERVATION`、`REBORN_AI_TIMEOUT_SECONDS` 仍可收紧运行上限，不再默认固定为12000/45。重启不自动重发。

后台 API Key 使用 Fernet 加密保存在独立配置表，主密钥默认 `REBORN_STORAGE_ROOT/.secrets/assistant.key`（Compose 为 `/app/storage/.secrets/assistant.key`）；可用 `REBORN_AI_MASTER_KEY_FILE` 指定私有路径。首次保存自动以独占创建方式生成，Linux权限0600，存储目录0700。备份数据库必须同时备份对应主密钥；主密钥丢失或不匹配时调用明确失败，管理员可重新填写密钥。禁止提交到 Git、放入课程包或公开文件服务；API日志和响应不输出密钥。沿用现有存储卷，无需增加容器或消息队列。升级前按数据库结构升级小节备份并迁移到head，再更新相关前端；旧聊天历史保留，新消息会补全状态。

### go-judge（默认包含，仅 Python）

`deploy/compose.yml` 默认包含 db/judge/api/web，使用前文同一条启动命令，不再有独立判题Compose、外部网络或手工填写执行URL。judge先通过健康检查（cgroups cpu/memory/pids、seccomp、非root沙箱UID），API再启动；Web等待API健康。固定go-judge v1.14.1与Python3.13镜像摘要，源码/许可与挂载配置在 `deploy/go-judge/`。

judge只接入项目内部judging网络，无宿主机端口；只有API与它共享该网络。API自动使用 `http://judge:5050`，二者共用环境文件中独立随机的 `REBORN_GO_JUDGE_AUTH_TOKEN`。四个执行槽，4CPU/1GiB上限、256MiB共享内存，默认seccomp、`-no-fallback`、不共享网络命名空间，不挂载业务文件、密钥、数据库或Docker socket。执行器privileged仅用于建立嵌套沙箱，学生程序使用UID1536。健康检查不能替代真实执行和隔离实测。

队列使用已有Submission/SubmissionPayload，无额外数据库或Redis。单API进程后台每批最多认领4份，按创建时间排序，条件更新防止重复认领。每份最多20个用例，逐个独立执行；单例CPU2秒、墙钟5秒、内存128MiB、进程16、stdout16KiB、stderr8KiB。prepared持久等待，dispatching执行中，完成直接回写结果。重启保留prepared；dispatching以及遗留queued/running转submission_unknown，旧token字段保留但不再轮询旧服务。超时、部分执行后断连及无效响应不自动重送。多API进程扩容前需要跨进程恢复租约，当前只启动一个API进程。

后端将输出的CRLF归一为LF并忽略末尾空白，内部空格和标点严格比较。私有预期输出不送执行器，仅公开样例诊断和总通过数进入学生回执。go-judge的Accepted只表示进程正常退出，不能直接当成答题正确。

在API容器中测量实际内部网络链路，不需要打开判题端口；从仓库根目录执行（项目名和环境文件替换为自己的）：

```powershell
Get-Content scripts/benchmark-go-judge.py -Raw | docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml exec -T api python - --output /tmp/go-judge-benchmark.json
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml cp api:/tmp/go-judge-benchmark.json .tmp/go-judge-benchmark.json
```

脚本检查鉴权、Python、超时/内存/输出限制、文件清理和禁网，再测1/4/8/16并发，每份5用例。自动化live测试仍通过显式 `REBORN_LIVE_GO_JUDGE_URL` 指向受控执行器；真实数据库测试必须使用独立 `REBORN_TEST_DATABASE_URL`。未知派发只能对账，不能重送或回退API宿主机执行。

### 已有分离判题环境合并

保持原项目名、环境文件及数据卷，补齐判题token后用 `deploy/compose.yml` 执行 `up --build -d --wait`。先确认新四服务健康、原卷挂载与历史记录保持，再删除已脱离API的旧独立判题容器/网络。不要用 `down -v`、全局prune或新项目名替代更新；不得重置旧失败提交/成绩。旧Judge0配置、轮询和Piston试验下载已退出当前部署。

### 资料讲解与语音合成

讲解生成使用一套独立的作者期模型配置，与助教预算分开：`REBORN_AUTHORING_AI_API_KEY`、`REBORN_AUTHORING_AI_BASE_URL`、`REBORN_AUTHORING_AI_MODEL`、`REBORN_AUTHORING_AI_VISION_MODEL`，以及可选 `REBORN_AUTHORING_AI_EFFORT`、`REBORN_AUTHORING_AI_MAX_TOKENS`、`REBORN_AUTHORING_AI_TIMEOUT_SECONDS`、`REBORN_AUTHORING_AI_DAILY_PAGES`。接口为 OpenAI 兼容的 chat completions；上述变量统一放在 `deploy/.env`（模板 `deploy/.env.example`）。管理员也可在“全站设置 → 智能体设置 → 讲稿生成 / 语音合成”分别填写连接、模型/音色与额度。每项服务未保存时读取环境初始化值；保存后以数据库配置为准，新请求生效，无需重启。未配置时审校界面显示真实不可用，不伪造讲解。

页图渲染需要宿主机或镜像内安装并可执行 `pdftoppm`（poppler）。程序先转PNG，再由Pillow压成JPEG；不要求某台机器的固定安装路径。缺少依赖或字体时应检查具体材料的渲染结果。

生成参数按实测锁定：关思考（`reasoning_effort=none`）、`max_tokens` 至少8000（输出被截断时自动按 3 倍预算重试一次；整册校准实测 8000 足够，16K 只减少重试）、`response_format=json_object`；成功判定需同时满足 JSON 可解析、正文非空、`finish_reason` 不为 `length`。开着思考时单页耗时升到15–55秒，且预算不足会返回空正文。批量校准按页窗滚动摘要，参数见 `backend/app/narration/calibrate.py`。改动 `prompts.py` 的正文会自动改变幂等键（提示词指纹参与哈希），不需要手动改版本号也不会复用旧讲解；`PROMPT_VERSION` 只用于追踪。校准每窗最多4页，携带原文/必要页图及完整讲解，开思考；输出上限取作者期配置（默认8000，后台可调到16K以上）——推理 token 计入 `max_tokens`，硬编码小值会随机返回 `finish_reason=length`。逐窗心跳。批量生成、全篇校准与音频批量只入队（202 `{job}`），由 lifespan 里的 `narration/jobs.py` worker 在线程中执行（`httpx.Client` 是同步的，放事件循环会卡住其它接口），请求不再等待；游标与合并结果逐窗落库，整册输入未变时直接复用上次完整报告，不再调用模型。测试用 `run_jobs` fixture 直接驱动队列，不启动线程也不连真实库；worker 每 2 秒扫一次队列，最多三份资料并行，同一资料仍由资料锁串行。视觉模型整轮固定，供应商前缀缓存靠“稳定前缀 + 可变尾部”的固定结构命中，命中数记在报告 `usage`。发图阈值集中在 `narration/input_policy.py`（校准：小于60字发图；生成：演示文稿小于60字、PDF小于200字），它参与整册指纹，改阈值等于换输入，旧报告不会复用。模型超时单独报“N 秒内未返回”，与普通请求失败区分。

服务配置复用加密配置存储：学生助教记录1、讲稿记录2、语音记录3，修订互相独立。空密钥输入保留原值，显式清除后不会回退到环境密钥。密钥与主密钥文件必须配套备份；配置不进入课程包。端口、存储、文档转换和转码参数继续是部署配置，集中在同一 env，不通过普通教师表单改变基础设施。

### 语音合成现状

项目使用云端语音，配置入口见上方“资料讲解与语音合成”；当前支持的协议及参数见环境模板和后台配置。仓库不提供自托管语音镜像，部署者需在自己的授权环境验证音质、格式和容量。

### PPT / PPTX转换

容器服务配置 `REBORN_CONVERTER_URL=http://converter:8090` 和随机、至少24字符的 `REBORN_CONVERTER_TOKEN`，使用 documents profile：

```powershell
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml --profile documents up --build -d
```

API 与 converter 通过私有 conversion 网络通信，转换器使用受限的 LibreOffice 容器。缺少转换服务时，可提取正文的 PPTX 支持[按页阅读文字](content-authoring.md#媒体与安全)。开发环境在 Windows 上可显式设置 `REBORN_LOCAL_PPT_PREVIEW=1`，启用禁用宏的本机 PowerPoint 或 WPS 生成 PDF。配置了隔离转换服务时优先使用该服务。

本机 API 可选择一次性 Docker 转换模式：先构建 `deploy/converter`，设置 `REBORN_CONVERTER_IMAGE=pythontopia-reborn-converter:local`，保持 `REBORN_CONVERTER_URL` 为空。此模式需要本机 Docker，并由代码启动禁网、非 root、只读输入、512MiB/1CPU/pids64限制的唯一容器。

```powershell
docker build -t pythontopia-reborn-converter:local deploy/converter
```

### 私有文件存储

默认使用 `REBORN_STORAGE_ROOT` 本地私有目录，Compose 挂载独立的 `reborn-storage` 卷。S3模式设置 `REBORN_STORAGE=s3`、`REBORN_S3_ENDPOINT`、`REBORN_S3_BUCKET`、独立 `REBORN_S3_PREFIX`，凭据走后端 AWS 标准环境。禁止复用旧项目对象前缀。

普通上传默认上限128MiB，可由 `REBORN_MAX_UPLOAD_BYTES` 调整。PDF/文本解析在独立进程执行，超时25秒；Linux另有限制CPU15秒、内存512MiB，Windows不具有同等进程内存限制，正式部署使用Linux容器。存储文件可访问不等于资料已授权、转换就绪或学习目标已完成，应同时核对材料状态和班级权限。

## 检查与浏览器验收

服务器IP或域名的HTTP测试部署属于非安全上下文，与localhost不同。请求UUID统一由前端`shared/uuid.ts`生成：原生`crypto.randomUUID`不可用时使用`crypto.getRandomValues`生成UUID v4。更新兼容修复后需重建并替换Web镜像、刷新页面；无需数据库迁移。正式部署仍应在入口配置HTTPS以保护登录和会话传输，UUID兼容不提供传输加密。专项`httpUuid.spec.ts`使用非localhost的HTTP页面验证此路径，不需要启动业务服务。

Docker API 入口在启动服务前执行 `alembic upgrade head`。共享课程迁移原位保留内容 ID，每个旧班配一门课程，没有课程的旧班创建同名空课。正常启动不导入课程包。升级前应备份数据库和私有文件；回退至一班一课版本需要恢复升级前备份。

## 基础检查

先完成一轮功能实现，在合并或交付前集中验证、修复问题，复测稳定后再合并；直接在main开发也需在功能交付前完成这一步。阶段性编辑或提交不要求重复全量测试。默认选择覆盖改动及直接影响范围的最小、稳定测试集；通过后无新变化不重跑。

| 改动范围 | 默认验证范围 |
| --- | --- |
| 文档 | 一致性、链接/锚点、`node scripts/check-docs.mjs`及`git diff --check` |
| 单个前端功能 | 对应组件或功能测试、涉及文件的lint；类型或构建链受影响时再检查对应端类型/构建 |
| 单个后端功能 | 对应pytest用例及涉及文件的Ruff；影响类型约定时增加相应类型检查 |
| 公共逻辑、接口或多模块联动 | 扩展到实际调用方、权限和关键交互回归，必要时执行相关浏览器专项 |
| 数据模型、迁移或课程导入 | 隔离环境中的相关迁移、数据保留和幂等用例；适用时重复升级或导入 |

修复后先复测失败用例及相关回归；全量套件只在影响广泛或定向检查不足以覆盖风险时运行，不通过删用例、放宽断言来制造通过。依赖未变且环境可用时不重装；新环境、锁文件变更或缺失依赖时才按锁文件安装。

以下命令保留作完整检查入口，按上述范围选用，不是每次提交的必跑清单。需要时从受影响的`frontend`或`admin`执行：

```powershell
npm ci  # 仅首次准备、锁文件变化或环境缺失时执行
npm run check
```

`check` 依次执行 lint、完整单元测试（最多2个worker）和带类型检查的构建；不再额外重复同一类型检查。局部改动优先指定测试文件或用例，只运行相关检查；只有影响两个前端时才同时验证两端。

后端使用独立虚拟环境；局部改动按测试文件或用例选择pytest并指定Ruff范围。确需完整后端检查时，从`backend`执行：

```powershell
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
python -m pip install -r requirements.lock  # 仅准备或更新依赖时执行
python -m ruff check app tests
python -m mypy
python -m pytest -q --durations=10 --basetemp .pytest-local
```

新增或修改的 Python 代码要写完整类型声明：参数、返回值、容器元素（`list[str]` 而不写 `list`），跨模块传递的结构用 `TypedDict` 描述，不用裸 `dict`。`requirements.lock` 同时锁定运行与验证依赖（包括 mypy）：

```powershell
python -m pip install -r requirements.lock  # 仅准备或更新依赖时执行
python -m mypy          # 读取 pyproject 里的 [tool.mypy]，当前只检查 app/narration
```

`[tool.mypy]` 先只对 `app/narration` 开启严格检查（`disallow_untyped_defs`、`check_untyped_defs`、`warn_return_any`），其余模块尚未注解，全量打开会淹没真问题。让某个旧模块也纳入时，把它加进 `files` 并先补齐注解，不要直接放宽全局设置。涉及该包的类型约定时执行此检查；未改依赖且环境可用时无需重新安装。

Windows测试进程显式使用UTF-8，避免旧夹具的默认文本读取采用系统GBK；这些设置只影响当前终端及其子进程，不修改系统语言。pytest临时目录保持在项目忽略目录内。

自动化测试使用 backend/tests/source_fixtures.py 和 tests/fixtures/teaching-scripts 的合成课程，不代表原教材正确。fixture_seed/fixture_package/fixture_instances 仅位于 tests，不是运行导入入口。浏览器测试包通过 PYTHONPATH=tests 调用 fixture_package 生成格式 4 目录，放入独立交换区；课程包 ID 通过 REBORN_E2E_COURSE_PACKAGE 指定。涉及迁移或导入时，在全新隔离数据库执行相应升级、重复升级或重复导入检查。PostgreSQL并发专项需要显式 `REBORN_TEST_DATABASE_URL`，测试会创建临时 schema 并清理，不能指向真实演示库或生产库。当前live判题使用 `REBORN_LIVE_GO_JUDGE_URL` 和 `REBORN_GO_JUDGE_AUTH_TOKEN`；未配置的外部专项应记录为跳过。

后端通用db夹具每次测试复制独立的SQLite内存库，只将合成建表和seed准备一次；测试中的提交、删除和Session均隔离。涉及相应改动时，真实迁移、重复seed和PostgreSQL锁验证独立执行，不用快照代替这些断言。默认串行，不依赖未锁定的pytest-xdist；实际耗时与机器、启用专项有关。

本项目不使用GitHub Actions，本机验证按上表选择。真实模型、TTS、判题及外部存储的集成验证需具备对应环境与授权；缺少条件时如实说明跳过。

地图/素材相关修改从仓库根检查：

```powershell
node scripts/generate-library.mjs --check
node scripts/validate-world.mjs
node scripts/audit-assets.mjs
```

文档改动从仓库根运行链接、锚点与归档完整性检查，再检查差异格式：

```powershell
node scripts/check-docs.mjs
git diff --check
```

纯文档整理只记录这些实际运行的检查，不将既往功能、外部服务或浏览器结果作为本轮重新验收。

`town_hub.json` 的生成入口为 `scripts/generate-maps.mjs`，图书馆为 `scripts/generate-library.mjs`；实际生成会写文件，不能用来替代只读检查。资源存在审计只证明文件存在，不证明视觉排版或真实渲染已经通过。

### 浏览器环境与专项

已知待核实项（记录于2026-11-16，本次文档整理未重跑）：学生浏览器用例assessmentPaper仍引用已移除的禁用按钮，narrationLearning仍使用旧material_id请求字段。相关套件不能视为全通过；修改对应功能时需先核对现行界面与契约，再修复用例并定向验证。

Playwright不会自动启动服务器。先准备独立验收数据库、媒体/交换目录及专用教师账号，设置E2E_URL、ADMIN_E2E_URL（同域入口）、E2E_TEACHER_STUDENT_ID、E2E_TEACHER_PASSWORD。跨教师权限另需E2E_OTHER_TEACHER_STUDENT_ID/PASSWORD。将解压后的完整测试包放进隔离交换目录，设置 REBORN_E2E_COURSE_PACKAGE 为清单的 package_id。学生用例先创建课程、显式导入，再开班并开放测试章节。后台包往返测试在同一隔离环境运行，测试进程的 REBORN_COURSE_EXCHANGE_ROOT 指向可访问的交换目录。

本机浏览器验收使用 tests/fixture_package 生成格式 4 合成测试包并解压到隔离交换目录，再启动API、React和Vue。依赖在启动服务器前安装，浏览器运行期间不要执行npm ci。后台e2e在admin指定相关测试文件执行；游戏按下方专项表选择用例，只有需要完整浏览器回归时才不指定文件。

浏览器尚未准备或版本变更时安装匹配版本。以下为`frontend`完整浏览器回归入口，局部改动优先使用后面的专项命令：

```powershell
npx playwright install chromium
npm run test:e2e -- --project=desktop --workers=1
```

也可将 `PLAYWRIGHT_CHANNEL=chrome` 指向已安装的Chrome。默认门禁为桌面Chromium、1920×1080，文字偏好100%–200%；额外小屏/手机视口仅在显式E2E_EXTRA_VIEWPORTS=1时运行，不作为默认提交前门槛。PYTHON_RUNNER_DEV_URL指向已准备Python运行时的Vite，公开样例真实WASM验证需显式启用该变量。资料转换测试必须启动API生命周期中的资料处理worker，并使用独立存储目录，不能用lifespan=off后把一直排队误认成业务失败。

| 专项 | 前置条件与命令（在 `frontend`） |
| --- | --- |
| 唯一主线、刷新续玩、账号隔离 | `npx playwright test rebornJourney.spec.ts storyChapter.spec.ts --project=desktop --workers=1` |
| 练习与不可重复整卷交卷 | `npx playwright test assessmentPaper.spec.ts --project=desktop --workers=1` |
| 交互练习题模板、草稿、重置、助教快照及保存校验 | `E2E_VITE_URL` 指向本地学生端 Vite 服务，在 frontend 运行 `npx playwright test interactivePractice.spec.ts --project=desktop --workers=1`。教师端在 admin 运行 `npx playwright test interactive-practice.spec.ts`。学生题卡与发送流程由 `frontend/tests/interactivePracticeWorkspace.spec.ts` 覆盖，授权、快照及模型工具由 `backend/tests/test_assistant_interactive_state.py` 覆盖。 |
| 地图、工作区、焦点、200%字号 | `npx playwright test worldConfiguration.spec.ts uiUsability.spec.ts --project=desktop --workers=1` |
| 真实课程媒体、学习规则、页面样式 | REBORN_E2E_COURSE_PACKAGE本身含真实PDF/视频，显式设置`E2E_COURSE_MEDIA_IMPORTED=1`；运行 `npx playwright test courseMediaPack.spec.ts learningRules.spec.ts gameDesign.spec.ts townWorkspaces.spec.ts --project=desktop --workers=1` |
| 所有原始视频首帧 | 在媒体前置条件上额外设置 `E2E_ALL_COURSE_VIDEOS=1`，运行 `courseMediaPack.spec.ts`；首帧不代表完整逐段播放 |
| 开发重置 | 隔离开发环境显式设置 `E2E_DEV_TOOLS=1`，运行 `devTools.spec.ts --grep-invert production`；只作用于测试创建的学生 |
| 生产禁用开发工具 | 独立生产配置的 `E2E_PRODUCTION_URL`，及 `E2E_PRODUCTION_TEACHER_STUDENT_ID/PASSWORD`（缺省使用测试教师变量），运行 `devTools.spec.ts --grep production` |
| 自制PPTX上传转换 | `ADMIN_E2E_PPTX` 指向明确提供的自制测试文件，转换服务就绪，在admin运行`media.spec.ts` |

表中简写的测试文件同样通过 `npx playwright test` 执行。缺少条件的用例可能跳过；不得把跳过、契约模拟或“服务可连通”记录为实际外部服务成功。

长旅程验收时冻结源码或使用编译后的独立Web，避免HMR刷新干扰。截图、trace使用忽略的 `frontend/test-results`、`frontend/playwright-report` 或 `.tmp-*` 输出目录；Vite已排除这些目录，避免trace中的HTML触发整页重载。必须实际查看截图，核对布局可读、目标可达、地图标记位置、单一世界画布、焦点与回到小镇、普通操作零模型调用。测试新增任务使用私有定义，不恢复旧主线。

`node scripts/load-world.mjs` 需要显式 `REBORN_LOAD_TOKEN` 和 `REBORN_LOAD_CLASSROOM`，可通过 `REBORN_LOAD_URL` 选择隔离API；默认200次请求、10并发，仅测已登录世界读取，不能作为学生AI或判题并发能力的证明。

交付回复说明实际通过、失败、跳过及未验证范围；需要长期留存时将日志与交接信息保存在本地忽略目录。公开手册不追加个人运行状态、测试次数或备份路径。

## 常见故障

外部模型、TTS、S3、PPT/PPTX转换及go-judge的可用性与隔离能力必须在目标环境验证，历史本机结果不构成新部署保证。容量需按实际班级与AI/判题负载测试，单账号世界读取不能代表这些服务的容量。

| 现象 | 先检查 |
| --- | --- |
| Web能打开，但API/登录失败 | 同项目 `ps`、API日志和 `/api/health`；区分镜像构建、数据库迁移、代理与账号问题 |
| 端口被占用或启动到了另一环境 | 环境文件、项目名和端口；给新环境换端口，不停止无关服务 |
| YAML修改不生效 | 校验是否通过、是否在后台完成目录包预览并确认导入、挂载来源与目标数据库是否正确；重建API不再自动导入内容 |
| 页面显示旧地图或旧前端 | API/Web共同配置是否同时重建，Web镜像和浏览器缓存是否更新 |
| PDF/视频缺失或无权限 | 是否显式导入材料包、导入的数据库与存储是否一致、章节是否开放；文本测试夹具不包含原教材媒体 |
| 助教不可用或回复中断 | 后端模型凭据/预算、活动授权和真实供应商状态；中断不自动重发，不能用假回复替代 |
| 判题排队、未知或执行失败 | go-judge健康、鉴权、数据库队列与隔离环境；未知状态先对账，不重复送交或在API主机执行 |
| PPT转换失败 | converter profile、私有token、URL/镜像模式、原文件和处理限制；失败必须保持可见 |
| 没有开发工具或重置返回409 | API两个显式开关、学生身份、班级关系与未完成判题/助教；不通过前端改状态绕过 |
| Playwright首次运行失败 | 浏览器安装、`E2E_URL`、专用教师凭据、服务/媒体前置与用例skip原因；不要误报为业务失败或成功 |
| 迁移失败或升级后资料异常 | 保留日志，核对所选库、锁文件、在线迁移条件与备份；不要删库、改迁移标记或覆盖学生记录 |

## 课程包离线清单预检

该CLI只检查已解包、静止的私有目录中的manifest与资源清单，不连接数据库、不导入课程、不解压归档。运行前完成文件复制并停止其他进程修改该目录；这不是面向不可信并发写入者的上传隔离器。目标包布局见[内容规范](content-authoring.md#班级课程完整包设计)，原course-pack-43不是新格式，不能直接用作完整包。

从backend目录，使用已安装requirements.lock的Python环境执行：

```powershell
python -m app.course_packages.manifest --check 'E:/course-exchange/my-course'
```

路径仅示例，应改为自己准备的私有包目录；无需设置数据库或模型凭据。成功退出0，JSON包含preflight_ok=true、scope=manifest_and_assets、content_validated=false、importable=false及文件/资源数量。失败退出2，错误JSON写stderr；不会输出资源正文和私有答案。成功只表示本层校验通过，不允许据此激活或发布。

当前字段、资源格式、限额及未覆盖范围见[预检契约](content-authoring.md#清单与资源预检契约)。

## 旧数据库升级前置条件

迁移 ea30c9b172f4 要求旧 NPC 表为空，只修改结构，不转换旧课程。它不会自动清空数据，也不提供旧格式运行。未授权清理的环境须停止升级并保留备份，不得套用本机测试清理操作。


课程包导出文件夹名称见[目录课程包操作](#目录课程包操作)，既有目录可继续选择，但清单及内容必须通过当前格式校验。

角色图片清理与课程交换清理共用启动/每10分钟后台周期。角色保存事务提交后立即尝试清理退休图片，失败保留在课程私有状态队列重试；未提交上传超过24小时过期。文件只允许清理所属课程的 characters 前缀，系统素材不参与清理。

课程设置升级至 f318a72c90de：先备份当前环境，再执行 alembic upgrade head；一次性将存储字段 library_npc_id 改名为 default_npc_id，并允许 activities.npc_key 为空。旧包不会转换，需更新 assistant/settings.yaml 后重新校验。不要为兼容旧包恢复旧字段。私有包与媒体不入Git，导出目录按课程交换规则保留或清理。

## Python 浏览器运行验证

公开样例首次运行需要加载本地 /python-runtime/0.27.7/ 固定运行时；不可用时显示加载错误，不回退到服务端运行。标准输入输出与基础 Python 为支持范围，本机耗时不等同于正式判题耗时。运行 Vite 后，设置 PYTHON_RUNNER_DEV_URL 指向 Vite 地址，执行 frontend/e2e/pythonRunner.spec.ts；测试验证真实 WASM、超时、取消和 API 网络隔离。练习正式提交复用浏览器运行时评测公开样例，保存完成回执且不进入后台评测管理；测验评测按 go-judge 小节部署独立 Linux 隔离服务。新增迁移 c421b8e091aa 只增加提示及初始代码字段，保留提交记录。Windows 测试设置 PYTHONUTF8=1 并为 pytest 指定工作区内独立 basetemp。

## 评测管理与故障排查

迁移 d729fa031b62 增加judge_service与submission_diagnostics，初始化全站派发开关，不回填或重跑旧提交。先备份当前数据库，再执行alembic upgrade head；新部署直接迁移到head。

后台进入“评测管理”：先检查连接状态、检测时间、队列处理器心跳，再按学生或提交编号查看详情。管理员可立即检测；维护前填写原因并暂停全站派发，等待正在执行的任务结束，处理服务后检查连接并恢复。暂停状态跨API重启保留，恢复不会重判已有成绩。不可用期间新提交保留prepared，UI显示等待；浏览器样例仍可运行。

结果待核查表示请求可能执行但完整回执缺失，不能盲目重送；保存提交编号并核对服务事件、已记录用例与部署日志。页面只展示业务诊断和受限健康事件，不展示Docker原始日志或提供重启容器按钮。宿主机故障、自动告警、历史日志回填和人工改分/重判均不属于当前管理能力。私有输出与代码属于教学数据，应随数据库备份保护，不放入公开日志或AI提示。

评测页默认查看近七个自然日（含今天），可改为近一天/三十天、自定义日期或全部时间。后台日期以VITE_TIME_ZONE为准；历史异常超出所选范围后不计入卡片，仍可用“全部时间”查回。查看老待处理任务时，同时核对不受筛选影响的全站实时队列。服务事件只保留最近50条，日期筛选不承诺恢复更早事件。日期筛选不清理业务数据。

## 级联删除维护

更新到e831ab247c90前备份当前数据库并保留私有媒体卷；沿用现有Compose项目运行迁移，不重建数据库卷。迁移新增七类定义的deleted_at、当前章节排序条件唯一索引和content_deletion_previews，不改学生证据。SQLite测试迁移重建章节表时暂时关闭外键，恢复后执行完整外键检查；正式PostgreSQL事务内升级。此迁移不可无损降级，恢复需使用隔离备份。

排查删除失败先查看预览blockers、过期和课程修订；确认冲突应重新预览，禁止绕过为直接SQL删除。历史评测已使用include_deleted读取；其他默认ORM查询只读当前内容，显式历史查询必须另行校验用户与班级。历史私有文件和已移除稳定ID继续保留，不能按“当前页面看不到”当作无用数据清理。删除预览和成功回执持久保存，本版未加入自动回收、恢复或永久清除入口。

迁移链当前 head 为 `b7e4c2a9f1d3`，合并 page_contents、交互练习与主链；更早的 `a52e901c7d41` 合并仍保留，不改写历史迁移。任一分支数据库升级前备份，然后执行 `alembic upgrade head` 与 `alembic check`。没有 `alembic_version` 的既有库不要直接 upgrade（会因表已存在失败），先按实际 schema stamp 到对应 head 再升级。旧讲解因缺少新资料指纹会失效，保留正文、审校记录与学生历史，需教师重新核对；不会自动重生成或消耗模型额度。


### 语音配置示例与任务排查

管理员在全站设置的智能体设置的语音合成标签切换协议或填入示例，核对后保存。DeepSeek官方示例为基础地址 `https://api.deepseek.com`、音色 `stella` 或 `tide`、WAV/PCM，无模型字段和合成调速；依据[官方语音指南](https://api-docs.deepseek.com/zh-cn/guides/tts/)。接口路径由服务端统一拼接；已填写完整 `/v1/tools/tts`、`/v1/audio/speech`、`/api/v1/services/audio/tts/SpeechSynthesizer` 或 `/v1` 的地址不会再次重复拼接。阿里百炼原生接口示例：基础地址 `https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com`、模型 `qwen-audio-3.1-tts-flash` 或 `cosyvoice-v3-plus`、音色按控制台填写，格式 mp3/wav/pcm/opus，语速 0.5–2；接口返回 JSON 中的音频 URL，服务端会再下载。语音设置页会从兼容接口拉取 TTS 模型并合并内置列表，音色提供内置常用中文列表、也可直接填复刻音色 ID；保存后可点「测试已保存连接」发送一次短合成请求验证地址、密钥与音色。自定义服务地址及API Key不会因切换协议被自动覆盖，明确填入示例只更新非密钥字段；测试只发送一句短合成请求，不保存音频，也不会自动定时探测。

资料合成管理分正在执行与历史记录，按每次执行排查进度与失败页；仅最新且参数完整的明确失败可确认重试，旧次或中断结果先核查。b72c49e018a3新增narration_runs并回填narration_jobs中实际保留的非idle记录，之后每次执行、重试独立留存。升级前备份数据库并确认没有正在执行的任务；不自动派发、重置或伪造历史，继续复用现有请求及逐页提交机制。

## 体验开发工具验收

迁移到head后，从小镇菜单打开开发工具。普通学生需development和REBORN_DEV_TOOLS=1；生产教师使用后台“进入小镇”创建的本人隔离体验身份。先保存检查点，再定位章节/内容或预览任务阶段；确认前核对当前账号班级。定位阶段回到出生点，目标角色按当前节点继续剧情。检查点不回退正式提交、成绩与聊天，课程变更会失效。

回归覆盖backend/tests/test_experience_tools.py、frontend/tests/experienceTools.spec.ts及原重玩/剧情/账号切换测试。使用新建隔离班级/账号执行内容定位→保存→阶段定位→恢复→继续学习；不得重置演示账号。迁移与重复导入在独立数据库进行，生产环境的普通学生重置路由必须缺席。

### 操作节点提示清理

升级前备份当前数据库，然后运行 `alembic upgrade head` 与 `alembic check`。迁移 d74e90bc21a6 一次性移除 action.text：已发布包中图书馆/日志的确切重复提示直接删除，其他实质文字改为保留原节点 ID 的对白并连接新操作节点，因此入口、连线与存档位置不丢失。不修改会话、任务进度、成绩或消息。受影响课程 revision 递增，旧编辑草稿需刷新，既有体验检查点按定义变更规则失效。拆分超过200节点时升级中止，先整理流程，不静默截断。回退使用升级前备份，不恢复运行时兼容分支。

格式 4 课程包携带章节内容和教学资源。固定对白及地图由平台提供。私有包及数据库备份不入 Git。

## 模块边界检查

目录和依赖归属见[架构](architecture.md#模块组织与依赖边界)。整理或新增模块后执行：

```powershell
node --test scripts/tests/module-boundaries.test.mjs
node scripts/check-modules.mjs
python -m unittest discover -s scripts/tests -p "test_*.py"
python scripts/check-python-imports.py
```

模块拆分或依赖关系变化时在本机运行此检查，不使用自动流水线。Python 检查只静态读取 `backend/app`，包含函数内导入、常量动态导入、循环依赖与跨模块私有访问，不加载应用或连接数据库。边界违规阻断，行数与压行只提醒复核职责；其他验证按[基础检查](#基础检查)选择受影响模块。删除旧路径时同步真实调用、测试模拟和命令，不用兼容转发遮蔽缺漏。

## 多资料活动升级

升级前停止写入并备份数据库、私有存储和课程目录，先在隔离副本演练迁移。`e51b92fa60c3` 将旧单资料关联及学习要求、已读页、位置、有效体验检查点迁入当前结构；旧已失效检查点不重新激活。数据库原成绩、任务和会话不重置。此迁移不可无损降级，回退使用升级前的完整备份，不运行 seed 覆盖已有课程。随后执行 Alembic 元数据检查，逐表比较未变更数据，并验证活动资料对应关系和学习记录。

课程目录清单格式为3。此前格式2私有目录先复制备份，再将活动 `material_id` 及 `content.learning/completion` 转为单项 `resources`，其他资料、媒体和答案不变；完整语义校验通过后使用。学生实测须用隔离班级/体验账号，不能重置演示学习记录。

## 仓库与开发分支

当前仓库为 [LangYiSheng/python-play-tutor](https://github.com/LangYiSheng/python-play-tutor)，开发分支是 `main`，跟踪 `origin/main`。已有开发目录继续原地使用，新环境按以下方式获取：

```sh
git clone https://github.com/LangYiSheng/python-play-tutor.git
cd python-play-tutor
git pull --ff-only
```

日常提交后使用 `git push` 推送到 `origin/main`。保留当前环境配置、数据库与私有课程，变更Git管理关系不构成部署或数据操作授权。


### 提交格式

提交格式以[协作约定](../AGENTS.md#协作与提交)为准。提交前核对分支、差异和暂存范围；功能交付前按[基础检查](#基础检查)测稳，不把阶段性提交当成全量测试触发器。

### 查询库与API文档

库、框架、SDK、API和CLI的用法问题先使用Context7查询当前文档；普通业务逻辑分析、重构和文档措辞整理无需查询。

1. 在沙箱外执行`npx ctx7@latest library <官方库名> "<具体问题>"`，按官方名称、相关性与来源质量选择返回的库ID。
2. 执行`npx ctx7@latest docs <返回的库ID> "<具体问题>"`；已有明确库ID时可直接查文档，版本问题使用返回的对应版本ID。
3. 每个问题最多3次命令，不在查询中携带凭据。配额错误如实说明，可使用`npx ctx7@latest login`或配置`CONTEXT7_API_KEY`提高限额；网络或DNS错误确认在沙箱外重试，不静默以记忆冒充查询结果。
