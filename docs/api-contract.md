# HTTP接口契约

All routes use /api. JSON fields use snake_case. Bearer session authentication is required except auth/login and health. Student requests carry explicit classroom_id. Public registration is closed. Errors return detail; malformed inputs return422. All public timestamps include an explicit UTC offset; release inputs must carry a timezone and are normalized to UTC before storage.

## Session and classes

- Public user fields additionally include `must_change_password`. POST /auth/password {current_password?,new_password} requires an authenticated session and an 8–200 character new password different from the login identifier and current password. Only accounts with server-side `must_change_password: true` may omit `current_password`; other accounts must provide and validate it. A supplied current password is always validated. The operation atomically revokes all sessions and returns a new {access_token,user} session for this client. Login accepts 1–200 characters so existing credentials keep working. Newly set passwords use the common length rule. Temporary-password accounts may only call /auth/me, /auth/password and /auth/logout until changed; other authenticated endpoints return403.
- GET /teacher/classrooms/{id}/students returns student roster {id,student_id,name,must_change_password,disabled}. POST same path {students:[{student_id,name}]} atomically creates 1–500 students and memberships, returning {created,bound,existing}; new student IDs must be at least 8 digits because they also serve as temporary passwords. Existing classroom students are skipped without modifying credentials; existing regular students can join the class while keeping their credentials. Staff and preview IDs reject the entire request. Concurrent duplicate writes return409 without partial creation.
- POST /teacher/classrooms/{id}/students/import-preview accepts multipart `file`: UTF-8 CSV or XLSX, 2MB, at most500 students, exact columns 学号/姓名. One worksheet, text student IDs, no formulas; bounded archive expansion. Returns {students:[{student_id,name,action:create|bind|existing}]}; preview is read-only, confirmation uses the create endpoint and revalidates authorization and conflicts.
- POST /teacher/classrooms/{id}/students/batch {student_ids:[string],action:reset-password|remove} accepts1–500 student IDs and returns {affected}. Only students already in the owned classroom may be targeted; any invalid target rejects all changes. Reset sets each password to their own student ID, revokes sessions and requires password change. A shorter legacy ID requires a custom temporary password from an administrator. Remove only deletes this membership, preserving accounts, other classrooms and learning evidence. Teachers cannot reset staff passwords; all staff change their own password with the old password.
- POST /teacher/classrooms/{id}/town-session creates or reuses a dedicated student identity for the authenticated teacher and selected classroom, then returns `{access_token,token_type,user}` with `user.town_preview: true`. Access requires classroom management and an installed course. The token can play only in the bound classroom and depends on the issuing teacher session remaining valid. Teacher logout, password changes, account suspension and loss of classroom access revoke preview access. The preview identity is omitted from class membership and teacher learning statistics. It cannot log in with a password or join additional classes.

- POST /auth/login {student_id,password} -> {access_token,user:{id,student_id,name,role,dev_tools_enabled}}. GET /auth/me returns the same public user fields; POST /auth/logout. `student_id` is a string of 1–32 ASCII digits, trimmed at the boundary, preserving leading zeroes. All roles use this field, interpreted as the work number for staff. The database enforces uniqueness across roles. Invalid credentials and disabled accounts return 401. The former POST /auth/register route returns 404. Unassigned legacy accounts must receive a real login identifier before they can log in.
- GET /classrooms returns authorized classroom summaries {id,name,course_id,course_name,teacher_id,teacher_name}; only active classrooms are returned. Teachers see their own classrooms and students see their memberships. Teacher names are returned without work numbers. join_code is included only for the owning teacher/admin, never for student members. POST /teacher/courses/{course_id}/classrooms {name} (teacher); POST /classrooms/join {join_code}; DELETE /teacher/classrooms/{id}/members/{user_id} (owner/admin). Authorized teacher progress/member details use `student_id` instead of email (nullable only for unassigned legacy users).
- 班级管理列表 `GET /teacher/classrooms/management` 按任课范围返回班级。改名使用 `PATCH /teacher/classrooms/{id}`，归档使用同路径下的 `POST /archive`，仅管理员可调用 `POST /teacher/courses/{course_id}/transfer` 转交整门课。正式删除使用 `DELETE /teacher/classrooms/{id}`，有学习记录时仅管理员可执行。归档保留成员关系。正式删除解除成员关系并保留历史，原班任课教师及管理员通过管理列表的 `?deleted=true` 查找已删除班级，使用 `GET /teacher/classrooms/{id}/history` 和 `/history/{student_id}` 只读查阅。这里的 student_id 路径参数是学生内部用户 ID。
- `PATCH /teacher/courses/{course_id}` 接收 `name` 和 `expected_revision`，由管理员或课程负责人修改课程名。成功后返回课程实例，版本不匹配且名称有变化时返回 409。
- 全站账号列表 `GET /admin/accounts?role=teacher|student` 返回含 `disabled` 的可分页记录，支持查询 `q` 和 `classroom_id`。创建教师 `POST /admin/teachers {student_id,name,password?}`，省略密码则使用工号，工号不足8位时须设置密码，重复工号返回409。以 `/admin/accounts/{user_id}` 为基址，`PUT /name {name}` 修改姓名，`PUT /status {disabled}` 停用或启用，`POST /reset-password {password?}` 设置临时密码（教师须提供密码），`DELETE` 永久删除并返回204。停用撤销现有会话。删除事务与关联记录一并提交，管理员和体验账号禁止单独删除。全局概览 `GET /admin/overview` 汇总各班学习任务、资料合成及代码评测。以上路由均须管理员身份。
- `GET /world?classroom_id=…` 返回学生位置、四个固定 NPC、已开放章节及建筑入口。位置和交互点来自平台地图，角色展示取自全站角色配置。
- `PUT /world/position` 接收 `classroom_id,map_key,tile_x,tile_y,direction`，校验当前地图和边界。`POST /world/transition` 接收 `classroom_id,portal_id`，校验班级、所在地图和与门的距离，返回更新的位置和世界状态。

