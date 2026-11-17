# 界面设计规范

学生游戏与教师后台使用两套独立规范，按页面用途选择，不按当前登录角色选择。教师进入小镇时也使用学生游戏规范。

| 页面 | 规范 | 主要实现入口 |
| --- | --- | --- |
| /world小镇、学习与游戏工作区 | [游戏界面](game-interface.md) | frontend/src/features/、OverlayHost.vue及游戏共享样式 |
| /teacher/班级、课程与教学管理 | [教师后台](teacher-interface.md) | admin/src/pages/、admin/src/features/及后台组件 |

两端各自复用组件、布局及状态，不交叉导入主题或无作用域样式。具体交互只在对应规范中维护；产品能力见[产品说明](../product.md)，系统职责见[架构](../architecture.md)。

修改界面时核对相关[需求](../requirements.md)，规则变化同步对应规范；按[开发手册](../development.md#基础检查)选择受影响场景验证，结果在交付回复中说明。文档归属和记录方式见[文档维护](../README.md#文档维护)。
