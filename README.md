# Pythontopia Reborn

当前开发仓库：[LangYiSheng/python-play-tutor](https://github.com/LangYiSheng/python-play-tutor)，默认分支 `main`。开发与 Git 约定见[开发手册](docs/development.md#仓库与开发分支)。

面向 Python 初学者的像素学习 RPG。学生在小镇与人物交谈、接取任务、读课件和完成真实练习；教师通过后台管理班级、材料、任务、发布规则与学习记录。

学生游戏使用 Vue 3 + TypeScript + Phaser 3，教师后台使用独立 React + TypeScript + shadcn/ui；两者共用 Python FastAPI 模块化单体。正式存储为独立 PostgreSQL；本机轻量开发可使用 SQLite。普通游戏行为不调用大模型，学习场景的主动提问使用统一 LangChain create_agent。正式代码执行使用同一 Compose 内的独立 Python-only go-judge 容器。

功能实现后按[开发手册](docs/development.md#基础检查)做最小范围的本机验证，修复问题、测稳再合并或交付；不随阶段性提交反复跑全量，本仓库不使用GitHub Actions。

## 运行

本机轻量开发可使用SQLite，正式部署必须配置独立PostgreSQL。后端与前端均使用锁定依赖，没有默认教师账号，需显式创建。启动不自动导入课程；课程包与教学配置由管理员显式导入，资料和题目通过后台独立维护。

容器配置与完整本机命令见 [开发说明](docs/development.md)。本机开发与独立 Compose 部署均可使用，各环境使用独立数据库和存储。开发重玩工具需要显式双开关，生产环境不注册重置路由。

从 `deploy/.env.example` 准备私有 `deploy/.env`，设置数据库密码、判题鉴权token和首次管理员信息后，一条命令启动完整基础系统：

```sh
docker compose --env-file deploy/.env -p pythontopia-reborn -f deploy/compose.yml up --build -d --wait
```

默认包含 `db / judge / api / web` 四个服务；判题没有宿主机公开端口，队列使用已有数据库，不另加 Redis。PPT转换器仍通过 `documents` profile按需启用；课程内容由教师显式导入，AI需单独配置凭据。

项目能力见[产品说明](docs/product.md)，开发任务从[文档索引](docs/README.md)查阅需求与对应规范。

## 当前教学流程

学生通过小镇角色完成阅读、练习与测验；教师维护班级课程和教学流程。详细能力及支持范围见[产品说明](docs/product.md)。

支持导入课程包的7份PDF课件与34段视频，保留材料和页面编号；媒体保存在私有存储，不随Git分发。教师也可上传有权使用的材料。缺少媒体、模型凭据或判题服务时如实显示不可用，配置和目标环境验证见[开发手册](docs/development.md#可选服务与配置)。

## 目录

```text
backend/        FastAPI、领域模块、Alembic、依赖锁与测试
frontend/       Vue学生世界、统一工作区与浏览器验收
admin/          React、TypeScript、shadcn/ui 教师后台与流程编辑器
shared/world/   随程序发布的地图、建筑、入口及固定对象目录
data/course/    私有课程交换与外部来源（不纳入Git）
assets/         保留素材源及上游署名、授权记录
scripts/        地图生成、资源/可达检查与限定负载脚本
deploy/         完整四服务Compose、Python判题沙箱与可选文档转换器
docs/           当前需求、产品/技术规范与操作手册
```

代码和美术按 [LICENSE](LICENSE)、[LICENSE-ART.md](LICENSE-ART.md) 及各素材原许可执行，保留原署名和来源。