## Development and preview progress reset

- `User.dev_tools_enabled` is true for a regular student only when the API process explicitly has both `REBORN_ENV=development` and `REBORN_DEV_TOOLS=1`. It is also true for a dedicated teacher preview student, whose session has `town_preview: true`. The capability comes from the server.
- `POST /dev/progress/reset {classroom_id,confirmed:true}` requires the authenticated student to belong to that classroom and affects only that student's records in that classroom. The body cannot select another user. Explicit confirmation is required; invalid input returns 422, unauthorized role or membership is rejected, and unfinished judge/assistant work returns 409 without clearing progress.
- 重置返回 `{ok,user_id,classroom_id,deleted}`。仅清理本人在该班的阅读参与、作答、成绩和地图位置。客户端收到成功回执后清除本人该班的阅读位置、草稿和会话恢复指针，再从出生点进入。账号、成员关系、服务端答疑审计和预算记录保留。
- The ordinary `/dev/progress/reset` route is registered only when both explicit development switches are enabled. `POST /teacher-town/progress/reset` accepts the same confirmation and response shape, and authorizes only the teacher preview identity in its bound classroom. This route is available to that identity in production as well.

## Learning and formal submissions

- A practice question with `kind: "interactive"` includes `interactive: {html,css,js}` in the authorized student DTO. Its private target is available in the teacher editor. Submit through `POST /submissions` with `answer: {value,correct,message}` and the normal activity, question, classroom and idempotency fields. The server requires the script's positive result and a typed JSON match with the private target to accept. A script failure leaves the question available for retry. Assessment definitions and assessment submissions exclude this kind. See [交互练习题](content-authoring.md#交互练习题) for authoring and field limits.
- When the student sends a practice assistant message on an interactive question, `state.question_id` identifies the question and `state.interactive_state` carries either `{"available":true,"value":…}` or `{"available":false}`. A legacy client may omit the field. A successful read can explicitly return a JSON null as its value. The server validates the state against the authorized question and its JSON limits. The assistant sees the frozen public value for that message and may separately read the latest public submission feedback. Authored source and the private target are excluded from assistant context.

- `GET /activities/{id}?classroom_id=…` 返回已授权的练习或测验、公开题面和本人进度。打开内容、保存测验草稿及正式提交均检查本班章节开放状态和当前前置要求。已交试卷继续判定。
- `GET /library?classroom_id=…` 列出学生有权阅读的资料及开放章节关联。`GET /materials/{id}?classroom_id=…` 返回资料详情，同路径的 `/file` 支持 HTTP Range 和私有缓存控制。阅读任务的证据写入章节参与接口。
- 教师创建或更新知识点练习时传入 `practice_rules`，例如 `{"goals":[{"knowledge_point_id":7,"total":3,"by_kind":{"python":1}}]}`。知识点限同一章节，发布时校验全局去重后能否满足各项配额。可通过 `published: false` 保存题量不足的草稿。更新练习时省略 `practice_rules` 保留当前方式，显式传 `null` 使用固定题单，题目及顺序由活动选题接口维护。已有个人题单或学习证据时，切换方式或变更目标返回 409。
- 学生首次打开 `GET /activities/{id}?classroom_id=…` 时生成个人题单。响应的 `questions` 只包含本人已分配的公开题目。`progress.practice` 提供各知识点目标和通过数（`goals` 中的 `total/by_kind/accepted/accepted_by_kind`），以及每次分配的 `question_id/knowledge_point_id/status/appended`。单独查询进度不触发抽题。正式提交后重新读取活动可获得新增题面和最新通过状态；非本人题单中的题拒绝提交。
- POST /submissions {classroom_id,activity_id,question_id,idempotency_key,mode:submit,answer?,code?,browser_cases?}; GET /submissions/{id}?classroom_id. Return id, activity/question/mode/status/feedback/created_at. Knowledge-point practice allows immediate retries of incorrect assigned questions. The retired server run mode returns 422; the ordinary Run action executes only in the browser and creates no Submission. Python practice submissions require browser_cases[{input,output,stdout,stderr}] for every current public sample (1–20 cases, stdout/stderr at most 16000 characters each). The server validates the current samples and compares returned output, persisting feedback.source=browser_practice with passed_count/total_count and public sample diagnostics, without creating a judge payload. Missing, partial, stale or invalid receipts return 422. Retries bind the same code and complete receipt to the same idempotency key; changed evidence returns 409. This is client-reported practice evidence, not proof of trusted execution or an exam grade. Assessment rejects single-question submissions. Existing historical receipts remain readable.
- Completed server-side Python judging adds `feedback.passed_count` and `feedback.total_count`, aggregated from the actual server-side go-judge execution and output comparison results (public and hidden together). Queued/running/infrastructure-error responses omit counts; old receipts may also omit them and the UI must not infer counts from public samples. Hidden inputs, expected/actual output and case indices remain private. Public diagnostic fields retain their existing filtering.
- GET /activities/{id}/assessment?classroom_id returns {id,status:draft|grading|graded|attention,revision,locked,legacy,question_ids,answers:[{question_id,answer,code}],results:[public_submission],correct_count,total,score:int|null,max_score:100,completed,passed}. All state is authenticated-student/classroom/activity scoped. A new empty sheet has id:null/revision:0 and GET creates no rows. On a student first read, an already fully graded legacy sheet is bound once to an immutable legacy attempt using only its actual existing question/answer/submission identities; this endpoint alone commits that binding under the authenticated user lock, without creating or regrading submissions. Other world/progress/evidence reads remain pure. Before hand-in results is empty. Submitted answers are immutable; grading uses existing per-question Submission rows and the durable database-backed go-judge worker. No expected answers, hidden cases or internal execution payloads are returned.
- PUT /activities/{id}/assessment {classroom_id,revision,answers:[{question_id,answer?,code?}]} persists the whole draft and increments revision. Unknown/duplicate question IDs and extra fields are rejected; a stale revision or locked sheet returns 409. Teacher preview cannot write. Drafts may be incomplete and are never graded.
- POST /activities/{id}/assessment/submit {classroom_id,idempotency_key,answers:[{question_id,answer?,code?}]} requires every currently configured question answered, atomically locks the sheet and stages all question submissions/execution payloads. Repeating the same key and answers returns the same receipt, including after the current question set changes; another key or changed answers returns 409. Concurrent hand-ins are serialized by authenticated user lock and a unique actor/class/activity sheet. A failure staging any question rolls back the whole hand-in. There is no student unlock or blind executor resubmission endpoint.
- A sheet is complete when grading reaches a terminal academic result for every question. The score is `correct_count * 100 // total` and remains null during grading. Infrastructure errors and uncertain dispatch leave the sheet locked for reconciliation. Submitted sheets retain the original question IDs and earned grades.
- Feedback contains detail/status and optional public samples[{status,stdout,stderr,compile_output}]. Completed go-judge submissions may include aggregate elapsed_ms for dispatch-to-result time (not queue wait or per-hidden-case timings). Hidden tests, expected outputs and hidden indices are absent. States include prepared/dispatching/queued/running/accepted/wrong_answer/compile_error/runtime_error/time_limit/memory_limit/infrastructure_error/submission_unknown. New server-judged submissions progress prepared→dispatching→terminal through the existing database queue; historical queued/running rows become submission_unknown on startup for manual reconciliation; receipt fields remain stored, with no retired-provider polling or replay. Uncertain dispatches require reconciliation; no blind resubmit.

## Teachers and authoring

`GET /teacher/courses` 列出可管理课程，`POST /teacher/courses {name}` 创建空课程。课程可以没有班级。以 `/teacher/courses/{course_id}` 为前缀，`GET/POST /classrooms` 列班或开班，`GET /insights` 汇总教学与智能体使用。`GET /teacher/classrooms/{id}/activity-report` 按章列出资料、练习和测验、必做状态与各生进度，`?grades=true` 查看测验成绩。班级独立设置各章的发布、暂停和开放时间。

课程内容工作区的只读图谱入口为 `GET /teacher/courses/{course_id}/course-graph`，返回课程名称、章节及资料摘要和章节关系。子路径同样校验当前课程权限。

- `/search?search=…&kind=all&page=1&size=10` 搜索章节、资料、知识点和题目，支持限定单一类型，匹配标题或题干。返回命中总数、当前页及轻量定位信息。
- `/materials/{id}` 查询资料的页码依据、讲解稿与音频数量。 `/points/{id}` 返回知识点的可核对来源与关联题数。展开关联题目使用题库的 `knowledge_point_id` 分页筛选。
- `/questions/{id}` 返回所选题目的名称、题干、状态、题型、所属章节、关联知识点与明确引用的可见资料。
- `/tasks` 读取本班执行中的课件任务，另返回各资料最近一次执行中至多 30 条仍在队列里的失败、中断或取消记录。返回 run_id、当前阶段、进度和可用操作。

以下审批接口以 `/teacher/courses/{course_id}/content-review` 为前缀，查询范围为当前教师在该课程可见的待审草稿。

- `GET /summary` 返回待审讲稿页数 `narration_count`、来源课件数 `material_count` 和可审题数 `question_count`。`total` 仍为待审页数与可审题数之和。
- `GET /materials?page=1&size=25` 按课件标识去重，按标题和标识排序，返回 `items`、`page`、课件总数 `total` 及可审题数 `question_count`。每项提供 `material_id`、`material_title`、`material_kind`、`narration_count` 和最早待审页码 `first_page_no`。
- `GET /groups` 按章汇总，`GET /groups/{chapter_id}/materials` 按该章内的来源资料汇总。两者均支持分页及可选的 `kind=question|narration`。`total` 为分组数，`item_total` 为过滤后草稿总数，每组另列题目数、讲稿页数与可批量通过数。
- 每条草稿只进入一个审批组。多章关联按课程顺序归入首个可见章节。`chapter_id=0` 表示未归章，`material_id=0` 表示无可核对的来源资料。
- `GET` 基础路径接受 `page`、`size`、`kind`、`chapter_id` 和 `material_id`，返回分页草稿与审阅版本。 `GET /narrations/{id}` 返回单页讲解草稿及来源详情。 `POST /decisions` 接收 1 至 100 个明确的对象（类型、标识、版本）、`accept` 或 `reject` 决定，以及接受单页讲稿时的可选修订文本。
- `GET /groups/{chapter_id}/preview` 返回该章在当前类型筛选下可通过的草稿数、题目数、讲稿页数、须单独审阅的数量和确认令牌。 `POST /groups/{chapter_id}/accept` 接收 `kind`、`expected_count`、`token`，一次事务覆盖已预览的所有页。成员或版本变化返回 409，需重新预览。交互练习题须在编辑器中试答后单独通过。

- GET /teacher/courses/{course_id}/catalog -> {chapters,knowledge_points,activities,npcs}, restricted to the selected authorized classroom CourseInstance. Passing view=chapters returns chapter metadata alone.
- GET /teacher/courses/{course_id}/questions with page returns {items,total,page}. Items contain id, title, kind, status, source_type and chapter_ids. Search matches title or prompt. The kind, status and source filters apply before pagination. `reviewable=true` restricts results to drafts the current teacher can review in this class. GET /teacher/courses/{course_id}/questions/{id} returns one authorized teacher detail. GET /teacher/courses/{course_id}/chapters/{chapter_id}/question-candidates returns chapter-scoped selection metadata and public sample availability.
- GET /teacher/courses/{course_id}/knowledge-points accepts page, size, search and chapter_id and returns {items,total,page}. Both paginated lists default to 10 rows and accept up to 100. GET /teacher/courses/{course_id}/knowledge-point-labels returns id, title and chapter_id for up to 65 selected IDs passed as repeated ids query parameters.
- `POST /teacher/courses/{course_id}/chapters` 使用 `title,order_index?` 创建章节，同路径下 `PUT /{id}` 更新章节。知识点由 `/knowledge-points` 管理。删除章节使用级联预览。
- `POST /teacher/courses/{course_id}/activities` 接收 `id,chapter_id,title,kind,practice_kind?,required?,order_index?,published?,knowledge_point_ids?,question_ids?,practice_rules?`，同路径下 `PUT /{id}` 修改。`kind=practice` 时选择 `objective` 或 `programming` 并设置必做或选做。`kind=assessment` 的测验均为必做。固定题单和按知识点抽题按活动类型校验。
- GET/POST /teacher/courses/{course_id}/questions and PUT/DELETE /teacher/courses/{course_id}/questions/{id} manage an independent question bank. POST {id,title,kind,prompt,chapter_ids?,knowledge_point_ids?,source_type?:ai_generated|imported,status?:draft|ready|disabled,options?,samples?,answer?,hidden_cases?,source?}; PUT accepts partial edits. Questions do not require activity_id. Ready questions need at least one authorized chapter and valid grading configuration; knowledge points are optional and must belong to selected chapters. source is optional reference evidence, not a third origin type. Teacher responses include owner_id, chapter_ids, knowledge_point_ids, source_type, status, source, activities:[{id,title,chapter_id}] and private grading fields; student responses never include private answers/cases. Cross-owner changes are rejected. Removing required chapter associations or making a referenced question unavailable returns409; direct DELETE requires the cascade preview protocol. Python samples+hidden cases total<=20 with validated field shapes and bounded text.
- DELETE /teacher/courses/{course_id}/activities/{id} and chapter/material/question DELETE routes authorize scope and ownership, then return409 requiring cascade preview and second confirmation. They cannot bypass the preview protocol.
- PUT /teacher/courses/{course_id}/activities/{id}/questions {question_ids:[string]} replaces the ordered selection atomically. Only owned/admin editable fixed-list practice/assessment activities, available questions in the same instance and matching chapter associations are accepted. Duplicate/unknown IDs are rejected; an assessment may select at most100 questions, matching draft/hand-in limits. Existing assessment attempts block changing the ordered assessment question set (409); changing a question kind with submitted/locked evidence also returns409 and requires a new ID. ActivityQuestion is the only stored selection source; GET /teacher/courses/{course_id}/catalog activity summaries expose computed question_ids for management. Reusing a question does not reuse another activity's submissions, grades or sheet locks.
- PUT /teacher/classrooms/{id}/releases/{chapter_id} {status:published|paused,opens_at:ISO8601|null}. GET /teacher/classrooms/{id}/releases. Server-time evaluation is immediate. Classroom releases control visibility and schedule; all students use current definitions.
- `GET /teacher/classrooms/{id}/progress` 汇总成员的章节任务进度。`GET /teacher/classrooms/{id}/students/{student_id}` 提供个人章节、资料、作答及测验记录。已完成章节按当前开放章节的必读资料、必做练习和测验计算。
- POST /teacher/courses/{course_id}/materials/upload multipart {chapter_ids?:JSON-encoded integer array,title,material_id?,file} -> {id,status,title}; omitted chapter_ids creates an unclassified upload, or preserves existing links on replacement. PUT /teacher/courses/{course_id}/materials/{id} {title?,chapter_ids?} edits metadata and multiple chapter links. GET /teacher/courses/{course_id}/materials lists authorized metadata; GET /teacher/courses/{course_id}/materials/{id} and /file provide owner/admin preview, including unclassified material, without classroom publication. DELETE /teacher/courses/{course_id}/materials/{id} requires the cascade preview protocol (409). queued/processing/ready/failed processing states persist. Student access requires an association to a chapter open in the current classroom. Same material_id replaces the current file while preserving type; chapter links determine its presence in each chapter.

## Active teaching assistant

- GET /assistant/status -> available, reason, model_calls. Missing credentials are explicit.
- `POST /assistant/sessions` 接收 `classroom_id` 及 `activity_id`、`material_id` 之一，返回会话标识与修订。资料、客观题和编程题分别绑定图书管理员、教授和教练。测验关闭答疑。`GET /assistant/sessions/{id}` 返回本人可读消息、修订及角色变更标记。
- POST /assistant/sessions/{id}/messages accepts {message,state,client_request_id,expected_revision}. State contains page_no/video_time for reading, or question_id/answer/code/local_run/displayed/selected_case for practice. For knowledge-point practice, the server freezes the learner’s assigned question list, goal and type counts, and outstanding corrections. Question membership, page authorization and submission ownership are checked server-side. LocalRun contains question_id/run_id/code/completed_at/duration_ms/cases(stdout,error,status)/error/stopped; it is client-reported public-sample feedback, never grading evidence. The server resolves expected outputs from public samples. Old page_no/video_time/code fields remain accepted during frontend rollout; practice still requires a valid current question.
- SSE emits meta(request_id/session_id/revision/role_changed), status(text,phase) during compression, token(text), references(items), done(status/tokens/revision), error(detail). Duplicate completed client_request_id replays its receipt without a model call; mismatched payload, stale revision or an in-flight duplicate returns409. Cancelled/failed receipts do not silently retry. The frontend retains failed input.
- POST /assistant/requests/{id}/cancel; owner validation and thread-safe cancellation. Sessions isolate user/class/activity or user/class/material and reauthorize on history access and every message. Material sessions have nullable activity_id, reference only the current material, and expose no question answers, submissions or synthetic teaching activity. References contain material_id/page_id/page_no with no content version. Assessment sessions reject assistant access.
- One create_agent runtime: learning exposes list_material_pages/search_material_pages/read_material_page/get_reading_progress; practice exposes list_activity_questions/read_activity_question/read_current_attempt/get_current_question_feedback/search_practice_materials/read_practice_material. Feedback source is displayed/local_run/submission and is bound to the current turn's question. Text readers accept offset/limit (default2000,max4000) and return total_chars/next_offset. Search examines complete authorized text and returns bounded excerpts. No execution, hidden answers, grading or unlock tools.
- 管理员通过 `GET/PUT /teacher/assistant/model` 统一管理全站开关、模型和预算。`PUT` 使用 `expected_revision`，`enabled` 默认开启。响应只给出密钥配置状态和掩码。`POST /teacher/assistant/model/test` 显式测试已保存配置。

Pausing a chapter suspends learner access. Reopening it restores access to the current content and saved evidence.

### 全站讲稿与语音服务设置

管理员 GET/PUT `/teacher/services/authoring` 与 `/teacher/services/speech`，普通教师/学生403。两者均含 expected_revision、base_url、api_key（空值保留）、clear_key、timeout；authoring 另含 model、vision_model、effort、max_tokens、daily_pages；speech 另含 protocol（openai/deepseek/dashscope）、model、voice、format、speed。DeepSeek 语音限制 wav/pcm 与合成速度1；DashScope 走原生 `/api/v1/services/audio/tts/SpeechSynthesizer`，只支持 mp3/wav/pcm/opus 与 0.5–2 语速，服务端从返回 JSON 的音频 URL 下载；原生地址含 `/compatible-mode` 时保存返回422，避免错误拼接兼容层。修订冲突409，验证失败422且不回显输入密钥。GET/PUT 响应含 revision、key_configured、source，无明文密钥。首次读取环境初始化，保存后独立覆盖；保存不产生外部调用，不影响学生模型与课程预算。

- GET `/teacher/services/speech/catalog`：用已保存地址与密钥拉取 TTS 模型，实时列表与内置列表合并；音色返回内置常用中文列表（复刻/设计音色仍可手填）。返回 `models`、`voices`、`model_source`；拉取失败回退内置列表，不阻断设置页。
- POST `/teacher/services/speech/test`：用已保存配置合成一句短文本，返回 `elapsed_ms`、`bytes`、`format`、`model`、`voice`，不保存音频。未保存配置409，未保存密钥503，语音配置不可用409，供应商失败502；仅管理员可调用。

## 资料逐页讲解与音频

课程目录交换现包含逐页讲稿与有效配音，文件契约见[讲稿与配音交换](content-authoring.md#课程包中的讲稿与配音)。导入预览diff新增narrations分类，摘要含服务端narration_revision；apply再次校验，预览后讲稿或配音变化返回409，生成任务进行中返回422。缺省讲稿不清空目标讲稿，已有未应用的旧预览需重新预览，成功回执继续幂等复用。学生接口仍只返回已审校且当前有效的正文和音频。

教师接口仅支持 PDF/演示文稿（其他类型422），由路径中的 `course_id` 指定课程；学生接口按资料授权与班级开放范围鉴权，未授权一律404/403，不泄露资料存在性。以下路径均在 `/api` 下。

- GET /teacher/courses/{course_id}/materials/{id}/narrations -> {pages:[{page_no,title,has_text,source_chars,source_text,raw_text,digest:{title,topic,tags,text,status,source,image_state,model}|null,narration:{text,target_seconds,status,source,model,image_used,anchors,edited_by_teacher,reviewed_at,stale_reason}|null}],coverage:{pages,covered,missing,draft,accepted,rejected,unavailable,stale}}。`raw_text` 为原始解析文本前2000字，`digest` 为整理稿；两者都不返回学生。`bridge_in` 已取消，旧数据保留列但不再生成或下发。
- PUT /teacher/courses/{course_id}/materials/{id}/narrations/{page_no} {text,target_seconds?} 写入或改写讲解正文，结果为 draft；整理稿已变时旧 accepted 记录在读取时被判 stale。DELETE 删除该页讲解。
- POST /teacher/courses/{course_id}/materials/{id}/narrations/{page_no}/accept；POST .../reject。只有 accepted 能进入学生端并合成音频。课程包保留各讲稿状态，草稿和过期内容不会因导入变成可见。未保存修改不得接受（后台层面阻断，服务端以提交正文为准）。
- POST /teacher/courses/{course_id}/materials/{id}/narrations/{page_no}/generate 按单页生成（同步返回结果），POST .../narrations/generate {first_page,last_page} **只入队并返回 202 `{job}`**，由后台 worker 执行。批量入口没有 `mode`：一律 4 页一窗，从整理稿生成，一次调用写 4 页，页号必须与输入一致，缺页/多页整窗失败并记入 `retry_pages`，已完成窗口保留；未配置作者期模型或无整理稿时当场 409，不会留一个必定失败的任务。单页入口用同一套窗口提示词与幂等键，可单独补写一页。
- POST .../narrations/pipeline **只入队并返回 202 `{job}`**：一键跑完整条链「梳理原文 → 整册校准 → 应用修正 → 生成讲解稿」。每段完成后把剩余阶段写进 `progress.chain`，`GET .../narrations/job` 的 `stage`/`chain` 供进度条显示；失败停在当前段并记 `failed_stage`，已完成段不重复计费，重试从该段继续。校准报告由链自动应用（整理稿保持 draft，原始文本不动）；没有可整理页面或未配置模型时当场 409。
- `PUT .../narrations/{page_no}/content {title?,topic?,tags?}` 让老师手工修正整理稿元数据（`source` 记为 teacher）。标题或标签变化按整理稿变化处理，旧讲解失效待重生成；正文编辑仍走讲解稿接口。
- POST .../narrations/digest **只入队并返回 202 `{job}`**：整理原文（4 页一窗），结果写 `page_contents`（title/topic/tags/整理稿），原始解析文本保持不动。未配置作者期模型或资料没有页面时当场 409；按页幂等，原文未变的页不重复调用模型，已整理的页再次触发只处理变化的页；页号与输入不一致的窗口失败并记入 `failed`，不写半截。缺页图按该页失败处理，页级 `image_state` 记录本页整理时是否带图。
- GET .../narrations/job -> {id,material_id,running,queued,kind,status,stage,chain,done,total,message,failed:[{page_no,error}],started_at}：前端轮询用；`stage`/`chain` 是一键链的当前段与剩余段；`running=false` 且 `queued=false` 表示这一轮已结束（`status` 为 done|failed|interrupted）。
- 生成／校准／音频端点共用一份资料锁：已有任务在跑时返回 409「这份资料正在处理中」；心跳超过 5 分钟的旧任务视为过期，允许接管。批量生成、全篇校准与音频批量都在后台 worker 线程里执行，请求只负责入队，关闭页面不会中止任务。
- POST .../narrations/accept-batch {first_page?,last_page?} 一次接受范围内全部可审草稿，返回 {accepted:[页码],count,skipped:[{page_no,reason}]}；空文本、非 draft 页跳过。
- POST .../narrations/audio-batch {first_page?,last_page?} 为范围内已接受的页批量合成音频，**只入队并返回 202 `{job}`**，结果从 `GET .../narrations/job` 的 `done`/`failed` 与 `GET .../narrations/audio` 的就绪状态读取；单页失败不中断。；两者幂等，输入未变不重复请求模型。余额/额度不足、无凭据、供应商失败分别返回429/409/502，单页失败不阻断其余页。
- GET /teacher/courses/{course_id}/materials/{id}/narrations/quota 返回当日额度使用；POST .../narrations/calibrate 排队全篇校准，**返回 202 `{job}`**，后台 worker 逐窗执行直到完成。进度看 `GET .../narrations/job`（done/total 为窗口数），报告看 `GET .../calibrate?partial=1`；`next_index`/`windows_done` 是游标，进程重启后游标与合并结果仍在，再触发只跑剩余窗口，已完成窗口不重复调用模型。整册输入（提示词前缀、视觉模型、窗口参数、参与页 revision、发图策略）未变时直接复用上次完整报告，零模型调用，报告里 `reused=true`。校准校对的是**整理稿与原文**：每窗附整理稿、原文、前后页，碎片页附页图；报告字段为 `fixes:[{page_no,before,after,reason,status}]`（修正后的完整整理稿）、`issues:[{page_no,kind,detail,status}]`（只报告不改）、`tag_map`（整册「别名→标准名」）与 `tag_stats{before,after,merged}`。改动过大的 fix 会降级为 issue，不替模型重写。没有整理稿时立即 404。GET .../calibrate 取最近一份**完整**报告，`?partial=1` 也返回进行中的报告；POST .../calibrate/apply 只接受完整报告（未完成409），把 fixes 写回 `page_contents`（保持 draft、原文不动）并把 `tag_map` 写入课程级字典，返回 `{applied_fixes,rejected_fixes,tags}`；整理稿在报告之后被改过的 fix 会被拒绝。报告另含 `usage{prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens}`、`shrunk_windows`（按缩减预算完成的窗口）、`output_retries`（因输出截断而加大预算重试的窗口数）、`render_errors`（无法渲染页图的页）与 `lost_images`（需要图但因预算没带上的页）。
- GET /teacher/courses/{course_id}/materials/{id}/narrations/{page_no}/page-image -> image/jpeg，返回审校用页图（与生成时送模型的页图同一份、同一尺寸）；文本资料或没有可读来源时404。页面图像不返回给学生，学生端仍只看课件本身。
- POST /teacher/courses/{course_id}/materials/{id}/narrations/{page_no}/audio 合成单页语音：仅 accepted 可合成（draft/未就绪409），无TTS引擎409且不伪造音频，引擎失败502。GET .../narrations/audio 返回逐页就绪状态与音色/模型；GET .../{page_no}/audio/file 为教师试听流（audio/mpeg）。
- GET /materials/{id}/narrations/{page_no}/page-image?classroom_id -> image/jpeg：学生播放讲解用的大页面，鉴权与讲解列表一致；没有可读来源时404。
- GET /materials/{id}/narrations?classroom_id 学生只读到 accepted 且未 stale 的页，字段仅 page_no/text/target_seconds/audio/audio_seconds。GET /materials/{id}/narrations/{page_no}/audio?classroom_id 为 audio/mpeg 流，未接受或无录音404。
- 逐页提问复用 `/assistant/sessions` 与现有消息/SSE接口，state.page_no 指定当前页；独立讲解 `/ask` 已移除（404），历史问答表保留。授权、课程开关、全站模型配置、额度、幂等和会话修订均沿用学习助教。工具可读取当前资料的有效已审校讲解，长内容分段读取，草稿不外泄。

讲解、审校、音频与提问均不改变成绩、解锁、任务进度或阅读完成；翻页、播放与浏览不产生模型调用。课程包携带讲稿状态及有效配音，详见内容规范的交换契约。

## 班级课程与包交换

课程接口在路径中指定 `course_id`。班级开放与学生数据另按 `classroom_id` 鉴权。包内使用稳定标识，导入后以服务端返回的标识访问课程实体。

- `GET /teacher/courses/{course_id}` 返回课程名称、负责人、包标识和修订。`GET /teacher/courses/{course_id}/ids` 查询稳定标识与运行标识的映射。
- 格式 4 导入章节、资料任务条件、知识点、题库、两类练习、测验及媒体。预检拒绝格式 3 及更早的包。固定地图、平台角色和答疑配置由部署提供。
- `POST /teacher/courses/{course_id}/imports/available/preview` 接收 `package_key`，校验私有目录副本并返回差异、阻断项、学习记录影响和过期时间。
- `POST /teacher/courses/{course_id}/imports/{preview_id}/apply` 接收 `request_id,expected_revision`，提交前复核内容指纹、课程修订与影响，重复请求返回原回执。
- `GET /teacher/courses/{course_id}/export` 在私有交换目录生成完整课程包，返回 `directory,path`。题目答案与课件媒体只供授权教师交换。账号、成员关系、学习记录及部署密钥均属于当前平台。
原始包、预览和答案只供授权教师。学生只获得过滤后的运行DTO；secrets目录名本身不构成权限边界。课程文件保存在REBORN_COURSE_EXCHANGE_ROOT，运行媒体保存在原私有存储，两者不是公开静态路径。

## 章节任务点

学生通过 `GET /chapter-tasks?classroom_id=…` 获取全部已开放章节。每章的 `tasks` 包含资料、客观题、编程题和测验的必做标记、`completed`、`locked`、`lock_reason` 及进度单位。正文阅读通过 `POST /chapters/{chapter_id}/materials/{material_id}/participation?classroom_id=…` 上报 `session_id,sequence,visible,page_id?`，视频另传 `position,playing,playback_rate`。服务端按学生、班级、章节和资料累计不同页面、有效前台时间或有效观看片段。

教师通过 `GET /teacher/courses/{course_id}/chapters/{chapter_id}/material-tasks` 获取 `items`，同路径下 `PUT /{material_id}` 接收 `required,rule,order_index?`。必读资料默认整份。分页资料支持 `scope=all|range|count` 和 `minimum_seconds`，视频支持观看时长和指定片段。学生完成必读资料后解锁两类练习，完成必做练习后解锁测验。追加必读资料会重新校验未完成活动，已有完成记录、已交试卷和成绩保留。

管理员通过 `GET /admin/teaching-roles` 查看全站角色与可用素材。`POST /admin/teaching-roles/{key}` 接收带 `expected_revision` 的 multipart 元数据和可选图片，保存名称、人设、立绘及像素形象。`GET /teaching-roles/{key}/image/{kind}` 为已登录用户提供角色自定义图片。

## 目录课程包接口

`GET /teacher/courses/{course_id}/packages` 列出可访问的目录，mine 标记本人导出，shared 标记共享包。`POST .../imports/available/preview` 对目录创建私有副本，生成内容指纹并执行完整校验与影响分析；确认应用时再次核对指纹、课程修订和授权。教师可将任意共享包导入本人管理的班级，不能借共享包修改其他教师的班级。

`package_key` 仅接受 `mounted-` 加64位十六进制摘要，不接受旧 `uploaded-` 标识。`GET .../export` 返回JSON，包含 `directory` 和 `path`，完整课程已写入服务器 `data/course/` 下的目录。旧ZIP上传、下载及预览应用分支均已退出。旧待应用的非目录预览返回422并要求重新选择目录；已完成导入的幂等回执仍按原请求返回，不重新执行导入，也不删除课程或学习记录。

课程包列表增加 directory、created_at、chapter_count 和 question_count。created_at 表示该包的 exported_at 或原始 created_at。列表仅读取章节定义和题目索引生成摘要，正式预览及应用仍执行完整校验。新导出目录为 export-<课程ID>-<安全课程名>-<北京时间YYYYMMDD-HHMMSS>-<8位随机串>，预检校验所选目录的格式版本。

GET /teacher/course/packages 返回个人导出及历史共享目录。DELETE /teacher/course/packages/{package_key} 允许导出者或管理员删除导出包，默认包受保护。原课程级接口仍校验目标课程权限。POST /teacher/course/packages/create-course 接收 package_key、name 和 request_id，完整校验并在同一事务中创建独立课程，重复请求返回同一课程。

导入预览的暂存副本在已应用或24小时过期后由后台周期清理。预览与应用接口继续使用既有有效期和幂等规则，成功回执独立于文件保留；同请求重试仍返回duplicate结果。清理忙碌跳过，处理中的预览、应用和导出持有交换目录锁。

## 评测管理

所有路径以 `/api/teacher/judge` 为前缀，需教师或管理员身份；带 classroom_id 的读取再校验班级所有权；省略 classroom_id 的读取仅管理员可用，覆盖全站。学生403，越权班级403，不存在的班级/该班提交404。

- `GET /service?classroom_id=…`：返回全局paused、受限health快照、checked_at、worker_seen_at、worker_alive与本班counts。只有管理员收到global_counts与最近50条events，不泄露其他班提交。
- `PUT /service`：仅管理员；严格DTO `{paused:boolean,reason:string}`，原因去空白后非空、最多200字符。全站控制持久化并记录操作者与原因；不修改成绩或停止正在执行的请求。
- `POST /service/probe`：仅管理员；即时连接、认证、隔离检查，保存受限结果，不执行学生代码。不返回执行服务地址、文件列表或密钥。
- `GET /submissions?classroom_id=…&q=…&status=…&page=1&size=25`：本班服务器Python评测提交（排除browser_practice练习回执），返回items/total；q最多100字符，匹配姓名/学号/当前题目名或完整提交编号；size为1–100，按提交时间倒序，列表无代码、输入和输出。
- `GET /submissions/{id}?classroom_id=…`：教师私有代码、feedback、提交时cases快照与diagnostic。每例附public标记、input、expected_output和可空result；result包含status/stdout/stderr/time_ns/memory_bytes/output_truncated。历史无诊断返回null，缺少某例结果也为null，不借用当前题目数据或伪造历史输出。题目/活动名称为当前名称。浏览器试运行和练习正式提交均不产生此处记录；其回执也不计入本班counts或global_counts。

原有学生提交DTO不增加教师诊断字段；教师查询、检测与管理均不触发模型调用。

评测详情的旧记录若已保存公开samples回执，可返回result.source=public_receipt并仅展示该公开证据，CPU/内存为空；隐藏结果仍为空。新私有诊断与历史公开回执在界面明确区分。

评测日期过滤：`GET /teacher/judge/service`与`GET /teacher/judge/submissions`共同接受可选`since`/`until`（必须成对、带时区的ISO时间，且since<until，否则422），采用左闭右开`[since,until)`。列表及本班counts按Submission.created_at过滤，在过滤后计算total和分页；events按发生时间过滤（仍只保留最近50条），health/heartbeat及管理员global_counts保持实时、全部日期。省略两者表示全部时间。页面默认近七天，按VITE_TIME_ZONE（默认Asia/Shanghai）把首日00:00与结束日下一天00:00转为UTC，日期首尾均包含；跨夏令时使用当地午夜而非固定增加24小时。查询日期不删除、重评或修改历史提交。

## Content deletion preview and confirmation

- POST /teacher/courses/{course_id}/content-deletions/preview {classroom_id,targets:[{kind:chapter|material|question|activity,id:string}]} authorizes all targets and returns {id,revision,confirmation,expires_at,remove:[{kind,id,title,reason}],detach:[{kind,id,title,reason}],preserve:[{kind,id?,title,count}],blockers:[{message,kind,id,path?,target?}],affected_students,ending_sessions,history_policy}. Targets are deduplicated, 1–100 per request. Preview changes no teaching content or learner history; it stores a private teacher/class/course-bound receipt, valid for15 minutes.
- POST /teacher/courses/{course_id}/content-deletions/{preview_id}/confirm {classroom_id,confirmation:string,confirmed:true} requires exact confirmation text. Under the exclusive course lock and preview row lock, revalidate revision, history/impact fingerprint, permissions and blockers. Success returns {ok:true,removed:int,detached:int,history_preserved:true}, atomically retires definitions, unlinks relationships, and increments course revision once. A repeated successful request returns the stored result, including after expiry. Expired/changed/blocked preview:409; invalid confirmation:422; wrong actor/class preview:404; unauthorized classroom/owner:403.
- Retired content is excluded from current teaching and export. Learner evidence and required private files remain. Judge history queries explicitly include retired question/activity metadata; student GET /submissions/{id} can read only their own retained receipt in an authorized class, with existing hidden-case redaction. A still-current submitted assessment retains its original questions, even if those questions were retired from the bank. No restore, purge, regrade or arbitrary force-delete endpoint is introduced.


### 资料合成管理

- `GET /api/teacher/courses/{course_id}/synthesis`：教师本班/管理员可读，学生403。参数 `query/view/status/page/size`；view为all/running/history，status为all/running/done/failed/interrupted/cancelled，页大小1–100。按执行记录分页，不列未执行资料。返回items、筛选total和搜索范围counts。每项包含执行记录id、资料ID/标题/类型、kind/status、done/total、message、failed、started_at/finished_at、requested_by显示名、scope、material_available、retryable/retry_note；不返回凭据、正文或文件地址。已删除资料仍保留执行记录，关闭查看和重试。
- `GET /api/teacher/courses/{course_id}/synthesis/runs/{run_id}` 按执行编号读取详情。全站管理员可用 `GET /api/admin/synthesis/runs/{run_id}`。进度包含本次请求的阶段、当前阶段及其百分比和单位；定位信息使用已记录的批次和页码，旧记录只在能核对时补充页码。
- `POST /api/teacher/courses/{course_id}/synthesis/{material_id}/cancel` 接收 `expected_started_at`。排队中的批量任务立即取消，已认领的任务记录取消请求并返回 cancelling，执行器在步骤边界停止后返回 cancelled。对当前失败任务重复取消均返回 `queue_dismissed: true`；执行记录保留 failed 状态及失败原因，图谱队列移除该记录。
- `POST /api/teacher/courses/{course_id}/synthesis/{material_id}/retry`：正文 `expected_started_at`，可重试有保存参数及指纹的明确失败、已取消或确定尚未执行即中断的任务。资料行锁内再次核对最新任务及失败时的资料/讲稿指纹；重复、内容变化、不支持或旧任务返回409。批次仅处理已记录失败页，返回新的任务状态；上游失败仍明确返回错误并保留已成功页。查询、筛选及打开页面零外部生成调用。

`narration_jobs`继续作为资料级执行锁；`narration_runs`每次执行新增一行，心跳进度和最终结果同步到该次记录，重试不覆盖历史。b72c49e018a3只回填实际存在的最近任务，不能恢复已覆盖记录。已认领任务的心跳过期显示interrupted，执行结果待核查；新任务接管时旧次记录保留待核查，不捏造结束时间。

### 体验开发工具

接口前缀为 /api/dev/experience（仅development且REBORN_DEV_TOOLS=1注册）与 /api/teacher-town/experience（仅教师本人当前班级体验学生）。每次校验classroom_id和认证归属，教师原身份/其他学生/其他班级不能借用；不存在或非本人检查点404，非法选择422，状态过期/待判题/助教进行中409。所有操作不调用模型。

| 方法与路径 | 契约 |
| --- | --- |
| GET 空路径 | 传入 `classroom_id`，返回章节开放状态、资料与活动定位信息和检查点摘要。 |
| POST /chapter | 传入 `classroom_id,chapter_id`，核对该章已发布并已到开放时间。 |
| POST /open | classroom_id、kind=material/activity、target、page_no/question_no（从1）、video_time（秒）；按正常学习权限返回workspace描述，不写完成记录。 |
| POST /checkpoints | classroom_id、name（1–80字）、client_state（最多256KB）、可选UUID request_id；每班每人20个上限，同request_id重试返回同id。服务端生成体验快照，不接受客户端任务/成绩状态。 |
| GET /checkpoints/{id}/preview | 核对本人班级和定义指纹，返回 `name,expected`。 |
| POST /checkpoints/{id}/restore | classroom_id、expected；状态/定义变化409，校验地图合法点，恢复本人体验记录并返回client_state。客户端只恢复本人班级的read/draft缓存键。 |
| DELETE /checkpoints/{id} | classroom_id查询；仅删除本人检查点。 |
| POST /spawn | 回到本人当前班级的出生点。 |

检查点保存角色位置和客户端阅读位置、草稿。恢复前须核对地图与定义指纹和本人当前体验状态。服务器保存的学习参与、提交、试卷、成绩和助教历史独立保留。

### 多选题答案契约

`kind: multiple_choice` 使用公开选项字符串与私有正确答案字符串数组；练习 `/submissions`、测验草稿/交卷的 `answer` 均为字符串数组，不接受逗号拼接文本代替数组。交卷要求至少选一个有效且不重复的选项，少选可以交卷但判错；评分为集合完全相等，不受选择顺序影响、不设部分分。草稿及锁定答案保留数组；学生响应不含正确答案。助教状态可携带学生当前选择的数组，仍只在明确提问时调用且不接收私有答案。
